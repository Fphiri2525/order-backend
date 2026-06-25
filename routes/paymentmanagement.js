/**
 * paymentManagement.js
 * Mount at: app.use('/api/payment-management', require('./routes/paymentManagement'));
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /transactions                         – paginated, filtered transaction list
 * GET  /analytics/today                      – overview stats (revenue, counts, avg)
 * GET  /analytics/hourly                     – hourly revenue chart data
 * GET  /analytics/methods                    – breakdown by payment method
 * GET  /analytics/outcomes                   – paid/pending/failed/refunded counts
 * POST /transactions/:id/verify              – mark pending → paid (manual verify)
 * POST /transactions/:id/retry               – re-send payment prompt (mobile money)
 * POST /transactions/:id/refund/request      – customer / admin requests refund
 * PATCH /transactions/:id/refund/:action     – approve | reject refund
 * GET  /refunds                              – pending + history
 * GET  /alerts                               – smart alerts for the alert banner
 * GET  /export                               – CSV download of transactions
 */

const express = require('express');
const db      = require('../database');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function handleError(res, section, error) {
  console.error(`❌ [payment-management/${section}]`, error.message);
  res.status(500).json({ success: false, message: `Failed: ${section}`, error: error.message });
}

// Normalise a raw payments+orders row into the Transaction shape the UI expects
function normaliseTransaction(row) {
  // Derive a human-readable PayStatus from what we store in DB
  const statusMap = {
    successful: 'paid',
    paid:       'paid',
    pending:    'pending',
    failed:     'failed',
    refunded:   'refunded',
  };

  const payStatus = statusMap[row.payment_status] ?? statusMap[row.order_status] ?? 'pending';

  // Map DB method names to display names
  const methodMap = {
    airtel_money:  'Airtel Money',
    tnm_mpamba:    'TNM Mpamba',
    paychangu:     'PayChangu',
    mobile_money:  'Airtel Money', // default mobile_money falls to Airtel
    cash:          'Cash',
  };
  const method = methodMap[row.method?.toLowerCase()] ?? row.method ?? 'Cash';

  const createdAt = row.created_at ? new Date(row.created_at) : new Date();
  const date = createdAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Parse items JSON if stored, else empty array
  let items = [];
  try { items = row.items ? JSON.parse(row.items) : []; } catch (_) {}

  // Derive failReason from gateway_response text heuristics
  let failReason = row.fail_reason ?? null;
  if (!failReason && payStatus === 'failed' && row.gateway_response) {
    const gr = row.gateway_response.toLowerCase();
    if (gr.includes('insufficient')) failReason = 'Insufficient funds';
    else if (gr.includes('timeout'))  failReason = 'Network timeout';
    else if (gr.includes('cancel'))   failReason = 'User cancelled';
    else if (gr.includes('verif'))    failReason = 'Verification failed';
  }

  return {
    id:              row.payment_id ?? row.tx_ref,
    orderId:         `#${row.order_id}`,
    customer:        row.customer_name ?? 'Guest',
    phone:           row.customer_phone ?? row.phone ?? 'N/A',
    amount:          parseFloat(row.amount ?? row.total_amount ?? 0),
    method,
    status:          payStatus,
    reference:       row.tx_ref ?? '',
    date,
    time,
    items,
    failReason:      failReason ?? null,
    gatewayResponse: row.gateway_response ?? null,
    refundRequested: !!row.refund_requested,
    refundStatus:    row.refund_status ?? null,
  };
}

