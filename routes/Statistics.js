const express = require('express');
const db = require('../database');

const router = express.Router();

// ================================
// 🛠️ HELPER: Standard Error Response
// ================================
function handleError(res, section, error) {
  const timestamp = new Date().toISOString();
  console.error(`\n[${timestamp}] ❌ [${section}] ${error.message}`);
  res.status(500).json({ success: false, message: `Failed to fetch ${section}`, error: error.message });
}

// Helper: get Monday of current week (YYYY-MM-DD)
function getWeekStart() {
  const now  = new Date();
  const day  = now.getDay() || 7;
  const diff = now.getDate() - day + 1;
  return new Date(now.setDate(diff)).toISOString().split('T')[0];
}

// ================================
// 📦 1. TOTAL ORDERS FOR TODAY
// GET /api/statistics/orders/today
// ================================
router.get('/orders/today', async (req, res) => {
  try {
    const [[result]] = await db.query(`
      SELECT
        COUNT(*)                                        AS total_orders,
        SUM(CASE WHEN status = 'paid'      THEN 1 ELSE 0 END) AS paid_orders,
        SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending_orders,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_orders,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed_orders,
        SUM(CASE WHEN status = 'preparing' THEN 1 ELSE 0 END) AS preparing_orders
      FROM orders
      WHERE DATE(created_at) = CURDATE()
    `);

    res.json({
      success: true,
      date: new Date().toISOString().split('T')[0],
      data: {
        total_orders:     result.total_orders     || 0,
        paid_orders:      result.paid_orders      || 0,
        pending_orders:   result.pending_orders   || 0,
        delivered_orders: result.delivered_orders || 0,
        failed_orders:    result.failed_orders    || 0,
        preparing_orders: result.preparing_orders || 0,
      },
    });
  } catch (error) {
    handleError(res, 'orders/today', error);
  }
});

// ================================
// 💰 2. TOTAL REVENUE
// GET /api/statistics/revenue
// ================================
router.get('/revenue', async (req, res) => {
  try {
    const [[allTime]] = await db.query(`
      SELECT
        COALESCE(SUM(total_amount), 0) AS total_revenue,
        COUNT(*) AS total_orders
      FROM orders
      WHERE status IN ('paid', 'preparing', 'delivered')
    `);

    const [[today]] = await db.query(`
      SELECT
        COALESCE(SUM(total_amount), 0) AS todays_revenue,
        COUNT(*) AS todays_orders
      FROM orders
      WHERE status IN ('paid', 'preparing', 'delivered')
        AND DATE(created_at) = CURDATE()
    `);

    const [[thisMonth]] = await db.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS monthly_revenue
      FROM orders
      WHERE status IN ('paid', 'preparing', 'delivered')
        AND MONTH(created_at) = MONTH(CURDATE())
        AND YEAR(created_at)  = YEAR(CURDATE())
    `);

    res.json({
      success: true,
      data: {
        all_time: {
          revenue: parseFloat(allTime.total_revenue),
          orders:  allTime.total_orders,
        },
        today: {
          revenue: parseFloat(today.todays_revenue),
          orders:  today.todays_orders,
        },
        this_month: {
          revenue: parseFloat(thisMonth.monthly_revenue),
        },
      },
    });
  } catch (error) {
    handleError(res, 'revenue', error);
  }
});

// ================================
// ⏳ 3. PENDING ORDERS FOR TODAY
// GET /api/statistics/orders/pending
// ================================
router.get('/orders/pending', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        o.order_id,
        o.total_amount,
        o.order_type,
        o.created_at,
        COALESCE(u.fullname, 'Guest') AS customer_name,
        COALESCE(u.contactnumber, o.phone, 'N/A') AS phone
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE o.status = 'pending'
        AND DATE(o.created_at) = CURDATE()
      ORDER BY o.created_at ASC
    `);

    res.json({
      success: true,
      date: new Date().toISOString().split('T')[0],
      data: {
        count:  rows.length,
        orders: rows,
      },
    });
  } catch (error) {
    handleError(res, 'orders/pending', error);
  }
});

