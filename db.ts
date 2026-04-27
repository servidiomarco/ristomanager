import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

// const pool = new Pool({
//   user: 'postgres',
//   host: 'localhost',
//   database: 'ristomanager',
//   password: 'postgres',
//   port: 5432,
// });
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? {
        rejectUnauthorized: false,
    } : false,
});

// Retry logic for schema creation
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const createSchema = async (retryCount = 0): Promise<void> => {
    let client;
    try {
        client = await pool.connect();
    } catch (connectionError) {
        if (retryCount < MAX_RETRIES) {
            console.log(`Database connection failed, retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await sleep(RETRY_DELAY_MS);
            return createSchema(retryCount + 1);
        }
        throw connectionError;
    }
    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                width INTEGER NOT NULL DEFAULT 800,
                height INTEGER NOT NULL DEFAULT 600
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS tables (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                shape VARCHAR(50) NOT NULL,
                seats INTEGER NOT NULL,
                x INTEGER NOT NULL,
                y INTEGER NOT NULL,
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                status VARCHAR(50) NOT NULL,
                is_locked BOOLEAN DEFAULT false,
                merged_with INTEGER[],
                temp_lock_expires_at TIMESTAMPTZ
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS dishes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                category VARCHAR(100),
                allergens TEXT[]
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS banquet_menus (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price_per_person DECIMAL(10, 2) NOT NULL,
                dish_ids INTEGER[]
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS reservations (
                id SERIAL PRIMARY KEY,
                customer_name VARCHAR(255) NOT NULL,
                reservation_time TIMESTAMPTZ NOT NULL,
                shift VARCHAR(50) NOT NULL,
                guests INTEGER NOT NULL,
                table_id INTEGER REFERENCES tables(id),
                notes TEXT,
                email VARCHAR(255),
                phone VARCHAR(50),
                payment_status VARCHAR(50) NOT NULL,
                deposit_amount DECIMAL(10, 2),
                total_amount DECIMAL(10, 2),
                banquet_menu_id INTEGER REFERENCES banquet_menus(id),
                enable_reminder BOOLEAN DEFAULT true,
                reminder_sent BOOLEAN DEFAULT false,
                arrival_status VARCHAR(50) DEFAULT 'WAITING'
            );
        `);

        // Add arrival_status column to existing tables if it doesn't exist
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'reservations' AND column_name = 'arrival_status'
                ) THEN
                    ALTER TABLE reservations ADD COLUMN arrival_status VARCHAR(50) DEFAULT 'WAITING';
                END IF;
            END $$;
        `);

        // ============================================
        // ACTIVITY LOGS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                user_email VARCHAR(255),
                user_name VARCHAR(255),
                action VARCHAR(50) NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                resource_id INTEGER,
                resource_name VARCHAR(255),
                details JSONB,
                status VARCHAR(20) DEFAULT 'SUCCESS',
                error_message TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create indexes for activity_logs (if not exists)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_logs_resource_type ON activity_logs(resource_type);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
        `);

        // ============================================
        // USERS TABLE FOR AUTHENTICATION
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'WAITER', 'KITCHEN')),
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMPTZ,
                refresh_token_hash VARCHAR(255)
            );
        `);

        // ============================================
        // ROLE PERMISSIONS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS role_permissions (
                id SERIAL PRIMARY KEY,
                role VARCHAR(50) NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'WAITER', 'KITCHEN')),
                permission VARCHAR(100) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(role, permission)
            );
        `);

        // Seed default owner account if no users exist
        const userCount = await client.query('SELECT COUNT(*) FROM users');
        if (parseInt(userCount.rows[0].count) === 0) {
            const defaultPassword = process.env.DEFAULT_OWNER_PASSWORD || 'admin123';
            const salt = await bcrypt.genSalt(12);
            const passwordHash = await bcrypt.hash(defaultPassword, salt);

            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role)
                 VALUES ($1, $2, $3, $4)`,
                ['admin@ristomanager.com', passwordHash, 'Admin Owner', 'OWNER']
            );
            console.log('Default owner account created: admin@ristomanager.com');
        }

        // Seed default role permissions if none exist
        const permCount = await client.query('SELECT COUNT(*) FROM role_permissions');
        if (parseInt(permCount.rows[0].count) === 0) {
            const defaultPermissions = [
                // OWNER - all permissions
                ['OWNER', 'dashboard:view'], ['OWNER', 'dashboard:full'],
                ['OWNER', 'floorplan:view'], ['OWNER', 'floorplan:update_status'], ['OWNER', 'floorplan:full'],
                ['OWNER', 'menu:view'], ['OWNER', 'menu:full'],
                ['OWNER', 'reservations:view'], ['OWNER', 'reservations:full'],
                ['OWNER', 'settings:view'], ['OWNER', 'settings:full'],
                ['OWNER', 'users:view'], ['OWNER', 'users:full'],
                ['OWNER', 'reports:view'], ['OWNER', 'reports:full'],
                ['OWNER', 'logs:view'], ['OWNER', 'logs:full'],
                // MANAGER
                ['MANAGER', 'dashboard:view'], ['MANAGER', 'dashboard:full'],
                ['MANAGER', 'floorplan:view'], ['MANAGER', 'floorplan:update_status'], ['MANAGER', 'floorplan:full'],
                ['MANAGER', 'menu:view'], ['MANAGER', 'menu:full'],
                ['MANAGER', 'reservations:view'], ['MANAGER', 'reservations:full'],
                ['MANAGER', 'reports:view'],
                ['MANAGER', 'logs:view'],
                // WAITER
                ['WAITER', 'dashboard:view'],
                ['WAITER', 'floorplan:view'], ['WAITER', 'floorplan:update_status'],
                ['WAITER', 'reservations:view'], ['WAITER', 'reservations:full'],
                // KITCHEN
                ['KITCHEN', 'menu:view'],
                ['KITCHEN', 'reservations:view']
            ];

            for (const [role, permission] of defaultPermissions) {
                await client.query(
                    'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [role, permission]
                );
            }
            console.log('Default role permissions created');
        }

        await client.query('COMMIT');
        console.log('Database schema created or already exists.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Error creating schema:', e);
        throw e;
    } finally {
        client.release();
    }
};

export default pool;