// ─── GET /transactions ────────────────────────────────────────────────────────
// Query params: status, method, search, limit, offset, date (YYYY-MM-DD | 'all')
router.get('/transactions', async (req, res) => {
  const {
    status, method, search,
    limit  = 100,
    offset = 0,
    date   = 'today',
  } = req.query;

  try {
    let where  = [];
    let params = [];

    if (date === 'today') {
      where.push('DATE(p.created_at) = CURDATE()');
    } else if (date && date !== 'all') {
      where.push('DATE(p.created_at) = ?');
      params.push(date);
    }

    // Map UI status names → DB payment status values
    if (status && status !== 'all') {
      const dbStatus = { paid: 'successful', pending: 'pending', failed: 'failed', refunded: 'refunded' }[status];
      if (dbStatus) { where.push('p.status = ?'); params.push(dbStatus); }
    }

    if (method && method !== 'all') {
      where.push('p.method LIKE ?');
      params.push(`%${method}%`);
    }

    if (search) {
      where.push('(o.order_id LIKE ? OR u.fullname LIKE ? OR u.contactnumber LIKE ? OR p.tx_ref LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await db.query(`
      SELECT
        p.id            AS payment_id,
        p.tx_ref,
        p.amount,
        p.method,
        p.status        AS payment_status,
        p.gateway_response,
        p.fail_reason,
        p.refund_requested,
        p.refund_status,
        p.created_at,
        o.order_id,
        o.status        AS order_status,
        o.order_type,
        o.total_amount,
        o.phone,
        COALESCE(u.fullname, 'Guest')                     AS customer_name,
        COALESCE(u.contactnumber, o.phone, 'N/A')         AS customer_phone,
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'name',  COALESCE(m.name, 'Food Item'),
              'qty',   oi.quantity,
              'price', oi.price
            )
          )
          FROM order_items oi
          LEFT JOIN menu_items m ON oi.menu_id = m.id
          WHERE oi.order_id = o.order_id
        ) AS items
      FROM payments p
      LEFT JOIN orders o  ON p.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id  = u.id
      ${whereSQL}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    // Count without pagination
    const [countRows] = await db.query(`
      SELECT COUNT(*) AS total
      FROM payments p
      LEFT JOIN orders o  ON p.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id  = u.id
      ${whereSQL}
    `, params);

    res.json({
      success: true,
      total:   countRows[0]?.total ?? rows.length,
      data:    rows.map(normaliseTransaction),
    });
  } catch (error) {
    handleError(res, 'transactions', error);
  }
});

// ─── GET /analytics/today ─────────────────────────────────────────────────────
router.get('/analytics/today', async (req, res) => {
  try {
    const [[stats]] = await db.query(`
      SELECT
        COUNT(*)                                                          AS total,
        SUM(CASE WHEN p.status = 'successful' THEN 1 ELSE 0 END)         AS paid,
        SUM(CASE WHEN p.status = 'pending'    THEN 1 ELSE 0 END)         AS pending,
        SUM(CASE WHEN p.status = 'failed'     THEN 1 ELSE 0 END)         AS failed,
        SUM(CASE WHEN p.status = 'refunded'   THEN 1 ELSE 0 END)         AS refunded,
        COALESCE(SUM(CASE WHEN p.status = 'successful' THEN p.amount ELSE 0 END), 0) AS revenue,
        COALESCE(AVG(CASE WHEN p.status = 'successful' THEN p.amount END), 0)        AS avg_value
      FROM payments p
      WHERE DATE(p.created_at) = CURDATE()
    `);

    // Yesterday comparison
    const [[yesterday]] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'successful' THEN amount ELSE 0 END), 0) AS revenue,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'successful' THEN 1 ELSE 0 END) AS paid
      FROM payments
      WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    `);

    const pctChange = (current, prev) => {
      if (!prev || prev === 0) return 0;
      return Math.round(((current - prev) / prev) * 100);
    };

    res.json({
      success: true,
      data: {
        total:    stats.total    || 0,
        paid:     stats.paid     || 0,
        pending:  stats.pending  || 0,
        failed:   stats.failed   || 0,
        refunded: stats.refunded || 0,
        revenue:  parseFloat(stats.revenue),
        avg_value: parseFloat(stats.avg_value),
        trends: {
          revenue_vs_yesterday: pctChange(stats.revenue, yesterday.revenue),
          total_vs_yesterday:   pctChange(stats.total,   yesterday.total),
          paid_vs_yesterday:    pctChange(stats.paid,    yesterday.paid),
        },
      },
    });
  } catch (error) {
    handleError(res, 'analytics/today', error);
  }
});

// ─── GET /analytics/hourly ────────────────────────────────────────────────────
router.get('/analytics/hourly', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        HOUR(created_at)                                AS hour,
        COUNT(*)                                        AS transaction_count,
        COALESCE(SUM(CASE WHEN status = 'successful' THEN amount ELSE 0 END), 0) AS revenue
      FROM payments
      WHERE DATE(created_at) = CURDATE()
      GROUP BY HOUR(created_at)
      ORDER BY hour
    `);

    // Build full 7–20 hour grid (operating hours)
    const hourMap = {};
    rows.forEach(r => { hourMap[r.hour] = r; });

    const hours = [];
    for (let h = 7; h <= 20; h++) {
      hours.push({
        hour:              h,
        label:             `${h}h`,
        transaction_count: hourMap[h]?.transaction_count ?? 0,
        revenue:           parseFloat(hourMap[h]?.revenue ?? 0),
      });
    }

    res.json({ success: true, data: { hours } });
  } catch (error) {
    handleError(res, 'analytics/hourly', error);
  }
});

