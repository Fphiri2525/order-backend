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

  console.log(`📥 [assign-rider] Incoming request -> order_id: ${order_id}, rider_name: ${rider_name}, rider_phone: ${rider_phone}, rider_email: ${rider_email}`);

  try {
    // Validation
    if (!order_id || !rider_name || !rider_phone || !rider_email) {
      console.log('⚠️ [assign-rider] Missing required field(s) in request body');
      return res.status(400).json({
        success: false,
        message: 'order_id, rider_name, rider_phone and rider_email are required'
      });
    }

    // Check if order exists
    console.log(`🔎 [assign-rider] Looking up delivery for order_id: ${order_id}...`);
    const [delivery] = await db.query(
      'SELECT * FROM deliveries WHERE order_id = ?',
      [order_id]
    );

    console.log(`🔎 [assign-rider] Delivery lookup returned ${delivery.length} row(s)`);

    if (delivery.length === 0) {
      console.log(`⚠️ [assign-rider] No delivery found for order_id: ${order_id}`);
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Assign rider
    console.log(`📝 [assign-rider] Updating deliveries row for order_id: ${order_id} -> rider: ${rider_name}, status: on_the_way`);
    const updateResult = await db.query(
      'UPDATE deliveries SET rider_name = ?, rider_phone = ?, status = ? WHERE order_id = ?',
      [rider_name, rider_phone, 'on_the_way', order_id]
    );
    console.log(`📝 [assign-rider] UPDATE result for order ${order_id}:`, {
      affectedRows: updateResult.affectedRows,
      changedRows: updateResult.changedRows
    });

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

    console.log(`✅ [assign-rider] Rider ${rider_name} successfully assigned to order ${order_id}. Updated row:`, updated[0]);

    // Send email to the rider notifying them of the assignment
    console.log(`📧 [assign-rider] Sending assignment email to ${rider_email} for order ${order_id}...`);

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
    })
      .then((sendResult) => {
        console.log(`✅ [assign-rider] Email sent successfully to ${rider_email} for order ${order_id}:`, sendResult);
      })
      .catch((err) => {
        console.error(`❌ [assign-rider] Email FAILED to send to ${rider_email} for order ${order_id}:`, err);
      });

    return res.status(200).json({
      success: true,
      message: 'Rider assigned successfully',
      data: updated[0]
    });

  } catch (error) {
    console.error(`❌ [assign-rider] Assign Rider Error for order ${order_id}:`, error);

    return res.status(500).json({
      success: false,
      message: 'Failed to assign rider',
      error: error.message
    });
  }
});

module.exports = router;