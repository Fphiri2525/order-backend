require('dotenv').config();
const mysql = require('mysql2');

// Debug env (safe logging)
console.log('🔹 Loading environment variables...');
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '(set)' : '(empty)');

// Create MySQL connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restaurant_order',

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    // Important for prices, emojis, food names
    charset: 'utf8mb4',

    // Prevent timezone issues
    timezone: 'Z'
});

// Promise-based pool (BEST for async/await)
const db = pool.promise();

// Test database connection on startup
(async () => {
    try {
        const connection = await db.getConnection();
        console.log('✅ Database connected successfully:', process.env.DB_NAME);
        connection.release();
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        process.exit(1);
    }
})();

module.exports = db;