// ─── GET /analytics/methods ───────────────────────────────────────────────────
router.get('/analytics/methods', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        COALESCE(method, 'unknown')                                           AS method,
        COUNT(*)                                                              AS count,
        COALESCE(SUM(CASE WHEN status = 'successful' THEN amount ELSE 0 END), 0) AS total_amount,
        SUM(CASE WHEN status = 'successful' THEN 1 ELSE 0 END)               AS successful,
        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END)               AS failed,
        SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END)               AS pending
      FROM payments
      WHERE DATE(created_at) = CURDATE()
      GROUP BY method
      ORDER BY total_amount DESC
    `);

    // Friendly name map
    const nameMap = {
      airtel_money: 'Airtel Money',
      tnm_mpamba:   'TNM Mpamba',
      paychangu:    'PayChangu',
      mobile_money: 'Airtel Money',
      cash:         'Cash',
    };

    const totalRevenue = rows.reduce((s, r) => s + parseFloat(r.total_amount), 0);

    res.json({
      success: true,
      data: rows.map(r => ({
        method:       nameMap[r.method?.toLowerCase()] ?? r.method,
        count:        r.count,
        total_amount: parseFloat(r.total_amount),
        successful:   r.successful,
        failed:       r.failed,
        pending:      r.pending,
        percentage:   totalRevenue > 0 ? Math.round((r.total_amount / totalRevenue) * 100) : 0,
      })),
    });
  } catch (error) {
    handleError(res, 'analytics/methods', error);
  }
});

// ─── GET /analytics/outcomes ──────────────────────────────────────────────────
router.get('/analytics/outcomes', async (req, res) => {
  try {
    const [[row]] = await db.query(`
      SELECT
        SUM(CASE WHEN status = 'successful' THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'refunded'   THEN 1 ELSE 0 END) AS refunded,
        COUNT(*)                                                AS total
      FROM payments
      WHERE DATE(created_at) = CURDATE()
    `);
    res.json({
      success: true,
      data: {
        paid:     row.paid     || 0,
        pending:  row.pending  || 0,
        failed:   row.failed   || 0,
        refunded: row.refunded || 0,
        total:    row.total    || 0,
      },
    });
  } catch (error) {
    handleError(res, 'analytics/outcomes', error);
  }
});

// ─── POST /transactions/:id/verify ───────────────────────────────────────────
// Manually mark a pending payment as paid
router.post('/transactions/:id/verify', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query(
      `UPDATE payments SET status = 'successful' WHERE (id = ? OR tx_ref = ?) AND status = 'pending'`,
      [id, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found or already processed' });
    }
    // Also mark the linked order as paid
    await db.query(
      `UPDATE orders SET status = 'paid'
       WHERE order_id = (SELECT order_id FROM payments WHERE id = ? OR tx_ref = ? LIMIT 1)`,
      [id, id]
    );
    res.json({ success: true, message: 'Payment verified and marked as paid' });
  } catch (error) {
    handleError(res, 'transactions/verify', error);
  }
});

// ─── POST /transactions/:id/retry ─────────────────────────────────────────────
// Mark failed payment back to pending so the customer gets a new prompt
router.post('/transactions/:id/retry', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query(
      `UPDATE payments SET status = 'pending', gateway_response = 'Retry requested by admin'
       WHERE (id = ? OR tx_ref = ?) AND status = 'failed'`,
      [id, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found or not in failed state' });
    }
    res.json({ success: true, message: 'Retry request sent — customer will receive a new prompt' });
  } catch (error) {
    handleError(res, 'transactions/retry', error);
  }
});

// ─── POST /transactions/:id/refund/request ────────────────────────────────────
router.post('/transactions/:id/refund/request', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  try {
    // Check payments table has refund_requested column; if not, alter first (dev convenience)
    const [result] = await db.query(
      `UPDATE payments
       SET refund_requested = 1, refund_status = 'pending', refund_reason = ?
       WHERE (id = ? OR tx_ref = ?) AND status = 'successful'`,
      [reason ?? null, id, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found or not eligible for refund' });
    }
    res.json({ success: true, message: 'Refund request submitted — awaiting admin approval' });
  } catch (error) {
    handleError(res, 'transactions/refund/request', error);
  }
});

// ─── PATCH /transactions/:id/refund/:action ───────────────────────────────────
// action = 'approve' | 'reject'
router.patch('/transactions/:id/refund/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or reject' });
  }

  const newRefundStatus = action === 'approve' ? 'approved' : 'rejected';
  const newPayStatus    = action === 'approve' ? 'refunded'  : undefined;

  try {
    const setClause = newPayStatus
      ? `refund_status = '${newRefundStatus}', status = '${newPayStatus}'`
      : `refund_status = '${newRefundStatus}'`;

    const [result] = await db.query(
      `UPDATE payments SET ${setClause}
       WHERE (id = ? OR tx_ref = ?) AND refund_requested = 1 AND refund_status = 'pending'`,
      [id, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'No pending refund request found for this transaction' });
    }

    if (action === 'approve') {
      // Mark order as refunded too
      await db.query(
        `UPDATE orders SET status = 'refunded'
         WHERE order_id = (SELECT order_id FROM payments WHERE id = ? OR tx_ref = ? LIMIT 1)`,
        [id, id]
      );
    }

    res.json({
      success: true,
      message: action === 'approve'
        ? 'Refund approved — will be processed to customer account'
        : 'Refund request rejected',
    });
  } catch (error) {
    handleError(res, `transactions/refund/${action}`, error);
  }
});

// ─── GET /refunds ─────────────────────────────────────────────────────────────
router.get('/refunds', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        p.id            AS payment_id,
        p.tx_ref,
        p.amount,
        p.method,
        p.status        AS payment_status,
        p.refund_status,
        p.refund_reason,
        p.created_at,
        o.order_id,
        COALESCE(u.fullname, 'Guest')                   AS customer_name,
        COALESCE(u.contactnumber, o.phone, 'N/A')       AS customer_phone,
        o.phone,
        o.total_amount
      FROM payments p
      LEFT JOIN orders o  ON p.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id  = u.id
      WHERE p.refund_requested = 1
      ORDER BY p.created_at DESC
    `);

    const pending  = rows.filter(r => r.refund_status === 'pending');
    const history  = rows;

    res.json({
      success: true,
      data: {
        pending_count: pending.length,
        pending:       pending.map(normaliseTransaction),
        history:       history.map(normaliseTransaction),
      },
    });
  } catch (error) {
    handleError(res, 'refunds', error);
  }
});

