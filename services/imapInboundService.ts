// IMAP inbound-email service — supervisore multi-tenant (Fase C4).
//
// Alternative to the Resend inbound webhook when the mailbox we send from
// isn't hosted on Resend (Aruba, Gmail, etc.). We open a long-lived
// IMAP+IDLE connection to the mailbox and, whenever a new message appears
// in INBOX, thread it back to a reservation using the same rules the Resend
// path uses (In-Reply-To → References → sender email fallback) and insert
// it into `outbound_messages` with direction='inbound'.
//
// Da Fase C4 il servizio non è più una connessione singola: un supervisore
// legge da integration_settings i tenant attivi con imap_enabled=true e
// tiene UN listener per tenant, ognuno con il proprio reconnect/backoff e
// il proprio watermark (imap_last_seen_uid sulla riga del tenant).
//
// Config lives on integration_settings (imap_host, imap_port, imap_secure,
// imap_user, imap_password, imap_enabled). `imap_last_seen_uid` è il
// watermark: on reconnect we only pull UIDs strictly greater than it, so a
// restart never re-imports the full inbox.

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { queryWithRetry } from '../db.js';
import type { SocketService } from './socketService.js';
import { sendToRoles as pushSendToRoles } from './pushService.js';
import {
    parseFromAddress,
    splitReferences,
    resolveReservationByMessageIds,
    resolveReservationByFromEmail,
} from './emailThreading.js';

// Le variabili IMAP_* valgono SOLO per il tenant 1: compat con le
// installazioni pre-SaaS che configuravano la mailbox via env invece che
// dalle Impostazioni. I tenant nuovi esistono solo in integration_settings.
const LEGACY_ENV_TENANT_ID = 1;

export interface ImapConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    enabled: boolean;
    lastSeenUid: number | null;
}

export interface ImapStatus {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    enabled: boolean;
    has_password: boolean;
    password_last4: string | null;
    last_seen_uid: number | null;
    configured: boolean;
    connected: boolean;
}

// Cache per tenant (Fase B3.6): la config vive sulla riga (tenant_id, 'smtp').
const CACHE_TTL_MS = 30_000;
const cache = new Map<number, { config: ImapConfig; loadedAt: number }>();

// Default neutri per i tenant SaaS: senza riga in integration_settings non
// c'è mailbox, quindi enabled=false e credenziali vuote.
function baseDefaults(): ImapConfig {
    return {
        host: '',
        port: 993,
        secure: true,
        user: '',
        password: '',
        enabled: false,
        lastSeenUid: null,
    };
}

function envDefaults(): ImapConfig {
    return {
        host: process.env.IMAP_HOST || '',
        port: Number(process.env.IMAP_PORT) || 993,
        secure: process.env.IMAP_SECURE !== 'false',
        user: process.env.IMAP_USER || '',
        password: process.env.IMAP_PASSWORD || '',
        enabled: process.env.IMAP_ENABLED === 'true',
        lastSeenUid: null,
    };
}

async function loadFromDb(tenantId: number): Promise<ImapConfig> {
    // Fallback env solo per il tenant storico (vedi LEGACY_ENV_TENANT_ID).
    const defaults = tenantId === LEGACY_ENV_TENANT_ID ? envDefaults() : baseDefaults();
    try {
        const result = await queryWithRetry(
            `SELECT imap_host, imap_port, imap_secure, imap_user, imap_password,
                    imap_enabled, imap_last_seen_uid
             FROM integration_settings WHERE tenant_id = $1 AND provider = 'smtp' LIMIT 1`,
            [tenantId]
        );
        const row = result.rows[0];
        if (!row) return defaults;
        const host = (row.imap_host && String(row.imap_host).trim()) || defaults.host;
        const port = Number.isFinite(Number(row.imap_port)) && Number(row.imap_port) > 0
            ? Number(row.imap_port)
            : defaults.port;
        const secure = typeof row.imap_secure === 'boolean' ? row.imap_secure : defaults.secure;
        const user = (row.imap_user && String(row.imap_user).trim()) || defaults.user;
        const password = (row.imap_password && String(row.imap_password)) || defaults.password;
        const enabled = typeof row.imap_enabled === 'boolean' ? row.imap_enabled : defaults.enabled;
        const lastSeenUid = row.imap_last_seen_uid !== null && row.imap_last_seen_uid !== undefined
            ? Number(row.imap_last_seen_uid)
            : null;
        return { host, port, secure, user, password, enabled, lastSeenUid };
    } catch (err) {
        console.warn(`[IMAP][t${tenantId}] loadFromDb failed, using defaults:`, (err as any)?.message || err);
        return defaults;
    }
}

