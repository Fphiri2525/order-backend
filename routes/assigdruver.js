const express = require('express');
const db = require('../database');
const { sendEmail } = require('../lib/email');

const router = express.Router();

/**
 * Assign Rider to an Order
 * POST /api/assign-driver/assign-rider
 */
router.post('/assign-rider', async (req, res) => {
  const { order_id, rider_name, rider_phone, rider_email } = req.body;

  try {
    // Validation
    if (!order_id || !rider_name || !rider_phone || !rider_email) {
      return res.status(400).json({
        success: false,
        message: 'order_id, rider_name, rider_phone and rider_email are required'
      });
    }

    // Check if order exists
    const [delivery] = await db.query(
      'SELECT * FROM deliveries WHERE order_id = ?',
      [order_id]
    );

    if (delivery.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Assign rider
    await db.query(
      'UPDATE deliveries SET rider_name = ?, rider_phone = ?, status = ? WHERE order_id = ?',
      [rider_name, rider_phone, 'on_the_way', order_id]
    );

    // Get updated delivery
    const [updated] = await db.query(
      `SELECT
        id,
        order_id,
        rider_name,
        rider_phone,
        status,
        location,
        scheduled_date,
        scheduled_time
      FROM deliveries
      WHERE order_id = ?`,
      [order_id]
    );

    // Send email to the rider notifying them of the assignment
    sendEmail({
      to: rider_email,
      subject: `New delivery assigned: Order ${order_id}`,
      html: `
        <p>Hi ${rider_name},</p>
        <p>You have been assigned to deliver <strong>Order ${order_id}</strong>.</p>
        <p>Please go and collect the order as soon as possible.</p>
        <p><strong>Pickup/Delivery location:</strong> ${updated[0].location || 'N/A'}</p>
        <p><strong>Scheduled date:</strong> ${updated[0].scheduled_date || 'N/A'} ${updated[0].scheduled_time || ''}</p>
        <p>Thanks,<br/>Delivery Team</p>
      `,
    }).catch((err) => console.error('Rider assignment email failed:', err));

    return res.status(200).json({
      success: true,
      message: 'Rider assigned successfully',
      data: updated[0]
    });

  } catch (error) {
    console.error('Assign Rider Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to assign rider',
      error: error.message
    });
  }
});

module.exports = router;