const express = require('express');
const axios = require('axios');
require('dotenv').config();
const db = require('../database');

const router = express.Router();

const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY;
const BASE_URL = process.env.BASE_URL;

const RESTAURANT_NAME = "La Crisco Eatery";
const RESTAURANT_SLOGAN = "Taste the Difference";

console.log('🔑 PAYCHANGU_KEY:', PAYCHANGU_SECRET_KEY ? '✅ Loaded' : '❌ MISSING');
console.log('🌐 BASE_URL:', BASE_URL || '❌ MISSING');

// ================================
// 🛠️ DEBUG LOGGER
// ================================
function debugLog(section, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🔍 [${section}] ${message}`);
  if (data !== null) console.log(JSON.stringify(data, null, 2));
}

function errorLog(section, message, error) {
  const timestamp = new Date().toISOString();
  console.error(`\n[${timestamp}] ❌ [${section}] ${message}`);
  console.error('Message:', error?.message);
  if (error?.response?.data) {
    console.error('Response:', JSON.stringify(error.response.data, null, 2));
  }
}

// ================================
// 🔧 NORMALIZE PAYMENT CHANNEL
// ================================
function normalizeChannel(channel) {
  const map = {
    'test': 'test',
    'airtel money': 'airtel_money',
    'tnm mpamba': 'tnm_mpamba',
    'card': 'card',
  };
  return map[(channel || '').toLowerCase()] || 'mobile_money';
}

// ================================
// 🎫 GENERATE TICKETS
// ================================
async function generateTicketsFixed(orderId) {
  const [existing] = await db.query(
    `SELECT 
      t.*,
      oi.quantity,
      oi.price,
      COALESCE(m.name, 'Food Item') as item_name
    FROM tickets t
    JOIN order_items oi ON t.order_item_id = oi.id
    LEFT JOIN menu_items m ON oi.menu_id = m.id
    WHERE t.order_id = ?
    LIMIT 1`,
    [orderId]
  );

  if (existing.length > 0) {
    return [{
      ticket_id: existing[0].id,
      ticket_code: existing[0].ticket_code,
      item_name: existing[0].item_name,
      quantity: existing[0].quantity,
      price: parseFloat(existing[0].price),
      used: existing[0].status === 'used',
    }];
  }

  const [items] = await db.query(
    `SELECT 
      oi.*,
      COALESCE(m.name, 'Food Item') as item_name
    FROM order_items oi
    LEFT JOIN menu_items m ON oi.menu_id = m.id
    WHERE oi.order_id = ?
    LIMIT 1`,
    [orderId]
  );

  if (items.length === 0) throw new Error('No order items found');

  const item = items[0];
  const ticketCode = `TKT-${orderId}-${Date.now()}`;

  const [result] = await db.query(
    `INSERT INTO tickets (order_id, order_item_id, ticket_code, status, generated_at)
     VALUES (?, ?, ?, 'active', NOW())`,
    [orderId, item.id, ticketCode]
  );

  return [{
    ticket_id: result.insertId,
    ticket_code: ticketCode,
    item_name: item.item_name,
    quantity: item.quantity,
    price: parseFloat(item.price),
    used: false,
  }];
}

// ================================
// 📦 BUILD RESPONSE
// ================================
function buildTicketResponse(order, items, tickets) {
  const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);
  const deliveryFee = order.order_type === 'delivery' ? 1500 : 0;
  const serviceFee = 500;

  return {
    success: true,
    restaurant: RESTAURANT_NAME,
    slogan: RESTAURANT_SLOGAN,
    order: {
      order_id: order.order_id,
      order_type: order.order_type,
      date: order.created_at,
      phone: order.phone,
      status: order.status,
    },
    items: items.map(item => ({
      name: item.item_name,
      qty: item.quantity,
      amount: parseFloat(item.price),
    })),
    totals: {
      subtotal,
      delivery_fee: deliveryFee,
      service_fee: serviceFee,
      total: parseFloat(order.total_amount),
    },
    tickets,
    qr_payload: JSON.stringify({
      order_id: order.order_id,
      timestamp: Date.now(),
    }),
  };
}

// ================================
// 🔐 VERIFY PAYCHANGU PAYMENT
// ================================
async function verifyPayChanguPayment(tx_ref) {
  try {
    const response = await axios.get(
      `https://api.paychangu.com/verify-payment/${tx_ref}`,
      { headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}` } }
    );

    const data = response.data;
    const isSuccessful = data.status === 'success' && data.data?.status === 'success';

    return { success: isSuccessful, data: data.data, rawResponse: data };
  } catch (error) {
    errorLog('VERIFY_PAYMENT', 'Verification failed', error);
    return { success: false, error: error.message };
  }
}

// ================================
// 🧾 CREATE ORDER
// ================================
router.post('/orders', async (req, res) => {
  const { order_id, user_id, total_amount, order_type, tx_ref, items, phone } = req.body;

  if (!order_id || !user_id || !total_amount || !tx_ref) {
    return res.status(400).json({
      success: false,
      message: 'order_id, user_id, total_amount and tx_ref are required',
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO orders (order_id, user_id, total_amount, order_type, status, tx_ref, phone, created_at)
       VALUES (?, ?, ?, ?, 'preparing', ?, ?, NOW())`,
      [order_id, user_id, total_amount, order_type || 'delivery', tx_ref, phone || null]
    );

    if (items && items.length > 0) {
      for (const item of items) {
        await conn.query(
          `INSERT INTO order_items (order_id, menu_id, quantity, price) VALUES (?, ?, ?, ?)`,
          [order_id, item.menu_id, item.quantity, item.price]
        );
      }
    }

    await conn.query(
      `INSERT INTO payments (order_id, tx_ref, amount, method, status, phone)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [order_id, tx_ref, total_amount, 'mobile_money', phone || null]
    );

    await conn.commit();

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: { order_id, status: 'preparing', payment_status: 'pending' },
    });

  } catch (error) {
    await conn.rollback();
    errorLog('CREATE_ORDER', 'Failed', error);
    res.status(500).json({ success: false, message: 'Failed to create order', error: error.message });
  } finally {
    conn.release();
  }
});

// ================================
// 💳 INITIATE PAYMENT
// ================================
router.post('/initiate', async (req, res) => {
  const { amount, tx_ref, name, phone, orderId } = req.body;

  if (!amount || !tx_ref || !name || !phone || !orderId) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const nameParts = name.trim().split(' ');

    const payload = {
      amount: amount.toString(),
      currency: 'MWK',
      email: `${phone}@lacrisco.com`,
      first_name: nameParts[0],
      last_name: nameParts.slice(1).join(' ') || 'Customer',
      // ✅ Both callback and return now point to the same handler
      // PayChangu sometimes uses GET for return_url and POST for callback_url
      callback_url: `${BASE_URL}/api/payments/callback`,
      return_url: `${BASE_URL}/api/payments/return`,
      tx_ref,
      customization: {
        title: RESTAURANT_NAME,
        description: `Order #${orderId}`,
      },
      meta: { order_id: orderId, phone },
    };

    debugLog('INITIATE_PAYMENT', 'Sending to PayChangu', payload);

    const response = await axios.post(
      'https://api.paychangu.com/payment',
      payload,
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
        },
      }
    );

    const data = response.data;
    debugLog('INITIATE_PAYMENT', 'PayChangu response', data);

    if (data.status === 'success') {
      return res.json({ success: true, checkout_url: data.data.checkout_url, tx_ref });
    }

    res.status(400).json({ success: false, message: 'Failed to initiate payment' });

  } catch (error) {
    errorLog('INITIATE_PAYMENT', 'Failed', error);
    res.status(500).json({ success: false, message: 'Payment initiation failed', error: error.message });
  }
});