// ================================
// ✅ 4. DELIVERED ORDERS
// GET /api/statistics/orders/delivered
// ================================
router.get('/orders/delivered', async (req, res) => {
  const dateFilter = req.query.date === 'all' ? '' : 'AND DATE(o.created_at) = CURDATE()';

  try {
    const [rows] = await db.query(`
      SELECT
        o.order_id,
        o.total_amount,
        o.order_type,
        o.created_at,
        COALESCE(u.fullname, 'Guest') AS customer_name,
        COALESCE(u.contactnumber, o.phone, 'N/A') AS phone
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE o.status = 'delivered'
      ${dateFilter}
      ORDER BY o.created_at DESC
    `);

    const [[totals]] = await db.query(`
      SELECT
        COUNT(*)                        AS total_delivered,
        COALESCE(SUM(total_amount), 0)  AS total_value
      FROM orders
      WHERE status = 'delivered'
      ${dateFilter}
    `);

    res.json({
      success: true,
      scope: req.query.date === 'all' ? 'all_time' : 'today',
      data: {
        count:       totals.total_delivered || 0,
        total_value: parseFloat(totals.total_value),
        orders:      rows,
      },
    });
  } catch (error) {
    handleError(res, 'orders/delivered', error);
  }
});

// ================================
// 📅 5. WEEKLY SALES BREAKDOWN
// GET /api/statistics/sales/weekly
// ================================
router.get('/sales/weekly', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        DAYNAME(o.created_at)                   AS day_name,
        DAYOFWEEK(o.created_at)                 AS day_number,
        DATE(o.created_at)                      AS date,
        COUNT(DISTINCT o.order_id)              AS total_orders,
        COALESCE(SUM(o.total_amount), 0)        AS total_revenue
      FROM orders o
      WHERE YEARWEEK(o.created_at, 1) = YEARWEEK(CURDATE(), 1)
        AND o.status IN ('paid', 'preparing', 'delivered')
      GROUP BY DAYNAME(o.created_at), DAYOFWEEK(o.created_at), DATE(o.created_at)
      ORDER BY DAYOFWEEK(o.created_at)
    `);

    const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const salesMap = {};
    rows.forEach(r => { salesMap[r.day_name] = r; });

    const weekData = days.map(day => ({
      day,
      date:          salesMap[day]?.date         || null,
      total_orders:  salesMap[day]?.total_orders  || 0,
      total_revenue: parseFloat(salesMap[day]?.total_revenue || 0),
    }));

    const totalWeekRevenue = weekData.reduce((sum, d) => sum + d.total_revenue, 0);

    res.json({
      success: true,
      week_start: getWeekStart(),
      data: {
        days:               weekData,
        total_week_revenue: totalWeekRevenue,
        total_week_orders:  weekData.reduce((s, d) => s + d.total_orders, 0),
        best_day:           weekData.reduce((a, b) => b.total_revenue > a.total_revenue ? b : a, weekData[0]),
      },
    });
  } catch (error) {
    handleError(res, 'sales/weekly', error);
  }
});

// ================================
// 🍽️ 6. MENU ITEM ORDER FREQUENCY
// GET /api/statistics/menu/popularity
// ================================
router.get('/menu/popularity', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        m.id                              AS menu_id,
        COALESCE(m.name, 'Unknown Item') AS menu_name,
        m.category,
        m.price,
        COUNT(oi.id)                      AS times_ordered,
        SUM(oi.quantity)                  AS total_quantity_sold,
        COALESCE(SUM(oi.quantity * oi.price), 0) AS total_revenue_generated
      FROM order_items oi
      LEFT JOIN menu_items m ON oi.menu_id = m.id
      JOIN orders o ON oi.order_id = o.order_id
        AND o.status IN ('paid', 'preparing', 'delivered')
      GROUP BY m.id, m.name, m.category, m.price
      ORDER BY times_ordered DESC
    `);

    res.json({
      success: true,
      data: {
        total_menu_items: rows.length,
        items: rows.map((r, index) => ({
          rank:                    index + 1,
          menu_id:                 r.menu_id,
          menu_name:               r.menu_name,
          category:                r.category,
          price:                   parseFloat(r.price),
          times_ordered:           r.times_ordered,
          total_quantity_sold:     r.total_quantity_sold,
          total_revenue_generated: parseFloat(r.total_revenue_generated),
        })),
      },
    });
  } catch (error) {
    handleError(res, 'menu/popularity', error);
  }
});

