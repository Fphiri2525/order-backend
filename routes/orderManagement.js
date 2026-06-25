const express = require('express');
const db = require('../database');

const router = express.Router();

// ─── Helper ───────────────────────────────────────────────────────────────────
function handleError(res, section, error) {
  console.error(`\n❌ [${section}]`, error.message);
  res.status(500).json({ success: false, message: `Failed: ${section}`, error: error.message });
}

// ================================
// 📋 1. GET ALL ORDERS (with filters)
// GET /api/order-management/orders
// Query: ?status=pending&search=chisomo&limit=50
// ================================
router.get('/orders', async (req, res) => {
  const { status, search, limit = 100 } = req.query;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    whereClause += ' AND o.status = ?';
    params.push(status);
  }

  if (search) {
    whereClause += ' AND (o.order_id LIKE ? OR u.fullname LIKE ? OR o.phone LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  params.push(parseInt(limit));

  try {
    const [orders] = await db.query(`
      SELECT
        o.order_id,
        o.user_id,
        COALESCE(u.fullname, 'Guest')                     AS customer_name,
        COALESCE(u.contactnumber, o.phone, 'N/A')         AS phone,
        o.total_amount,
        o.status,
        o.order_type,
        o.tx_ref,
        d.location AS address,
        o.created_at,
        p.status                        AS payment_status,
        p.method                        AS payment_method,
        p.amount                        AS payment_amount,
        CASE
          WHEN TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) < 5
            AND o.status = 'pending'                      THEN 'new'
          WHEN TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) > 15
            AND o.status = 'pending'                      THEN 'urgent'
          WHEN o.total_amount >= 10000                    THEN 'high_value'
          ELSE NULL
        END                             AS priority,
        TIMESTAMPDIFF(MINUTE, o.created_at, NOW())        AS elapsed_min
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      LEFT JOIN payments p ON o.order_id = p.order_id
      LEFT JOIN deliveries d ON o.order_id = d.order_id
      ${whereClause}
      ORDER BY
        FIELD(o.status, 'pending', 'accepted', 'preparing', 'ready', 'delivered', 'cancelled'),
        o.created_at DESC
      LIMIT ?
    `, params);

    const orderIds = orders.map(o => o.order_id);
    let itemsMap = {};

    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const [items] = await db.query(`
        SELECT
          oi.order_id,
          oi.id,
          oi.quantity,
          oi.price,
          COALESCE(m.name, 'Food Item') AS item_name,
          m.category
        FROM order_items oi
        LEFT JOIN menu_items m ON oi.menu_id = m.id
        WHERE oi.order_id IN (${placeholders})
      `, orderIds);

      items.forEach(item => {
        if (!itemsMap[item.order_id]) itemsMap[item.order_id] = [];
        itemsMap[item.order_id].push({
          name:     item.item_name,
          qty:      item.quantity,
          price:    parseFloat(item.price),
          category: item.category,
        });
      });
    }

    const result = orders.map(o => ({
      id:             o.order_id,
      customer:       o.customer_name,
      phone:          o.phone,
      items:          itemsMap[o.order_id] || [],
      total:          parseFloat(o.total_amount),
      status:         o.status,
      paymentMethod:  normalisePaymentMethod(o.payment_method),
      paymentStatus:  normalisePaymentStatus(o.payment_status),
      deliveryType:   o.order_type === 'pickup' ? 'pickup' : 'delivery',
      time:           formatTime(o.created_at),
      estPrepTime:    estimatePrepTime(itemsMap[o.order_id] || []),
      elapsedMin:     o.elapsed_min || 0,
      priority:       o.priority,
      address:        o.address || null,
      created_at:     o.created_at,
    }));

    res.json({ success: true, count: result.length, data: result });
  } catch (error) {
    handleError(res, 'GET /orders', error);
  }
});

