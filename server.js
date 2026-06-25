const express = require('express');
const path = require('path');
const app = express();

require('dotenv').config();

app.use(express.json());

// ─── SERVE STATIC FILES (IMAGES) ─────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── ROUTES ──────────────────────────────────────────────
const userRoutes = require('./routes/users');
const menuRoutes = require('./routes/menu');
const paymentRoutes = require('./routes/payments');
const orderRoutes = require('./routes/orders');
const orderItemRoutes = require('./routes/order_items');
const deliveryRoutes = require('./routes/deliveries');
const statisticsRoutes = require('./routes/Statistics');

const orderManagementRoutes = require('./routes/orderManagement');
const paymentmanagementRoutes = require('./routes/paymentmanagement');

// NEW: Chef Routes
const chelfRoutes = require('./routes/chelf');

// NEW: Assign Driver Routes
const assignDriverRoutes = require('./routes/assigdruver');

// ─── REGISTER ROUTES ─────────────────────s────────────────
app.use('/api/users', userRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/order-items', orderItemRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/statistics', statisticsRoutes);

app.use('/api/order-management', orderManagementRoutes);
app.use('/api/payment-management', paymentmanagementRoutes);

// NEW: Chef Routes
app.use('/api/chelf', chelfRoutes);

// NEW: Assign Driver Routes
app.use('/api/assign-driver', assignDriverRoutes);

// ─── 404 HANDLER ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
  });
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);

  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// ─── START SERVER ────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Uploads folder: ${path.join(__dirname, 'uploads')}`);
  console.log(`📊 Statistics: http://localhost:${PORT}/api/statistics/dashboard`);
  console.log(`📋 Orders Mgmt: http://localhost:${PORT}/api/order-management/orders`);
  console.log(`💳 Payment Mgmt: http://localhost:${PORT}/api/payment-management`);
  console.log(`👨‍🍳 Chef API: http://localhost:${PORT}/api/chelf`);
  console.log(`🚚 Assign Driver API: http://localhost:${PORT}/api/assign-driver/assign-rider`);
});