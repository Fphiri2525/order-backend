const express = require('express');
const db = require('../database');

const router = express.Router();

// ================================
// 📋 GET ALL ITEMS FOR AN ORDER
// ================================
router.get("/:order_id", async (req, res) => {
  const { order_id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT oi.*, m.name AS menu_name, m.image AS menu_image
       FROM order_items oi
       LEFT JOIN menu m ON oi.menu_id = m.id
       WHERE oi.order_id = ?`,
      [order_id]
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("❌ Get order items error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch order items" });
  }
});

// ================================
// ➕ ADD ITEM TO AN ORDER
// ================================
router.post("/", async (req, res) => {
  const { order_id, menu_id, quantity, price } = req.body;

  if (!order_id || !menu_id || !quantity || !price) {
    return res.status(400).json({
      success: false,
      message: "order_id, menu_id, quantity, and price are required",
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
      `INSERT INTO order_items (order_id, menu_id, quantity, price)
       VALUES (?, ?, ?, ?)`,
      [order_id, menu_id, quantity, price]
    );

    res.status(201).json({
      success: true,
      message: "Item added to order",
      data: { id: result.insertId, order_id, menu_id, quantity, price },
    });
  } catch (error) {
    console.error("❌ Add order item error:", error.message);
    res.status(500).json({ success: false, message: "Failed to add item" });
  }
});

// ================================
// ✏️ UPDATE ITEM QUANTITY
// ================================
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;

  if (!quantity || quantity < 1) {
    return res.status(400).json({
      success: false,
      message: "quantity must be at least 1",
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE order_items SET quantity = ? WHERE id = ?`,
      [quantity, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    res.json({ success: true, message: "Item quantity updated" });
  } catch (error) {
    console.error("❌ Update item error:", error.message);
    res.status(500).json({ success: false, message: "Failed to update item" });
  }
});

// ================================
// 🗑️ DELETE AN ITEM
// ================================
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      `DELETE FROM order_items WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    res.json({ success: true, message: "Item removed from order" });
  } catch (error) {
    console.error("❌ Delete item error:", error.message);
    res.status(500).json({ success: false, message: "Failed to delete item" });
  }
});

module.exports = router;