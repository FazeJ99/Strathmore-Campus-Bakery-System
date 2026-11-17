const mysql = require('mysql2');

// If running on cloud, use Cloud credentials; otherwise use localhost
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',       // Your local MySQL password
    database: process.env.DB_NAME || 'campus_bakery_db',
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();

console.log(`✅ Database pool initialized (Host: ${process.env.DB_HOST || 'localhost'})`);