async function getConfig(tenantId: number, force = false): Promise<ImapConfig> {
    const now = Date.now();
    const cached = cache.get(tenantId);
    if (!force && cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.config;
    const config = await loadFromDb(tenantId);
    cache.set(tenantId, { config, loadedAt: now });
    return config;
}

export function invalidateImapConfigCache(tenantId?: number): void {
    if (tenantId !== undefined) cache.delete(tenantId);
    else cache.clear();
}

function isImapConfigured(c: ImapConfig): boolean {
    return !!(c.host && c.port && c.user && c.password);
}

export async function getImapConfigStatus(tenantId: number): Promise<ImapStatus> {
    const c = await getConfig(tenantId, true);
    const listener = listeners.get(tenantId);
    return {
        host: c.host,
        port: c.port,
        secure: c.secure,
        user: c.user,
        enabled: c.enabled,
        has_password: !!c.password,
        password_last4: c.password ? c.password.slice(-4) : null,
        last_seen_uid: c.lastSeenUid,
        configured: isImapConfigured(c),
        connected: !!listener?.client && listener.client.usable === true,
    };
}

// --------------------------------------------------------------------------
// Per-tenant listener lifecycle
// --------------------------------------------------------------------------

type SocketProvider = () => SocketService | undefined;

interface TenantListener {
    tenantId: number;
    client: ImapFlow | null;
    stopping: boolean;
    reconnectTimer: NodeJS.Timeout | null;
    reconnectAttempts: number;
    // Serializza il processing per-tenant: due 'exists' ravvicinati non
    // devono correre sullo stesso range di UID (double-insert).
    processing: Promise<void>;
}

const listeners = new Map<number, TenantListener>();
let socketProvider: SocketProvider = () => undefined;
let rescanTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(listener: TenantListener): void {
    if (listener.stopping || listener.reconnectTimer) return;
    listener.reconnectAttempts += 1;
    // Exponential backoff capped at 5 minutes.
    const base = Math.min(30_000 * Math.pow(2, listener.reconnectAttempts - 1), 300_000);
    // Add ±20% jitter so multiple deploys don't reconnect in lock-step.
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delayMs = Math.round(jitter);
    console.log(`[IMAP][t${listener.tenantId}] reconnect scheduled in ${Math.round(delayMs / 1000)}s (attempt ${listener.reconnectAttempts})`);
    listener.reconnectTimer = setTimeout(() => {
        listener.reconnectTimer = null;
        connectAndListen(listener).catch((err) => {
            console.error(`[IMAP][t${listener.tenantId}] reconnect failed:`, err?.message || err);
            scheduleReconnect(listener);
        });
    }, delayMs);
}

async function connectAndListen(listener: TenantListener): Promise<void> {
    if (listener.stopping) return;
    const tenantId = listener.tenantId;
    const config = await getConfig(tenantId, true);
    if (!config.enabled) {
        console.log(`[IMAP][t${tenantId}] disabled in settings — not connecting`);
        return;
    }
    if (!isImapConfigured(config)) {
        console.log(`[IMAP][t${tenantId}] not configured (host/user/password missing) — not connecting`);
        return;
    }

    const client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
        logger: false,
        // ImapFlow's own reconnect via reconnect() is manual; we handle it.
    });

    // Any low-level error kills the connection — schedule a reconnect. Do NOT
    // rethrow here; imapflow surfaces socket errors as events, not exceptions.
    client.on('error', (err: any) => {
        console.warn(`[IMAP][t${tenantId}] connection error:`, err?.message || err);
    });
    client.on('close', () => {
        if (listener.client === client) listener.client = null;
        if (!listener.stopping) {
            console.log(`[IMAP][t${tenantId}] connection closed — will reconnect`);
            scheduleReconnect(listener);
        }
    });

    try {
        await client.connect();
    } catch (err: any) {
        console.warn(`[IMAP][t${tenantId}] initial connect failed:`, err?.message || err);
        try { await client.logout(); } catch { /* ignore */ }
        scheduleReconnect(listener);
        return;
    }

    console.log(`[IMAP][t${tenantId}] connected to ${config.host}:${config.port} as ${config.user}`);
    listener.client = client;
    listener.reconnectAttempts = 0;

    // While the mailbox is open, ImapFlow keeps the connection in IDLE and
    // emits 'exists' whenever the server notifies about new messages.
    client.on('exists', () => {
        // We don't await here — the event loop is not our friend inside
        // event emitters. Fire-and-forget with error logging.
        processNewMessages(listener, client).catch((err) => {
            console.error(`[IMAP][t${tenantId}] processNewMessages error:`, err?.message || err);
        });
    });

    try {
        await client.mailboxOpen('INBOX');
    } catch (err: any) {
        console.error(`[IMAP][t${tenantId}] mailboxOpen failed:`, err?.message || err);
        try { await client.logout(); } catch { /* ignore */ }
        scheduleReconnect(listener);
        return;
    }

    // Catch up on anything that arrived while we were offline.
    processNewMessages(listener, client).catch((err) => {
        console.error(`[IMAP][t${tenantId}] catch-up processNewMessages error:`, err?.message || err);
    });
}