// ================================
// 🔄 2. UPDATE ORDER STATUS
// PATCH /api/order-management/orders/:order_id/status
// ================================
router.patch('/orders/:order_id/status', async (req, res) => {
  const { order_id } = req.params;
  const { status } = req.body;

  const allowed = ['pending', 'accepted', 'preparing', 'ready', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${allowed.join(', ')}`,
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE orders SET status = ? WHERE order_id = ?`,
      [status, order_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (status === 'cancelled') {
      await db.query(
        `UPDATE payments SET status = 'failed' WHERE order_id = ? AND status = 'pending'`,
        [order_id]
      );
    }

    console.log(`✅ Order ${order_id} → ${status}`);
    res.json({ success: true, message: `Order ${order_id} updated to '${status}'`, order_id, status });
  } catch (error) {
    handleError(res, 'PATCH /orders/status', error);
  }
});

// ================================
// 🚗 3. GET ALL DELIVERY RIDERS
// GET /api/order-management/drivers
// ================================
router.get('/drivers', async (req, res) => {
  try {
    // Get unique riders from deliveries table
    const [rows] = await db.query(`
      SELECT
        d.id AS delivery_id,
        d.rider_name AS name,
        d.rider_phone AS phone,
        d.status AS current_status,
        d.location AS current_location,
        COUNT(DISTINCT o.order_id) AS active_orders,
        MAX(d.scheduled_date) AS last_delivery_date
      FROM deliveries d
      LEFT JOIN orders o ON d.order_id = o.order_id 
        AND o.status NOT IN ('delivered', 'cancelled')
      WHERE d.rider_name IS NOT NULL AND d.rider_name != ''
      GROUP BY d.rider_name, d.rider_phone
      ORDER BY d.status ASC, d.scheduled_date DESC
    `);

    // Transform to match expected driver format
    const drivers = rows.map(row => ({
      id: row.delivery_id,
      name: row.name,
      phone: row.phone || 'N/A',
      vehicle: 'Motorcycle', // Default vehicle type
      status: row.current_status || 'available',
      rating: 4.5, // Default rating since we don't have ratings table
      active_orders: row.active_orders || 0,
      current_location: row.current_location || 'Unknown',
      last_delivery: row.last_delivery_date
    }));

    res.json({ 
      success: true, 
      count: drivers.length, 
      data: drivers,
      note: 'Driver data sourced from deliveries table (no drivers table exists)'
    });
  } catch (error) {
    console.warn('⚠️  Error fetching riders from deliveries table:', error.message);
    res.json({ 
      success: true, 
      count: 0, 
      data: [], 
      note: 'No delivery riders available' 
    });
  }
});

// ================================
// 🚗 4. ASSIGN RIDER TO ORDER
// PATCH /api/order-management/orders/:order_id/assign-driver
// ================================
router.patch('/orders/:order_id/assign-driver', async (req, res) => {
  const { order_id } = req.params;
  const { driver_id } = req.body;

  if (!driver_id) {
    return res.status(400).json({ success: false, message: 'driver_id is required' });
  }

  try {
    // First check if order exists
    const [orderCheck] = await db.query(
      `SELECT * FROM orders WHERE order_id = ?`,
      [order_id]
    );

    if (orderCheck.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Check if order already has a delivery record
    const [deliveryCheck] = await db.query(
      `SELECT * FROM deliveries WHERE order_id = ?`,
      [order_id]
    );

    if (deliveryCheck.length === 0) {
      // Create new delivery record
      await db.query(
        `INSERT INTO deliveries (order_id, rider_name, status, scheduled_date) 
         VALUES (?, ?, 'assigned', CURDATE())`,
        [order_id, driver_id]
      );
    } else {
      // Update existing delivery record
      await db.query(
        `UPDATE deliveries SET rider_name = ?, status = 'assigned' WHERE order_id = ?`,
        [driver_id, order_id]
      );
    }

    // Update order status if it's still pending
    const order = orderCheck[0];
    if (order.status === 'pending' || order.status === 'accepted') {
      await db.query(
        `UPDATE orders SET status = 'accepted' WHERE order_id = ?`,
        [order_id]
      );
    }

    // Get the rider info
    const [riderInfo] = await db.query(
      `SELECT id, rider_name AS name, rider_phone AS phone, status, location 
       FROM deliveries 
       WHERE order_id = ? AND rider_name = ?`,
      [order_id, driver_id]
    );

    res.json({
      success: true,
      message: 'Rider assigned successfully',
      order_id,
      driver: riderInfo[0] ? {
        id: riderInfo[0].id,
        name: riderInfo[0].name,
        phone: riderInfo[0].phone || 'N/A',
        status: riderInfo[0].status || 'assigned',
        location: riderInfo[0].location || 'Unknown'
      } : { id: driver_id, name: driver_id },
      note: 'Assignment stored in deliveries table'
    });
  } catch (error) {
    handleError(res, 'PATCH /assign-driver', error);
  }
});

// ================================
// 📊 5. ORDERS PER HOUR (today)
// GET /api/order-management/analytics/hourly
// ================================
router.get('/analytics/hourly', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        HOUR(created_at)               AS hour,
        COUNT(*)                       AS order_count,
        COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE DATE(created_at) = CURDATE()
      GROUP BY HOUR(created_at)
      ORDER BY hour ASC
    `);

    const hours = Array.from({ length: 16 }, (_, i) => i + 7);
    const hourMap = {};
    rows.forEach(r => { hourMap[r.hour] = r; });

    const data = hours.map(h => ({
      hour:        h,
      label:       String(h),
      order_count: hourMap[h]?.order_count  || 0,
      revenue:     parseFloat(hourMap[h]?.revenue || 0),
    }));

    const peakHour = data.reduce((a, b) => b.order_count > a.order_count ? b : a, data[0]);

    res.json({
      success: true,
      data: {
        hours:       data,
        peak_hour:   peakHour.hour,
        peak_label:  `${peakHour.hour}:00–${peakHour.hour + 1}:00`,
        peak_orders: peakHour.order_count,
      },
    });
  } catch (error) {
    handleError(res, 'analytics/hourly', error);
  }
});

// ================================
// 📊 6. PAYMENT METHOD BREAKDOWN (today)
// GET /api/order-management/analytics/payments
// ================================
router.get('/analytics/payments', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        COALESCE(p.method, 'unknown') AS method,
        COUNT(*)                      AS count,
        COALESCE(SUM(p.amount), 0)    AS total_amount
      FROM payments p
      JOIN orders o ON p.order_id = o.order_id
      WHERE DATE(o.created_at) = CURDATE()
        AND p.status = 'successful'
      GROUP BY p.method
      ORDER BY total_amount DESC
    `);

    const total = rows.reduce((s, r) => s + Number(r.count), 0) || 1;

    res.json({
      success: true,
      data: rows.map(r => ({
        method:       normalisePaymentMethod(r.method),
        raw_method:   r.method,
        count:        r.count,
        total_amount: parseFloat(r.total_amount),
        percentage:   Math.round((r.count / total) * 100),
      })),
    });
  } catch (error) {
    handleError(res, 'analytics/payments', error);
  }
});

