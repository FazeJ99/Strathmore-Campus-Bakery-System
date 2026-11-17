const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 4000,
    // Enhanced SSL settings for TiDB + Render
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 20000 // Give it 20 seconds to connect
});

const promisePool = pool.promise();

// Diagnostic check: Test the connection on boot
promisePool.query('SELECT 1')
    .then(() => console.log('✅ DATABASE CONNECTED SUCCESSFULLY'))
    .catch(err => console.error('❌ DATABASE CONNECTION FAILED:', err.message));

module.exports = promisePool;