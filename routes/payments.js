const express = require('express');
const axios = require('axios');
require('dotenv').config();
const db = require('../database');

const router = express.Router();

// ✅ FIXED: was process.env.PRIVATE_KEY — must match your .env variable name exactly
const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY;
const BASE_URL = process.env.BASE_URL; // e.g. http://192.168.27.144:3000
console.log('KEY LOADED:', process.env.PAYCHANGU_SECRET_KEY);
// ================================
// 🧾 CREATE ORDER + PAYMENT RECORD
// ================================
router.post("/orders", async (req, res) => {
  const { order_id, user_id, total_amount, order_type, tx_ref, items, phone } = req.body;

  console.log("📥 Incoming order:", req.body);

  if (!order_id || !user_id || !total_amount || !tx_ref) {
    return res.status(400).json({
      success: false,
      message: "order_id, user_id, total_amount, and tx_ref are required",
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO orders (order_id, user_id, total_amount, order_type, status, tx_ref)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [order_id, user_id, total_amount, order_type || "delivery", tx_ref]
    );

    if (items && items.length > 0) {
      for (const item of items) {
        await conn.query(
          `INSERT INTO order_items (order_id, menu_id, quantity, price)
           VALUES (?, ?, ?, ?)`,
          [order_id, item.menu_id, item.quantity, item.price]
        );
      }
    }

    await conn.query(
      `INSERT INTO payments (order_id, tx_ref, amount, method, status, phone)
       VALUES (?, ?, ?, 'mobile_money', 'pending', ?)`,
      [order_id, tx_ref, total_amount, phone || null]
    );

    await conn.commit();
    console.log("📦 Order + payment record created:", order_id);

    res.status(201).json({
      success: true,
      message: "Order saved successfully",
      data: { order_id, user_id, total_amount, order_type, tx_ref, status: "pending" },
    });
  } catch (error) {
    await conn.rollback();
    console.error("❌ Create order DB error:", error.message);
    res.status(500).json({ success: false, message: "Failed to create order", error: error.message });
  } finally {
    conn.release();
  }
});

// ======================================
// 💳 INITIATE PAYCHANGU CHECKOUT
// ✅ NEW: This was completely missing before.
// Without this, the WebView had no real checkout_url to load.
// ======================================
router.post("/initiate", async (req, res) => {
  const { amount, tx_ref, name, phone, orderId } = req.body;

  if (!amount || !tx_ref || !name || !phone || !orderId) {
    return res.status(400).json({
      success: false,
      message: "amount, tx_ref, name, phone, and orderId are required",
    });
  }

  try {
    const nameParts = name.trim().split(" ");
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(" ") || "Customer";

    const response = await axios.post(
      "https://api.paychangu.com/payment",
      {
        amount:       amount.toString(),
        currency:     "MWK",
        // ✅ FIXED: Use a real email if available; this is a safe fallback
        email:        `${phone}@foodiedash.com`,
        first_name:   firstName,
        last_name:    lastName,
        // ✅ FIXED: callback_url must be a publicly reachable URL (not localhost in production)
        callback_url: `${BASE_URL}/api/payments/payment/callback`,
        return_url:   `${BASE_URL}/api/payments/payment/return`,
        tx_ref:       tx_ref,
        customization: {
          title:       "FoodieDash",
          description: `Order #${orderId}`,
        },
        meta: {
          order_id: orderId,
          phone:    phone,
        },
      },
      {
        headers: {
          Accept:          "application/json",
          "Content-Type":  "application/json",
          // ✅ FIXED: Secret key used here on backend — NEVER send secret key to frontend
          Authorization:   `Bearer ${PAYCHANGU_SECRET_KEY}`,
        },
      }
    );

    const data = response.data;
    console.log("💳 PayChangu initiate response:", data);

    if (data.status === "success") {
      return res.json({
        success:      true,
        // ✅ This is the real hosted URL e.g. https://checkout.paychangu.com/923677185321
        checkout_url: data.data.checkout_url,
        tx_ref:       data.data.data.tx_ref,
      });
    }

    return res.status(400).json({
      success: false,
      message: data.message || "Failed to initiate payment",
    });

  } catch (error) {
    console.error("❌ Initiate payment error:", error.response?.data || error.message);
    res.status(500).json({
      success:  false,
      message:  "Payment initiation failed",
      error:    error.response?.data || error.message,
    });
  }
});

// ======================================
// 🔐 VERIFY PAYMENT
// ✅ FIXED: Wrong endpoint used before — /v1/transaction/verify/:tx_ref
// Correct PayChangu endpoint is /verify-payment/:tx_ref
// ======================================
router.get("/payment/verify/:tx_ref", async (req, res) => {
  const { tx_ref } = req.params;

  try {
    // ✅ FIXED: Correct verification endpoint
    const response = await axios.get(
      `https://api.paychangu.com/verify-payment/${tx_ref}`,
      {
        headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}` },
      }
    );

    const data = response.data;
    console.log("🔍 PayChangu verify response:", data);

    if (data.status === "success") {
      await db.query(`UPDATE payments SET status = 'successful' WHERE tx_ref = ?`, [tx_ref]);
      await db.query(`UPDATE orders   SET status = 'paid'        WHERE tx_ref = ?`, [tx_ref]);
      return res.json({ success: true, message: "Payment verified successfully", data });
    }

    await db.query(`UPDATE payments SET status = 'failed' WHERE tx_ref = ?`, [tx_ref]);
    await db.query(`UPDATE orders   SET status = 'failed' WHERE tx_ref = ?`, [tx_ref]);
    return res.json({ success: false, message: "Payment not successful", data });

  } catch (error) {
    console.error("❌ Verification error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Payment verification failed",
      error:   error.response?.data || error.message,
    });
  }
});

// ======================================
// 📩 PAYCHANGU WEBHOOK CALLBACK (POST)
// Called by PayChangu server after payment
// ======================================
router.post("/payment/callback", async (req, res) => {
  try {
    const payload = req.body;
    console.log("📩 Webhook callback received:", payload);

    const { tx_ref, status } = payload;

    if (!tx_ref) {
      return res.status(400).json({ success: false, message: "tx_ref missing" });
    }

    const isSuccess    = status === "successful";
    const paymentStatus = isSuccess ? "successful" : "failed";
    const orderStatus   = isSuccess ? "paid"        : "failed";

    await db.query(`UPDATE payments SET status = ? WHERE tx_ref = ?`, [paymentStatus, tx_ref]);
    await db.query(`UPDATE orders   SET status = ? WHERE tx_ref = ?`, [orderStatus,   tx_ref]);

    console.log(`✅ Webhook processed — payment ${paymentStatus} for tx_ref: ${tx_ref}`);
    // ✅ Always respond 200 to PayChangu so they don't retry
    res.status(200).json({ success: true, message: "Callback received" });

  } catch (error) {
    console.error("❌ Callback error:", error.message);
    res.status(500).json({ success: false, message: "Callback processing failed" });
  }
});

// ======================================
// 🔁 RETURN URL HANDLER (GET)
// ✅ NEW: PayChangu redirects user browser here after payment
// This is different from the webhook — it's the user's redirect
// ======================================
router.get("/payment/return", async (req, res) => {
  const { tx_ref, status } = req.query;
  console.log("🔁 Return URL hit:", { tx_ref, status });

  // You can redirect to a success/failure page or just respond
  // The mobile app handles this via WebView URL detection
  if (status === "successful" || status === "success") {
    return res.redirect(`${BASE_URL}/success?tx_ref=${tx_ref}&status=successful`);
  }
  return res.redirect(`${BASE_URL}/success?tx_ref=${tx_ref}&status=failed`);
});

// ======================================
// 📊 GET ALL PAYMENTS
// ======================================
router.get("/payments", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, o.user_id, o.order_type
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.order_id
      ORDER BY p.created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("❌ Get payments error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch payments" });
  }
});

// ======================================
// 🔍 GET PAYMENT BY tx_ref
// ======================================
router.get("/payments/:tx_ref", async (req, res) => {
  const { tx_ref } = req.params;
  try {
    const [rows] = await db.query(`SELECT * FROM payments WHERE tx_ref = ?`, [tx_ref]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error("❌ Get payment error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch payment" });
  }
});

module.exports = router;