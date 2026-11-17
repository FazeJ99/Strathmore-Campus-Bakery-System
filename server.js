const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- HELPER: AUDIT TRAIL LOGGER ---
async function logAudit(userId, action, details) {
    try {
        await db.query(
            'INSERT INTO audit_logs (user_id, action, details) VALUES (?, ?, ?)',
            [userId || null, action, details]
        );
    } catch (e) {
        console.error('Audit Log Error:', e.message);
    }
}

// --- 1. AUTHENTICATION & ACCESS CONTROL ---

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { full_name, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            'INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)',
            [full_name, email, hashedPassword]
        );
        await logAudit(result.insertId, 'USER_REGISTER', `New user registered: ${email}`);
        res.status(201).json({ message: "Account created successfully!" });
    } catch (err) {
        res.status(500).json({ error: "Email already exists or database error." });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) return res.status(401).json({ error: "Invalid email" });
        
        const valid = await bcrypt.compare(password, users[0].password_hash);
        if (!valid) return res.status(401).json({ error: "Wrong password" });

        await logAudit(users[0].user_id, 'USER_LOGIN', `Successful login: ${email}`);
        res.json({ 
            user_id: users[0].user_id, 
            full_name: users[0].full_name, 
            role: users[0].role 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// Password Reset (Forgot Password Facility)
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email, new_password } = req.body;
        const [users] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(404).json({ error: "Account not found." });

        const newHash = await bcrypt.hash(new_password || 'password123', 10);
        await db.query('UPDATE users SET password_hash = ? WHERE email = ?', [newHash, email]);
        await logAudit(users[0].user_id, 'PASSWORD_RESET', `Password reset for: ${email}`);

        res.json({ success: true, message: "Password updated successfully to temporary password!" });
    } catch (err) {
        res.status(500).json({ error: "Reset failed." });
    }
});

// --- 2. PRODUCT MANAGEMENT (CRUD) ---

app.get('/api/products', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM products WHERE is_available = 1');
    res.json(rows);
});

app.post('/api/products/manage', async (req, res) => {
    const { product_id, name, description, category, price, stock_qty, image_url } = req.body;
    if (product_id) {
        await db.query(
            'UPDATE products SET name=?, description=?, category=?, price=?, stock_qty=?, image_url=? WHERE product_id=?',
            [name, description, category, price, stock_qty, image_url, product_id]
        );
        await logAudit(null, 'PRODUCT_UPDATE', `Updated product: ${name} (ID: ${product_id})`);
    } else {
        const [resProd] = await db.query(
            'INSERT INTO products (name, description, category, price, stock_qty, image_url) VALUES (?,?,?,?,?,?)',
            [name, description, category, price, stock_qty, image_url]
        );
        await logAudit(null, 'PRODUCT_CREATE', `Created product: ${name} (ID: ${resProd.insertId})`);
    }
    res.json({ success: true });
});

app.delete('/api/products/:id', async (req, res) => {
    await db.query('DELETE FROM products WHERE product_id = ?', [req.params.id]);
    await logAudit(null, 'PRODUCT_DELETE', `Deleted product ID: ${req.params.id}`);
    res.json({ success: true });
});

// --- 3. ACID ORDER TRANSACTION ---

app.post('/api/orders/place', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { user_id, items, total_price, payment_method, pickup_time } = req.body;

        // 1. Stock Check & Row Locking
        for (let item of items) {
            const [prod] = await connection.query(
                'SELECT stock_qty, name FROM products WHERE product_id = ? FOR UPDATE', 
                [item.product_id]
            );
            if (!prod[0] || prod[0].stock_qty < item.quantity) {
                throw new Error(`Insufficient kitchen stock for ${prod[0] ? prod[0].name : 'selected item'}`);
            }
            await connection.query(
                'UPDATE products SET stock_qty = stock_qty - ? WHERE product_id = ?', 
                [item.quantity, item.product_id]
            );
        }

        // 2. Insert Order Header
        const payStatus = (payment_method === 'Cash on Pickup') ? 'Pending' : 'Paid';
        const [orderResult] = await connection.query(
            'INSERT INTO orders (user_id, total_price, payment_method, payment_status, pickup_time) VALUES (?, ?, ?, ?, ?)',
            [user_id, total_price, payment_method, payStatus, pickup_time]
        );
        const orderId = orderResult.insertId;

        // 3. Insert Order Line Items
        for (let item of items) {
            await connection.query(
                'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
                [orderId, item.product_id, item.quantity, item.price]
            );
        }

        await connection.commit();
        await logAudit(user_id, 'ORDER_PLACED', `Order #${orderId} placed (Ksh ${total_price}, ${payment_method})`);
        res.json({ success: true, order_id: orderId });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// --- 4. TRACKING, REPORTS & ADMIN AUDIT QUEUE ---

app.get('/api/orders/track/:orderId', async (req, res) => {
    const [rows] = await db.query('SELECT status, payment_status FROM orders WHERE order_id = ?', [req.params.orderId]);
    res.json(rows[0]);
});

app.get('/api/admin/orders', async (req, res) => {
    const query = `
        SELECT o.*, u.full_name, 
        GROUP_CONCAT(CONCAT(p.name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items_summary
        FROM orders o
        JOIN users u ON o.user_id = u.user_id
        JOIN order_items oi ON o.order_id = oi.order_id
        JOIN products p ON oi.product_id = p.product_id
        GROUP BY o.order_id
        ORDER BY o.created_at DESC
    `;
    const [rows] = await db.query(query);
    res.json(rows);
});

app.patch('/api/admin/orders/:id', async (req, res) => {
    const { status, payment_status } = req.body;
    if (status) await db.query('UPDATE orders SET status = ? WHERE order_id = ?', [status, req.params.id]);
    if (payment_status) await db.query('UPDATE orders SET payment_status = ? WHERE order_id = ?', [payment_status, req.params.id]);
    
    await logAudit(null, 'ORDER_UPDATE', `Order #${req.params.id} updated: Status=${status || 'unchanged'}, Payment=${payment_status || 'unchanged'}`);
    res.json({ success: true });
});

// Audit Trail Retrieval Endpoint
app.get('/api/admin/audit-trail', async (req, res) => {
    const [logs] = await db.query(`
        SELECT a.*, u.email as user_email 
        FROM audit_logs a 
        LEFT JOIN users u ON a.user_id = u.user_id 
        ORDER BY a.created_at DESC 
        LIMIT 50
    `);
    res.json(logs);
});

// --- SERVER INITIALIZATION ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 CBOOS Backend Server Active on Port ${PORT}`);
    console.log(`🔗 Student Storefront: http://localhost:${PORT}`);
    console.log(`🔗 Staff Admin Portal: http://localhost:${PORT}/admin.html`);
    console.log(`======================================================\n`);
});