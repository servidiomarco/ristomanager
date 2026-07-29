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

// Anchor every new pool connection to Europe/Rome so timestamptz columns are
// interpreted consistently on both writes and reads:
//   - Naive datetime strings (e.g. "2026-07-16T22:30") passed to INSERT/UPDATE
//     are interpreted as Europe/Rome wall-clock (previously Postgres treated
//     them as UTC because Railway's default session TZ is UTC, shifting every
//     reservation by 1h in winter / 2h in summer).
//   - DATE(reservation_time), to_char(reservation_time, ...) and other
//     naive-timestamp extractions return Rome wall-clock values without an
//     explicit `AT TIME ZONE 'Europe/Rome'` at every call site.
// The existing `AT TIME ZONE 'Europe/Rome'` casts scattered through the
// codebase remain correct — they're now redundant but harmless.
pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'Europe/Rome'").catch(err => {
        console.error('Failed to set session TIMEZONE on pool client:', err?.message || err);
    });
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

        // ============================================
        // TABELLE FONDANTI — devono esistere per prime
        // ============================================
        // `users` e `activity_logs` sono referenziate (FK o backfill) da
        // blocchi che stanno più in basso in questa funzione. Su un database
        // già popolato non si nota, perché le tabelle ci sono da prima e i
        // CREATE ... IF NOT EXISTS più avanti sono no-op; su un database
        // vuoto invece createSchema fallisce e l'app non parte.
        //
        // Definirle qui in testa è l'unico ordinamento che regge entrambi i
        // casi. Le ALTER, gli indici e i seed di queste due tabelle restano
        // nelle rispettive sezioni più sotto: qui c'è solo la CREATE.
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

        // Per-shift room closure. Parallel to table_hidden_overrides but at the
        // room level: staff can close a room only for a specific (date, shift)
        // without touching the extended rooms.is_closed flag. Both signals are
        // OR-ed by the public/voice channels when computing availability.
        await client.query(`
            CREATE TABLE IF NOT EXISTS room_closed_overrides (
                id SERIAL PRIMARY KEY,
                date DATE NOT NULL,
                shift VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH', 'DINNER')),
                room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, shift, room_id)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_room_closed_date_shift ON room_closed_overrides(date, shift);`);

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

        // Follow-up tracking for calls that didn't produce a reservation:
        // staff mark the call as PENDING/CONTACTED and can leave notes for
        // whoever picks it up next.
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS follow_up_status VARCHAR(20) DEFAULT 'PENDING';`);
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS notes TEXT;`);
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS follow_up_updated_at TIMESTAMPTZ;`);
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS follow_up_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
        // Safety net for LLM hallucinations: flags calls where the agent
        // verbally confirmed a booking but never invoked the create-reservation
        // tool. Set by the post-call webhook. Powers the "Da recuperare" chip
        // and the red badge on the Conversazioni page.
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS phantom_confirmation BOOLEAN NOT NULL DEFAULT FALSE;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_voice_calls_phantom ON voice_calls(phantom_confirmation) WHERE phantom_confirmation = TRUE;`);
        // Set to TRUE once the phantom booking has been dealt with — either
        // by linking a manually-created reservation or by an explicit mark
        // from staff. Lets the UI collapse the red banner while keeping the
        // original phantom_confirmation flag intact for reporting.
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS phantom_recovered BOOLEAN NOT NULL DEFAULT FALSE;`);
        // Marks calls where the agent hit the "gruppi grandi" handoff branch
        // (guests > voice_large_group_threshold): the tool refused, agent
        // read the callback phrase. Set by the post-call webhook via
        // transcript scan. Powers a dedicated badge on the Conversazioni card
        // so staff know it's a callback request, not a plain follow-up.
        await client.query(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS large_group_handoff BOOLEAN NOT NULL DEFAULT FALSE;`);

        // Payment link requests (Revolut hosted checkout). Amounts are in
        // minor units (cents) — same convention as Revolut / Stripe so we
        // don't lose precision on rounding. `status` mirrors the Revolut
        // order state (PENDING/AUTHORISED/COMPLETED/CANCELLED/FAILED) plus
        // our own EXPIRED terminal state for orders we've abandoned.
        await client.query(`
            CREATE TABLE IF NOT EXISTS payment_requests (
                id SERIAL PRIMARY KEY,
                reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
                amount_cents INTEGER NOT NULL,
                currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
                description TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                provider VARCHAR(20) NOT NULL DEFAULT 'revolut',
                provider_order_id VARCHAR(100) UNIQUE,
                checkout_url TEXT,
                delivery_channel VARCHAR(20),
                delivery_provider_sid VARCHAR(100),
                delivery_error TEXT,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMPTZ,
                metadata JSONB
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_reservation ON payment_requests(reservation_id) WHERE reservation_id IS NOT NULL;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);`);

        // Pay-at-table + split-bill (Fase 1 MVP). One `table_bills` row per
        // conto aperto al tavolo; N `table_bill_splits` per la ripartizione
        // che gli ospiti dichiarano dal QR pubblico. Il pagamento vero e
        // proprio resta su `payment_requests` (Revolut hosted checkout);
        // ogni split punta al proprio payment_request via FK opzionale.
        //
        // `items` è JSONB nullable: popolato solo in Fase 2 quando arriverà
        // la GET del conto da Passepartout. In Fase 1 lo split è solo per
        // importo (equal_share / fixed_amount).
        //
        // `share_token` è il segreto opaco nell'URL pubblico
        // (`/pay/:token`). Ruotato su VOID/CLOSED così un token compromesso
        // muore appena il bill si chiude.
        await client.query(`
            CREATE TABLE IF NOT EXISTS table_bills (
                id SERIAL PRIMARY KEY,
                reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
                table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
                total_cents INTEGER NOT NULL CHECK (total_cents > 0),
                covers INTEGER NOT NULL CHECK (covers > 0),
                currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
                items JSONB,
                status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
                share_token VARCHAR(64) UNIQUE,
                opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMPTZ,
                opened_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                external_ref VARCHAR(64),
                cash_settled_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_settled_cents >= 0),
                tip_cents INTEGER NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
                notes TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_bills_reservation ON table_bills(reservation_id) WHERE reservation_id IS NOT NULL;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_bills_status ON table_bills(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_bills_share_token ON table_bills(share_token) WHERE share_token IS NOT NULL;`);

        // Ripartizione dichiarata dai singoli ospiti dal QR. `expires_at`
        // scade il claim non pagato (~5 min) così un ospite distratto non
        // blocca il residuo per sempre. Il job di reconcile controlla
        // Revolut prima di rilasciarlo, per gestire webhook persi.
        await client.query(`
            CREATE TABLE IF NOT EXISTS table_bill_splits (
                id SERIAL PRIMARY KEY,
                table_bill_id INTEGER NOT NULL REFERENCES table_bills(id) ON DELETE CASCADE,
                kind VARCHAR(20) NOT NULL,
                amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                item_ids JSONB,
                claimant_label TEXT,
                claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMPTZ,
                payment_request_id INTEGER REFERENCES payment_requests(id) ON DELETE SET NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'CLAIMED',
                paid_at TIMESTAMPTZ,
                released_at TIMESTAMPTZ
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_bill_splits_bill ON table_bill_splits(table_bill_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_bill_splits_expiring ON table_bill_splits(expires_at) WHERE status = 'CLAIMED';`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_table_bill_splits_payment ON table_bill_splits(payment_request_id) WHERE payment_request_id IS NOT NULL;`);

        // Retro-FK sul payment_request così partendo dal webhook Revolut si
        // risale allo split senza scan. ON DELETE SET NULL: se lo split
        // sparisce (cascade dal bill) il payment_request sopravvive come
        // record contabile.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'payment_requests' AND column_name = 'table_bill_split_id'
                ) THEN
                    ALTER TABLE payment_requests
                        ADD COLUMN table_bill_split_id INTEGER REFERENCES table_bill_splits(id) ON DELETE SET NULL;
                END IF;
            END $$;
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_split ON payment_requests(table_bill_split_id) WHERE table_bill_split_id IS NOT NULL;`);

        // Badge "nuovi pagamenti" in sidebar: un pagamento COMPLETED/PAID con
        // seen_at NULL è "non visto". La pagina Pagamenti marca tutto visto
        // all'apertura. Backfill una tantum dentro lo stesso DO $$ (guardato
        // dall'esistenza della colonna) così al primo deploy il badge parte
        // da zero invece di contare tutto lo storico.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'payment_requests' AND column_name = 'seen_at'
                ) THEN
                    ALTER TABLE payment_requests ADD COLUMN seen_at TIMESTAMPTZ;
                    UPDATE payment_requests SET seen_at = NOW();
                END IF;
            END $$;
        `);

        // Invariante cross-row: la somma dei claim vivi (CLAIMED o PAID)
        // non può eccedere il totale del bill. PostgreSQL non permette
        // CHECK subquery, quindi lo enforce con trigger BEFORE INSERT/UPDATE
        // su table_bill_splits. Lookup a caldo del bill in row-lock così
        // due insert concorrenti sono serializzati e uno dei due riceve
        // l'errore invece di sfondare il totale.
        await client.query(`
            CREATE OR REPLACE FUNCTION enforce_table_bill_split_sum()
            RETURNS TRIGGER AS $$
            DECLARE
                v_total INTEGER;
                v_live_sum INTEGER;
            BEGIN
                -- Solo i claim che pesano sul residuo sono contati.
                IF NEW.status NOT IN ('CLAIMED', 'PAID') THEN
                    RETURN NEW;
                END IF;

                SELECT total_cents INTO v_total
                FROM table_bills
                WHERE id = NEW.table_bill_id
                FOR UPDATE;

                IF v_total IS NULL THEN
                    RAISE EXCEPTION 'table_bill % not found', NEW.table_bill_id;
                END IF;

                SELECT COALESCE(SUM(amount_cents), 0) INTO v_live_sum
                FROM table_bill_splits
                WHERE table_bill_id = NEW.table_bill_id
                  AND status IN ('CLAIMED', 'PAID')
                  AND (TG_OP = 'INSERT' OR id <> NEW.id);

                IF v_live_sum + NEW.amount_cents > v_total THEN
                    RAISE EXCEPTION 'split sum (% + %) exceeds bill total (%) for bill %',
                        v_live_sum, NEW.amount_cents, v_total, NEW.table_bill_id
                        USING ERRCODE = '23514';
                END IF;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        await client.query(`DROP TRIGGER IF EXISTS trg_enforce_table_bill_split_sum ON table_bill_splits;`);
        await client.query(`
            CREATE TRIGGER trg_enforce_table_bill_split_sum
            BEFORE INSERT OR UPDATE ON table_bill_splits
            FOR EACH ROW EXECUTE FUNCTION enforce_table_bill_split_sum();
        `);

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
        // La CREATE TABLE sta in testa a createSchema (sezione "tabelle
        // fondanti"): il backfill di reservations.created_at legge da qui e
        // gira molto più in alto. Qui restano solo gli indici.

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
        // La CREATE TABLE sta in testa a createSchema (sezione "tabelle
        // fondanti"): diverse tabelle più sopra hanno una FK verso users e su
        // un database vuoto fallirebbero. Qui restano solo ALTER e seed.

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

        // Outbound-confirmation tracking (SMS/WhatsApp booking ack). Populated
        // when we hand off to Twilio; updated by the Twilio StatusCallback.
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_status VARCHAR(20);`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_channel VARCHAR(20);`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_delivered_at TIMESTAMPTZ;`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_provider_sid VARCHAR(64);`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_error TEXT;`);
        // Index for the status-callback lookup (find reservation by Twilio SID).
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reservations_confirmation_sid ON reservations (confirmation_provider_sid);`);

        // GDPR consents captured at booking time. Kept on the reservation so we
        // have per-booking proof (art. 7.1): what was consented and when.
        // consent_marketing  → invio comunicazioni commerciali (art. 6.1.a)
        // consent_data_health → trattamento allergie/intolleranze (dati sanitari, art. 9.2.a)
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS consent_marketing BOOLEAN;`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS consent_data_health BOOLEAN;`);
        await client.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS consent_updated_at TIMESTAMPTZ;`);

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
        // Marketing consent at customer level — propagated from the booking flow
        // so it can be used to filter marketing sends. Timestamp = proof (art. 7).
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_marketing BOOLEAN;`);
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_marketing_updated_at TIMESTAMPTZ;`);

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

        // Payments (Revolut hosted checkout dashboard). :view lets front-of-
        // house see and open payment links; :full is needed to create/void
        // requests (invoked via /payments/requests endpoints).
        const paymentsPermissions = [
            ['OWNER', 'payments:view'], ['OWNER', 'payments:full'],
            ['GENERAL_MANAGER', 'payments:view'], ['GENERAL_MANAGER', 'payments:full'],
            ['MANAGER', 'payments:view'], ['MANAGER', 'payments:full'],
            ['RECEPTION', 'payments:view'],
            ['WAITER', 'payments:view'],
        ];
        for (const [role, permission] of paymentsPermissions) {
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
        // NOTIFICATIONS INBOX (persistent log per user)
        // ============================================
        // Persistent history of every push notification we dispatch, one row
        // per recipient user. Web push is fire-and-forget by design (delivery
        // dies with the browser), so we save the payload *before* attempting
        // delivery. Powers the NotifichePage centre so operators can rewind
        // past alerts, mark them read/dismissed, and see counts survive across
        // sessions and devices.
        //
        // category: coarse bucket used by the UI filters (voice, payment,
        //   reservation, message, ...); tag: fine-grained dedupe key that
        //   matches the web-push tag so the same alert doesn't spawn multiple
        //   rows on retry.
        await client.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category VARCHAR(40),
                title TEXT NOT NULL,
                body TEXT,
                url TEXT,
                tag VARCHAR(120),
                metadata JSONB,
                sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                read_at TIMESTAMPTZ,
                dismissed_at TIMESTAMPTZ
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, sent_at DESC);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(recipient_user_id) WHERE read_at IS NULL AND dismissed_at IS NULL;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_tag ON notifications(recipient_user_id, tag) WHERE tag IS NOT NULL AND dismissed_at IS NULL;`);

        // ============================================
        // REMINDERS — user-editable scheduled push notifications
        // ============================================
        // Powers the "Promemoria" section in Impostazioni. Every reminder is
        // a schedule + a message + a set of recipient roles. The scheduler
        // (startRemindersScheduler in server.ts) polls this table every 5
        // minutes and fires the due rows. `system_key` lets a row hook into
        // a hardcoded handler (e.g. BREAD_DAILY computes the daily bread
        // quantity from the reservation coperti); when the handler exists
        // the description is generated at fire time, otherwise the stored
        // title/description are used verbatim.
        //
        // kind:
        //   ONE_OFF   — fires on `schedule_date` at `schedule_time` then
        //               is auto-deactivated (active=false) so it doesn't
        //               re-fire tomorrow.
        //   RECURRING — driven by `frequency`:
        //                DAILY   → every day at schedule_time
        //                WEEKLY  → on each weekday in `weekdays`
        //                MONTHLY → on `month_day` of every month (1..28
        //                          to avoid missing months with fewer days)
        //
        // schedule_time is HH:MM in Europe/Rome (the whole app uses local
        // wall-clock semantics; scheduler compares against Italian time).
        await client.query(`
            CREATE TABLE IF NOT EXISTS reminders (
                id SERIAL PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                description TEXT,
                kind VARCHAR(20) NOT NULL CHECK (kind IN ('ONE_OFF', 'RECURRING')),
                frequency VARCHAR(20) CHECK (frequency IS NULL OR frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
                schedule_time VARCHAR(5) NOT NULL,
                schedule_date DATE,
                weekdays TEXT[],
                month_day INTEGER CHECK (month_day IS NULL OR (month_day >= 1 AND month_day <= 28)),
                target_roles TEXT[] NOT NULL DEFAULT ARRAY['OWNER']::TEXT[],
                active BOOLEAN NOT NULL DEFAULT TRUE,
                system_key VARCHAR(50),
                last_run_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reminders_active ON reminders(active) WHERE active = TRUE;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reminders_system_key ON reminders(system_key) WHERE system_key IS NOT NULL;`);

        // Seed the Bread reminder ONLY on first create — never re-insert if
        // the operator has deleted it or edited its schedule. The row
        // behaves like any other reminder (fully editable), but its
        // system_key keys into the runDailyBreadReminder handler so the
        // "N kg per M coperti" body stays auto-computed.
        await client.query(`
            INSERT INTO reminders
                (title, description, kind, frequency, schedule_time, target_roles, active, system_key)
            SELECT
                'Promemoria pane',
                'Calcola automaticamente i kg di pane per il giorno seguente in base ai coperti previsti.',
                'RECURRING', 'DAILY', '20:00',
                ARRAY['OWNER']::TEXT[], TRUE, 'BREAD_DAILY'
            WHERE NOT EXISTS (
                SELECT 1 FROM reminders WHERE system_key = 'BREAD_DAILY'
            );
        `);

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

        // Slot-level blacklist per weekday+shift. When the operator disabilita
        // uno slot (es. 20:00 il sabato sera) l'ora sparisce da getAvailableSlots
        // e quindi anche dal modal prenotazioni, /public/availability (usato da
        // /prenota) e dalla validazione del webhook create-reservation
        // dell'agente vocale. Regola ricorrente — per disabilitare uno slot
        // solo per una data specifica, resta la strada di special_closures
        // (che oggi ha granularità turno intero).
        await client.query(`
            CREATE TABLE IF NOT EXISTS opening_hours_disabled_slots (
                weekday   SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
                shift     VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH','DINNER')),
                slot_time TIME NOT NULL,
                PRIMARY KEY (weekday, shift, slot_time)
            );
        `);

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
        // Some settings are numeric (e.g. thresholds), so `value` needs to be
        // nullable and we grow a companion `int_value` column. Rows use one
        // or the other depending on their type — never both. Keeps a single
        // KV table without introducing JSONB just for a handful of values.
        await client.query(`ALTER TABLE app_settings ALTER COLUMN value DROP NOT NULL;`);
        await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS int_value INTEGER;`);
        // Handoff threshold for the voice agent: bookings > this go to a
        // human callback instead of hitting the tools. Seeded at 8 to match
        // the value hardcoded in the webhook before this became configurable.
        await client.query(`
            INSERT INTO app_settings (key, int_value) VALUES
                ('voice_large_group_threshold', 8)
            ON CONFLICT (key) DO NOTHING;
        `);
        // Some settings carry text values (HH:MM, labels, …). Same rule as
        // int_value: rows use text_value XOR the others depending on type.
        await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS text_value TEXT;`);
        // Voice-agent "prenotazioni sospese" mode: when the toggle is on,
        // the init-conversation webhook overrides Sofia's first_message with
        // a suspension notice pointing the caller at a fallback callback
        // time. Seed OFF + default 19:00 so a fresh install is safe.
        await client.query(`
            INSERT INTO app_settings (key, value) VALUES
                ('voice_bookings_suspended', false)
            ON CONFLICT (key) DO NOTHING;
        `);
        await client.query(`
            INSERT INTO app_settings (key, text_value) VALUES
                ('voice_bookings_suspension_callback_time', '19:00')
            ON CONFLICT (key) DO NOTHING;
        `);
        await client.query(`
            INSERT INTO app_settings (key, text_value) VALUES
                ('voice_bookings_suspension_schedule', '[]')
            ON CONFLICT (key) DO NOTHING;
        `);

        // ============================================
        // INTEGRATION SETTINGS (per-provider secrets + environment)
        // ============================================
        // One row per external provider (currently only Revolut). Values are
        // stored in plaintext to match the existing Twilio/Meta/Vonage pattern;
        // add row-level encryption at the same time for all providers if we
        // need it later. Any NULL/empty column here falls back to the matching
        // env var at read time (see services/revolutService.ts), so an install
        // without a DB row keeps behaving exactly like before.
        await client.query(`
            CREATE TABLE IF NOT EXISTS integration_settings (
                provider           VARCHAR(50) PRIMARY KEY,
                environment        VARCHAR(20) NOT NULL DEFAULT 'sandbox',
                api_key            TEXT,
                webhook_secret     TEXT,
                api_version        VARCHAR(20),
                updated_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
            );
        `);
        // Auto-deposit policy, attached to the Revolut row: when enabled,
        // public web bookings with `guests >= auto_deposit_min_guests` get a
        // Revolut checkout link in their ack SMS. Kept here (rather than in
        // app_settings) because the feature only makes sense with Revolut
        // configured, and it lets us read/write everything in one row.
        await client.query(`
            ALTER TABLE integration_settings
                ADD COLUMN IF NOT EXISTS auto_deposit_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS auto_deposit_min_guests INTEGER NOT NULL DEFAULT 9;
        `);
        // Email config (SMTP or Resend). Both live on the same row
        // provider='smtp'; the `email_provider` column decides which backend
        // to use. smtp_* fields drive raw SMTP; resend_api_key drives the
        // Resend HTTPS API. Rows with provider='revolut' leave these NULL.
        await client.query(`
            ALTER TABLE integration_settings
                ADD COLUMN IF NOT EXISTS smtp_host       TEXT,
                ADD COLUMN IF NOT EXISTS smtp_port       INTEGER,
                ADD COLUMN IF NOT EXISTS smtp_secure     BOOLEAN,
                ADD COLUMN IF NOT EXISTS smtp_user       TEXT,
                ADD COLUMN IF NOT EXISTS smtp_password   TEXT,
                ADD COLUMN IF NOT EXISTS smtp_from_email TEXT,
                ADD COLUMN IF NOT EXISTS smtp_from_name  TEXT,
                ADD COLUMN IF NOT EXISTS email_provider  VARCHAR(20),
                ADD COLUMN IF NOT EXISTS resend_api_key  TEXT;
        `);
        // Reply-To for outgoing email + Svix signing secret for the Resend
        // inbound webhook. Reply-To routes customer replies to the inbound
        // subdomain (typically reply@reply.<domain>) so /webhook/resend-inbound
        // can capture them; the signing secret validates each inbound POST.
        await client.query(`
            ALTER TABLE integration_settings
                ADD COLUMN IF NOT EXISTS smtp_reply_to           TEXT,
                ADD COLUMN IF NOT EXISTS resend_inbound_secret   TEXT;
        `);
        // IMAP polling for inbound email. Alternative to the Resend inbound
        // webhook: we connect to the mailbox we send from (e.g. Aruba) via
        // IMAP+IDLE and thread each new message back to a reservation using
        // the same In-Reply-To/References logic. `imap_last_seen_uid` is our
        // watermark so a restart doesn't re-import the whole inbox.
        await client.query(`
            ALTER TABLE integration_settings
                ADD COLUMN IF NOT EXISTS imap_host          TEXT,
                ADD COLUMN IF NOT EXISTS imap_port          INTEGER,
                ADD COLUMN IF NOT EXISTS imap_secure        BOOLEAN,
                ADD COLUMN IF NOT EXISTS imap_user          TEXT,
                ADD COLUMN IF NOT EXISTS imap_password      TEXT,
                ADD COLUMN IF NOT EXISTS imap_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS imap_last_seen_uid BIGINT;
        `);

        // ============================================
        // OUTBOUND MESSAGES LOG (SMS / WhatsApp)
        // ============================================
        // Persistent log of every SMS/WhatsApp we hand to a provider so the
        // operator can see the message history per customer without opening
        // the Twilio console. `to_phone_digits` is the digits-only form of
        // the recipient (used to match a voice-call phone against this log).
        await client.query(`
            CREATE TABLE IF NOT EXISTS outbound_messages (
                id                SERIAL PRIMARY KEY,
                provider          VARCHAR(20) NOT NULL,
                channel           VARCHAR(20) NOT NULL,
                to_phone          VARCHAR(30) NOT NULL,
                to_phone_digits   VARCHAR(20) NOT NULL,
                body              TEXT NOT NULL,
                status            VARCHAR(20),
                provider_sid      VARCHAR(64),
                reservation_id    INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
                sent_at           TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                delivered_at      TIMESTAMPTZ,
                failed_at         TIMESTAMPTZ,
                error_code        VARCHAR(20),
                error_message     TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_to_phone_digits ON outbound_messages(to_phone_digits);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_provider_sid ON outbound_messages(provider_sid);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_sent_at ON outbound_messages(sent_at DESC);`);
        // Broaden the log to also cover outbound emails. to_phone/to_phone_digits
        // are dropped-NOT-NULL because email rows leave them empty; to_email is
        // added for the recipient address.
        await client.query(`ALTER TABLE outbound_messages ALTER COLUMN to_phone DROP NOT NULL;`);
        await client.query(`ALTER TABLE outbound_messages ALTER COLUMN to_phone_digits DROP NOT NULL;`);
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS to_email TEXT;`);
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS subject TEXT;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_to_email ON outbound_messages(lower(to_email));`);
        // Inbound email support. `direction` distinguishes rows we sent from
        // replies received via the Resend inbound webhook. `from_email` carries
        // the sender on inbound rows (outbound rows leave it NULL). `message_id`
        // is the RFC 5322 Message-ID we generated (outbound) or the one Resend
        // reports (inbound). `in_reply_to` is the RFC 5322 In-Reply-To header
        // used to thread a reply back to the outbound message that started it.
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS direction VARCHAR(10) NOT NULL DEFAULT 'outbound';`);
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS from_email TEXT;`);
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS message_id TEXT;`);
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_message_id ON outbound_messages(message_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_in_reply_to ON outbound_messages(in_reply_to);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_from_email ON outbound_messages(lower(from_email));`);
        // Inbound SMS/WhatsApp support. Symmetric to to_phone/to_phone_digits:
        // outbound rows leave these NULL, inbound rows carry the sender number.
        // The digits index lets the inbox group all messages to/from the same
        // customer regardless of direction.
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS from_phone VARCHAR(30);`);
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS from_phone_digits VARCHAR(20);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_messages_from_phone_digits ON outbound_messages(from_phone_digits);`);
        // `read_at` is set when an operator marks an inbound message read via
        // the inbox UI. Outbound rows leave it NULL.
        await client.query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;`);

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
        // RESERVATION ALLERGEN PRESETS
        // ============================================
        // Configurable intolleranze chips shown in the reservation modal.
        // Same shape as note presets but no icon — allergens render as a
        // uniform amber pill on the card, so per-item icons would add no
        // signal. Seed matches the previous hardcoded COMMON_ALLERGENS list.
        await client.query(`
            CREATE TABLE IF NOT EXISTS reservation_allergen_presets (
                id         SERIAL PRIMARY KEY,
                label      VARCHAR(80) NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const existingAllergenPresetCount = await client.query(`SELECT COUNT(*)::int AS n FROM reservation_allergen_presets;`);
        if (existingAllergenPresetCount.rows[0]?.n === 0) {
            await client.query(`
                INSERT INTO reservation_allergen_presets (label, sort_order) VALUES
                    ('Glutine',          10),
                    ('Crostacei',        20),
                    ('Uova',             30),
                    ('Pesce',            40),
                    ('Arachidi',         50),
                    ('Soia',             60),
                    ('Latte',            70),
                    ('Frutta a guscio',  80),
                    ('Sedano',           90),
                    ('Senape',          100),
                    ('Sesamo',          110),
                    ('Solfiti',         120),
                    ('Lupini',          130),
                    ('Molluschi',       140);
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

        // ============================================
        // DEV BOARD (pagina Development, solo account admin)
        // ============================================
        // Kanban di progetto: una card per implementazione. column_key è la
        // colonna (in_progress / review / nice_to_have / paused / done);
        // position ordina dentro la colonna — il client rinumera l'intera
        // colonna di destinazione a ogni drop, quindi basta un intero.
        await client.query(`
            CREATE TABLE IF NOT EXISTS dev_board_cards (
                id          SERIAL PRIMARY KEY,
                title       VARCHAR(200) NOT NULL,
                description TEXT,
                column_key  VARCHAR(20) NOT NULL DEFAULT 'in_progress',
                position    INTEGER NOT NULL DEFAULT 0,
                created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_dev_board_cards_column ON dev_board_cards(column_key, position);
        `);
        const existingDevCardCount = await client.query(`SELECT COUNT(*)::int AS n FROM dev_board_cards;`);
        if (existingDevCardCount.rows[0]?.n === 0) {
            await client.query(`
                INSERT INTO dev_board_cards (title, description, column_key, position) VALUES
                    ('Pay-at-table + split bill (Fase 1)', 'QR effimero, Revolut hosted checkout, split equal/custom.', 'in_progress', 0),
                    ('Integrazione Passepartout (Fase 2)', 'Sblocca item-level split e scontrino fiscale. In attesa di risposte dal rivenditore.', 'paused', 0),
                    ('Redesign UX 2.0', 'Stati time-derived, check-in zero friction, hero dashboard, GDPR.', 'done', 0),
                    ('Popup tavolo scaduto + coerenza stati timed', 'Prompt "Tavolo ancora occupato?" e board lista/modal allineati sullo stato derivato.', 'done', 1),
                    ('Template WhatsApp via Twilio', '5/5 template Utility approvati e collegati; SMS resta fallback automatico.', 'done', 2);
            `);
        }

        // ============================================
        // GESTIONALE DI SALA — PR 1: listini, varianti, partite
        // ============================================
        // Fondamenta dello schema comande (vedi docs/gestionale-sala-plan.md).
        // Questa PR crea solo strutture e fa il backfill dei prezzi: nessun
        // endpoint le legge ancora, nessuna UI le mostra. Il CRM si comporta
        // esattamente come prima.
        //
        // Tutto il blocco sta in coda a createSchema di proposito: le comande
        // arriveranno a toccare `dishes` da più punti, e tenerle raggruppate
        // qui riduce la superficie di conflitto quando si lavora in parallelo
        // su questo file.

        // --- Listini -----------------------------------------------------
        // `dishes.price` è un prezzo unico. I listini servono a differenziare
        // sala / asporto / eventi e a cambiare i prezzi stagionali senza
        // riscrivere lo storico: i conti chiusi conservano lo snapshot del
        // prezzo, non un riferimento al listino.
        await client.query(`
            CREATE TABLE IF NOT EXISTS menu_price_lists (
                id          SERIAL PRIMARY KEY,
                name        VARCHAR(100) NOT NULL,
                is_default  BOOLEAN NOT NULL DEFAULT FALSE,
                is_active   BOOLEAN NOT NULL DEFAULT TRUE,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Un solo listino di default, garantito dall'indice parziale.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_price_lists_single_default
                ON menu_price_lists(is_default) WHERE is_default;
        `);
        // Nome univoco case-insensitive: rende i seed idempotenti senza
        // guardie applicative e blocca il doppione da errore di battitura.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_price_lists_name
                ON menu_price_lists(LOWER(name));
        `);
        await client.query(`
            INSERT INTO menu_price_lists (name, is_default, sort_order)
            VALUES ('Sala', TRUE, 0)
            ON CONFLICT DO NOTHING;
        `);

        // Prezzo per (piatto, listino), in centesimi interi. Da qui in avanti
        // gli importi nuovi sono sempre INTEGER: `dishes.price` resta
        // DECIMAL per compatibilità, ma la conversione avviene solo qui.
        await client.query(`
            CREATE TABLE IF NOT EXISTS dish_prices (
                dish_id       INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
                price_list_id INTEGER NOT NULL REFERENCES menu_price_lists(id) ON DELETE CASCADE,
                price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
                PRIMARY KEY (dish_id, price_list_id)
            );
        `);
        // Backfill dal prezzo attuale verso il listino di default. Idempotente
        // due volte: ON CONFLICT copre il riavvio, e la SELECT prende anche i
        // piatti creati dopo questa migrazione ma prima che la UI dei listini
        // esista (PR 2+), così nessun piatto resta senza prezzo.
        //
        // GREATEST(0, ...) evita che un prezzo negativo già in tabella faccia
        // fallire il CHECK: un dato assurdo non deve impedire il boot dell'app.
        await client.query(`
            INSERT INTO dish_prices (dish_id, price_list_id, price_cents)
            SELECT d.id, pl.id, GREATEST(0, ROUND(d.price * 100))::int
            FROM dishes d
            CROSS JOIN menu_price_lists pl
            WHERE pl.is_default
            ON CONFLICT (dish_id, price_list_id) DO NOTHING;
        `);

        // --- Varianti ----------------------------------------------------
        // «Senza cipolla», «al sangue», «+ bufala € 2». I gruppi sono
        // riusabili fra piatti (un solo gruppo "Cottura" per tutte le carni).
        // Sulla riga di comanda i modificatori verranno snapshottati in JSONB
        // (PR 2), non referenziati: cambiare il prezzo di un modificatore non
        // deve muovere i conti già emessi.
        await client.query(`
            CREATE TABLE IF NOT EXISTS modifier_groups (
                id          SERIAL PRIMARY KEY,
                name        VARCHAR(100) NOT NULL,
                min_select  INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
                max_select  INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK (max_select >= min_select)
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS modifiers (
                id                SERIAL PRIMARY KEY,
                group_id          INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
                name              VARCHAR(100) NOT NULL,
                price_delta_cents INTEGER NOT NULL DEFAULT 0,
                is_active         BOOLEAN NOT NULL DEFAULT TRUE,
                sort_order        INTEGER NOT NULL DEFAULT 0
            );
        `);
        // price_delta_cents senza CHECK: può essere negativo (uno sconto per
        // il piatto servito senza un ingrediente costoso).
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_modifiers_group ON modifiers(group_id, sort_order);
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS dish_modifier_groups (
                dish_id  INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
                group_id INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
                PRIMARY KEY (dish_id, group_id)
            );
        `);

        // --- Partite di preparazione -------------------------------------
        // Una riga per postazione di cucina, ognuna col proprio monitor KDS
        // (PR 4). La cucina di riferimento ne ha tre.
        await client.query(`
            CREATE TABLE IF NOT EXISTS stations (
                id         SERIAL PRIMARY KEY,
                name       VARCHAR(50) NOT NULL,
                color      VARCHAR(20),
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_active  BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Stesso motivo dei listini: senza indice univoco il seed sotto
        // duplicherebbe le partite a ogni riavvio del server.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_name ON stations(LOWER(name));
        `);
        await client.query(`
            INSERT INTO stations (name, color, sort_order) VALUES
                ('Antipasti', 'emerald', 1),
                ('Primi',     'amber',   2),
                ('Griglia',   'rose',    3)
            ON CONFLICT DO NOTHING;
        `);

        // Partita di destinazione del piatto. NULL = nessuna partita
        // assegnata: la riga finirà sul monitor del passe invece di sparire.
        await client.query(`
            ALTER TABLE dishes ADD COLUMN IF NOT EXISTS station_id INTEGER
                REFERENCES stations(id) ON DELETE SET NULL;
        `);
        // Tempo di preparazione tipico. Alimenta il lancio scaglionato delle
        // uscite (PR 5): senza, in una cucina multi-partita gli antipasti
        // arrivano al passe dieci minuti prima della griglia. NULL viene
        // trattato come 0 — comportamento identico a un KDS non scaglionato,
        // così il campo si può popolare piatto per piatto senza fretta.
        await client.query(`
            ALTER TABLE dishes ADD COLUMN IF NOT EXISTS prep_minutes INTEGER
                CHECK (prep_minutes IS NULL OR prep_minutes >= 0);
        `);

        // ============================================
        // GESTIONALE DI SALA — PR 2: comande
        // ============================================
        // Una `orders` per conto aperto al tavolo, N `order_items` per riga
        // ordinata. La comanda dice *cosa si sta preparando*; il conto
        // (`table_bills`) dice *quanto si deve*. Restano due macchine a stati
        // separate: il ponte fra le due arriva nella PR 6.

        // `reservation_id` è nullable perché i walk-in non hanno prenotazione,
        // `table_id` perché una prenotazione può non avere ancora un tavolo
        // assegnato. Il CHECK impedisce la comanda orfana di entrambi.
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id                 SERIAL PRIMARY KEY,
                reservation_id     INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
                table_id           INTEGER REFERENCES tables(id) ON DELETE SET NULL,
                table_bill_id      INTEGER REFERENCES table_bills(id) ON DELETE SET NULL,
                order_type         VARCHAR(20) NOT NULL DEFAULT 'DINE_IN',
                price_list_id      INTEGER REFERENCES menu_price_lists(id) ON DELETE SET NULL,
                covers             INTEGER NOT NULL DEFAULT 1 CHECK (covers > 0),
                status             VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                                   CHECK (status IN ('OPEN','CLOSED','VOIDED')),
                opened_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
                closed_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
                opened_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                closed_at          TIMESTAMPTZ,
                notes              TEXT,
                idempotency_key    VARCHAR(80) UNIQUE,
                CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL)
            );
        `);
        // Una sola comanda aperta per tavolo e per prenotazione. È il vincolo
        // che rende sicuri due camerieri sullo stesso tavolo: entrambi
        // scrivono sulla stessa comanda invece di crearne due, e il socket li
        // riallinea. Strutturale e non applicativo, così la race fra due
        // richieste simultanee la perde il database e non i clienti.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_table
                ON orders(table_id) WHERE status = 'OPEN' AND table_id IS NOT NULL;
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_reservation
                ON orders(reservation_id) WHERE status = 'OPEN' AND reservation_id IS NOT NULL;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_orders_bill ON orders(table_bill_id)
                WHERE table_bill_id IS NOT NULL;
        `);

        // La riga di comanda porta lo *snapshot* di nome, prezzo e varianti:
        // rinominare un piatto o ritoccarne il prezzo non deve muovere le
        // comande in corso, né i conti già emessi.
        //
        // I tre istanti sono distinti e non intercambiabili:
        //   queued_at        → la sala ha proposto
        //   fired_at         → il passe ha lanciato l'uscita
        //   station_start_at → quando QUESTA partita deve iniziare
        //   started_at       → quando ha iniziato davvero
        // Il lancio scaglionato (PR 5) calcola station_start_at; qui la
        // colonna esiste già così la PR 5 non dovrà migrare dati vivi.
        await client.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id                 SERIAL PRIMARY KEY,
                order_id           INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                dish_id            INTEGER REFERENCES dishes(id) ON DELETE SET NULL,
                name_snapshot      VARCHAR(255) NOT NULL,
                unit_price_cents   INTEGER NOT NULL CHECK (unit_price_cents >= 0),
                modifiers          JSONB,
                qty                INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
                course_no          INTEGER NOT NULL DEFAULT 1 CHECK (course_no > 0),
                seat_no            INTEGER CHECK (seat_no IS NULL OR seat_no > 0),
                station_id         INTEGER REFERENCES stations(id) ON DELETE SET NULL,
                status             VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                                   CHECK (status IN ('DRAFT','QUEUED','SENT','PREPARING','READY','SERVED','VOIDED')),
                note               TEXT,
                queued_at          TIMESTAMPTZ,
                fired_at           TIMESTAMPTZ,
                station_start_at   TIMESTAMPTZ,
                started_at         TIMESTAMPTZ,
                ready_at           TIMESTAMPTZ,
                served_at          TIMESTAMPTZ,
                voided_at          TIMESTAMPTZ,
                voided_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
                void_reason        TEXT,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                idempotency_key    VARCHAR(80) UNIQUE
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id, course_no);
        `);
        // Coda del monitor di partita (PR 4): solo le righe lavorabili.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_order_items_kds
                ON order_items(station_id, status)
                WHERE status IN ('SENT','PREPARING','READY');
        `);

        // Modalità di lancio delle uscite. Seed su AUTO_ALL — obbligatorio
        // finché la vista passe non esiste (PR 5): senza qualcuno che possa
        // lanciarle a mano, le uscite oltre la prima resterebbero bloccate in
        // QUEUED e in cucina non arriverebbe nulla. Si passa ad AUTO_FIRST
        // nello stesso deploy che porta online il passe.
        await client.query(`
            INSERT INTO app_settings (key, text_value) VALUES
                ('course_fire_mode', 'AUTO_ALL')
            ON CONFLICT (key) DO NOTHING;
        `);
        // Il modulo comande resta spento finché non c'è una UI che lo usi.
        await client.query(`
            INSERT INTO app_settings (key, value) VALUES
                ('table_orders_enabled', false)
            ON CONFLICT (key) DO NOTHING;
        `);

        // ============================================
        // GESTIONALE DI SALA — PR 6: ponte comanda → conto
        // ============================================
        // Da qui in avanti `table_bills.total_cents` è un valore derivato
        // dalle righe di comanda, non un numero digitato dal cameriere.

        // Un conto attivo per tavolo/prenotazione, garantito dal database.
        // Sostituisce il controllo applicativo in POST /reservations/:id/bill,
        // che lasciava aperta la race fra due camerieri che aprono il conto
        // sullo stesso tavolo nello stesso istante.
        //
        // NOT VALID: eventuali righe storiche con entrambi gli ancoraggi NULL
        // (table_id azzerato da un ON DELETE SET NULL) non devono far fallire
        // la migrazione — il vincolo vale sulle scritture nuove.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'table_bills_anchor_present'
                ) THEN
                    ALTER TABLE table_bills ADD CONSTRAINT table_bills_anchor_present
                        CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL) NOT VALID;
                END IF;
            END $$;
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_table_bills_one_active
                ON table_bills(COALESCE(reservation_id, -table_id))
                WHERE status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL');
        `);

        // ============================================
        // GESTIONALE DI SALA — PR 10: servizio (data + turno)
        // ============================================
        // Senza queste due colonne una comanda aperta a pranzo resta in mezzo
        // alla cena, e una di ieri compare oggi: il resto del CRM ragiona per
        // data e turno, le comande devono farlo anche loro.
        //
        // La "data di servizio" non è la data solare: una cena che finisce
        // all'una di notte appartiene ancora al giorno prima. Il giorno di
        // servizio comincia alle 05:00 Europe/Rome.
        await client.query(`
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_date DATE;
        `);
        await client.query(`
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift VARCHAR(10)
                CHECK (shift IS NULL OR shift IN ('LUNCH','DINNER'));
        `);
        // Backfill dalle comande già esistenti, con la stessa regola.
        await client.query(`
            UPDATE orders SET
                service_date = (
                    CASE WHEN EXTRACT(hour FROM (opened_at AT TIME ZONE 'Europe/Rome')) < 5
                         THEN ((opened_at AT TIME ZONE 'Europe/Rome') - INTERVAL '1 day')::date
                         ELSE (opened_at AT TIME ZONE 'Europe/Rome')::date
                    END
                ),
                shift = (
                    CASE WHEN EXTRACT(hour FROM (opened_at AT TIME ZONE 'Europe/Rome')) BETWEEN 5 AND 16
                         THEN 'LUNCH' ELSE 'DINNER'
                    END
                )
            WHERE service_date IS NULL OR shift IS NULL;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_orders_service
                ON orders(service_date, shift, status);
        `);

        // L'unicità della comanda aperta vale DENTRO il servizio: una comanda
        // dimenticata a pranzo non deve impedire di aprirne una a cena sullo
        // stesso tavolo. Gli indici della PR 2 vanno sostituiti.
        await client.query(`DROP INDEX IF EXISTS idx_orders_one_open_per_table;`);
        await client.query(`DROP INDEX IF EXISTS idx_orders_one_open_per_reservation;`);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_table_service
                ON orders(table_id, service_date, shift)
                WHERE status = 'OPEN' AND table_id IS NOT NULL;
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_reservation
                ON orders(reservation_id) WHERE status = 'OPEN' AND reservation_id IS NOT NULL;
        `);

        // ============================================
        // GESTIONALE DI SALA — PR 7: storni, sconti, coperti
        // ============================================

        // Righe di sistema: coperto e servizio non sono piatti e non vanno
        // mai in cucina, ma pesano sul conto. Distinguerle serve a non
        // mandarle al KDS e a non contarle nel servizio addebitato.
        await client.query(`
            ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_kind VARCHAR(20)
                NOT NULL DEFAULT 'DISH'
                CHECK (line_kind IN ('DISH','COVER','SERVICE'));
        `);

        // Sconto a livello di comanda, con motivazione: uno sconto senza
        // motivo scritto è un ammanco che nessuno sa spiegare a fine mese.
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) CHECK (discount_type IN ('PERCENT','AMOUNT'));`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) CHECK (discount_value IS NULL OR discount_value >= 0);`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_reason TEXT;`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);

        // Coperto e servizio, spenti di partenza: chi non li applica non deve
        // ritrovarseli sul conto dopo un aggiornamento.
        await client.query(`
            INSERT INTO app_settings (key, int_value) VALUES
                ('cover_charge_cents', 0),
                ('service_charge_percent', 0)
            ON CONFLICT (key) DO NOTHING;
        `);

        // Con la vista passe online (PR 5) il lancio passa da AUTO_ALL ad
        // AUTO_FIRST: la prima uscita continua a partire da sola, dalla
        // seconda in poi decide il passe. Prima di questa PR non esisteva
        // nessuno che potesse lanciarle a mano, quindi AUTO_ALL era
        // obbligatorio; ora sarebbe il contrario, un lancio automatico che
        // scavalca il coordinamento.
        //
        // Una tantum, tracciata da una chiave marcatore: chi ha scelto
        // deliberatamente AUTO_ALL o MANUAL dopo il rilascio non se lo vede
        // riscrivere a ogni riavvio del server.
        const fireModeMigrated = await client.query(
            `SELECT 1 FROM app_settings WHERE key = 'course_fire_mode_passe_migrated'`
        );
        if (fireModeMigrated.rowCount === 0) {
            await client.query(`
                UPDATE app_settings SET text_value = 'AUTO_FIRST'
                WHERE key = 'course_fire_mode' AND text_value = 'AUTO_ALL';
            `);
            await client.query(`
                INSERT INTO app_settings (key, value) VALUES ('course_fire_mode_passe_migrated', true)
                ON CONFLICT (key) DO NOTHING;
            `);
        }

        // ============================================
        // STAMPA — coda preconti per l'agente locale
        // ============================================
        // Il backend (in cloud) non può raggiungere la termica in sala:
        // accoda qui, e un agente sulla LAN del ristorante ritira i job e
        // li inoltra in ESC/POS (scripts/print-agent.mjs). Il payload è uno
        // snapshot completo del documento: il conto è immutabile una volta
        // emesso, e l'agente non deve fare altre query per stampare.
        await client.query(`
            CREATE TABLE IF NOT EXISTS print_jobs (
                id SERIAL PRIMARY KEY,
                kind VARCHAR(20) NOT NULL,
                payload JSONB NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PRINTED','FAILED')),
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                printed_at TIMESTAMPTZ
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_print_jobs_pending
                ON print_jobs(id) WHERE status = 'PENDING';
        `);

        // Permessi del modulo comande sui database esistenti. A runtime la
        // fonte di verità è questa tabella, non ROLE_PERMISSIONS in
        // auth/permissions.ts: senza queste righe gli endpoint rispondono 403
        // anche all'OWNER. Deve restare allineato a quel file.
        //
        // `orders:expedite` è separato da `orders:kds` di proposito: lanciare
        // un'uscita tocca tutte le partite, lavorare la propria coda no.
        const orderPermissions: [string, string][] = [
            ['OWNER', 'orders:view'], ['OWNER', 'orders:take'], ['OWNER', 'orders:kds'],
            ['OWNER', 'orders:expedite'], ['OWNER', 'orders:void'],
            ['GENERAL_MANAGER', 'orders:view'], ['GENERAL_MANAGER', 'orders:take'],
            ['GENERAL_MANAGER', 'orders:kds'], ['GENERAL_MANAGER', 'orders:expedite'],
            ['GENERAL_MANAGER', 'orders:void'],
            ['MANAGER', 'orders:view'], ['MANAGER', 'orders:take'],
            ['MANAGER', 'orders:expedite'], ['MANAGER', 'orders:void'],
            ['RECEPTION', 'orders:view'],
            ['WAITER', 'orders:view'], ['WAITER', 'orders:take'],
            ['KITCHEN', 'orders:view'], ['KITCHEN', 'orders:kds'], ['KITCHEN', 'orders:expedite'],
        ];
        for (const [role, permission] of orderPermissions) {
            await client.query(
                'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [role, permission]
            );
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