// ─── GET /alerts ──────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const alerts = [];

    // Failed payments today
    const [[failedRow]] = await db.query(`
      SELECT COUNT(*) AS cnt FROM payments
      WHERE DATE(created_at) = CURDATE() AND status = 'failed'
    `);
    if (failedRow.cnt > 0) {
      alerts.push({
        id: 'failed-today',
        message: `${failedRow.cnt} payment${failedRow.cnt > 1 ? 's' : ''} failed today — review the Failed tab`,
        type: 'warn',
      });
    }

    // Pending refunds
    const [[refundRow]] = await db.query(`
      SELECT COUNT(*) AS cnt FROM payments
      WHERE refund_requested = 1 AND refund_status = 'pending'
    `);
    if (refundRow.cnt > 0) {
      alerts.push({
        id: 'refund-pending',
        message: `${refundRow.cnt} refund request${refundRow.cnt > 1 ? 's' : ''} awaiting your approval`,
        type: 'warn',
      });
    }

    // Large payment (above 10 000 MWK) received today
    const [largeRows] = await db.query(`
      SELECT p.amount, COALESCE(u.fullname,'Guest') AS name
      FROM payments p
      LEFT JOIN orders o  ON p.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id  = u.id
      WHERE DATE(p.created_at) = CURDATE() AND p.status = 'successful' AND p.amount >= 10000
      ORDER BY p.amount DESC LIMIT 1
    `);
    if (largeRows.length > 0) {
      alerts.push({
        id: 'large-payment',
        message: `Large payment received — MWK ${parseFloat(largeRows[0].amount).toLocaleString()} from ${largeRows[0].name}`,
        type: 'info',
      });
    }

    // Latest refund approved
    const [approvedRows] = await db.query(`
      SELECT p.amount, COALESCE(u.fullname,'Guest') AS name
      FROM payments p
      LEFT JOIN orders o  ON p.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id  = u.id
      WHERE p.refund_status = 'approved' AND DATE(p.created_at) = CURDATE()
      ORDER BY p.created_at DESC LIMIT 1
    `);
    if (approvedRows.length > 0) {
      alerts.push({
        id: 'refund-approved',
        message: `Refund approved — MWK ${parseFloat(approvedRows[0].amount).toLocaleString()} returned to ${approvedRows[0].name}`,
        type: 'success',
      });
    }

    res.json({ success: true, data: alerts });
  } catch (error) {
    handleError(res, 'alerts', error);
  }
});