// ================================
// 📡 7. TOTAL TRANSACTIONS BY PAYMENT METHOD
// GET /api/statistics/transactions
// ================================
router.get('/transactions', async (req, res) => {
  try {
    const [byMethod] = await db.query(`
      SELECT
        COALESCE(method, 'unknown')   AS payment_method,
        COUNT(*)                      AS transaction_count,
        COALESCE(SUM(amount), 0)      AS total_amount,
        SUM(CASE WHEN status = 'successful' THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) AS failed
      FROM payments
      GROUP BY method
      ORDER BY total_amount DESC
    `);

    const [[overall]] = await db.query(`
      SELECT
        COUNT(*)                      AS total_transactions,
        COALESCE(SUM(amount), 0)      AS total_processed,
        SUM(CASE WHEN status = 'successful' THEN amount ELSE 0 END) AS total_successful_amount,
        SUM(CASE WHEN status = 'successful' THEN 1 ELSE 0 END)      AS total_successful_count,
        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END)      AS total_failed_count
      FROM payments
    `);

    res.json({
      success: true,
      data: {
        overall: {
          total_transactions: overall.total_transactions,
          total_processed:    parseFloat(overall.total_processed),
          successful_amount:  parseFloat(overall.total_successful_amount),
          successful_count:   overall.total_successful_count,
          failed_count:       overall.total_failed_count,
          success_rate:       overall.total_transactions > 0
            ? ((overall.total_successful_count / overall.total_transactions) * 100).toFixed(1) + '%'
            : '0%',
        },
        by_method: byMethod.map(m => ({
          payment_method:    m.payment_method,
          transaction_count: m.transaction_count,
          total_amount:      parseFloat(m.total_amount),
          successful:        m.successful,
          pending:           m.pending,
          failed:            m.failed,
        })),
      },
    });
  } catch (error) {
    handleError(res, 'transactions', error);
  }
});

// ================================
// 👑 8. TOP CUSTOMERS BY ORDER COUNT
// GET /api/statistics/customers/top
// ================================
router.get('/customers/top', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;

  try {
    const [rows] = await db.query(`
      SELECT
        u.id                                                AS user_id,
        COALESCE(u.fullname, 'Guest')                       AS customer_name,
        COALESCE(u.contactnumber, o.phone, 'N/A')           AS phone,
        u.emailaddress                                      AS email,
        COUNT(DISTINCT o.order_id)                          AS total_orders,
        COALESCE(SUM(
          CASE WHEN o.status IN ('paid','preparing','delivered')
          THEN o.total_amount ELSE 0 END
        ), 0)                                               AS total_spent,
        COALESCE(SUM(
          CASE WHEN o.status IN ('paid','preparing','delivered')
          THEN o.total_amount ELSE 0 END
        ) / NULLIF(COUNT(DISTINCT o.order_id), 0), 0)       AS average_order_value,
        MAX(o.created_at)                                   AS last_order_date,
        MIN(o.created_at)                                   AS first_order_date
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE o.status IN ('paid', 'preparing', 'delivered')
      GROUP BY u.id, u.fullname, u.contactnumber, u.emailaddress
      ORDER BY total_orders DESC, total_spent DESC
      LIMIT ?
    `, [limit]);

    res.json({
      success: true,
      data: {
        total_customers_shown: rows.length,
        top_customers: rows.map((c, index) => ({
          rank:                index + 1,
          customer_name:       c.customer_name,
          phone:               c.phone,
          email:               c.email || 'N/A',
          total_orders:        c.total_orders,
          total_spent:         `MWK ${parseFloat(c.total_spent).toLocaleString()}`,
          total_spent_raw:     parseFloat(c.total_spent),
          average_order_value: `MWK ${parseFloat(c.average_order_value).toLocaleString()}`,
          last_order_date:     c.last_order_date,
          first_order_date:    c.first_order_date,
        })),
      },
    });
  } catch (error) {
    handleError(res, 'customers/top', error);
  }
});

