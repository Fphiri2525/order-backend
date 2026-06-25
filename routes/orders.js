const express = require('express');
const db = require('../database'); // mysql2/promise pool

const router = express.Router();

// ================================
// 📋 GET ALL ORDERS
// (order number, food items, customer + contact, pickup/delivery time from deliveries table)
// ================================
router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;

  try {
    const [rows] = await db.query(
      `
      SELECT
        o.id,
        o.order_id,
        o.status,
        o.order_type,
        o.total_amount,
        o.created_at          AS order_time,

        u.fullname             AS customer_name,
        u.contactnumber        AS customer_phone,

        oi.quantity,
        oi.price,

        m.id                   AS menu_id,
        m.name                  AS menu_name,
        m.category,

        d.status                AS delivery_status,
        d.location               AS delivery_location,
        d.scheduled_date,
        d.scheduled_time

      FROM orders o
      LEFT JOIN \`user\` u       ON o.user_id   = u.id
      LEFT JOIN order_items oi  ON o.order_id  = oi.order_id
      LEFT JOIN menu_items m    ON oi.menu_id  = m.id
      LEFT JOIN deliveries d    ON o.order_id  = d.order_id
      ORDER BY o.created_at DESC
      LIMIT ?
      `,
      [limit]
    );

    // group rows by order_id so each order has one items[] array
    const ordersMap = {};

    for (const row of rows) {
      if (!ordersMap[row.order_id]) {
        ordersMap[row.order_id] = {
          id: row.id,
          order_id: row.order_id,
          status: row.status,
          order_type: row.order_type,
          total_amount: row.total_amount,
          order_time: row.order_time,

          customer_name: row.customer_name,
          customer_phone: row.customer_phone,

          delivery_status: row.delivery_status,
          delivery_location: row.delivery_location,
          scheduled_date: row.scheduled_date,
          scheduled_time: row.scheduled_time,

          items: [],
        };
      }

      if (row.menu_id) {
        ordersMap[row.order_id].items.push({
          menu_id: row.menu_id,
          name: row.menu_name,
          category: row.category,
          quantity: row.quantity,
          price: row.price,
        });
      }
    }

    const orders = Object.values(ordersMap);

    res.json({
      success: true,
      total_orders: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error('❌ Get orders error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
});

// ================================
// ✅ VERIFY SCANNED TICKET (QR CODE)
// Checks: ticket_code exists, status is 'active' (not 'used' or 'expired')
// If valid → marks ticket as 'used' and order as 'delivered'
// ================================
router.post('/verify', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, message: 'Ticket code is required' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `
      SELECT
        t.id          AS ticket_id,
        t.order_id,
        t.order_item_id,
        t.ticket_code,
        t.status      AS ticket_status,
        t.generated_at,
        t.activated_at,
        t.scanned_at,

        o.id          AS order_table_id,
        o.status      AS order_status,
        o.total_amount,
        o.order_type,
        o.created_at  AS order_time,

        u.fullname        AS customer_name,
        u.contactnumber   AS customer_phone

      FROM tickets t
      LEFT JOIN orders o   ON t.order_id = o.order_id
      LEFT JOIN \`user\` u ON o.user_id = u.id
      WHERE t.ticket_code = ?
      FOR UPDATE
      `,
      [code]
    );

    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        valid: false,
        message: 'Invalid ticket: code not found',
      });
    }

    const ticket = rows[0];

    // ── Check: ticket already used? ──
    if (ticket.ticket_status === 'used') {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        valid: false,
        message: 'This ticket has already been used',
        data: ticket,
      });
    }

    // ── Check: ticket expired? ──
    if (ticket.ticket_status === 'expired') {
      await conn.rollback();
      return res.status(410).json({
        success: false,
        valid: false,
        message: 'This ticket has expired',
        data: ticket,
      });
    }

    // At this point ticket_status must be 'active' — valid scan
    // ── Mark ticket as used ──
    await conn.query(
      `UPDATE tickets
       SET status = 'used', scanned_at = NOW()
       WHERE ticket_code = ?`,
      [code]
    );

    // ── Mark order as delivered ──
    await conn.query(
      `UPDATE orders SET status = 'delivered' WHERE order_id = ?`,
      [ticket.order_id]
    );

    await conn.commit();

    res.json({
      success: true,
      valid: true,
      message: 'Ticket verified successfully and marked as used',
      data: {
        ticket_code: ticket.ticket_code,
        order_id: ticket.order_id,
        ticket_status: 'used',
        order_status: 'delivered',
        customer_name: ticket.customer_name,
        customer_phone: ticket.customer_phone,
        total_amount: ticket.total_amount,
        order_type: ticket.order_type,
      },
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Verify ticket error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to verify ticket' });
  } finally {
    conn.release();
  }
});