// ================================
// ✅ SHARED PAYMENT HANDLER
// Used by both return_url and callback_url
// ================================
async function handlePaymentSuccess(tx_ref, res, redirectMode = false) {
  try {
    debugLog('PAYMENT_HANDLER', `Processing tx_ref: ${tx_ref}`);

    const verification = await verifyPayChanguPayment(tx_ref);
    debugLog('PAYMENT_HANDLER', 'Verification result', verification);

    if (verification.success) {
      const channel = normalizeChannel(verification.data?.authorization?.channel);

      await db.query(
        `UPDATE payments SET status = 'successful', method = ? WHERE tx_ref = ?`,
        [channel, tx_ref]
      );

      const [orders] = await db.query(
        `SELECT order_id FROM orders WHERE tx_ref = ?`,
        [tx_ref]
      );

      if (orders.length > 0) {
        const orderId = orders[0].order_id;
        await generateTicketsFixed(orderId);

        debugLog('PAYMENT_HANDLER', `✅ Payment successful for order: ${orderId}`);

        if (redirectMode) {
          return res.redirect(`foodiedash://success?orderId=${orderId}`);
        }
        return res.json({ success: true, order_id: orderId });
      }
    }

    // Payment not verified
    await db.query(
      `UPDATE payments SET status = 'failed' WHERE tx_ref = ?`,
      [tx_ref]
    );

    if (redirectMode) {
      return res.redirect(`foodiedash://checkout?payment=failed`);
    }
    return res.json({ success: false, message: 'Payment verification failed' });

  } catch (error) {
    errorLog('PAYMENT_HANDLER', 'Failed', error);
    if (redirectMode) {
      return res.redirect(`foodiedash://checkout?payment=error`);
    }
    return res.status(500).json({ success: false, message: error.message });
  }
}

