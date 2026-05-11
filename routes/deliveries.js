const express = require('express');
const db = require('../database');

const router = express.Router();

// ================================
// 📋 GET ALL DELIVERIES
// ================================
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.*, o.user_id, o.total_amount, o.order_type
      FROM deliveries d
      LEFT JOIN orders o ON d.order_id = o.order_id
      ORDER BY d.id DESC
    `);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("❌ Get deliveries error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch deliveries" });
  }
});

// ================================
// 🔍 GET DELIVERY BY ORDER ID
// ================================
router.get("/:order_id", async (req, res) => {
  const { order_id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT * FROM deliveries WHERE order_id = ?`,
      [order_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error("❌ Get delivery error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch delivery" });
  }
});

// ================================
// 🚴 CREATE DELIVERY
// ================================
router.post("/", async (req, res) => {
  const { order_id, rider_name, rider_phone, location } = req.body;

  if (!order_id || !location) {
    return res.status(400).json({
      success: false,
      message: "order_id and location are required",
    });
  }

  try {
    // Check order exists
    const [orders] = await db.query(
      `SELECT id FROM orders WHERE order_id = ?`,
      [order_id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const [result] = await db.query(
      `INSERT INTO deliveries (order_id, rider_name, rider_phone, status, location)
       VALUES (?, ?, ?, 'pending', ?)`,
      [order_id, rider_name || null, rider_phone || null, location]
    );

    console.log("🚴 Delivery created for order:", order_id);

    res.status(201).json({
      success: true,
      message: "Delivery created successfully",
      data: {
        id: result.insertId,
        order_id,
        rider_name,
        rider_phone,
        status: "pending",
        location,
      },
    });
  } catch (error) {
    console.error("❌ Create delivery error:", error.message);
    res.status(500).json({ success: false, message: "Failed to create delivery" });
  }
});

// ================================
// ✏️ UPDATE DELIVERY STATUS
// ================================
router.patch("/:order_id/status", async (req, res) => {
  const { order_id } = req.params;
  const { status, rider_name, rider_phone, location } = req.body;

  const allowed = ["pending", "on_the_way", "delivered"];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${allowed.join(", ")}`,
    });
  }

  try {
    // Build dynamic update
    const fields = [];
    const values = [];

    if (status) { fields.push("status = ?"); values.push(status); }
    if (rider_name) { fields.push("rider_name = ?"); values.push(rider_name); }
    if (rider_phone) { fields.push("rider_phone = ?"); values.push(rider_phone); }
    if (location) { fields.push("location = ?"); values.push(location); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(order_id);

    const [result] = await db.query(
      `UPDATE deliveries SET ${fields.join(", ")} WHERE order_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    // If delivered, also update order status
    if (status === "delivered") {
      await db.query(
        `UPDATE orders SET status = 'delivered' WHERE order_id = ?`,
        [order_id]
      );
    }

    res.json({ success: true, message: "Delivery updated successfully" });
  } catch (error) {
    console.error("❌ Update delivery error:", error.message);
    res.status(500).json({ success: false, message: "Failed to update delivery" });
  }
});

// ================================
// 🗑️ DELETE DELIVERY
// ================================
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      `DELETE FROM deliveries WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    res.json({ success: true, message: "Delivery deleted successfully" });
  } catch (error) {
    console.error("❌ Delete delivery error:", error.message);
    res.status(500).json({ success: false, message: "Failed to delete delivery" });
  }
});

module.exports = router;