const bcrypt = require('bcryptjs');
const db = require('./db');

async function fix() {
    try {
        console.log("🛠️  Repairing passwords...");
        
        // Generate a fresh, valid hash for 'password123'
        const newHash = await bcrypt.hash('password123', 10);

        // Update both the Admin and the Student to use this exact hash
        await db.query('UPDATE users SET password_hash = ? WHERE email IN (?, ?)', 
            [newHash, 'admin@bakery.com', 'john@student.com']
        );

        console.log("✅ Passwords fixed! Both accounts now use: password123");
        process.exit();
    } catch (err) {
        console.error("❌ Error fixing passwords:", err);
        process.exit(1);
    }
}

fix();