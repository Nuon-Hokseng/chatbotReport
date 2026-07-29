require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE,
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS authorized_users (
                chat_id VARCHAR(255) PRIMARY KEY
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS secrets (
                code VARCHAR(255) PRIMARY KEY
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                user_id VARCHAR(255) PRIMARY KEY,
                state JSONB NOT NULL
            );
        `);

        console.log('✅ Database tables verified.');

        // Initialize admin if not exists
        if (process.env.ACC_ID) {
            await pool.query(
                `INSERT INTO authorized_users (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING`,
                [String(process.env.ACC_ID)]
            );
        }

        // Initialize 10 secrets if secrets table is completely empty
        const secretsRes = await pool.query('SELECT COUNT(*) FROM secrets');
        if (parseInt(secretsRes.rows[0].count) === 0) {
            const fs = require('fs');
            const path = require('path');
            const secretsPath = path.join(__dirname, 'secrets.json');
            
            if (fs.existsSync(secretsPath)) {
                // Migrate from file if it exists
                const codes = JSON.parse(fs.readFileSync(secretsPath));
                for (const code of codes) {
                    await pool.query('INSERT INTO secrets (code) VALUES ($1) ON CONFLICT DO NOTHING', [code]);
                }
                console.log('✅ Migrated secrets from secrets.json');
            } else {
                // Generate new codes if neither exists
                const crypto = require('crypto');
                for (let i = 0; i < 10; i++) {
                    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
                    await pool.query('INSERT INTO secrets (code) VALUES ($1) ON CONFLICT DO NOTHING', [code]);
                }
                console.log('✅ Generated 10 new secrets directly into DB');
            }
        }
    } catch (err) {
        console.error('❌ Failed to initialize database:', err);
    }
}

module.exports = {
    pool,
    initDB
};