// ================================
// 📩 RETURN URL (GET — browser redirect after payment)
// ================================
router.get('/return', async (req, res) => {
  const { tx_ref } = req.query;
  debugLog('RETURN_URL', `GET /return called with tx_ref: ${tx_ref}`);

  if (!tx_ref) return res.redirect(`foodiedash://checkout?payment=failed`);
  await handlePaymentSuccess(tx_ref, res, true);
});

// ================================
// 📩 CALLBACK (POST — PayChangu webhook)
// ================================
router.post('/callback', async (req, res) => {
  const { tx_ref } = req.body;
  debugLog('CALLBACK', `POST /callback called with tx_ref: ${tx_ref}`);

  // Respond immediately so PayChangu doesn't retry
  res.status(200).json({ success: true });

  if (!tx_ref) return;
  await handlePaymentSuccess(tx_ref, { json: () => {}, redirect: () => {} }, false);
});

// ================================
// 📩 CALLBACK (GET — some gateways send GET to callback too)
// ================================
router.get('/callback', async (req, res) => {
  const { tx_ref } = req.query;
  debugLog('CALLBACK_GET', `GET /callback called with tx_ref: ${tx_ref}`);

  if (!tx_ref) return res.redirect(`foodiedash://checkout?payment=failed`);
  await handlePaymentSuccess(tx_ref, res, true);
});

// ================================
// 🎫 GENERATE TICKETS
// ================================
router.post('/tickets/generate/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const [payments] = await db.query(
      `SELECT status FROM payments WHERE order_id = ?`,
      [orderId]
    );

    const isPaid = payments.length > 0 && payments[0].status === 'successful';

    if (!isPaid) {
      return res.status(400).json({ success: false, message: 'Payment not successful' });
    }

    const tickets = await generateTicketsFixed(orderId);
    const [orders] = await db.query(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    const [items] = await db.query(
      `SELECT oi.*, COALESCE(m.name, 'Food Item') as item_name
       FROM order_items oi
       LEFT JOIN menu_items m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    res.json(buildTicketResponse(orders[0], items, tickets));

  } catch (error) {
    errorLog('GENERATE_TICKETS', 'Failed', error);
    res.status(500).json({ success: false, message: 'Failed to generate ticket', error: error.message });
  }
});

// ================================
// 🎫 GET TICKETS
// ================================
router.get('/tickets/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const [tickets] = await db.query(
      `SELECT t.*, oi.quantity, oi.price, COALESCE(m.name, 'Food Item') as item_name
       FROM tickets t
       JOIN order_items oi ON t.order_item_id = oi.id
       LEFT JOIN menu_items m ON oi.menu_id = m.id
       WHERE t.order_id = ?`,
      [orderId]
    );

    const [orders] = await db.query(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    const [items] = await db.query(
      `SELECT oi.*, COALESCE(m.name, 'Food Item') as item_name
       FROM order_items oi
       LEFT JOIN menu_items m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    res.json(buildTicketResponse(orders[0], items, tickets));

  } catch (error) {
    errorLog('GET_TICKETS', 'Failed', error);
    res.status(500).json({ success: false, message: 'Failed to get tickets' });
  }
});

// ================================
// 🔐 VERIFY PAYMENT (manual check)
// ================================
router.get('/verify/:tx_ref', async (req, res) => {
  const { tx_ref } = req.params;

  try {
    const verification = await verifyPayChanguPayment(tx_ref);

    if (verification.success) {
      const channel = normalizeChannel(verification.data?.authorization?.channel);

      await db.query(
        `UPDATE payments SET status = 'successful', method = ? WHERE tx_ref = ?`,
        [channel, tx_ref]
      );

      const [orders] = await db.query(`SELECT order_id FROM orders WHERE tx_ref = ?`, [tx_ref]);
      let tickets = [];

      if (orders.length > 0) {
        tickets = await generateTicketsFixed(orders[0].order_id);
      }

      return res.json({ success: true, message: 'Payment verified successfully', tickets });
    }

    await db.query(`UPDATE payments SET status = 'failed' WHERE tx_ref = ?`, [tx_ref]);
    res.json({ success: false, message: 'Payment failed' });

  } catch (error) {
    errorLog('VERIFY_PAYMENT', 'Failed', error);
    res.status(500).json({ success: false, message: 'Verification failed', error: error.message });
  }
});

// ================================
// 📋 GET ORDER DETAILS
// ================================
router.get('/order/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const [orders] = await db.query(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);

    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const [items] = await db.query(
      `SELECT oi.*, COALESCE(m.name, 'Food Item') as item_name
       FROM order_items oi
       LEFT JOIN menu_items m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    const [payments] = await db.query(`SELECT * FROM payments WHERE order_id = ?`, [orderId]);

    res.json({ success: true, order: orders[0], payment: payments[0] || null, items });

  } catch (error) {
    errorLog('GET_ORDER', 'Failed', error);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

module.exports = router;