// IMAP inbound-email service.
//
// Alternative to the Resend inbound webhook when the mailbox we send from
// isn't hosted on Resend (Aruba, Gmail, etc.). We open a long-lived
// IMAP+IDLE connection to the mailbox and, whenever a new message appears
// in INBOX, thread it back to a reservation using the same rules the Resend
// path uses (In-Reply-To → References → sender email fallback) and insert
// it into `outbound_messages` with direction='inbound'.
//
// Config lives on integration_settings (imap_host, imap_port, imap_secure,
// imap_user, imap_password, imap_enabled). `imap_last_seen_uid` is our
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

// Il poller IMAP gira senza richiesta HTTP: come le altre superfici pubbliche
// (webhook, voce) resta ancorato al tenant storico finché la Fase C non
// threada il tenant nella configurazione della mailbox.
const PUBLIC_TENANT_ID = 1;

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

const CACHE_TTL_MS = 30_000;
let cache: { config: ImapConfig; loadedAt: number } | null = null;

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

async function loadFromDb(): Promise<ImapConfig> {
    const defaults = envDefaults();
    try {
        const result = await queryWithRetry(
            `SELECT imap_host, imap_port, imap_secure, imap_user, imap_password,
                    imap_enabled, imap_last_seen_uid
             FROM integration_settings WHERE provider = 'smtp' LIMIT 1`
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
        console.warn('[IMAP] loadFromDb failed, using env fallbacks:', (err as any)?.message || err);
        return defaults;
    }
}

async function getConfig(force = false): Promise<ImapConfig> {
    const now = Date.now();
    if (!force && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.config;
    const config = await loadFromDb();
    cache = { config, loadedAt: now };
    return config;
}

export function invalidateImapConfigCache(): void {
    cache = null;
}

function isImapConfigured(c: ImapConfig): boolean {
    return !!(c.host && c.port && c.user && c.password);
}

export async function getImapConfigStatus(): Promise<ImapStatus> {
    const c = await getConfig(true);
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
        connected: !!currentClient && currentClient.usable === true,
    };
}

// --------------------------------------------------------------------------
// Connection lifecycle
// --------------------------------------------------------------------------

type SocketProvider = () => SocketService | undefined;

let currentClient: ImapFlow | null = null;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let socketProvider: SocketProvider = () => undefined;

function scheduleReconnect(): void {
    if (stopping || reconnectTimer) return;
    reconnectAttempts += 1;
    // Exponential backoff capped at 5 minutes.
    const base = Math.min(30_000 * Math.pow(2, reconnectAttempts - 1), 300_000);
    // Add ±20% jitter so multiple deploys don't reconnect in lock-step.
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delayMs = Math.round(jitter);
    console.log(`[IMAP] reconnect scheduled in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectAndListen().catch((err) => {
            console.error('[IMAP] reconnect failed:', err?.message || err);
            scheduleReconnect();
        });
    }, delayMs);
}

async function connectAndListen(): Promise<void> {
    if (stopping) return;
    const config = await getConfig(true);
    if (!config.enabled) {
        console.log('[IMAP] disabled in settings — not connecting');
        return;
    }
    if (!isImapConfigured(config)) {
        console.log('[IMAP] not configured (host/user/password missing) — not connecting');
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
        console.warn('[IMAP] connection error:', err?.message || err);
    });
    client.on('close', () => {
        if (currentClient === client) currentClient = null;
        if (!stopping) {
            console.log('[IMAP] connection closed — will reconnect');
            scheduleReconnect();
        }
    });

    try {
        await client.connect();
    } catch (err: any) {
        console.warn('[IMAP] initial connect failed:', err?.message || err);
        try { await client.logout(); } catch { /* ignore */ }
        scheduleReconnect();
        return;
    }

    console.log(`[IMAP] connected to ${config.host}:${config.port} as ${config.user}`);
    currentClient = client;
    reconnectAttempts = 0;

    // While the mailbox is open, ImapFlow keeps the connection in IDLE and
    // emits 'exists' whenever the server notifies about new messages.
    client.on('exists', () => {
        // We don't await here — the event loop is not our friend inside
        // event emitters. Fire-and-forget with error logging.
        processNewMessages(client).catch((err) => {
            console.error('[IMAP] processNewMessages error:', err?.message || err);
        });
    });

    try {
        await client.mailboxOpen('INBOX');
    } catch (err: any) {
        console.error('[IMAP] mailboxOpen failed:', err?.message || err);
        try { await client.logout(); } catch { /* ignore */ }
        scheduleReconnect();
        return;
    }

    // Catch up on anything that arrived while we were offline.
    processNewMessages(client).catch((err) => {
        console.error('[IMAP] catch-up processNewMessages error:', err?.message || err);
    });
}

// --------------------------------------------------------------------------
// Message processing
// --------------------------------------------------------------------------

// Serialize processing so two rapid 'exists' events don't race on the same
// UID range. imapflow itself queues commands per client, but we also don't
// want to double-insert if two calls both see the same watermark.
let processing: Promise<void> = Promise.resolve();

function processNewMessages(client: ImapFlow): Promise<void> {
    processing = processing.then(() => doProcess(client)).catch((err) => {
        console.error('[IMAP] doProcess chain error:', err?.message || err);
    });
    return processing;
}

async function doProcess(client: ImapFlow): Promise<void> {
    if (!client.usable) return;
    const config = await getConfig(true);
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
        console.warn('[IMAP] fetch failed:', err?.message || err);
        return;
    }

    if (messages.length === 0) return;
    console.log(`[IMAP] processing ${messages.length} new message(s), uid >= ${since}`);

    // Sort by UID ascending so we insert in arrival order and can advance the
    // watermark linearly.
    messages.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));

    for (const msg of messages) {
        const uid = msg.uid!;
        try {
            await handleMessage(msg);
        } catch (err: any) {
            console.error(`[IMAP] handleMessage uid=${uid} failed:`, err?.message || err);
        }
        // Advance watermark regardless of success so a poison message doesn't
        // block the queue forever. The error is already logged.
        await persistLastSeenUid(uid);
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

async function handleMessage(msg: FetchMessageObject): Promise<void> {
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
    let reservationId = await resolveReservationByMessageIds(PUBLIC_TENANT_ID, candidateIds);
    if (!reservationId) {
        reservationId = await resolveReservationByFromEmail(PUBLIC_TENANT_ID, fromEmail);
    }
    if (!reservationId) {
        console.warn('[IMAP] unmatched reply from', fromEmail, 'subject:', subject);
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
                PUBLIC_TENANT_ID,
            ]
        );
        insertedRow = insert.rows[0] ?? null;
    } catch (err: any) {
        console.error('[IMAP] insert failed:', err?.message || err);
        return;
    }

    if (insertedRow) {
        const socket = socketProvider();
        if (socket) {
            try { socket.broadcastToAll('inboundEmail:received', insertedRow); }
            catch (err) { console.warn('[IMAP] broadcast failed:', err); }
        }
        // Wake the PWA / notifications center. Mirrors what logInboundMessage
        // does for SMS/WhatsApp so email replies show up with their own
        // category badge instead of blending in with 'message'.
        const preview = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const fromDisplay = fromEmail || 'sconosciuto';
        pushSendToRoles(
            PUBLIC_TENANT_ID,
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'email',
                title: subject ? `Nuova email: ${subject}` : 'Nuova email dal cliente',
                body: preview ? `${fromDisplay}: ${preview}` : `Da ${fromDisplay}`,
                url: reservationId ? `/?view=RESERVATIONS&reservationId=${reservationId}` : '/?view=MESSAGGI',
                tag: `email-inbound-${insertedRow.id}`,
            },
            { excludeUserId: null }
        ).catch((err: any) => console.warn('[IMAP] push notification failed:', err?.message || err));
    }
}

async function persistLastSeenUid(uid: number): Promise<void> {
    try {
        await queryWithRetry(
            `UPDATE integration_settings SET imap_last_seen_uid = $1
             WHERE provider = 'smtp' AND (imap_last_seen_uid IS NULL OR imap_last_seen_uid < $1)`,
            [uid]
        );
        // Refresh cache so the next doProcess() sees the new watermark
        // without waiting for the TTL.
        if (cache) cache.config.lastSeenUid = uid;
    } catch (err: any) {
        console.warn('[IMAP] persistLastSeenUid failed:', err?.message || err);
    }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function startImapInboundService(provider: SocketProvider): Promise<void> {
    socketProvider = provider;
    stopping = false;
    try {
        await connectAndListen();
    } catch (err: any) {
        console.error('[IMAP] startup failed:', err?.message || err);
        scheduleReconnect();
    }
}

export async function stopImapInboundService(): Promise<void> {
    stopping = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    const client = currentClient;
    currentClient = null;
    if (client) {
        try { await client.logout(); }
        catch (err: any) { console.warn('[IMAP] logout error:', err?.message || err); }
    }
}

export async function restartImapInboundService(): Promise<void> {
    await stopImapInboundService();
    invalidateImapConfigCache();
    stopping = false;
    reconnectAttempts = 0;
    await startImapInboundService(socketProvider);
}

// Best-effort connectivity check used by the settings "Test connection"
// button. Opens a fresh short-lived connection so it never disturbs the
// long-lived listener.
export async function verifyImapConnection(): Promise<{ ok: boolean; error?: string }> {
    const config = await getConfig(true);
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
