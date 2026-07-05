import dotenv from 'dotenv';
dotenv.config();

import dns from 'dns';
import net from 'net';
import { Pool, types } from 'pg';
import bcrypt from 'bcryptjs';

// Railway's internal DNS returns both AAAA (IPv6) and A (IPv4) for the
// postgres host. In production we observed the IPv6 endpoint returning
// ECONNREFUSED while IPv4 timed out after 10s, surfacing as AggregateError
// [ETIMEDOUT] on PUT /reservations and /auth/me. Pin DNS to IPv4 first and
// disable Node's "happy eyeballs" so we don't burn time racing both families.
dns.setDefaultResultOrder('ipv4first');
if (typeof (net as any).setDefaultAutoSelectFamily === 'function') {
    (net as any).setDefaultAutoSelectFamily(false);
}

// Return DATE columns as plain YYYY-MM-DD strings instead of JS Date objects.
// PostgreSQL DATE has no timezone; the default parser shifts it through the
// server's local TZ, causing off-by-one-day bugs in clients in other zones.
types.setTypeParser(1082, (val: string) => val);

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
    // Cap concurrent DB connections (Railway hobby plans cap around 20-100).
    max: 10,
    // Close idle clients after 30s so we evict before the Railway TCP proxy does.
    // Without this, the pool serves a half-closed socket and the next query
    // throws "Connection terminated unexpectedly", surfacing as random 500s.
    idleTimeoutMillis: 30_000,
    // Fail fast (5s) instead of letting a request hang for 10s on a dead route.
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    // Activate TCP keepalive after 10s of idle so half-closed sockets are
    // detected before the next query is dispatched on them.
    keepAliveInitialDelayMillis: 10_000,
    // Server-side and client-side query caps so a hung query can't pin a
    // pool client indefinitely.
    statement_timeout: 15_000,
    query_timeout: 20_000,
} as any);

// Without this handler, an error event from an idle client crashes the worker
// (Node treats unhandled "error" events on EventEmitters as uncaught).
// Log only the error message to keep noise down during DB outages —
// dumping the full pg client object burns through Railway's log
// rate limit and drops real signal.
pool.on('error', (err) => {
    console.error('Postgres pool idle client error:', err?.message || err);
});

// Retry transient connection errors once. Most ETIMEDOUT / ECONNRESET /
// "Connection terminated unexpectedly" failures we've seen recover on the
// next attempt because the pool evicts the dead client and reconnects.
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', '57P01', '57P02', '57P03']);
const isTransient = (err: any): boolean => {
    if (!err) return false;
    if (TRANSIENT_CODES.has(err.code)) return true;
    if (typeof err.message === 'string' && err.message.includes('Connection terminated')) return true;
    if (Array.isArray(err.errors) && err.errors.some((e: any) => TRANSIENT_CODES.has(e?.code))) return true;
    return false;
};

// Errors that mean Postgres itself is unavailable (restart / failover).
// For these the immediate retry is pointless — we need to wait for the DB
// to come up. Up to 3 attempts with linear backoff.
const RESTART_CODES = new Set(['ECONNREFUSED', '57P01', '57P02', '57P03']);
const isRestartError = (err: any): boolean => {
    if (!err) return false;
    if (RESTART_CODES.has(err.code)) return true;
    if (Array.isArray(err.errors) && err.errors.some((e: any) => RESTART_CODES.has(e?.code))) return true;
    return false;
};

const sleepMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const queryWithRetry = async (text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }> => {
    const maxAttempts = 3;
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await pool.query(text, params);
        } catch (err: any) {
            lastErr = err;
            if (!isTransient(err) || attempt === maxAttempts) throw err;
            // Postgres restart needs a real wait; other transients can retry quickly.
            const delay = isRestartError(err) ? 1500 * attempt : 100;
            console.warn(`Postgres transient error (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`, err.code || err.message);
            await sleepMs(delay);
        }
    }
    throw lastErr;
};

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
                height INTEGER NOT NULL DEFAULT 600,
                is_closed BOOLEAN DEFAULT false
            );
        `);

        await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT false;`);
        await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS location VARCHAR(20);`);
        // One-shot seed for the initial room set. Idempotent: only assigns
        // location when still NULL, so later edits via UI/SQL win.
        await client.query(`
            UPDATE rooms SET location = 'INDOOR'
            WHERE location IS NULL AND name IN ('Veranda', 'Tettoia', 'Macine');
        `);
        await client.query(`
            UPDATE rooms SET location = 'OUTDOOR'
            WHERE location IS NULL AND name IN ('Fiume', 'Fuori', 'Porticato');
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
                temp_lock_expires_at TIMESTAMPTZ,
                rotation INTEGER DEFAULT 0,
                width_cm INTEGER,
                length_cm INTEGER,
                notes TEXT
            );
        `);

        // Add min_seats and max_seats columns if they don't exist (migration)
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS min_seats INTEGER;`);
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS max_seats INTEGER;`);
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS rotation INTEGER DEFAULT 0;`);
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS width_cm INTEGER;`);
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS length_cm INTEGER;`);
        await client.query(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS notes TEXT;`);

        // Per-shift table merges. Replaces the global tables.merged_with column,
        // which was a single state shared across all shifts and dates.
        await client.query(`
            CREATE TABLE IF NOT EXISTS table_merges (
                id SERIAL PRIMARY KEY,
                date DATE NOT NULL,
                shift VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH', 'DINNER')),
                primary_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
                merged_ids INTEGER[] NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, shift, primary_id)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_merges_date_shift ON table_merges(date, shift);`);

        // Per-shift table hiding. Lets the floor crew temporarily exclude a
        // table from the active map for a given service without deleting it
        // from the global layout (e.g. a corner table not opened tonight).
        await client.query(`
            CREATE TABLE IF NOT EXISTS table_hidden_overrides (
                id SERIAL PRIMARY KEY,
                date DATE NOT NULL,
                shift VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH', 'DINNER')),
                table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, shift, table_id)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_hidden_date_shift ON table_hidden_overrides(date, shift);`);

        // One-time migration: copy any pre-existing global merges into today's
        // LUNCH and DINNER so the user's current setup remains visible after
        // deploy. Runs only when table_merges is empty (first time).
        const mergeCount = await client.query('SELECT COUNT(*)::int AS c FROM table_merges');
        if (mergeCount.rows[0].c === 0) {
            await client.query(`
                INSERT INTO table_merges (date, shift, primary_id, merged_ids)
                SELECT CURRENT_DATE, 'LUNCH', id, merged_with
                FROM tables
                WHERE merged_with IS NOT NULL AND array_length(merged_with, 1) > 0
                ON CONFLICT DO NOTHING;
            `);
            await client.query(`
                INSERT INTO table_merges (date, shift, primary_id, merged_ids)
                SELECT CURRENT_DATE, 'DINNER', id, merged_with
                FROM tables
                WHERE merged_with IS NOT NULL AND array_length(merged_with, 1) > 0
                ON CONFLICT DO NOTHING;
            `);
            // Clear the legacy global state — it would otherwise still surface
            // through any code path that hasn't been updated.
            await client.query(`UPDATE tables SET merged_with = NULL WHERE merged_with IS NOT NULL;`);
        }
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS dishes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                category VARCHAR(100),
                allergens TEXT[],
                photo_url TEXT
            );
        `);

        // Migration: add photo_url column to existing dishes table
        await client.query(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS photo_url TEXT;`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS banquet_menus (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price_per_person DECIMAL(10, 2) NOT NULL,
                dish_ids INTEGER[],
                event_date DATE,
                deposit_amount DECIMAL(10, 2),
                courses JSONB,
                shift VARCHAR(10),
                guests INTEGER,
                notes_courses TEXT,
                notes_service TEXT,
                notes_mise_en_place TEXT
            );
        `);

        // Add operational fields to existing banquet_menus tables
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS shift VARCHAR(10);`);
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS guests INTEGER;`);
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS notes_courses TEXT;`);
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS notes_service TEXT;`);
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS notes_mise_en_place TEXT;`);
        // Children sub-count (of `guests`) and optional child fare. children_price
        // NULL means children are billed at the adult rate.
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS children INTEGER NOT NULL DEFAULT 0;`);
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS children_price DECIMAL(10, 2);`);

        // Add event_date column to existing banquet_menus if missing
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'banquet_menus' AND column_name = 'event_date'
                ) THEN
                    ALTER TABLE banquet_menus ADD COLUMN event_date DATE;
                END IF;
            END $$;
        `);

        // Add deposit_amount column to existing banquet_menus if missing
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'banquet_menus' AND column_name = 'deposit_amount'
                ) THEN
                    ALTER TABLE banquet_menus ADD COLUMN deposit_amount DECIMAL(10, 2);
                END IF;
            END $$;
        `);

        // Add courses (JSONB) column to existing banquet_menus if missing
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS courses JSONB;`);

        // Backfill courses for rows that have dish_ids but no courses yet:
        // wrap the existing flat list into a single course "Composizione" so old
        // banquets keep working in the new courses-based UI.
        await client.query(`
            UPDATE banquet_menus
            SET courses = jsonb_build_array(
                jsonb_build_object(
                    'name', 'Composizione',
                    'dish_ids', COALESCE(to_jsonb(dish_ids), '[]'::jsonb)
                )
            )
            WHERE courses IS NULL
              AND dish_ids IS NOT NULL
              AND array_length(dish_ids, 1) > 0;
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
                arrival_status VARCHAR(50) DEFAULT 'WAITING',
                reservation_status VARCHAR(50) DEFAULT 'CONFIRMED'
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

        // Track origin of each reservation: MANUAL (CRM), WHATSAPP (Vonage), VOICE (ElevenLabs).
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'MANUAL';`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS requires_review BOOLEAN DEFAULT false;`);
        // Children sub-count of `guests`. Server enforces 0 <= children <= guests.
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS children INTEGER NOT NULL DEFAULT 0;`);

        // Expected table hold time, in minutes, used to check overlap with other
        // reservations on the same table (double-seating support). NULL means
        // "use shift default" — the app resolves it (90 lunch / 120 dinner).
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;`);

        // Original booking timestamp. Added without a default so existing rows
        // stay NULL until backfilled below — that way the migration uses real
        // CREATE log times instead of stamping every row with the migration time.
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
        // Backfill from activity_logs: earliest CREATE entry per reservation is
        // the authoritative booking time. Only touches rows still NULL so the
        // migration is idempotent.
        await client.query(`
            UPDATE reservations r
            SET created_at = sub.first_created
            FROM (
                SELECT resource_id, MIN(created_at) AS first_created
                FROM activity_logs
                WHERE resource_type = 'RESERVATION' AND action = 'CREATE' AND resource_id IS NOT NULL
                GROUP BY resource_id
            ) sub
            WHERE r.id = sub.resource_id AND r.created_at IS NULL;
        `);
        // New rows always capture insertion time automatically from now on.
        await client.query(`ALTER TABLE reservations ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;`);

        // Audit table for ElevenLabs voice calls. Stores transcript + summary so
        // staff can review what the agent agreed to. Linked to a reservation
        // when one is created during the call.
        await client.query(`
            CREATE TABLE IF NOT EXISTS voice_calls (
                id SERIAL PRIMARY KEY,
                conversation_id VARCHAR(100) UNIQUE NOT NULL,
                phone VARCHAR(50),
                duration_seconds INTEGER,
                transcript TEXT,
                summary TEXT,
                reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_voice_calls_phone ON voice_calls(phone);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_voice_calls_reservation ON voice_calls(reservation_id) WHERE reservation_id IS NOT NULL;`);

        // Add reservation_status column to existing tables if it doesn't exist
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'reservations' AND column_name = 'reservation_status'
                ) THEN
                    ALTER TABLE reservations ADD COLUMN reservation_status VARCHAR(50) DEFAULT 'CONFIRMED';
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
                role VARCHAR(50) NOT NULL CHECK (role IN ('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN')),
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMPTZ,
                refresh_token_hash VARCHAR(255)
            );
        `);

        // Per-user landing preference: which view to open after login.
        // NULL = fall back to the first accessible view (legacy behavior).
        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS preferred_landing_view VARCHAR(50);
        `);

        // Track who created each reservation (added after users table exists for the FK)
        await client.query(`
            ALTER TABLE reservations
            ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        `);

        // ============================================
        // ROLE PERMISSIONS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS role_permissions (
                id SERIAL PRIMARY KEY,
                role VARCHAR(50) NOT NULL CHECK (role IN ('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN')),
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
                ['OWNER', 'banquet:view_price'],
                ['OWNER', 'banquet:manage_payments'],
                // GENERAL_MANAGER
                ['GENERAL_MANAGER', 'dashboard:view'], ['GENERAL_MANAGER', 'dashboard:full'],
                ['GENERAL_MANAGER', 'floorplan:view'], ['GENERAL_MANAGER', 'floorplan:update_status'], ['GENERAL_MANAGER', 'floorplan:full'],
                ['GENERAL_MANAGER', 'menu:view'], ['GENERAL_MANAGER', 'menu:full'],
                ['GENERAL_MANAGER', 'reservations:view'], ['GENERAL_MANAGER', 'reservations:full'],
                ['GENERAL_MANAGER', 'reports:view'], ['GENERAL_MANAGER', 'reports:full'],
                ['GENERAL_MANAGER', 'logs:view'],
                ['GENERAL_MANAGER', 'staff:view'], ['GENERAL_MANAGER', 'staff:full'],
                ['GENERAL_MANAGER', 'banquet:view_price'],
                ['GENERAL_MANAGER', 'banquet:manage_payments'],
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

        // Role CHECK constraint migration. Each new role we add (GENERAL_MANAGER,
        // RECEPTION, …) needs to be in the allow-list on *both* users and
        // role_permissions, otherwise INSERTs trip the constraint.
        await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
        await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN'))`);
        await client.query(`ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check`);
        await client.query(`ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN'))`);

        // Seed GENERAL_MANAGER default permissions if missing
        const generalManagerPermissions = [
            ['GENERAL_MANAGER', 'dashboard:view'], ['GENERAL_MANAGER', 'dashboard:full'],
            ['GENERAL_MANAGER', 'floorplan:view'], ['GENERAL_MANAGER', 'floorplan:update_status'], ['GENERAL_MANAGER', 'floorplan:full'],
            ['GENERAL_MANAGER', 'menu:view'], ['GENERAL_MANAGER', 'menu:full'],
            ['GENERAL_MANAGER', 'reservations:view'], ['GENERAL_MANAGER', 'reservations:full'],
            ['GENERAL_MANAGER', 'staff:view'], ['GENERAL_MANAGER', 'staff:full'],
            ['GENERAL_MANAGER', 'reports:view'], ['GENERAL_MANAGER', 'reports:full'],
            ['GENERAL_MANAGER', 'logs:view']
        ];
        for (const [role, permission] of generalManagerPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }

        // Add banquet:view_price for OWNER + GENERAL_MANAGER
        const banquetPricePermissions = [
            ['OWNER', 'banquet:view_price'],
            ['GENERAL_MANAGER', 'banquet:view_price']
        ];
        for (const [role, permission] of banquetPricePermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }
        console.log('GENERAL_MANAGER role and banquet:view_price migration completed');

        // Add banquet:manage_payments for OWNER + GENERAL_MANAGER
        const banquetPaymentPermissions = [
            ['OWNER', 'banquet:manage_payments'],
            ['GENERAL_MANAGER', 'banquet:manage_payments']
        ];
        for (const [role, permission] of banquetPaymentPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }
        console.log('banquet:manage_payments migration completed');

        // Seed RECEPTION default permissions. Reception staff handle the door:
        // they need full reservation control, the floor plan (read-only +
        // status flip for seating/freeing), the customer rubrica, and voice
        // call logs. They explicitly do NOT get menu, inventory, staff,
        // reports or users access.
        const receptionRoleSeedPermissions = [
            ['RECEPTION', 'dashboard:view'],
            ['RECEPTION', 'floorplan:view'],
            ['RECEPTION', 'floorplan:update_status'],
            ['RECEPTION', 'reservations:view'],
            ['RECEPTION', 'reservations:full'],
            ['RECEPTION', 'customers:view'],
            ['RECEPTION', 'customers:full'],
            ['RECEPTION', 'reception:view'],
            ['RECEPTION', 'voice_calls:view'],
        ];
        for (const [role, permission] of receptionRoleSeedPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }
        console.log('RECEPTION role permissions migration completed');

        // ============================================
        // BANQUET PAYMENTS TABLE
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS banquet_payments (
                id SERIAL PRIMARY KEY,
                banquet_id INTEGER NOT NULL REFERENCES banquet_menus(id) ON DELETE CASCADE,
                amount DECIMAL(10, 2) NOT NULL,
                payment_date DATE NOT NULL,
                payment_type VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20) NOT NULL,
                notes TEXT,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_banquet_payments_banquet_id ON banquet_payments(banquet_id);`);

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

        // Migrations: linked banquet ids + auto-reminder marker
        await client.query(`
            ALTER TABLE todos ADD COLUMN IF NOT EXISTS linked_banquet_ids INTEGER[];
        `);
        await client.query(`
            ALTER TABLE todos ADD COLUMN IF NOT EXISTS banquet_reminder_hours INTEGER;
        `);
        await client.query(`
            ALTER TABLE todos ADD COLUMN IF NOT EXISTS auto_kind VARCHAR(50);
        `);

        // Create indexes for todos
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_assigned_to_user ON todos(assigned_to_user_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_banquet_reminder ON todos(banquet_reminder_hours, due_date) WHERE banquet_reminder_hours IS NOT NULL;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_auto_kind ON todos(auto_kind, due_date) WHERE auto_kind IS NOT NULL;
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
        // SUPPLIERS TABLE (fornitori, può appartenere a 1+ shopping categories)
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS suppliers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(255) NOT NULL,
                categories VARCHAR(20)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(20)[],
                phone VARCHAR(50),
                note TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migrate from the legacy single-category schema if needed.
        // If "category" column still exists, copy it into "categories" then drop it.
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'suppliers' AND column_name = 'category'
                ) THEN
                    ALTER TABLE suppliers
                        ADD COLUMN IF NOT EXISTS categories VARCHAR(20)[]
                        NOT NULL DEFAULT ARRAY[]::VARCHAR(20)[];
                    UPDATE suppliers
                        SET categories = ARRAY[category]::VARCHAR(20)[]
                        WHERE categories IS NULL OR cardinality(categories) = 0;
                    ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_category_name_key;
                    ALTER TABLE suppliers DROP COLUMN category;
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_suppliers_categories ON suppliers USING GIN(categories);
        `);

        // Link shopping items to an optional supplier (ON DELETE SET NULL keeps items orphan-safe)
        await client.query(`
            ALTER TABLE shopping_items
            ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_shopping_items_supplier_id ON shopping_items(supplier_id);
        `);

        // Optional quantity + unit. Both nullable: items without a quantity render as before.
        await client.query(`
            ALTER TABLE shopping_items
            ADD COLUMN IF NOT EXISTS quantity NUMERIC(10, 3);
        `);
        await client.query(`
            ALTER TABLE shopping_items
            ADD COLUMN IF NOT EXISTS unit VARCHAR(20)
            CHECK (unit IS NULL OR unit IN ('kg', 'g', 'l', 'ml', 'pz', 'conf', 'cassetta', 'cartone'));
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
                weekly_rest_day SMALLINT CHECK (weekly_rest_day BETWEEN 0 AND 6),
                notes TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration for existing databases
        await client.query(`
            ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS weekly_rest_day SMALLINT CHECK (weekly_rest_day BETWEEN 0 AND 6);
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
                shift VARCHAR(10) CHECK (shift IN ('LUNCH', 'DINNER')),
                notes TEXT,
                approved BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add shift column to existing tables (NULL = full day, 'LUNCH'/'DINNER' = single shift)
        await client.query(`
            ALTER TABLE staff_time_off ADD COLUMN IF NOT EXISTS shift VARCHAR(10) CHECK (shift IN ('LUNCH', 'DINNER'));
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_time_off_staff_id ON staff_time_off(staff_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_staff_time_off_dates ON staff_time_off(start_date, end_date);
        `);

        // ============================================
        // CUSTOMERS TABLE (rubrica)
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                email VARCHAR(255),
                address TEXT,
                city VARCHAR(100),
                postal_code VARCHAR(20),
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(LOWER(name));`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);`);

        // Enforce phone uniqueness on the digits-only form so "+39 333 1234567"
        // and "3331234567" can't both exist. Two customers sharing a phone
        // multiplies rows in the reservation→customer JOIN (and the rubrica
        // VIP/preferred-table flags become non-deterministic).
        //
        // Cleanup before the index is created — otherwise it errors out on
        // existing duplicates. Tie-break: keep the lowest id, blank the phone
        // on the rest so they survive (with a marker note) instead of being
        // silently lost. Idempotent: a re-run finds no duplicates to fix.
        await client.query(`
            WITH ranked AS (
                SELECT id,
                       regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') AS digits,
                       ROW_NUMBER() OVER (
                           PARTITION BY regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')
                           ORDER BY id ASC
                       ) AS rn
                FROM customers
                WHERE phone IS NOT NULL
                  AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> ''
            )
            UPDATE customers c
            SET phone = NULL,
                notes = COALESCE(c.notes, '') ||
                        CASE WHEN COALESCE(c.notes, '') = '' THEN '' ELSE E'\\n' END ||
                        '[telefono rimosso automaticamente: duplicato di un altro contatto]',
                updated_at = CURRENT_TIMESTAMP
            FROM ranked r
            WHERE c.id = r.id
              AND r.rn > 1;
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_digits_unique
            ON customers ((regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')))
            WHERE phone IS NOT NULL
              AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> '';
        `);

        // Track whether a customer was created by the backfill so we can prune
        // legacy auto-imported entries that don't meet the current rules
        // (phone or email required) without touching customers added manually.
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS auto_imported BOOLEAN NOT NULL DEFAULT FALSE;`);

        // Per-customer service preferences used by reservation auto-assignment
        // and floor-card hints. preferred_table_id is a soft FK (SET NULL on
        // table deletion) so existing notes survive a floor-plan rework.
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL;`);
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferences_notes TEXT;`);
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS dietary_notes TEXT;`);
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT FALSE;`);

        // Link banquet menus to customers (nullable). Using ON DELETE SET NULL
        // because deleting a customer should not destroy the banquet history.
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;`);

        // Tables assigned to a banquet (multi-table). Used by the floor plan and
        // by overbooking checks against reservations on the same date+shift.
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS table_ids INTEGER[];`);

        // Discount on the banquet total. type is 'PERCENT' (0-100) or 'AMOUNT' (€).
        // NULL means no discount.
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10);`);
        await client.query(`ALTER TABLE banquet_menus ADD COLUMN IF NOT EXISTS discount_value DECIMAL(10, 2);`);

        // Customer permissions for roles
        const customerPermissions = [
            ['OWNER', 'customers:view'], ['OWNER', 'customers:full'],
            ['GENERAL_MANAGER', 'customers:view'], ['GENERAL_MANAGER', 'customers:full'],
            ['MANAGER', 'customers:view'], ['MANAGER', 'customers:full'],
            ['WAITER', 'customers:view'],
        ];
        for (const [role, permission] of customerPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }

        // Drop auto-imported customers without a phone number — the rubrica
        // only stores entries we can call back. Manually-created customers
        // (auto_imported = FALSE) are left alone.
        await client.query(`
            DELETE FROM customers
             WHERE auto_imported = TRUE
               AND phone IS NULL;
        `);

        // Normalise existing names to Title Case. INITCAP treats apostrophes,
        // hyphens and spaces as word separators — so "MARIO ROSSI",
        // "mario rossi" and "d'angelo" all land on "Mario Rossi" / "D'Angelo".
        // Idempotent: only rows that aren't already title-cased get touched.
        await client.query(`
            UPDATE customers
               SET name = INITCAP(name)
             WHERE name <> INITCAP(name);
        `);

        // One-time backfill: seed the rubrica from reservations the first time
        // this migration runs. Restricted to reservations that carry a phone
        // — that's the only identifier we use in the rubrica. Deduplicated
        // on phone.
        const customerCount = await client.query('SELECT COUNT(*)::int AS c FROM customers');
        if (customerCount.rows[0].c === 0) {
            await client.query(`
                INSERT INTO customers (name, phone, email, auto_imported)
                SELECT name, phone, email, TRUE
                FROM (
                    SELECT
                        INITCAP(TRIM(customer_name)) AS name,
                        NULLIF(TRIM(phone), '') AS phone,
                        NULLIF(TRIM(email), '') AS email,
                        ROW_NUMBER() OVER (
                            PARTITION BY NULLIF(TRIM(phone), '')
                            ORDER BY id DESC
                        ) AS rn
                    FROM reservations
                    WHERE customer_name IS NOT NULL
                      AND TRIM(customer_name) <> ''
                      AND NULLIF(TRIM(phone), '') IS NOT NULL
                ) deduped
                WHERE rn = 1;
            `);

            // Link existing banquet_menus.customer_id by matching the banquet's
            // most recent reservation to the customer we just inserted.
            await client.query(`
                UPDATE banquet_menus bm
                SET customer_id = sub.customer_id
                FROM (
                    SELECT DISTINCT ON (r.banquet_menu_id)
                        r.banquet_menu_id,
                        c.id AS customer_id
                    FROM reservations r
                    JOIN customers c
                      ON c.phone IS NOT DISTINCT FROM NULLIF(TRIM(r.phone), '')
                     AND LOWER(c.name) = LOWER(INITCAP(TRIM(r.customer_name)))
                    WHERE r.banquet_menu_id IS NOT NULL
                    ORDER BY r.banquet_menu_id, r.id DESC
                ) sub
                WHERE bm.id = sub.banquet_menu_id AND bm.customer_id IS NULL;
            `);
            console.log('Customers rubrica backfilled from reservations');
        }

        // ============================================
        // INVENTORY TABLES
        // ============================================
        // Areas (CUCINA / SALA / BAR) are fixed enums on each row, not a table.
        // Locations within an area are user-managed (e.g. "Cella 1" / "Cella 2"
        // for CUCINA). Stock = quantity per (product, location). Movements
        // capture every carico / scarico for the audit trail.
        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_locations (
                id SERIAL PRIMARY KEY,
                area VARCHAR(20) NOT NULL CHECK (area IN ('CUCINA', 'SALA', 'BAR')),
                name VARCHAR(100) NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(area, name)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_locations_area ON inventory_locations(area, sort_order);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_categories (
                id SERIAL PRIMARY KEY,
                area VARCHAR(20) NOT NULL CHECK (area IN ('CUCINA', 'SALA', 'BAR')),
                name VARCHAR(100) NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(area, name)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_categories_area ON inventory_categories(area, sort_order);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_products (
                id SERIAL PRIMARY KEY,
                area VARCHAR(20) NOT NULL CHECK (area IN ('CUCINA', 'SALA', 'BAR')),
                name VARCHAR(255) NOT NULL,
                unit VARCHAR(20),
                notes TEXT,
                category_id INTEGER REFERENCES inventory_categories(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Backfill: existing installs may not have category_id yet.
        await client.query(`ALTER TABLE inventory_products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES inventory_categories(id) ON DELETE SET NULL;`);
        // Migration: replace UNIQUE(area, name) with a per-category unique key
        // so the same product name (e.g. "GNOCCHI") can live in multiple
        // categories (PRIMI vs CELIACO). COALESCE(..., 0) keeps NULL-category
        // products unique on name as well.
        await client.query(`ALTER TABLE inventory_products DROP CONSTRAINT IF EXISTS inventory_products_area_name_key;`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_products_area_cat_name ON inventory_products (area, COALESCE(category_id, 0), name);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_products_area ON inventory_products(area, name);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_products_category ON inventory_products(category_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_stock (
                product_id INTEGER NOT NULL REFERENCES inventory_products(id) ON DELETE CASCADE,
                location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
                quantity NUMERIC(12, 3) NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (product_id, location_id)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_stock_location ON inventory_stock(location_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS inventory_movements (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES inventory_products(id) ON DELETE CASCADE,
                location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
                delta NUMERIC(12, 3) NOT NULL,
                reason VARCHAR(20) NOT NULL CHECK (reason IN ('CARICO', 'SCARICO', 'RETTIFICA', 'TRASFERIMENTO')),
                notes TEXT,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                user_name VARCHAR(255),
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id, created_at DESC);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_location ON inventory_movements(location_id, created_at DESC);`);

        // Inventory permissions: view = read, full = create/edit products,
        // locations and post movements.
        const inventoryPermissions = [
            ['OWNER', 'inventory:view'], ['OWNER', 'inventory:full'],
            ['GENERAL_MANAGER', 'inventory:view'], ['GENERAL_MANAGER', 'inventory:full'],
            ['MANAGER', 'inventory:view'], ['MANAGER', 'inventory:full'],
            ['WAITER', 'inventory:view'],
            ['KITCHEN', 'inventory:view'], ['KITCHEN', 'inventory:full'],
        ];
        for (const [role, permission] of inventoryPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }

        // Voice calls (ElevenLabs conversations) — read access for management roles.
        const voiceCallsPermissions = [
            ['OWNER', 'voice_calls:view'],
            ['GENERAL_MANAGER', 'voice_calls:view'],
            ['MANAGER', 'voice_calls:view'],
        ];
        for (const [role, permission] of voiceCallsPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }

        // Reception (iPad host view) — granted to all front-of-house roles.
        const receptionPermissions = [
            ['OWNER', 'reception:view'],
            ['GENERAL_MANAGER', 'reception:view'],
            ['MANAGER', 'reception:view'],
            ['WAITER', 'reception:view'],
        ];
        for (const [role, permission] of receptionPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
        }

        // ============================================
        // PUSH SUBSCRIPTIONS TABLE (Web Push)
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);`);

        // ============================================
        // OPENING HOURS + SPECIAL CLOSURES
        // ============================================
        await client.query(`
            CREATE TABLE IF NOT EXISTS opening_hours (
                weekday      INTEGER PRIMARY KEY,
                lunch_open   TIME,
                lunch_close  TIME,
                dinner_open  TIME,
                dinner_close TIME,
                slot_minutes INTEGER NOT NULL DEFAULT 30
            );
        `);
        // Seed default schedule once (matches the slot grid previously hardcoded
        // in services/elevenlabsService.ts so behaviour is unchanged on first deploy).
        await client.query(`
            INSERT INTO opening_hours (weekday, lunch_open, lunch_close, dinner_open, dinner_close, slot_minutes)
            SELECT g.weekday, '13:00'::time, '14:00'::time, '19:30'::time, '23:30'::time, 30
            FROM generate_series(0, 6) AS g(weekday)
            ON CONFLICT (weekday) DO NOTHING;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS special_closures (
                id     SERIAL PRIMARY KEY,
                date   DATE NOT NULL,
                shift  VARCHAR(20),
                reason TEXT,
                UNIQUE (date, shift)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_special_closures_date ON special_closures(date);`);

        // ============================================
        // FEATURE FLAGS (app_settings)
        // ============================================
        // Generic key/value store for runtime feature toggles. Keeps things
        // simple: BOOLEAN-only for now, one row per flag.
        await client.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key        VARCHAR(100) PRIMARY KEY,
                value      BOOLEAN NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Seed defaults: public bookings start OFF (mirrors the previous env
        // var default), voice agent starts ON to avoid silently dropping
        // existing call traffic when this migration runs in prod.
        await client.query(`
            INSERT INTO app_settings (key, value) VALUES
                ('public_bookings_enabled', false),
                ('voice_agent_enabled',      true)
            ON CONFLICT (key) DO NOTHING;
        `);

        // ============================================
        // RESERVATION NOTE PRESETS
        // ============================================
        // Configurable quick-notes list shown as chips in the reservation
        // modal. Free-form label + explicit sort_order (small integer) so the
        // operator can drag/reorder in Impostazioni. First-run seed matches the
        // previous hardcoded set so nothing changes for existing installs.
        await client.query(`
            CREATE TABLE IF NOT EXISTS reservation_note_presets (
                id         SERIAL PRIMARY KEY,
                label      VARCHAR(80) NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Optional lucide icon key; NULL means "no icon" and the chip renders
        // as a plain text pill. Client keeps a whitelist so unknown values
        // gracefully fall back to no icon.
        await client.query(`ALTER TABLE reservation_note_presets ADD COLUMN IF NOT EXISTS icon VARCHAR(40);`);
        const existingPresetCount = await client.query(`SELECT COUNT(*)::int AS n FROM reservation_note_presets;`);
        if (existingPresetCount.rows[0]?.n === 0) {
            await client.query(`
                INSERT INTO reservation_note_presets (label, sort_order, icon) VALUES
                    ('Seggiolone',       10, 'baby'),
                    ('Cane',             20, 'dog'),
                    ('Compleanno',       30, 'cake'),
                    ('Anniversario',     40, 'heart'),
                    ('Tavolo tranquillo',50, 'volume-x'),
                    ('Vista',            60, 'mountain');
            `);
        }

        // ============================================
        // HACCP (controlli giornalieri)
        // ============================================
        // 5 tables mirror the operator's existing paper sheets:
        //   1) temperature readings per appliance, daily
        //   2) oil status per fryer, daily
        //   3) cleaning checks per risk point, daily
        //   4) goods receipt entries (ad-hoc, multiple per day)
        //   5) blast-chilling production logs (ad-hoc, multiple per day)
        //
        // Tables 1–3 have UNIQUE(date, label) so the daily form upserts in place;
        // tables 4–5 grow row-by-row as the operator records deliveries/batches.
        await client.query(`
            CREATE TABLE IF NOT EXISTS haccp_temperature_readings (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                date DATE NOT NULL,
                location VARCHAR(100) NOT NULL,
                temperature NUMERIC(5,1) NOT NULL,
                target_max NUMERIC(5,1),
                note TEXT,
                recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recorded_by_user_name VARCHAR(255),
                recorded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, location)
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_haccp_temp_date ON haccp_temperature_readings(date);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS haccp_oil_checks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                date DATE NOT NULL,
                fryer_label VARCHAR(100) NOT NULL,
                action VARCHAR(20) NOT NULL CHECK (action IN ('SOSTITUITO','FILTRATO','UTILIZZABILE')),
                note TEXT,
                recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recorded_by_user_name VARCHAR(255),
                recorded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, fryer_label)
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_haccp_oil_date ON haccp_oil_checks(date);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS haccp_cleaning_checks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                date DATE NOT NULL,
                point VARCHAR(100) NOT NULL,
                done BOOLEAN NOT NULL DEFAULT false,
                note TEXT,
                recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recorded_by_user_name VARCHAR(255),
                recorded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, point)
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_haccp_cleaning_date ON haccp_cleaning_checks(date);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS haccp_goods_receipts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                date DATE NOT NULL,
                product VARCHAR(255) NOT NULL,
                lot_number VARCHAR(100),
                temperature NUMERIC(5,1),
                accepted BOOLEAN NOT NULL DEFAULT true,
                note TEXT,
                recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recorded_by_user_name VARCHAR(255),
                recorded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_haccp_receipt_date ON haccp_goods_receipts(date);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS haccp_production_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                date DATE NOT NULL,
                product VARCHAR(255) NOT NULL,
                blast_temp_range VARCHAR(20),
                blast_duration VARCHAR(20),
                internal_lot VARCHAR(100),
                note TEXT,
                recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                recorded_by_user_name VARCHAR(255),
                recorded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_haccp_production_date ON haccp_production_logs(date);
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