// ================================
// 🔍 GET SINGLE ORDER BY order_id
// ================================
router.get('/:order_id', async (req, res) => {
  const { order_id } = req.params;

  try {
    const [rows] = await db.query(
      `
      SELECT
        o.id,
        o.order_id,
        o.status,
        o.order_type,
        o.total_amount,
        o.created_at          AS order_time,

        u.fullname             AS customer_name,
        u.contactnumber        AS customer_phone,

        oi.quantity,
        oi.price,

        m.id                   AS menu_id,
        m.name                  AS menu_name,
        m.category,

        d.status                AS delivery_status,
        d.location               AS delivery_location,
        d.scheduled_date,
        d.scheduled_time

      FROM orders o
      LEFT JOIN \`user\` u       ON o.user_id   = u.id
      LEFT JOIN order_items oi  ON o.order_id  = oi.order_id
      LEFT JOIN menu_items m    ON oi.menu_id  = m.id
      LEFT JOIN deliveries d    ON o.order_id  = d.order_id
      WHERE o.order_id = ?
      `,
      [order_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = {
      id: rows[0].id,
      order_id: rows[0].order_id,
      status: rows[0].status,
      order_type: rows[0].order_type,
      total_amount: rows[0].total_amount,
      order_time: rows[0].order_time,

      customer_name: rows[0].customer_name,
      customer_phone: rows[0].customer_phone,

      delivery_status: rows[0].delivery_status,
      delivery_location: rows[0].delivery_location,
      scheduled_date: rows[0].scheduled_date,
      scheduled_time: rows[0].scheduled_time,

      items: rows
        .filter((r) => r.menu_id)
        .map((r) => ({
          menu_id: r.menu_id,
          name: r.menu_name,
          category: r.category,
          quantity: r.quantity,
          price: r.price,
        })),
    };

    res.json({ success: true, data: order });
  } catch (error) {
    console.error('❌ Get order error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

// ================================
// 🧾 CREATE ORDER
// ================================
router.post('/', async (req, res) => {
  const { order_id, user_id, total_amount, order_type, tx_ref, phone, items } = req.body;

  if (!order_id || !user_id || !total_amount || !items || items.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'order_id, user_id, total_amount, and items are required',
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO orders (order_id, user_id, total_amount, order_type, status, tx_ref, phone)
       VALUES (?, ?, ?, ?, 'preparing', ?, ?)`,
      [order_id, user_id, total_amount, order_type || 'delivery', tx_ref || null, phone || null]
    );

    for (const item of items) {
      await conn.query(
        `INSERT INTO order_items (order_id, menu_id, quantity, price)
         VALUES (?, ?, ?, ?)`,
        [order_id, item.menu_id, item.quantity, item.price]
      );
    }

    await conn.commit();

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: { order_id, user_id, total_amount, order_type, status: 'preparing' },
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Create order error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  } finally {
    conn.release();
  }
});

// ================================
// ✏️ UPDATE ORDER STATUS
// ================================
router.patch('/:order_id/status', async (req, res) => {
  const { order_id } = req.params;
  const { status } = req.body;

  // matches your enum exactly: preparing, ready, delivered
  const allowed = ['preparing', 'ready', 'delivered'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${allowed.join(', ')}`,
    });
  }

  try {
    const [result] = await db.query(`UPDATE orders SET status = ? WHERE order_id = ?`, [
      status,
      order_id,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    res.json({ success: true, message: `Order status updated to '${status}'` });
  } catch (error) {
    console.error('❌ Update order error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update order' });
  }
});

// ================================
// 🗑️ DELETE ORDER
// ================================
router.delete('/:order_id', async (req, res) => {
  const { order_id } = req.params;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [order_id]);
    await conn.query(`DELETE FROM payments WHERE order_id = ?`, [order_id]);
    await conn.query(`DELETE FROM deliveries WHERE order_id = ?`, [order_id]);
    await conn.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);
    await conn.commit();

    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Delete order error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete order' });
  } finally {
    conn.release();
  }
});

// ================================
// 💰 GET PAID ORDERS (payments.status = 'successful')
// order number, items, customer + contact, pickup/delivery time from deliveries table
// ================================
router.get('/status/paid', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;

  try {
    const [rows] = await db.query(
      `
      SELECT
        o.id,
        o.order_id,
        o.status,
        o.order_type,
        o.total_amount,
        o.created_at          AS order_time,

        u.fullname             AS customer_name,
        u.contactnumber        AS customer_phone,

        p.status                AS payment_status,
        p.payment_date,
        p.method                 AS payment_method,

        oi.quantity,
        oi.price,

        m.id                    AS menu_id,
        m.name                   AS menu_name,
        m.category,

        d.status                 AS delivery_status,
        d.location                AS delivery_location,
        d.scheduled_date,
        d.scheduled_time

      FROM orders o
      INNER JOIN payments p     ON o.order_id = p.order_id AND p.status = 'successful'
      LEFT JOIN \`user\` u       ON o.user_id   = u.id
      LEFT JOIN order_items oi  ON o.order_id  = oi.order_id
      LEFT JOIN menu_items m    ON oi.menu_id  = m.id
      LEFT JOIN deliveries d    ON o.order_id  = d.order_id
      WHERE o.status != 'delivered'
      ORDER BY o.created_at DESC
      LIMIT ?
      `,
      [limit]
    );

    const ordersMap = {};

    for (const row of rows) {
      if (!ordersMap[row.order_id]) {
        ordersMap[row.order_id] = {
          id: row.id,
          order_id: row.order_id,
          status: row.status,
          order_type: row.order_type,
          total_amount: row.total_amount,
          order_time: row.order_time,

          customer_name: row.customer_name,
          customer_phone: row.customer_phone,

          payment_status: row.payment_status,
          payment_date: row.payment_date,
          payment_method: row.payment_method,

          delivery_status: row.delivery_status,
          delivery_location: row.delivery_location,
          scheduled_date: row.scheduled_date,
          scheduled_time: row.scheduled_time,

          items: [],
        };
      }

      if (row.menu_id) {
        ordersMap[row.order_id].items.push({
          menu_id: row.menu_id,
          name: row.menu_name,
          category: row.category,
          quantity: row.quantity,
          price: row.price,
        });
      }
    }

    const orders = Object.values(ordersMap);

    res.json({
      success: true,
      total_orders: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error('❌ Get paid orders error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch paid orders' });
  }
});

module.exports = router;