const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

function generateHash() {
  return crypto.randomBytes(8).toString('hex');
}

router.post('/api/tickets/generate/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    // 1. Get order
    const [orderRows] = await db.promise().query(
      "SELECT * FROM orders WHERE order_id = ?",
      [orderId]
    );

    if (orderRows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderRows[0];

    // 2. Get items
    const [items] = await db.promise().query(
      "SELECT * FROM order_items WHERE order_id = ?",
      [orderId]
    );

    // 3. Create tickets per item
    const tickets = [];

    for (let item of items) {
      const ticketHash = generateHash();

      const [result] = await db.promise().query(
        `INSERT INTO tickets (order_id, order_item_id, ticket_hash, status)
         VALUES (?, ?, ?, 'ACTIVE')`,
        [orderId, item.id, ticketHash]
      );

      tickets.push({
        ticket_id: result.insertId,
        ticket_hash: ticketHash,
        item: item
      });
    }

    // 4. Build RECEIPT RESPONSE (what your UI will show)
    res.json({
      restaurant: "Ere Crisco Restaurant",
      slogan: "Delicious food, made for you.",
      order: {
        order_id: order.order_id,
        order_type: order.order_type,
        date: order.created_at
      },
      items: items.map(i => ({
        name: i.item_name,
        qty: i.quantity,
        amount: i.price
      })),
      totals: {
        subtotal: order.total_amount,
        service_charge: order.total_amount * 0.1,
        total: order.total_amount * 1.1
      },
      tickets,
      qr_payload: tickets.map(t => ({
        t: t.ticket_hash
      }))
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;