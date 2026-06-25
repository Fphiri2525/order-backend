const express = require('express');
const crypto  = require('crypto');
const db      = require('./db');

const router = express.Router();

function generateTicketCode() {
  // e.g. TKT-A3F9B2C1
  return `TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ─── POST /api/tickets/generate/:orderId ───────────────────────────────────────
router.post('/generate/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const [orderRows] = await db.promise().query(
      'SELECT * FROM orders WHERE order_id = ?',
      [orderId]
    );
    if (orderRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const order = orderRows[0];

    const [existing] = await db.promise().query(
      'SELECT id FROM tickets WHERE order_id = ? LIMIT 1',
      [orderId]
    );

    let tickets = [];

    if (existing.length === 0) {
      const [items] = await db.promise().query(
        `SELECT oi.*, COALESCE(m.name, oi.item_name) AS item_name
         FROM order_items oi
         LEFT JOIN menu_item m ON oi.menu_id = m.id
         WHERE oi.order_id = ?`,
        [orderId]
      );

      for (const item of items) {
        const ticketCode = generateTicketCode();

        const [result] = await db.promise().query(
          `INSERT INTO tickets
             (order_id, order_item_id, ticket_code, status, generated_at, created_at)
           VALUES (?, ?, ?, 'ACTIVE', NOW(), NOW())`,
          [orderId, item.id, ticketCode]
        );

        tickets.push({
          ticket_id:   result.insertId,
          ticket_code: ticketCode,
          item_name:   item.item_name,
          quantity:    item.quantity,
          price:       item.price,
        });
      }
    } else {
      const [rows] = await db.promise().query(
        `SELECT t.id, t.ticket_code, t.status,
                oi.quantity, oi.price,
                COALESCE(m.name, oi.item_name) AS item_name
         FROM tickets t
         LEFT JOIN order_items oi ON t.order_item_id = oi.id
         LEFT JOIN menu_item m ON oi.menu_id = m.id
         WHERE t.order_id = ?`,
        [orderId]
      );
      tickets = rows.map(r => ({
        ticket_id:   r.id,
        ticket_code: r.ticket_code,
        item_name:   r.item_name,
        quantity:    r.quantity,
        price:       r.price,
      }));
    }

    const [allItems] = await db.promise().query(
      `SELECT oi.quantity, oi.price,
              COALESCE(m.name, oi.item_name) AS item_name
       FROM order_items oi
       LEFT JOIN menu_item m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    const subtotal    = allItems.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
    const deliveryFee = order.order_type === 'delivery' ? 1500 : 0;
    const serviceFee  = 500;
    const total       = subtotal + deliveryFee + serviceFee;

    const primaryCode = tickets.length > 0 ? tickets[0].ticket_code : '';
    const qrPayload   = JSON.stringify({ order_id: orderId, ticket_code: primaryCode });

    res.json({
      success:    true,
      restaurant: 'Ere Crisco Restaurant',
      slogan:     'Delicious food, made for you.',
      order: {
        order_id:   order.order_id,
        order_type: order.order_type,
        date:       order.created_at,
        phone:      order.phone,
        address:    order.address || null,
      },
      items: allItems.map(i => ({
        name:   i.item_name,
        qty:    i.quantity,
        amount: parseFloat(i.price),
      })),
      totals: { subtotal, delivery_fee: deliveryFee, service_fee: serviceFee, total },
      tickets,
      qr_payload: qrPayload,
    });

  } catch (err) {
    console.error('❌ Ticket generation error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/tickets/:orderId ─────────────────────────────────────────────────
router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const [orderRows] = await db.promise().query(
      'SELECT * FROM orders WHERE order_id = ?',
      [orderId]
    );
    if (orderRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const order = orderRows[0];

    const [tickets] = await db.promise().query(
      `SELECT t.id, t.ticket_code, t.status,
              oi.quantity, oi.price,
              COALESCE(m.name, oi.item_name) AS item_name
       FROM tickets t
       LEFT JOIN order_items oi ON t.order_item_id = oi.id
       LEFT JOIN menu_item m ON oi.menu_id = m.id
       WHERE t.order_id = ?`,
      [orderId]
    );

    const [allItems] = await db.promise().query(
      `SELECT oi.quantity, oi.price,
              COALESCE(m.name, oi.item_name) AS item_name
       FROM order_items oi
       LEFT JOIN menu_item m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    const subtotal    = allItems.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
    const deliveryFee = order.order_type === 'delivery' ? 1500 : 0;
    const serviceFee  = 500;
    const total       = subtotal + deliveryFee + serviceFee;

    const primaryCode = tickets.length > 0 ? tickets[0].ticket_code : '';
    const qrPayload   = JSON.stringify({ order_id: orderId, ticket_code: primaryCode });

    res.json({
      success:    true,
      restaurant: 'Ere Crisco Restaurant',
      slogan:     'Delicious food, made for you.',
      order: {
        order_id:   order.order_id,
        order_type: order.order_type,
        date:       order.created_at,
        phone:      order.phone,
        address:    order.address || null,
      },
      items: allItems.map(i => ({
        name:   i.item_name,
        qty:    i.quantity,
        amount: parseFloat(i.price),
      })),
      totals: { subtotal, delivery_fee: deliveryFee, service_fee: serviceFee, total },
      tickets: tickets.map(t => ({
        ticket_id:   t.id,
        ticket_code: t.ticket_code,
        item_name:   t.item_name,
        quantity:    t.quantity,
        price:       t.price,
      })),
      qr_payload: qrPayload,
    });

  } catch (err) {
    console.error('❌ Ticket fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/tickets/scan ────────────────────────────────────────────────────
router.post('/scan', async (req, res) => {
  const { ticket_code } = req.body;
  if (!ticket_code) {
    return res.status(400).json({ success: false, message: 'ticket_code is required' });
  }

  try {
    const [rows] = await db.promise().query(
      'SELECT * FROM tickets WHERE ticket_code = ?',
      [ticket_code]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = rows[0];

    if (ticket.status === 'SCANNED') {
      return res.status(409).json({ success: false, message: 'Ticket already scanned', ticket });
    }
    if (ticket.status === 'INVALID') {
      return res.status(403).json({ success: false, message: 'Ticket is invalid', ticket });
    }

    await db.promise().query(
      `UPDATE tickets SET status = 'SCANNED', scanned_at = NOW() WHERE ticket_code = ?`,
      [ticket_code]
    );

    res.json({ success: true, message: 'Ticket scanned successfully', ticket_code });
  } catch (err) {
    console.error('❌ Ticket scan error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;