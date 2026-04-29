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
                min_seats INTEGER,
                max_seats INTEGER,
                x INTEGER NOT NULL,
                y INTEGER NOT NULL,
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                status VARCHAR(50) NOT NULL,
                is_locked BOOLEAN DEFAULT false,
                merged_with INTEGER[],
                temp_lock_expires_at TIMESTAMPTZ
            );
        `);

        // Add min_seats and max_seats columns if they don't exist (migration)
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS min_seats INTEGER;`);
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS max_seats INTEGER;`);
        
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
                ['OWNER', 'staff:view'], ['OWNER', 'staff:full'],
                // MANAGER
                ['MANAGER', 'dashboard:view'], ['MANAGER', 'dashboard:full'],
                ['MANAGER', 'floorplan:view'], ['MANAGER', 'floorplan:update_status'], ['MANAGER', 'floorplan:full'],
                ['MANAGER', 'menu:view'], ['MANAGER', 'menu:full'],
                ['MANAGER', 'reservations:view'], ['MANAGER', 'reservations:full'],
                ['MANAGER', 'reports:view'],
                ['MANAGER', 'logs:view'],
                ['MANAGER', 'staff:view'], ['MANAGER', 'staff:full'],
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

        // Add logs permissions if they don't exist (migration for existing databases)
        const logsPermissions = [
            ['OWNER', 'logs:view'],
            ['OWNER', 'logs:full'],
            ['MANAGER', 'logs:view']
        ];
        for (const [role, permission] of logsPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }

        // Add staff permissions if they don't exist (migration for existing databases)
        const staffPermissions = [
            ['OWNER', 'staff:view'],
            ['OWNER', 'staff:full'],
            ['MANAGER', 'staff:view'],
            ['MANAGER', 'staff:full']
        ];
        for (const [role, permission] of staffPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }
        console.log('Staff permissions migration completed');

        // ============================================
        // TODOS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS todos (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                title VARCHAR(255) NOT NULL,
                description TEXT,
                completed BOOLEAN DEFAULT false,
                priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH')),
                category VARCHAR(50) NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('GENERAL', 'RESERVATION', 'INVENTORY', 'STAFF', 'MAINTENANCE', 'EVENT')),
                due_date DATE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMPTZ,
                linked_reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
                assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                assigned_to_user_name VARCHAR(255),
                assigned_to_team VARCHAR(50) CHECK (assigned_to_team IN ('OWNER', 'MANAGER', 'WAITER', 'KITCHEN')),
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_by_user_name VARCHAR(255)
            );
        `);

        // Create indexes for todos
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_assigned_to_user ON todos(assigned_to_user_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_assigned_to_team ON todos(assigned_to_team);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
        `);

        // ============================================
        // SHOPPING LIST TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS shopping_items (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(255) NOT NULL,
                category VARCHAR(20) NOT NULL DEFAULT 'ALTRO' CHECK (category IN ('CUCINA', 'BAR', 'ALTRO')),
                checked BOOLEAN DEFAULT false,
                date DATE NOT NULL DEFAULT CURRENT_DATE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_by_user_name VARCHAR(255)
            );
        `);

        // Add created_by_user_name column if it doesn't exist (migration)
        await client.query(`
            ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS created_by_user_name VARCHAR(255);
        `);

        // Create indexes for shopping_items
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_shopping_items_date ON shopping_items(date);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_shopping_items_category ON shopping_items(category);
        `);

        // ============================================
        // STAFF MEMBERS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS staff_members (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(100) NOT NULL,
                surname VARCHAR(100) NOT NULL,
                category VARCHAR(20) NOT NULL CHECK (category IN ('SALA', 'CUCINA')),
                staff_type VARCHAR(20) NOT NULL CHECK (staff_type IN ('FISSO', 'STAGIONALE', 'EXTRA')),
                phone VARCHAR(50),
                email VARCHAR(255),
                role VARCHAR(100),
                hire_date DATE,
                contract_end_date DATE,
                notes TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_members_category ON staff_members(category);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_members_is_active ON staff_members(is_active);
        `);

        // ============================================
        // STAFF SHIFTS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS staff_shifts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                staff_id UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                shift VARCHAR(20) NOT NULL CHECK (shift IN ('LUNCH', 'DINNER')),
                present BOOLEAN DEFAULT true,
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(staff_id, date, shift)
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts(date);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_shifts_staff_id ON staff_shifts(staff_id);
        `);

        // ============================================
        // STAFF TIME OFF TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS staff_time_off (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                staff_id UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                type VARCHAR(20) NOT NULL CHECK (type IN ('RIPOSO', 'VACANZA', 'MALATTIA', 'PERMESSO')),
                notes TEXT,
                approved BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_time_off_staff_id ON staff_time_off(staff_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_time_off_dates ON staff_time_off(start_date, end_date);
        `);

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
