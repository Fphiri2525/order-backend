const express = require('express');
const db = require('../database'); // your mysql2 connection

const router = express.Router();

// ================================
// 📋 GET ALL ORDERS
// ================================
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT o.*, u.name AS customer_name
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
    `);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("❌ Get orders error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

// ================================
// 🔍 GET SINGLE ORDER BY order_id
// ================================
router.get("/:order_id", async (req, res) => {
  const { order_id } = req.params;

  try {
    const [orders] = await db.query(
      `SELECT * FROM orders WHERE order_id = ?`,
      [order_id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const [items] = await db.query(
      `SELECT oi.*, m.name AS menu_name
       FROM order_items oi
       LEFT JOIN menu m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [order_id]
    );

    res.json({
      success: true,
      data: { ...orders[0], items },
    });
  } catch (error) {
    console.error("❌ Get order error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch order" });
  }
});

// ================================
// 🧾 CREATE ORDER
// ================================
router.post("/", async (req, res) => {
  const { order_id, user_id, total_amount, order_type, tx_ref, items } = req.body;

  if (!order_id || !user_id || !total_amount || !items || items.length === 0) {
    return res.status(400).json({
      success: false,
      message: "order_id, user_id, total_amount, and items are required",
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Insert into orders
    await conn.query(
      `INSERT INTO orders (order_id, user_id, total_amount, order_type, status, tx_ref)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [order_id, user_id, total_amount, order_type || "delivery", tx_ref || null]
    );

    // Insert each order item
    for (const item of items) {
      await conn.query(
        `INSERT INTO order_items (order_id, menu_id, quantity, price)
         VALUES (?, ?, ?, ?)`,
        [order_id, item.menu_id, item.quantity, item.price]
      );
    }

    await conn.commit();

    console.log("📦 Order created:", order_id);

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: { order_id, user_id, total_amount, order_type, status: "pending" },
    });
  } catch (error) {
    await conn.rollback();
    console.error("❌ Create order error:", error.message);
    res.status(500).json({ success: false, message: "Failed to create order" });
  } finally {
    conn.release();
  }
});

// ================================
// ✏️ UPDATE ORDER STATUS
// ================================
router.patch("/:order_id/status", async (req, res) => {
  const { order_id } = req.params;
  const { status } = req.body;

  const allowed = ["pending", "paid", "failed", "preparing", "delivered"];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${allowed.join(", ")}`,
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE orders SET status = ? WHERE order_id = ?`,
      [status, order_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, message: `Order status updated to '${status}'` });
  } catch (error) {
    console.error("❌ Update order error:", error.message);
    res.status(500).json({ success: false, message: "Failed to update order" });
  }
});

// ================================
// 🗑️ DELETE ORDER
// ================================
router.delete("/:order_id", async (req, res) => {
  const { order_id } = req.params;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [order_id]);
    await conn.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);

    await conn.commit();

    res.json({ success: true, message: "Order deleted successfully" });
  } catch (error) {
    await conn.rollback();
    console.error("❌ Delete order error:", error.message);
    res.status(500).json({ success: false, message: "Failed to delete order" });
  } finally {
    conn.release();
  }
});

module.exports = router;