// ================================
// 📊 7. TODAY STATS
// GET /api/order-management/analytics/today
// ================================
router.get('/analytics/today', async (req, res) => {
  try {
    const [[counts]] = await db.query(`
      SELECT
        COUNT(*)                                                         AS total,
        SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END)           AS pending,
        SUM(CASE WHEN status = 'accepted'  THEN 1 ELSE 0 END)           AS accepted,
        SUM(CASE WHEN status = 'preparing' THEN 1 ELSE 0 END)           AS preparing,
        SUM(CASE WHEN status = 'ready'     THEN 1 ELSE 0 END)           AS ready,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END)           AS delivered,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)           AS cancelled,
        COALESCE(SUM(
          CASE WHEN status IN ('delivered','ready','preparing','accepted','paid')
          THEN total_amount ELSE 0 END
        ), 0)                                                            AS revenue
      FROM orders
      WHERE DATE(created_at) = CURDATE()
    `);

    const [[yesterday]] = await db.query(`
      SELECT
        COUNT(*)                                              AS total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        COALESCE(SUM(
          CASE WHEN status IN ('delivered','ready','preparing','accepted','paid')
          THEN total_amount ELSE 0 END
        ), 0)                                                 AS revenue
      FROM orders
      WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    `);

    const [[topMeal]] = await db.query(`
      SELECT COALESCE(m.name, 'Unknown') AS name, SUM(oi.quantity) AS qty
      FROM order_items oi
      LEFT JOIN menu_items m ON oi.menu_id = m.id
      JOIN orders o ON oi.order_id = o.order_id
        AND DATE(o.created_at) = CURDATE()
        AND o.status NOT IN ('cancelled')
      GROUP BY m.id
      ORDER BY qty DESC
      LIMIT 1
    `);

    const [[overdue]] = await db.query(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status = 'pending'
        AND TIMESTAMPDIFF(MINUTE, created_at, NOW()) > 10
        AND DATE(created_at) = CURDATE()
    `);

    const revenue  = parseFloat(counts.revenue);
    const yRevenue = parseFloat(yesterday.revenue);
    const revTrend = yRevenue > 0 ? Math.round(((revenue - yRevenue) / yRevenue) * 100) : 0;
    const avgValue = counts.delivered > 0 ? Math.round(revenue / counts.delivered) : 0;

    res.json({
      success: true,
      data: {
        total:           counts.total     || 0,
        pending:         counts.pending   || 0,
        accepted:        counts.accepted  || 0,
        preparing:       counts.preparing || 0,
        ready:           counts.ready     || 0,
        delivered:       counts.delivered || 0,
        cancelled:       counts.cancelled || 0,
        revenue,
        avg_order_value: avgValue,
        top_meal:        topMeal?.name || null,
        top_meal_qty:    topMeal?.qty  || 0,
        pending_overdue: overdue.count || 0,
        trends: {
          total_vs_yesterday: yesterday.total > 0
            ? Math.round(((counts.total - yesterday.total) / yesterday.total) * 100) : 0,
          revenue_vs_yesterday:  revTrend,
          delivered_vs_yesterday: yesterday.delivered > 0
            ? Math.round(((counts.delivered - yesterday.delivered) / yesterday.delivered) * 100) : 0,
        },
      },
    });
  } catch (error) {
    handleError(res, 'analytics/today', error);
  }
});

// ================================
// 📊 8. TOP MEALS TODAY
// GET /api/order-management/analytics/top-meals
// ================================
router.get('/analytics/top-meals', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        COALESCE(m.name, 'Unknown Item')         AS name,
        m.category,
        SUM(oi.quantity)                         AS total_qty,
        COUNT(DISTINCT oi.order_id)              AS order_count,
        COALESCE(SUM(oi.quantity * oi.price), 0) AS revenue
      FROM order_items oi
      LEFT JOIN menu_items m ON oi.menu_id = m.id
      JOIN orders o ON oi.order_id = o.order_id
        AND DATE(o.created_at) = CURDATE()
        AND o.status NOT IN ('cancelled')
      GROUP BY m.id, m.name, m.category
      ORDER BY total_qty DESC
      LIMIT 10
    `);

    const maxQty = rows.length > 0 ? rows[0].total_qty : 1;

    res.json({
      success: true,
      data: rows.map((r, i) => ({
        rank:        i + 1,
        name:        r.name,
        category:    r.category || 'General',
        count:       r.total_qty,
        order_count: r.order_count,
        revenue:     parseFloat(r.revenue),
        pct:         Math.round((r.total_qty / maxQty) * 100),
      })),
    });
  } catch (error) {
    handleError(res, 'analytics/top-meals', error);
  }
});