// ─── GET /export ──────────────────────────────────────────────────────────────
// Returns CSV. Query: ?format=csv&date=today|all|YYYY-MM-DD
router.get('/export', async (req, res) => {
  const { date = 'today' } = req.query;

  try {
    let dateWhere = '';
    const params  = [];
    if (date === 'today') {
      dateWhere = 'WHERE DATE(p.created_at) = CURDATE()';
    } else if (date !== 'all') {
      dateWhere = 'WHERE DATE(p.created_at) = ?';
      params.push(date);
    }

    const [rows] = await db.query(`
      SELECT
        p.tx_ref        AS reference,
        o.order_id,
        COALESCE(u.fullname, 'Guest')          AS customer,
        COALESCE(u.contactnumber, o.phone, '') AS phone,
        p.amount,
        p.method,
        p.status,
        p.created_at
      FROM payments p
      LEFT JOIN orders o  ON p.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id  = u.id
      ${dateWhere}
      ORDER BY p.created_at DESC
    `, params);

    const headers = ['Reference', 'Order ID', 'Customer', 'Phone', 'Amount (MWK)', 'Method', 'Status', 'Date & Time'];
    const csvRows = rows.map(r => [
      r.reference ?? '',
      r.order_id  ?? '',
      (r.customer ?? '').replace(/,/g, ' '),
      r.phone     ?? '',
      r.amount    ?? 0,
      r.method    ?? '',
      r.status    ?? '',
      r.created_at ? new Date(r.created_at).toISOString() : '',
    ].join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${date}.csv"`);
    res.send(csv);
  } catch (error) {
    handleError(res, 'export', error);
  }
});

module.exports = router;