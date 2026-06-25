const express = require('express');
const router = express.Router();
const db = require('../database');
const { sendEmail } = require('../lib/email');

// Helper function to promisify db.query
const queryAsync = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
};

// ============================================
// GET ORDERS FOR CHEF DASHBOARD
// ============================================

/**
 * Get orders that need chef attention
 * Shows: Item names, User name, Pickup time, Contact number
 */
router.get('/chef-orders', async (req, res) => {
    try {
        console.log('📡 Fetching chef orders...');

        // Get the orders
        const query = `
            SELECT 
                o.order_id,
                o.status AS order_status,
                o.created_at AS order_date,
                u.fullname AS username,
                u.contactnumber,
                d.scheduled_date,
                d.scheduled_time,
                d.status AS delivery_status
            FROM orders o
            LEFT JOIN user u ON o.user_id = u.id
            LEFT JOIN deliveries d ON o.order_id = d.order_id
            WHERE o.status IN ('preparing', 'ready')
            ORDER BY 
                FIELD(o.status, 'preparing', 'ready'),
                o.created_at DESC
        `;

        const results = await queryAsync(query);

        console.log(`✅ Found ${results.length} orders for chef`);

        if (!results || results.length === 0) {
            return res.status(200).json({
                success: true,
                count: 0,
                data: []
            });
        }

        // Get order items for all orders
        const orderIds = results.map(order => order.order_id);
        
        const itemsQuery = `
            SELECT 
                oi.order_id,
                oi.quantity,
                m.name AS item_name
            FROM order_items oi
            LEFT JOIN menu m ON oi.menu_id = m.menu_id
            WHERE oi.order_id IN (?)
        `;

        const itemsResults = await queryAsync(itemsQuery, [orderIds]);

        // Group items by order_id
        const itemsByOrder = {};
        if (itemsResults && itemsResults.length > 0) {
            itemsResults.forEach(item => {
                if (!itemsByOrder[item.order_id]) {
                    itemsByOrder[item.order_id] = [];
                }
                itemsByOrder[item.order_id].push({
                    name: item.item_name || 'Unknown Item',
                    quantity: item.quantity || 1
                });
            });
        }

        // Combine orders with their items
        const ordersWithItems = results.map(order => ({
            order_id: order.order_id,
            username: order.username || 'Customer',
            contactnumber: order.contactnumber || '',
            order_status: order.order_status || 'preparing',
            scheduled_date: order.scheduled_date || null,
            scheduled_time: order.scheduled_time || null,
            delivery_status: order.delivery_status || 'pending',
            order_date: order.order_date,
            items: itemsByOrder[order.order_id] || []
        }));

        res.status(200).json({
            success: true,
            count: ordersWithItems.length,
            data: ordersWithItems
        });

    } catch (error) {
        console.error('❌ Error in /chef-orders:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// ============================================
// GET DELIVERED AND PAID ORDERS (HISTORY)
// ============================================

/**
 * Get delivered and paid orders for history
 */
router.get('/delivered-paid-orders', async (req, res) => {
    try {
        console.log('📡 Fetching delivered and paid orders...');

        const query = `
            SELECT 
                o.order_id,
                o.status AS order_status,
                o.created_at AS order_date,
                u.fullname AS username,
                u.contactnumber,
                d.scheduled_date,
                d.scheduled_time,
                d.status AS delivery_status,
                p.payment_date
            FROM orders o
            LEFT JOIN user u ON o.user_id = u.id
            LEFT JOIN deliveries d ON o.order_id = d.order_id
            LEFT JOIN payments p ON o.order_id = p.order_id
            WHERE o.status = 'delivered'
            AND p.status = 'successful'
            ORDER BY p.payment_date DESC, o.created_at DESC
        `;

        const results = await queryAsync(query);

        console.log(`✅ Found ${results.length} delivered and paid orders`);

        if (!results || results.length === 0) {
            return res.status(200).json({
                success: true,
                count: 0,
                data: []
            });
        }

        // Get order items for all orders
        const orderIds = results.map(order => order.order_id);
        
        const itemsQuery = `
            SELECT 
                oi.order_id,
                oi.quantity,
                m.name AS item_name
            FROM order_items oi
            LEFT JOIN menu m ON oi.menu_id = m.menu_id
            WHERE oi.order_id IN (?)
        `;

        const itemsResults = await queryAsync(itemsQuery, [orderIds]);

        // Group items by order_id
        const itemsByOrder = {};
        if (itemsResults && itemsResults.length > 0) {
            itemsResults.forEach(item => {
                if (!itemsByOrder[item.order_id]) {
                    itemsByOrder[item.order_id] = [];
                }
                itemsByOrder[item.order_id].push({
                    name: item.item_name || 'Unknown Item',
                    quantity: item.quantity || 1
                });
            });
        }

        // Combine orders with their items
        const ordersWithItems = results.map(order => ({
            order_id: order.order_id,
            username: order.username || 'Customer',
            contactnumber: order.contactnumber || '',
            order_status: order.order_status || 'delivered',
            scheduled_date: order.scheduled_date || null,
            scheduled_time: order.scheduled_time || null,
            delivery_status: order.delivery_status || 'delivered',
            order_date: order.order_date,
            payment_date: order.payment_date,
            items: itemsByOrder[order.order_id] || []
        }));

        res.status(200).json({
            success: true,
            count: ordersWithItems.length,
            data: ordersWithItems
        });

    } catch (error) {
        console.error('❌ Error in /delivered-paid-orders:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// ============================================
// UPDATE ORDER STATUS (CHEF ACTIONS)
// ============================================

/**
 * Update order status - Chef can update from 'preparing' to 'ready'
 * When status becomes 'ready', the customer is notified by email.
 */
router.patch('/order/:orderId/status', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;

        console.log(`📥 [order-status] Incoming request -> orderId: ${orderId}, requestedStatus: ${status}`);

        if (!status) {
            console.log('⚠️ [order-status] No status provided in request body');
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        // Validate status - Chef can only set to 'ready' or 'preparing'
        const validStatuses = ['preparing', 'ready'];
        if (!validStatuses.includes(status)) {
            console.log(`⚠️ [order-status] Rejected invalid status "${status}" for order ${orderId}`);
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Chef can only set status to: preparing, ready'
            });
        }

        const query = 'UPDATE orders SET status = ? WHERE order_id = ?';
        const result = await queryAsync(query, [status, orderId]);

        console.log(`📝 [order-status] UPDATE result for order ${orderId}:`, {
            affectedRows: result.affectedRows,
            changedRows: result.changedRows
        });

        if (result.affectedRows === 0) {
            console.log(`⚠️ [order-status] Order ${orderId} not found, affectedRows was 0`);
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        console.log(`✅ Order ${orderId} status updated to ${status}`);

        // If the order just became "ready", notify the customer by email
        console.log(`🔎 [order-ready-email] Checking if email notification should fire. status === 'ready' -> ${status === 'ready'}`);

        if (status === 'ready') {
            console.log(`📧 [order-ready-email] Entered email branch for order ${orderId}`);
            try {
                const customerQuery = `
                    SELECT u.fullname AS username, u.email AS customer_email
                    FROM orders o
                    LEFT JOIN user u ON o.user_id = u.id
                    WHERE o.order_id = ?
                `;

                console.log(`🔎 [order-ready-email] Looking up customer email for order ${orderId}...`);
                const customerResult = await queryAsync(customerQuery, [orderId]);
                console.log(`🔎 [order-ready-email] customerQuery returned ${customerResult ? customerResult.length : 0} row(s):`, customerResult);

                const customer = customerResult[0];

                if (customer && customer.customer_email) {
                    console.log(`📧 [order-ready-email] Sending "order ready" email to ${customer.customer_email} (username: ${customer.username || 'N/A'}) for order ${orderId}`);

                    sendEmail({
                        to: customer.customer_email,
                        subject: `Your order ${orderId} is ready!`,
                        html: `
                            <p>Hi ${customer.username || 'there'},</p>
                            <p>Good news — your order <strong>${orderId}</strong> is now ready!</p>
                            <p>A rider will be assigned shortly to deliver it to you.</p>
                            <p>Thanks for ordering with us!</p>
                        `,
                    })
                        .then((sendResult) => {
                            console.log(`✅ [order-ready-email] sendEmail resolved for order ${orderId}:`, sendResult);
                        })
                        .catch((err) => {
                            console.error(`❌ [order-ready-email] sendEmail failed for order ${orderId}:`, err);
                        });
                } else {
                    console.warn(`⚠️ No email found for customer on order ${orderId}, skipping notification`);
                    console.warn(`⚠️ [order-ready-email] customer row was:`, customer);
                }
            } catch (emailLookupError) {
                console.error('❌ Error looking up customer email:', emailLookupError);
                console.error(`❌ [order-ready-email] Full error for order ${orderId}:`, {
                    message: emailLookupError.message,
                    stack: emailLookupError.stack
                });
                // don't fail the status update just because the email lookup failed
            }
        } else {
            console.log(`ℹ️ [order-ready-email] Skipping email, new status was "${status}" not "ready"`);
        }

        res.status(200).json({
            success: true,
            message: `Order status updated to ${status} successfully`
        });

    } catch (error) {
        console.error('❌ Error updating order status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update order status',
            error: error.message
        });
    }
});

// ============================================
// GET SINGLE ORDER WITH DETAILS
// ============================================

/**
 * Get a single order with all details
 */
router.get('/order/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;

        const query = `
            SELECT 
                o.order_id,
                o.status AS order_status,
                o.created_at AS order_date,
                u.fullname AS username,
                u.contactnumber,
                d.scheduled_date,
                d.scheduled_time,
                d.status AS delivery_status
            FROM orders o
            LEFT JOIN user u ON o.user_id = u.id
            LEFT JOIN deliveries d ON o.order_id = d.order_id
            WHERE o.order_id = ?
        `;

        const results = await queryAsync(query, [orderId]);

        if (results.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        const order = results[0];

        // Get order items
        const itemsQuery = `
            SELECT 
                oi.quantity,
                m.name AS item_name
            FROM order_items oi
            LEFT JOIN menu m ON oi.menu_id = m.menu_id
            WHERE oi.order_id = ?
        `;

        const itemsResults = await queryAsync(itemsQuery, [orderId]);

        const items = itemsResults.map(item => ({
            name: item.item_name || 'Unknown Item',
            quantity: item.quantity || 1
        }));

        res.status(200).json({
            success: true,
            data: {
                order_id: order.order_id,
                username: order.username || 'Customer',
                contactnumber: order.contactnumber || '',
                order_status: order.order_status || 'preparing',
                scheduled_date: order.scheduled_date || null,
                scheduled_time: order.scheduled_time || null,
                delivery_status: order.delivery_status || 'pending',
                order_date: order.order_date,
                items: items
            }
        });

    } catch (error) {
        console.error('❌ Error fetching order:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch order',
            error: error.message
        });
    }
});

// ============================================
// GET ORDERS BY STATUS (FOR CHEF FILTERING)
// ============================================

/**
 * Get orders by specific status
 */
router.get('/orders/status/:status', async (req, res) => {
    try {
        const { status } = req.params;
        
        // Validate status
        const validStatuses = ['preparing', 'ready', 'delivered'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be: preparing, ready, or delivered'
            });
        }

        const query = `
            SELECT 
                o.order_id,
                o.status AS order_status,
                o.created_at AS order_date,
                u.fullname AS username,
                u.contactnumber,
                d.scheduled_date,
                d.scheduled_time,
                d.status AS delivery_status
            FROM orders o
            LEFT JOIN user u ON o.user_id = u.id
            LEFT JOIN deliveries d ON o.order_id = d.order_id
            WHERE o.status = ?
            ORDER BY o.created_at DESC
        `;

        const results = await queryAsync(query, [status]);

        if (!results || results.length === 0) {
            return res.status(200).json({
                success: true,
                count: 0,
                data: []
            });
        }

        // Get order items
        const orderIds = results.map(order => order.order_id);
        const itemsQuery = `
            SELECT 
                oi.order_id,
                oi.quantity,
                m.name AS item_name
            FROM order_items oi
            LEFT JOIN menu m ON oi.menu_id = m.menu_id
            WHERE oi.order_id IN (?)
        `;

        const itemsResults = await queryAsync(itemsQuery, [orderIds]);

        const itemsByOrder = {};
        if (itemsResults && itemsResults.length > 0) {
            itemsResults.forEach(item => {
                if (!itemsByOrder[item.order_id]) {
                    itemsByOrder[item.order_id] = [];
                }
                itemsByOrder[item.order_id].push({
                    name: item.item_name || 'Unknown Item',
                    quantity: item.quantity || 1
                });
            });
        }

        const ordersWithItems = results.map(order => ({
            order_id: order.order_id,
            username: order.username || 'Customer',
            contactnumber: order.contactnumber || '',
            order_status: order.order_status,
            scheduled_date: order.scheduled_date || null,
            scheduled_time: order.scheduled_time || null,
            delivery_status: order.delivery_status || 'pending',
            order_date: order.order_date,
            items: itemsByOrder[order.order_id] || []
        }));

        res.status(200).json({
            success: true,
            count: ordersWithItems.length,
            data: ordersWithItems
        });

    } catch (error) {
        console.error('❌ Error fetching orders by status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch orders',
            error: error.message
        });
    }
});

module.exports = router;