async function stopListener(listener: TenantListener): Promise<void> {
    listener.stopping = true;
    if (listener.reconnectTimer) {
        clearTimeout(listener.reconnectTimer);
        listener.reconnectTimer = null;
    }
    const client = listener.client;
    listener.client = null;
    if (client) {
        try { await client.logout(); }
        catch (err: any) { console.warn(`[IMAP][t${listener.tenantId}] logout error:`, err?.message || err); }
    }
}

function startListener(tenantId: number): TenantListener {
    const listener: TenantListener = {
        tenantId,
        client: null,
        stopping: false,
        reconnectTimer: null,
        reconnectAttempts: 0,
        processing: Promise.resolve(),
    };
    listeners.set(tenantId, listener);
    connectAndListen(listener).catch((err: any) => {
        console.error(`[IMAP][t${tenantId}] startup failed:`, err?.message || err);
        scheduleReconnect(listener);
    });
    return listener;
}

export async function stopImapForTenant(tenantId: number): Promise<void> {
    const listener = listeners.get(tenantId);
    if (!listener) return;
    listeners.delete(tenantId);
    await stopListener(listener);
}

export async function restartImapForTenant(tenantId: number): Promise<void> {
    await stopImapForTenant(tenantId);
    invalidateImapConfigCache(tenantId);
    // startListener si arrende da solo se la config è disabled/incompleta,
    // quindi il restart è sicuro anche quando il PUT ha appena spento IMAP.
    startListener(tenantId);
}

// --------------------------------------------------------------------------
// Supervisor
// --------------------------------------------------------------------------

// Tenant che DEVONO avere un listener: quelli attivi con imap_enabled=true,
// più il tenant storico se le env IMAP_* lo abilitano senza riga a database
// (compat pre-SaaS, vedi LEGACY_ENV_TENANT_ID).
async function desiredTenantIds(): Promise<Set<number>> {
    const desired = new Set<number>();
    const result = await queryWithRetry(
        `SELECT s.tenant_id
         FROM integration_settings s
         JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
         WHERE s.provider = 'smtp' AND s.imap_enabled = TRUE`,
        []
    );
    for (const row of result.rows) desired.add(Number(row.tenant_id));
    if (!desired.has(LEGACY_ENV_TENANT_ID) && envDefaults().enabled) {
        // getConfig fonde riga ed env con le stesse regole del listener: se
        // la riga esiste e dice enabled=false, l'env NON la scavalca.
        const legacy = await getConfig(LEGACY_ENV_TENANT_ID, true);
        if (legacy.enabled) desired.add(LEGACY_ENV_TENANT_ID);
    }
    return desired;
}

async function superviseOnce(): Promise<void> {
    const desired = await desiredTenantIds();
    // Spegni i listener dei tenant disabilitati/sospesi nel frattempo.
    for (const tenantId of Array.from(listeners.keys())) {
        if (!desired.has(tenantId)) {
            console.log(`[IMAP][t${tenantId}] no longer enabled — stopping listener`);
            await stopImapForTenant(tenantId);
        }
    }
    // Accendi i nuovi.
    for (const tenantId of desired) {
        if (!listeners.has(tenantId)) startListener(tenantId);
    }
}

// --------------------------------------------------------------------------
// Message processing
// --------------------------------------------------------------------------

