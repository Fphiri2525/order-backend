const express = require('express');
const db = require('../database');

const router = express.Router();

// ================================
// 🛠️ ERROR LOGGER
// ================================
function errorLog(section, message, error) {
  const timestamp = new Date().toISOString();
  console.error(`\n[${timestamp}] ❌ [${section}] ${message}`);
  console.error('Message:', error?.message);
}

// ================================
// 📦 CREATE DELIVERY
// Called automatically after order is saved
// ================================
router.post('/create', async (req, res) => {
  const {
    order_id,
    rider_name,
    rider_phone,
    location,
    scheduled_date,
    scheduled_time,
  } = req.body;

  if (!order_id) {
    return res.status(400).json({
      success: false,
      message: 'order_id is required',
    });
  }

  try {
    const [orders] = await db.query(
      `SELECT order_id, order_type FROM orders WHERE order_id = ?`,
      [order_id]
    );

    if (orders.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    const [existing] = await db.query(
      `SELECT id FROM deliveries WHERE order_id = ?`,
      [order_id]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Delivery already exists for this order',
      });
    }

    const [result] = await db.query(
      `INSERT INTO deliveries
        (order_id, rider_name, rider_phone, status, location, scheduled_date, scheduled_time)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [
        order_id,
        rider_name     || 'Not Assigned',
        rider_phone    || null,
        location       || null,
        scheduled_date || null,
        scheduled_time || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Delivery created successfully',
      data: {
        delivery_id: result.insertId,
        order_id,
        rider_name: rider_name || 'Not Assigned',
        status: 'pending',
      },
    });

  } catch (error) {
    errorLog('CREATE_DELIVERY', 'Failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create delivery',
      error: error.message,
    });
  }
});

// ================================
// 📋 GET ALL PAID ORDERS WITH DELIVERY INFO
// Only returns orders where payment status = 'successful'
// Optional filters: ?status=pending|on_the_way|delivered
//                   ?order_type=delivery|pickup|dine_in
// ================================
router.get('/orders/paid', async (req, res) => {
  const { status, order_type } = req.query;

  try {
    let query = `
      SELECT
        d.id              AS delivery_id,
        d.order_id,
        d.rider_name,
        d.rider_phone,
        d.status          AS delivery_status,
        d.location,
        d.scheduled_date,
        d.scheduled_time,

        o.user_id,
        o.total_amount,
        o.order_type,
        o.phone,
        o.created_at      AS order_date,
        o.status          AS order_status,

        p.status          AS payment_status,
        p.method          AS payment_method,
        p.tx_ref,

        GROUP_CONCAT(
          CONCAT(m.name, ' x', oi.quantity)
          ORDER BY oi.id
          SEPARATOR ', '
        ) AS items_summary

      FROM deliveries d
      JOIN orders  o  ON d.order_id = o.order_id
      JOIN payments p ON o.order_id = p.order_id
      JOIN order_items oi ON o.order_id = oi.order_id
      LEFT JOIN menu_items m ON oi.menu_id = m.id

      WHERE p.status = 'successful'
    `;

    const params = [];

    if (status) {
      query += ` AND d.status = ?`;
      params.push(status);
    }

    if (order_type) {
      query += ` AND o.order_type = ?`;
      params.push(order_type);
    }

    query += ` GROUP BY d.id ORDER BY d.id DESC`;

    const [rows] = await db.query(query, params);

    res.json({
      success: true,
      total: rows.length,
      orders: rows.map(row => ({
        delivery_id:      row.delivery_id,
        order_id:         row.order_id,
        order_type:       row.order_type,
        order_status:     row.order_status,
        order_date:       row.order_date,
        phone:            row.phone,
        total_amount:     parseFloat(row.total_amount),
        items_summary:    row.items_summary,

        delivery: {
          status:         row.delivery_status,
          rider_name:     row.rider_name,
          rider_phone:    row.rider_phone,
          location:       row.location,
          scheduled_date: row.scheduled_date,
          scheduled_time: row.scheduled_time,
        },

        payment: {
          status:  row.payment_status,
          method:  row.payment_method,
          tx_ref:  row.tx_ref,
        },
      })),
    });

  } catch (error) {
    errorLog('GET_PAID_ORDERS', 'Failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch paid orders',
      error: error.message,
    });
  }
});

// ================================
// 📋 GET DELIVERY BY ORDER ID
// ================================
router.get('/order/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const [deliveries] = await db.query(
      `SELECT * FROM deliveries WHERE order_id = ?`,
      [orderId]
    );

    if (deliveries.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found for this order',
      });
    }

    res.json({
      success: true,
      delivery: deliveries[0],
    });

  } catch (error) {
    errorLog('GET_DELIVERY', 'Failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch delivery',
    });
  }
});

// ================================
// 📋 GET ALL DELIVERIES (raw, no payment filter)
// Optional: ?status=pending|on_the_way|delivered
// ================================
router.get('/', async (req, res) => {
  const { status } = req.query;

  try {
    let query = `SELECT * FROM deliveries`;
    const params = [];

    if (status) {
      query += ` WHERE status = ?`;
      params.push(status);
    }

    query += ` ORDER BY id DESC`;

    const [deliveries] = await db.query(query, params);

    res.json({
      success: true,
      total: deliveries.length,
      deliveries,
    });

  } catch (error) {
    errorLog('GET_ALL_DELIVERIES', 'Failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch deliveries',
    });
  }
});

// ================================
// ✏️ UPDATE DELIVERY STATUS
// ================================
router.patch('/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;

  const allowed = ['pending', 'on_the_way', 'delivered'];

  if (!status || !allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${allowed.join(', ')}`,
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE deliveries SET status = ? WHERE order_id = ?`,
      [status, orderId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found',
      });
    }

    res.json({
      success: true,
      message: `Delivery status updated to '${status}'`,
      data: { order_id: orderId, status },
    });

  } catch (error) {
    errorLog('UPDATE_STATUS', 'Failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery status',
    });
  }
});

// ================================
// ✏️ ASSIGN RIDER TO DELIVERY
// ================================
router.patch('/assign/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { rider_name, rider_phone, scheduled_date, scheduled_time } = req.body;

  if (!rider_name) {
    return res.status(400).json({
      success: false,
      message: 'rider_name is required',
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE deliveries
       SET
         rider_name     = ?,
         rider_phone    = ?,
         scheduled_date = ?,
         scheduled_time = ?,
         status         = 'on_the_way'
       WHERE order_id = ?`,
      [
        rider_name,
        rider_phone    || null,
        scheduled_date || null,
        scheduled_time || null,
        orderId,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found',
      });
    }

    res.json({
      success: true,
      message: `Rider '${rider_name}' assigned successfully`,
      data: {
        order_id: orderId,
        rider_name,
        status: 'on_the_way',
      },
    });

  } catch (error) {
    errorLog('ASSIGN_RIDER', 'Failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign rider',
    });
  }
});

module.exports = router;