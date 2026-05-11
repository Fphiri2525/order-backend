const express = require('express');
const path = require('path'); // Add this
const app = express();
require('dotenv').config();

app.use(express.json());

// ─── SERVE STATIC FILES (IMAGES) ─────────────
// THIS IS CRITICAL - It makes uploaded images accessible
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── ROUTES ─────────────────────────────
const userRoutes      = require('./routes/users');
const menuRoutes      = require('./routes/menu');
const paymentRoutes   = require('./routes/payments');
const orderRoutes     = require('./routes/orders');
const orderItemRoutes = require('./routes/order_items');
const deliveryRoutes  = require('./routes/deliveries');

app.use('/api/users',       userRoutes);
app.use('/api/menu',        menuRoutes);
app.use('/api/payments',    paymentRoutes);
app.use('/api/orders',      orderRoutes);
app.use('/api/order-items', orderItemRoutes);
app.use('/api/deliveries',  deliveryRoutes);

// ─── 404 HANDLER ────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── GLOBAL ERROR HANDLER ───────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ─── START SERVER ───────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {  // Changed to '0.0.0.0' to allow network access
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Uploads folder: ${path.join(__dirname, 'uploads')}`);
});