function processNewMessages(listener: TenantListener, client: ImapFlow): Promise<void> {
    listener.processing = listener.processing.then(() => doProcess(listener, client)).catch((err) => {
        console.error(`[IMAP][t${listener.tenantId}] doProcess chain error:`, err?.message || err);
    });
    return listener.processing;
}

async function doProcess(listener: TenantListener, client: ImapFlow): Promise<void> {
    if (!client.usable) return;
    const tenantId = listener.tenantId;
    const config = await getConfig(tenantId, true);
    const since = (config.lastSeenUid ?? 0) + 1;
    const range = `${since}:*`;

    // Fetch minimal envelope + source. We ask for `source` because mailparser
    // needs raw MIME to correctly extract the body across multipart layouts.
    const messages: FetchMessageObject[] = [];
    try {
        for await (const msg of client.fetch(range, { uid: true, source: true, envelope: true })) {
            // `uid: true` on fetch options makes the range refer to UIDs, but
            // when since>highestUid the server returns the highest message
            // anyway — filter defensively.
            if (typeof msg.uid !== 'number' || msg.uid < since) continue;
            messages.push(msg);
        }
    } catch (err: any) {
        console.warn(`[IMAP][t${tenantId}] fetch failed:`, err?.message || err);
        return;
    }

    if (messages.length === 0) return;
    console.log(`[IMAP][t${tenantId}] processing ${messages.length} new message(s), uid >= ${since}`);

    // Sort by UID ascending so we insert in arrival order and can advance the
    // watermark linearly.
    messages.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));

    for (const msg of messages) {
        const uid = msg.uid!;
        try {
            await handleMessage(tenantId, msg);
        } catch (err: any) {
            console.error(`[IMAP][t${tenantId}] handleMessage uid=${uid} failed:`, err?.message || err);
        }
        // Advance watermark regardless of success so a poison message doesn't
        // block the queue forever. The error is already logged.
        await persistLastSeenUid(tenantId, uid);
    }
}

function extractAddressList(addr: AddressObject | AddressObject[] | undefined): string | null {
    if (!addr) return null;
    const list = Array.isArray(addr) ? addr : [addr];
    for (const item of list) {
        const a = item?.value?.[0]?.address;
        if (a) return a.toLowerCase();
    }
    return null;
}

async function handleMessage(tenantId: number, msg: FetchMessageObject): Promise<void> {
    if (!msg.source) return;
    const parsed: ParsedMail = await simpleParser(msg.source);

    const fromEmail = parseFromAddress(
        parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? null
    );
    const toEmail = extractAddressList(parsed.to);
    const subject = parsed.subject?.trim() || '(senza oggetto)';
    const messageId = parsed.messageId?.trim() || null;
    const inReplyTo = parsed.inReplyTo?.trim() || null;
    const referenceIds = Array.isArray(parsed.references)
        ? parsed.references.map((s) => s.trim()).filter(Boolean)
        : splitReferences((parsed.references as string | undefined) ?? null);

    const candidateIds = [inReplyTo, ...referenceIds].filter(Boolean) as string[];
    let reservationId = await resolveReservationByMessageIds(tenantId, candidateIds);
    if (!reservationId) {
        reservationId = await resolveReservationByFromEmail(tenantId, fromEmail);
    }
    if (!reservationId) {
        console.warn(`[IMAP][t${tenantId}] unmatched reply from`, fromEmail, 'subject:', subject);
    }

    const body = parsed.text?.trim()
        || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '')
        || '(email vuota)';

    const sentAt = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
        ? parsed.date
        : null;

    let insertedRow: any = null;
    try {
        const insert = await queryWithRetry(
            `INSERT INTO outbound_messages
                (tenant_id, provider, channel, direction, from_email, to_email, subject, body, status,
                 provider_sid, message_id, in_reply_to, reservation_id, sent_at)
             VALUES ($10, 'imap', 'email', 'inbound', $1, $2, $3, $4, 'received',
                     $5, $6, $7, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP))
             RETURNING id, provider, channel, direction, from_email, to_email, subject, body, status,
                       provider_sid, message_id, in_reply_to, reservation_id, sent_at,
                       delivered_at, failed_at, error_code, error_message, to_phone`,
            [
                fromEmail,
                toEmail,
                subject,
                body,
                String(msg.uid),
                messageId,
                inReplyTo,
                reservationId,
                sentAt,
                tenantId,
            ]
        );
        insertedRow = insert.rows[0] ?? null;
    } catch (err: any) {
        console.error(`[IMAP][t${tenantId}] insert failed:`, err?.message || err);
        return;
    }

    if (insertedRow) {
        const socket = socketProvider();
        if (socket) {
            try { socket.broadcastToAll(tenantId, 'inboundEmail:received', insertedRow); }
            catch (err) { console.warn(`[IMAP][t${tenantId}] broadcast failed:`, err); }
        }
        // Wake the PWA / notifications center. Mirrors what logInboundMessage
        // does for SMS/WhatsApp so email replies show up with their own
        // category badge instead of blending in with 'message'.
        const preview = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const fromDisplay = fromEmail || 'sconosciuto';
        pushSendToRoles(
            tenantId,
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'email',
                title: subject ? `Nuova email: ${subject}` : 'Nuova email dal cliente',
                body: preview ? `${fromDisplay}: ${preview}` : `Da ${fromDisplay}`,
                url: reservationId ? `/?view=RESERVATIONS&reservationId=${reservationId}` : '/?view=MESSAGGI',
                tag: `email-inbound-${insertedRow.id}`,
            },
            { excludeUserId: null }
        ).catch((err: any) => console.warn(`[IMAP][t${tenantId}] push notification failed:`, err?.message || err));
    }
}