// ================================
// 📊 9. FULL DASHBOARD SUMMARY
// GET /api/statistics/dashboard
// ================================
router.get('/dashboard', async (req, res) => {
  try {
    const [[ordersToday]] = await db.query(`
      SELECT
        COUNT(*)                                               AS total,
        SUM(CASE WHEN status = 'paid'      THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'preparing' THEN 1 ELSE 0 END) AS preparing
      FROM orders
      WHERE DATE(created_at) = CURDATE()
    `);

    const [[revenue]] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE()
          AND status IN ('paid', 'preparing', 'delivered')
          THEN total_amount ELSE 0 END), 0)                   AS today,
        COALESCE(SUM(CASE WHEN MONTH(created_at) = MONTH(CURDATE())
          AND YEAR(created_at) = YEAR(CURDATE())
          AND status IN ('paid', 'preparing', 'delivered')
          THEN total_amount ELSE 0 END), 0)                   AS this_month,
        COALESCE(SUM(CASE WHEN status IN ('paid', 'preparing', 'delivered')
          THEN total_amount ELSE 0 END), 0)                   AS all_time
      FROM orders
    `);

    const [[topItem]] = await db.query(`
      SELECT COALESCE(m.name, 'Unknown') AS name, COUNT(oi.id) AS times_ordered
      FROM order_items oi
      LEFT JOIN menu_items m ON oi.menu_id = m.id
      JOIN orders o ON oi.order_id = o.order_id
        AND o.status IN ('paid','preparing','delivered')
      GROUP BY m.id
      ORDER BY times_ordered DESC
      LIMIT 1
    `);

    /* ✅ FIXED: u.fullname (not u.name), grouped by user_id + fullname */
    const [[topCustomer]] = await db.query(`
      SELECT
        COALESCE(u.fullname, 'Guest') AS name,
        COUNT(DISTINCT o.order_id)    AS order_count
      FROM orders o
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE o.status IN ('paid', 'preparing', 'delivered')
      GROUP BY o.user_id, u.fullname
      ORDER BY order_count DESC
      LIMIT 1
    `);

    const [[txSummary]] = await db.query(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
      FROM payments WHERE status = 'successful'
    `);

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      data: {
        orders_today: {
          total:     ordersToday.total     || 0,
          paid:      ordersToday.paid      || 0,
          pending:   ordersToday.pending   || 0,
          delivered: ordersToday.delivered || 0,
          preparing: ordersToday.preparing || 0,
        },
        revenue: {
          today:      parseFloat(revenue.today),
          this_month: parseFloat(revenue.this_month),
          all_time:   parseFloat(revenue.all_time),
        },
        transactions: {
          total_successful: txSummary.count,
          total_amount:     parseFloat(txSummary.amount),
        },
        highlights: {
          most_ordered_item: topItem     ? { name: topItem.name,        times:  topItem.times_ordered }   : null,
          top_customer:      topCustomer ? { name: topCustomer.name,    orders: topCustomer.order_count } : null,
        },
      },
    });
  } catch (error) {
    handleError(res, 'dashboard', error);
  }
});

module.exports = router;