// ================================
// 🍳 9. KITCHEN QUEUE
// GET /api/order-management/kitchen
// ================================
router.get('/kitchen', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        o.order_id,
        COALESCE(u.fullname, 'Guest')                     AS customer_name,
        o.status,
        o.order_type,
        o.created_at,
        TIMESTAMPDIFF(MINUTE, o.created_at, NOW())        AS elapsed_min
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE o.status IN ('accepted', 'preparing', 'ready')
        AND DATE(o.created_at) = CURDATE()
      ORDER BY
        FIELD(o.status, 'preparing', 'accepted', 'ready'),
        o.created_at ASC
    `);

    const orderIds = rows.map(r => r.order_id);
    let itemsMap = {};

    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const [items] = await db.query(`
        SELECT oi.order_id, oi.quantity,
               COALESCE(m.name, 'Food Item') AS item_name
        FROM order_items oi
        LEFT JOIN menu_items m ON oi.menu_id = m.id
        WHERE oi.order_id IN (${placeholders})
      `, orderIds);
      items.forEach(item => {
        if (!itemsMap[item.order_id]) itemsMap[item.order_id] = [];
        itemsMap[item.order_id].push({ name: item.item_name, qty: item.quantity });
      });
    }

    const cooking = rows.filter(r => r.status !== 'ready');
    const ready   = rows.filter(r => r.status === 'ready');

    const mapOrder = (o) => ({
      id:           o.order_id,
      customer:     o.customer_name,
      status:       o.status,
      deliveryType: o.order_type === 'pickup' ? 'pickup' : 'delivery',
      items:        itemsMap[o.order_id] || [],
      elapsedMin:   o.elapsed_min || 0,
      estPrepTime:  estimatePrepTime(itemsMap[o.order_id] || []),
      created_at:   o.created_at,
    });

    res.json({
      success: true,
      data: {
        cooking_queue: cooking.map(mapOrder),
        ready_queue:   ready.map(mapOrder),
        overdue_count: cooking.filter(o =>
          o.elapsed_min > estimatePrepTime(itemsMap[o.order_id] || [])
        ).length,
        active_count:  cooking.length,
      },
    });
  } catch (error) {
    handleError(res, 'kitchen', error);
  }
});

// ================================
// ⚠️ 10. SMART ALERTS
// GET /api/order-management/alerts
// ================================
router.get('/alerts', async (req, res) => {
  try {
    const alerts = [];

    const [overduePending] = await db.query(`
      SELECT o.order_id, COALESCE(u.fullname, 'Guest') AS customer,
             TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) AS mins
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE o.status = 'pending'
        AND TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) > 10
        AND DATE(o.created_at) = CURDATE()
      ORDER BY mins DESC
      LIMIT 3
    `);
    overduePending.forEach(o => {
      alerts.push({
        id:      `overdue-${o.order_id}`,
        message: `Order #${o.order_id} has been pending for ${o.mins} min — needs attention`,
        type:    'warn',
      });
    });

    const [overduePrep] = await db.query(`
      SELECT o.order_id,
             TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) AS elapsed
      FROM orders o
      WHERE o.status = 'preparing'
        AND TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) > 25
        AND DATE(o.created_at) = CURDATE()
      LIMIT 2
    `);
    overduePrep.forEach(o => {
      alerts.push({
        id:      `prep-overdue-${o.order_id}`,
        message: `Order #${o.order_id} has been preparing for ${o.elapsed} min — check kitchen`,
        type:    'warn',
      });
    });

    const [[failedPayments]] = await db.query(`
      SELECT COUNT(*) AS count
      FROM payments p
      JOIN orders o ON p.order_id = o.order_id
      WHERE p.status = 'failed'
        AND DATE(o.created_at) = CURDATE()
    `);
    if (failedPayments.count > 0) {
      alerts.push({
        id:      'failed-payments',
        message: `${failedPayments.count} failed payment(s) today — follow up with customers`,
        type:    'warn',
      });
    }

    const [[newOrders]] = await db.query(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE created_at >= NOW() - INTERVAL 5 MINUTE
    `);
    if (newOrders.count >= 3) {
      alerts.push({
        id:      'new-orders-burst',
        message: `${newOrders.count} new orders received in the last 5 minutes — kitchen alert`,
        type:    'info',
      });
    }

    // Check for deliveries without assigned rider (using deliveries table)
    const [[unassigned]] = await db.query(`
      SELECT COUNT(*) AS count
      FROM orders o
      WHERE o.order_type = 'delivery'
        AND o.status IN ('accepted', 'preparing', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM deliveries d 
          WHERE d.order_id = o.order_id 
          AND d.rider_name IS NOT NULL 
          AND d.rider_name != ''
        )
        AND DATE(o.created_at) = CURDATE()
    `);

    if (unassigned.count > 0) {
      alerts.push({
        id:      'unassigned-drivers',
        message: `${unassigned.count} delivery order(s) have no rider assigned`,
        type:    'warn',
      });
    }

    res.json({ success: true, count: alerts.length, data: alerts });
  } catch (error) {
    handleError(res, 'alerts', error);
  }
});

// ================================
// 🎫 11. VERIFY QR & MARK COLLECTED
// POST /api/order-management/orders/:order_id/verify-qr
// ================================
router.post('/orders/:order_id/verify-qr', async (req, res) => {
  const { order_id } = req.params;

  try {
    const [orders] = await db.query(
      `SELECT * FROM orders WHERE order_id = ?`, [order_id]
    );
    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = orders[0];
    if (order.status !== 'ready') {
      return res.status(400).json({
        success: false,
        message: `Order must be 'ready' to verify pickup. Current status: ${order.status}`,
      });
    }

    await db.query(
      `UPDATE orders SET status = 'delivered' WHERE order_id = ?`,
      [order_id]
    );

    // Update delivery record if it exists
    await db.query(
      `UPDATE deliveries SET status = 'delivered' WHERE order_id = ?`,
      [order_id]
    ).catch(() => {});

    // Update ticket if it exists
    await db.query(
      `UPDATE tickets SET status = 'used' WHERE order_id = ?`,
      [order_id]
    ).catch(() => {});

    res.json({
      success: true,
      message: 'QR verified — order marked as collected',
      order_id,
      status: 'delivered',
    });
  } catch (error) {
    handleError(res, 'verify-qr', error);
  }
});

// ─── Pure-JS helpers ─────────────────────────────────────────────────────────
function estimatePrepTime(items) {
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  if (totalQty <= 2)  return 10;
  if (totalQty <= 5)  return 15;
  if (totalQty <= 10) return 20;
  return 25;
}

function normalisePaymentMethod(method) {
  const map = {
    airtel_money: 'Airtel Money',
    airtel:       'Airtel Money',
    mpamba:       'TNM Mpamba',
    tnm:          'TNM Mpamba',
    mobile_money: 'Airtel Money',
    cash:         'Cash',
    card:         'Card',
  };
  return method ? (map[method.toLowerCase()] ?? method) : 'Cash';
}

function normalisePaymentStatus(status) {
  if (status === 'successful') return 'paid';
  if (status === 'failed')     return 'failed';
  return 'unpaid';
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

module.exports = router;