async function persistLastSeenUid(tenantId: number, uid: number): Promise<void> {
    try {
        // Watermark sulla riga del tenant della mailbox: senza filtro, con la
        // PK (tenant_id, provider), l'UPDATE toccherebbe la riga smtp di OGNI
        // ristorante.
        await queryWithRetry(
            `UPDATE integration_settings SET imap_last_seen_uid = $1
             WHERE tenant_id = $2 AND provider = 'smtp'
               AND (imap_last_seen_uid IS NULL OR imap_last_seen_uid < $1)`,
            [uid, tenantId]
        );
        // Refresh cache so the next doProcess() sees the new watermark
        // without waiting for the TTL.
        const cached = cache.get(tenantId);
        if (cached) cached.config.lastSeenUid = uid;
    } catch (err: any) {
        console.warn(`[IMAP][t${tenantId}] persistLastSeenUid failed:`, err?.message || err);
    }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

// Rilettura periodica dei tenant abilitati. Il PUT delle Impostazioni chiama
// restartImapForTenant, ma copre solo il processo che riceve la PUT:
// modifiche fatte da un altro processo (o direttamente a database, o la
// sospensione di un tenant) le raccoglie solo questo re-scan — una SELECT
// ogni 10 minuti costa niente.
const RESCAN_INTERVAL_MS = 10 * 60_000;

export async function startImapInboundService(provider: SocketProvider): Promise<void> {
    socketProvider = provider;
    try {
        await superviseOnce();
    } catch (err: any) {
        console.error('[IMAP] supervisor initial scan failed:', err?.message || err);
        // Niente retry dedicato: il re-scan periodico qui sotto riprova da solo.
    }
    if (!rescanTimer) {
        rescanTimer = setInterval(() => {
            superviseOnce().catch((err: any) => {
                console.error('[IMAP] supervisor re-scan failed:', err?.message || err);
            });
        }, RESCAN_INTERVAL_MS);
        // unref: il timer non deve tenere in vita il processo allo shutdown.
        rescanTimer.unref?.();
    }
}

export async function stopImapInboundService(): Promise<void> {
    if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = null;
    }
    for (const tenantId of Array.from(listeners.keys())) {
        await stopImapForTenant(tenantId);
    }
}

// Best-effort connectivity check used by the settings "Test connection"
// button. Opens a fresh short-lived connection so it never disturbs the
// long-lived listener.
export async function verifyImapConnection(tenantId: number): Promise<{ ok: boolean; error?: string }> {
    const config = await getConfig(tenantId, true);
    if (!isImapConfigured(config)) {
        return { ok: false, error: 'IMAP non è configurato' };
    }
    const client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
        logger: false,
    });
    try {
        await client.connect();
        await client.mailboxOpen('INBOX');
        await client.logout();
        return { ok: true };
    } catch (err: any) {
        try { await client.logout(); } catch { /* ignore */ }
        return { ok: false, error: err?.message || 'IMAP verify failed' };
    }
}
