import dotenv from 'dotenv';
dotenv.config();

// Build version identifier - change this to verify deployments
const BUILD_VERSION = '2026-04-29-v3';
console.log(`🚀 Server starting - Build version: ${BUILD_VERSION}`);

import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';
import path from 'path';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import pool, { createSchema, queryWithRetry } from './db.js';
import { SocketService } from './services/socketService.js';
import { Shift, PaymentStatus, UserRole } from './types.js';
import authRoutes from './auth/authRoutes.js';
import logRoutes from './activityLogs/logRoutes.js';
import { authenticate, authorize, requirePermission } from './auth/authMiddleware.js';
import { RolePermissionService } from './auth/permissionService.js';
import { canAssignToRole } from './auth/permissions.js';
import { LogService, ActivityAction, ResourceType } from './activityLogs/logService.js';
import { isPushConfigured, getVapidPublicKey, sendToUser as pushSendToUser, sendToRoles as pushSendToRoles } from './services/pushService.js';
import {
    isRevolutConfigured,
    verifyWebhookSignature as verifyRevolutWebhook,
    getRevolutConfigStatus,
    invalidateRevolutConfigCache,
    type RevolutEnvironment,
} from './services/revolutService.js';
import {
    getSumUpConfigStatus,
    invalidateSumUpConfigCache,
    getSumUpCallbackSecret,
    callbackTokenMatches,
} from './services/sumupService.js';
import {
    PAYMENT_PROVIDERS,
    isPaymentProvider,
    publicBaseUrl,
    getActivePaymentProvider,
    setActivePaymentProvider,
    isProviderConfigured,
    isPaymentConfigured,
    providerLabel,
    createPaymentOrder,
    fetchPaymentOrder,
    cancelPaymentOrder,
    refundPaymentOrder,
    transitionMetadata,
    type PaymentProvider,
} from './services/paymentProviderService.js';
import {
    isSmtpConfigured,
    getSmtpConfigStatus,
    invalidateSmtpConfigCache,
    sendMail,
    verifySmtpConnection,
    getResendInboundContext,
} from './services/smtpService.js';
import {
    parseFromAddress,
    pickHeader,
    splitReferences,
    resolveReservationByMessageIds,
    resolveReservationByFromEmail,
} from './services/emailThreading.js';
import {
    getImapConfigStatus,
    verifyImapConnection,
    startImapInboundService,
    restartImapInboundService,
    invalidateImapConfigCache,
} from './services/imapInboundService.js';
import {
    verifyElevenLabsSignature,
    findAvailability,
    findCustomerByPhone,
    createVoiceReservation,
    cancelVoiceReservation,
    modifyVoiceReservation,
    recordVoiceCall,
    formatItalianConfirmation,
    formatItalianCancellation,
    formatItalianModification,
    normalizeItalianPhone,
    parseFlexibleDate,
    parseFlexibleTime,
    formatItalianDateReadback,
    spellItalianPhoneDigits,
} from './services/elevenlabsService.js';
import {
    ROOM_OCCUPANCY_CAPS_KEY,
    RoomOccupancyCap,
    getRoomOccupancyCaps,
    computeRoomOccupancy,
    pickSelfServiceTable,
    listBookableRooms,
} from './services/roomOccupancyService.js';
import { toTitleCase } from './utils/text.js';
import {
    getAvailableSlots,
    getAllOpeningHours,
    getOpeningHours,
    listClosures,
    formatSlotListItalian,
} from './utils/slots.js';

const app = express();
// Railway terminates TLS at a single upstream proxy and forwards via
// X-Forwarded-For. Without this, express-rate-limit refuses to derive
// the client IP and falls back to throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// Create HTTP server from Express app
const httpServer = createServer(app);

// Socket service instance (initialized in startServer)
let socketService: SocketService | undefined;

// Flexible CORS configuration - temporarily allow all for debugging
const corsOptions = {
  origin: true,  // Allow all origins temporarily
  credentials: true
};

app.use(cors(corsOptions));
// 2 MB body limit accommodates inlined dish photos as base64 data URLs
// (resized client-side to ~200KB). Default 100KB would reject them.
// `verify` stashes the raw payload so HMAC-signed webhooks (e.g. ElevenLabs)
// can validate against the exact bytes sent by the caller — JSON.stringify
// would reorder keys and break the signature.
app.use(express.json({
    limit: '2mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; }
}));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Disable HTTP caching for all API responses. iOS Safari (and Safari-based
// PWAs in particular) will otherwise serve stale GET responses even after
// the underlying data has changed, since the server sets no validators.
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Health check endpoint for Railway. On the public booking subdomain
// (prenotazioni.vecchiofrantoio.com) the root path redirects to /prenota
// so visitors who type only the hostname land on the form.
app.get('/', (req, res) => {
  if (req.hostname === 'prenotazioni.vecchiofrantoio.com') {
    return res.redirect(301, '/prenota');
  }
  res.json({ status: 'ok', message: 'RistoManager API is running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    server: 'running',
    socketio: socketService ? 'initialized' : 'not initialized'
  });
});

// Public build version. The Vite bundle bakes the same short SHA in via
// `__APP_VERSION__`; the client polls this endpoint and shows an "update
// available" banner when they diverge — usually because the browser is still
// running a bundle from before the last deploy. `Cache-Control: no-store`
// ensures the poll always sees the live process, not a cached response.
// The banner check runs every 5 minutes plus on visibility change / focus.
// Endpoint is public — no auth needed, it's just the current build SHA.
// Response body is intentionally minimal to keep the poll cheap.
app.get('/version', (_req, res) => {
    const version = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev';
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ version });
});

// ============================================
// AUTHENTICATION ROUTES
// ============================================
app.use('/auth', authRoutes);

// ============================================
// ACTIVITY LOGS ROUTES
// ============================================
app.use('/activity-logs', logRoutes);

// ============================================
// WHATSAPP WEBHOOK ENDPOINTS (Vonage)
// ============================================

// Vonage WhatsApp inbound messages webhook
app.post('/webhook/vonage-inbound', async (req, res) => {
    console.log('[Vonage] Incoming message:', JSON.stringify(req.body, null, 2));

    try {
        // Acknowledge immediately to Vonage
        res.status(200).send();

        // Vonage sends two different formats:
        // Format 1 (actual): { from, message_type: "text", text: "..." }
        // Format 2 (sandbox): { from, message: { content: { type: "text", text: "..." } } }

        const from = req.body.from;
        let messageText = null;

        // Check actual Vonage format first
        if (req.body.message_type === 'text' && req.body.text) {
            messageText = req.body.text;
        }
        // Check sandbox/alternative format
        else if (req.body.message?.content?.type === 'text') {
            messageText = req.body.message.content.text;
        }

        if (messageText && from) {
            // Vonage sandbox is deprecated but any inbound still lands here.
            // Persist for the inbox — no auto-reply (see Twilio webhook note).
            const row = await logInboundMessage({
                provider: 'vonage', channel: 'whatsapp',
                from: String(from), to: '', body: String(messageText),
            });
            if (row && socketService) {
                socketService.broadcastToAll('message:inbound', row);
            }
        } else {
            console.log('[Vonage] Non-text message received, ignoring');
        }

    } catch (error) {
        console.error('[Vonage] Error processing message:', error);
        // Still respond 200 to Vonage to avoid retries
        res.status(200).send();
    }
});

// Vonage WhatsApp status updates webhook
app.post('/webhook/vonage-status', (req, res) => {
    console.log('[Vonage] Message status:', JSON.stringify(req.body, null, 2));
    res.status(200).send();
});

// ============================================
// WHATSAPP WEBHOOK ENDPOINTS (Twilio)
// ============================================
// Twilio posts application/x-www-form-urlencoded, which the global json()
// parser doesn't touch. Mounting urlencoded only on these routes keeps the
// rest of the API json-only.
const twilioUrlEncoded = express.urlencoded({ extended: false });

// Twilio signs every request: HMAC-SHA1 with the auth token, message =
// public_url + sorted(key+value) concatenation, base64-encoded. We need
// trust-proxy=1 (already set) so req.protocol/host reflect the URL Twilio
// configured, not the loopback Railway sees internally.
function validateTwilioSignature(req: express.Request): boolean {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;
    const signature = req.header('X-Twilio-Signature');
    if (!signature) return false;
    try {
        const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const params = (req.body || {}) as Record<string, string>;
        const sortedKeys = Object.keys(params).sort();
        const data = sortedKeys.reduce((acc, key) => acc + key + (params[key] ?? ''), url);
        const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (err) {
        console.error('[Twilio] Signature validation failed:', err);
        return false;
    }
}

// Twilio WhatsApp inbound messages webhook. Persists the inbound row into
// outbound_messages (direction='inbound') and broadcasts it via socket so the
// operator inbox can show it in real time. Deliberately NO auto-reply: the
// old bot that tried to parse "DATA ORA OSPITI NOME" was misleading for
// customers replying to a confirmation ("Ok perfetto") and has been retired.
app.post('/webhook/twilio-whatsapp', twilioUrlEncoded, async (req, res) => {
    if (!validateTwilioSignature(req)) {
        console.warn('[Twilio] Inbound: invalid signature, rejecting');
        return res.status(403).send();
    }
    console.log('[Twilio] Incoming message:', req.body);
    // Acknowledge with empty TwiML so Twilio doesn't auto-reply on our behalf.
    res.set('Content-Type', 'text/xml').status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    try {
        const fromRaw = String(req.body?.From || '');
        const toRaw = String(req.body?.To || '');
        const from = fromRaw.replace(/^whatsapp:/, '');
        const to = toRaw.replace(/^whatsapp:/, '');
        const body = String(req.body?.Body || '').trim();
        const sid = req.body?.MessageSid || req.body?.SmsMessageSid || null;
        const isWhatsApp = fromRaw.startsWith('whatsapp:');
        const channel: 'sms' | 'whatsapp' = isWhatsApp ? 'whatsapp' : 'sms';
        const numMedia = Number(req.body?.NumMedia || 0);
        if (numMedia > 0) {
            console.log('[Twilio] Inbound has media attachments — text-only recorded');
        }
        if (!from || !body) {
            console.log('[Twilio] Inbound: missing From or empty Body, ignoring');
            return;
        }
        const row = await logInboundMessage({
            provider: 'twilio', channel, from, to, body, sid,
        });
        if (row && socketService) {
            socketService.broadcastToAll('message:inbound', row);
        }
    } catch (error) {
        console.error('[Twilio] Error processing inbound:', error);
    }
});

// Twilio delivery status callbacks (sent/delivered/read/failed). Applies to
// both SMS and WhatsApp outbound sends — Twilio uses the same payload shape
// for both channels. When the SID matches a reservation we persist the status
// and broadcast so the delivery icon updates live on the card.
app.post('/webhook/twilio-whatsapp-status', twilioUrlEncoded, async (req, res) => {
    if (!validateTwilioSignature(req)) {
        console.warn('[Twilio] Status: invalid signature, rejecting');
        return res.status(403).send();
    }
    const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body || {};
    const errSuffix = ErrorCode ? ` errCode=${ErrorCode}${ErrorMessage ? ` (${ErrorMessage})` : ''}` : '';
    console.log(`[Twilio] Status: ${MessageSid} → ${MessageStatus} (to ${To})${errSuffix}`);
    res.status(200).send();

    // Persist the delivery status on the reservation, if we tracked this SID.
    // Twilio delivers callbacks out of order; only advance the status when the
    // new state is meaningful (delivered/failed/undelivered), and only stamp
    // confirmation_delivered_at once, on the first 'delivered' event.
    if (!MessageSid || !MessageStatus) return;
    try {
        const status = String(MessageStatus).toLowerCase();
        const errText = ErrorCode
            ? `${ErrorCode}${ErrorMessage ? ` (${ErrorMessage})` : ''}`
            : null;
        const updated = await queryWithRetry(
            `UPDATE reservations
             SET confirmation_status = $1::text,
                 confirmation_delivered_at = CASE
                     WHEN $1::text = 'delivered' AND confirmation_delivered_at IS NULL
                         THEN CURRENT_TIMESTAMP
                     ELSE confirmation_delivered_at
                 END,
                 confirmation_error = $2
             WHERE confirmation_provider_sid = $3
             RETURNING *`,
            [status, errText, MessageSid]
        );
        if (updated.rows[0] && socketService) {
            try { socketService.broadcastReservationUpdated(updated.rows[0]); }
            catch (err) { console.warn('[Twilio] status broadcast failed:', err); }
        }

        // Also update the outbound_messages log so the SMS section in the
        // conversation modal reflects the final delivery state.
        try {
            await queryWithRetry(
                `UPDATE outbound_messages
                 SET status = $1::text,
                     delivered_at = CASE
                         WHEN $1::text = 'delivered' AND delivered_at IS NULL
                             THEN CURRENT_TIMESTAMP
                         ELSE delivered_at
                     END,
                     failed_at = CASE
                         WHEN $1::text IN ('failed', 'undelivered') AND failed_at IS NULL
                             THEN CURRENT_TIMESTAMP
                         ELSE failed_at
                     END,
                     error_code = $2,
                     error_message = $3
                 WHERE provider_sid = $4`,
                [status, ErrorCode || null, errText, MessageSid]
            );
        } catch (err: any) {
            console.warn('[Twilio] outbound_messages update failed:', err?.message || err);
        }

        // Auto-fallback WA → SMS on terminal WhatsApp errors that the sync
        // send path can't see (Twilio returns 200 to the initial POST and
        // then Meta rejects async). Without this the reservation confirmation
        // sits as 'undelivered' and staff has to notice + resend manually.
        // Fires only for OUTBOUND WhatsApp attempts tied to a reservation
        // with a phone; keeps idempotency by skipping when we've already
        // logged any outbound SMS for the same reservation after the failed
        // WA send (covers both auto-retries and manual staff SMS sends).
        if (ErrorCode && WA_FALLBACK_ERROR_CODES.has(String(ErrorCode))) {
            maybeFallbackWhatsAppToSms(String(MessageSid), String(ErrorCode))
                .catch(err => console.warn('[Twilio] WA→SMS fallback failed:', err?.message || err));
        }
    } catch (err: any) {
        console.warn('[Twilio] status persist failed:', err?.message || err);
    }
});

// Twilio WhatsApp error codes that mean "this specific recipient can't be
// reached over WhatsApp right now" and are worth retrying over SMS. Kept as
// a Set so lookup is O(1) inside the hot webhook path.
//
//   63003 — Channel could not find a valid To
//   63005 — Channel handset not found / unreachable
//   63007 — Failed to find a valid channel address
//   63016 — Freeform message outside the 24h Customer Service Window
//   63018 — Rate limit exceeded
//   63024 — Business Initiated message rejected by Meta (opt-out, blocked,
//           handset unregistered, or a transient Meta-side reason)
const WA_FALLBACK_ERROR_CODES = new Set(['63003', '63005', '63007', '63016', '63018', '63024']);

async function maybeFallbackWhatsAppToSms(originalSid: string, errCode: string): Promise<void> {
    // Look up the failed WA send in our log — we need the plain-text body,
    // reservation link, and the moment it was sent (idempotency anchor).
    const orig = await queryWithRetry(
        `SELECT id, body, to_phone, reservation_id, sent_at, channel, direction
         FROM outbound_messages
         WHERE provider_sid = $1
         LIMIT 1`,
        [originalSid]
    );
    const row = orig.rows[0];
    if (!row || row.direction !== 'outbound' || row.channel !== 'whatsapp') return;
    if (!row.reservation_id) return;
    if (!row.body || !String(row.body).trim()) return;
    if (!isTwilioSmsConfigured()) return;

    // Idempotency: skip if we (auto or manual) already sent an SMS for this
    // reservation after the failed WA. Twilio can deliver the terminal state
    // callback multiple times, and staff might have jumped in manually.
    const already = await queryWithRetry(
        `SELECT 1 FROM outbound_messages
         WHERE reservation_id = $1
           AND channel = 'sms'
           AND direction = 'outbound'
           AND sent_at > $2
         LIMIT 1`,
        [row.reservation_id, row.sent_at]
    );
    if (already.rowCount && already.rowCount > 0) return;

    const resr = await queryWithRetry(
        `SELECT phone FROM reservations WHERE id = $1`,
        [row.reservation_id]
    );
    const phone = resr.rows[0]?.phone;
    if (!phone || !String(phone).trim()) return;

    console.log(`[Twilio] Auto-fallback SMS after WA ${originalSid} → ${errCode} (reservation ${row.reservation_id})`);
    try {
        const smsResult = await sendTwilioSms(String(phone), String(row.body), row.reservation_id);
        // Rewire the reservation's confirmation tracking to the new SMS sid
        // so the delivery icon updates as the SMS gets delivered.
        await recordConfirmationSent(row.reservation_id, smsResult).catch(err =>
            console.warn('[Twilio] recordConfirmationSent (fallback) failed:', err?.message || err)
        );
    } catch (err: any) {
        console.error(`[Twilio] Auto-fallback SMS send failed for reservation ${row.reservation_id}:`, err?.message || err);
    }
}

// ============================================
// RESEND INBOUND EMAIL WEBHOOK
// ============================================
// Resend delivers each reply from a customer as an `email.received` event to
// this endpoint. Payload only carries metadata (from, to, subject, message_id,
// in_reply_to via headers) — the body must be fetched separately via the
// Received Emails API. We match the reply to a reservation using, in order:
//   1) In-Reply-To → the outbound message_id we saved when we sent
//   2) any Message-ID in References that we recognise (deep threads)
//   3) sender email → most recent reservation with that email
// Signature is verified with the Svix headers Resend attaches (svix-id,
// svix-timestamp, svix-signature). Secret is stored in integration_settings
// (resend_inbound_secret) so the operator can rotate it from Impostazioni.

function verifySvixSignature(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
    secret: string
): boolean {
    if (!secret) return false;
    const idHeader = String(headers['svix-id'] ?? '');
    const tsHeader = String(headers['svix-timestamp'] ?? '');
    const sigHeader = String(headers['svix-signature'] ?? '');
    if (!idHeader || !tsHeader || !sigHeader) return false;

    // Timestamp tolerance: 5 minutes on either side, same window as Svix's
    // reference implementation. Rejects replayed requests older than that.
    const tsNum = Number(tsHeader);
    if (!Number.isFinite(tsNum)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > 5 * 60) return false;

    // Secrets come as `whsec_<base64>`; strip prefix and base64-decode to raw
    // bytes for the HMAC key. Missing prefix is tolerated for defensive coding.
    const keyPart = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    let keyBytes: Buffer;
    try { keyBytes = Buffer.from(keyPart, 'base64'); } catch { return false; }
    if (keyBytes.length === 0) return false;

    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const signedPayload = `${idHeader}.${tsHeader}.${bodyStr}`;
    const expectedB64 = crypto.createHmac('sha256', keyBytes).update(signedPayload).digest('base64');
    const expectedBuf = Buffer.from(expectedB64, 'utf8');

    // sigHeader is a space-separated list of `v1,<sig>` entries; accept if any matches.
    for (const entry of sigHeader.split(' ')) {
        const [ver, sig] = entry.split(',');
        if (ver !== 'v1' || !sig) continue;
        const sigBuf = Buffer.from(sig, 'utf8');
        if (sigBuf.length !== expectedBuf.length) continue;
        if (crypto.timingSafeEqual(sigBuf, expectedBuf)) return true;
    }
    return false;
}

interface ResendReceivedEmail {
    id: string;
    from: string;
    to: string[] | null;
    cc: string[] | null;
    bcc: string[] | null;
    reply_to: string[] | null;
    subject: string | null;
    text: string | null;
    html: string | null;
    headers: Record<string, string | string[]> | null;
    message_id: string | null;
    created_at: string | null;
}

// Fetches the full email (body + headers) that a webhook only referenced by id.
async function fetchResendReceivedEmail(id: string, apiKey: string): Promise<ResendReceivedEmail | null> {
    try {
        const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) {
            const t = await r.text();
            console.warn(`[Resend-inbound] fetch ${id} failed: ${r.status} ${t.slice(0, 200)}`);
            return null;
        }
        return (await r.json()) as ResendReceivedEmail;
    } catch (err: any) {
        console.warn('[Resend-inbound] fetch error:', err?.message || err);
        return null;
    }
}

app.post('/webhook/resend-inbound', async (req, res) => {
    const context = await getResendInboundContext();
    if (!context) {
        console.warn('[Resend-inbound] not configured (missing api key or webhook secret)');
        return res.status(503).json({ error: 'inbound_not_configured' });
    }

    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
        console.warn('[Resend-inbound] missing raw body');
        return res.status(400).json({ error: 'missing_body' });
    }

    if (!verifySvixSignature(rawBody, req.headers as any, context.signingSecret)) {
        console.warn('[Resend-inbound] invalid signature, rejecting');
        return res.status(401).json({ error: 'invalid_signature' });
    }

    // Ack fast so Resend does not retry the webhook while we're still working.
    res.status(200).json({ ok: true });

    try {
        const payload = req.body ?? {};
        if (payload?.type !== 'email.received' || !payload?.data?.email_id) {
            console.log('[Resend-inbound] ignoring event:', payload?.type);
            return;
        }
        const emailId = String(payload.data.email_id);

        const full = await fetchResendReceivedEmail(emailId, context.apiKey);
        if (!full) {
            console.warn('[Resend-inbound] could not retrieve full email', emailId);
            return;
        }

        const fromEmail = parseFromAddress(full.from);
        const inReplyTo = pickHeader(full.headers, 'In-Reply-To');
        const referenceIds = splitReferences(pickHeader(full.headers, 'References'));
        const messageId = full.message_id || pickHeader(full.headers, 'Message-ID');

        // Try In-Reply-To first (most reliable), then walk References (older
        // clients quote the entire thread), then fall back to sender lookup.
        const candidateIds = [inReplyTo, ...referenceIds].filter(Boolean) as string[];
        let reservationId = await resolveReservationByMessageIds(candidateIds);
        if (!reservationId) {
            reservationId = await resolveReservationByFromEmail(fromEmail);
        }
        if (!reservationId) {
            console.warn('[Resend-inbound] unmatched reply from', fromEmail, 'subject:', full.subject);
        }

        // Body: prefer plain text so the timeline renders cleanly; fall back to
        // the HTML with tags stripped when the sender only sent HTML.
        const body = full.text?.trim()
            || (full.html ? String(full.html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '')
            || '(email vuota)';
        const subject = full.subject?.trim() || '(senza oggetto)';
        const toEmail = Array.isArray(full.to) && full.to.length > 0 ? String(full.to[0]) : null;

        let insertedRow: any = null;
        try {
            const insert = await queryWithRetry(
                `INSERT INTO outbound_messages
                    (provider, channel, direction, from_email, to_email, subject, body, status,
                     provider_sid, message_id, in_reply_to, reservation_id, sent_at)
                 VALUES ('resend', 'email', 'inbound', $1, $2, $3, $4, 'received',
                         $5, $6, $7, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP))
                 RETURNING id, provider, channel, direction, from_email, to_email, subject, body, status,
                           provider_sid, message_id, in_reply_to, reservation_id, sent_at,
                           delivered_at, failed_at, error_code, error_message, to_phone`,
                [
                    fromEmail,
                    toEmail,
                    subject,
                    body,
                    emailId,
                    messageId,
                    inReplyTo,
                    reservationId,
                    full.created_at,
                ]
            );
            insertedRow = insert.rows[0] ?? null;
        } catch (err: any) {
            console.error('[Resend-inbound] insert failed:', err?.message || err);
            return;
        }

        if (insertedRow && socketService) {
            try { socketService.broadcastToAll('inboundEmail:received', insertedRow); }
            catch (err) { console.warn('[Resend-inbound] broadcast failed:', err); }
        }
    } catch (err: any) {
        console.error('[Resend-inbound] handler error:', err?.message || err);
    }
});

// ============================================
// ELEVENLABS VOICE-AGENT WEBHOOKS
// ============================================
// Tools the Restaurant Host agent can call mid-conversation. Each request
// is signed with HMAC-SHA256 (Stripe-style header); the secret lives in
// ELEVENLABS_WEBHOOK_SECRET. If the secret is unset we skip verification
// and log a warning — useful during early dev, never run that way in prod.

const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';
if (!ELEVENLABS_WEBHOOK_SECRET) {
    console.warn('[ElevenLabs] ELEVENLABS_WEBHOOK_SECRET is not set — webhook HMAC verification is DISABLED. Do not deploy like this.');
}

// Two valid auth shapes:
//   - HMAC signature (ElevenLabs-Signature header) — used for the post-call webhook
//   - Shared-secret header (X-Webhook-Secret) — used for tool calls, since
//     ElevenLabs tool runner doesn't sign requests but supports custom headers
// Either is sufficient. Both compare against the same ELEVENLABS_WEBHOOK_SECRET.
function timingSafeStringEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function authorizeElevenLabs(req: express.Request, res: express.Response): boolean {
    if (!ELEVENLABS_WEBHOOK_SECRET) return true;

    // Path A — shared-secret header sent by ElevenLabs tool runner.
    const sharedSecret = req.header('x-webhook-secret');
    if (sharedSecret && timingSafeStringEqual(sharedSecret, ELEVENLABS_WEBHOOK_SECRET)) {
        return true;
    }

    // Path B — HMAC signature (post-call webhook + workspace-signed webhooks).
    if (verifyElevenLabsSignature(req as any, ELEVENLABS_WEBHOOK_SECRET)) return true;

    // Verbose failure log: tells us which path was attempted and which header was present.
    const sigHeader = req.header('elevenlabs-signature') || '<missing>';
    const sigMasked = sigHeader.length > 24 ? sigHeader.slice(0, 24) + '…' : sigHeader;
    const bodyLen = (req as any).rawBody?.length ?? -1;
    console.warn('[ElevenLabs] auth failed', {
        path: req.path,
        x_webhook_secret_present: !!sharedSecret,
        x_webhook_secret_match: sharedSecret ? false : null,
        elevenlabs_signature_header: sigMasked,
        body_bytes: bodyLen,
    });
    res.status(401).json({ error: 'invalid_credentials' });
    return false;
}

// Scans an ElevenLabs post-call transcript for the pattern
// "agent verbally confirmed a booking": an agent turn that contains a
// confirmation verb ("confermato/confermata/confermo") alongside a booking
// noun ("tavolo", "prenotazione", "persone", "invieremo conferma").
// Filtering on turns that start with "agent:" avoids matching customer
// lines like "sì, confermo io".
export function detectPhantomConfirmation(transcript: string): boolean {
    if (!transcript) return false;
    const confirm = /\bconfermat[ao]\b|\bconfermo\b/;
    const bookingWord = /\b(?:tavolo|prenotazione|persone|invieremo\s+conferma)\b/;
    for (const rawLine of transcript.split('\n')) {
        const line = rawLine.trim();
        if (!/^agent:/i.test(line)) continue;
        const text = line.slice(6).toLowerCase();
        if (!confirm.test(text)) continue;
        // "posso confermarle" alone is ambiguous — we require a booking
        // noun in the same turn so we don't false-positive on politeness.
        if (bookingWord.test(text)) return true;
    }
    return false;
}

// "agent triggered the large-group handoff": either the backend refused a
// check-availability/create-reservation for guests > threshold, or the
// agent read the handoff phrase directly (per the prompt). Both paths
// converge on the same sentence, so we scan for its stable signature:
// "gestire la prenotazione al telefono". Very specific — virtually no
// false positives outside this flow.
export function detectLargeGroupHandoff(transcript: string): boolean {
    if (!transcript) return false;
    const signature = /gestire\s+la\s+prenotazione\s+al\s+telefono/i;
    for (const rawLine of transcript.split('\n')) {
        const line = rawLine.trim();
        if (!/^agent:/i.test(line)) continue;
        if (signature.test(line)) return true;
    }
    return false;
}

// Static first message used both by the ElevenLabs agent (configured on the
// dashboard) and as the fallback we return from the init-conversation
// webhook when the caller is anonymous, unknown, or lookup fails. Keeping
// the two literally identical means "webhook down" is indistinguishable
// from "no personalisation possible" for the caller.
const VOICE_FIRST_MESSAGE_FALLBACK =
    'Ciao, sono Sofia del Vecchio Frantoio. Posso aiutarti a prenotare un tavolo. ' +
    'Per altre richieste chiama dalle 10:30 alle 14:30 o dalle 18:45 alle 23:30. ' +
    'Per quando vorresti prenotare?';

// Conversation Initiation Webhook — called by ElevenLabs BEFORE the first
// message is spoken. We look up the caller in the rubrica and inject
// dynamic variables + a personalised `first_message` override so returning
// customers are greeted by name from second zero (no double-greeting from
// a mid-conversation lookup_customer tool call).
//
// Dashboard setup (one-time):
//   Agent → Security → Fetch conversation initiation data from webhook
//   URL:    https://prenotazioni.vecchiofrantoio.com/webhook/elevenlabs/init-conversation
//   Secret: same value as ELEVENLABS_WEBHOOK_SECRET
//
// If the webhook 5xx/timeouts, ElevenLabs falls back to the static
// first_message on the agent — so failure mode is "generic greeting",
// never a broken call. That's why we return 200 with the fallback message
// on errors instead of 5xx.
app.post('/webhook/elevenlabs/init-conversation', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;

    // "Prenotazioni sospese" mode: Sofia is still on the phone but she
    // announces the pause instead of running the booking flow. Suspension
    // can come from the manual toggle OR a scheduled window that covers
    // "now" — the shared helper resolves both and picks the right callback
    // time (schedule entry's end_time, or the manual default). The
    // first_message override + the {{booking_status_message}} dynamic
    // variable are the only two knobs available (agent.prompt.prompt is
    // read from Studio, but we still push it so the prompt guard fires).
    const { suspended, callbackTime: suspensionCallback } = await computeVoiceSuspensionState();
    const suspensionMessage = suspended
        ? `Buongiorno, sono Sofia del Vecchio Frantoio. Le prenotazioni sono momentaneamente sospese. La invitiamo a richiamare dopo le ${suspensionCallback} per verificare eventuali tavoli disponibili. Grazie e a presto!`
        : '';

    const baseDynamicVars = {
        customer_first_name: '',
        customer_full_name: '',
        customer_id: '',
        caller_id_spelled: '',
        customer_known: 'false',
        booking_status_message: suspensionMessage,
    };
    const effectiveFirstMessage = suspended ? suspensionMessage : VOICE_FIRST_MESSAGE_FALLBACK;
    const fallbackResponse = {
        type: 'conversation_initiation_client_data',
        dynamic_variables: baseDynamicVars,
        conversation_config_override: {
            agent: { first_message: effectiveFirstMessage },
        },
    };

    // When suspended we short-circuit even for known callers: no personalised
    // greeting, no customer lookup. The suspension message is what matters.
    if (suspended) {
        return res.json(fallbackResponse);
    }

    if (!(await getFeatureFlag('voice_agent_enabled', true))) {
        return res.json(fallbackResponse);
    }

    // ElevenLabs sends caller_id at the top level for SIP calls; guard
    // against alternate shapes just in case.
    const body = req.body || {};
    const callerIdRaw = String(
        body.caller_id
        ?? body.parameters?.caller_id
        ?? body.dynamic_variables?.system__caller_id
        ?? ''
    ).trim();

    if (!callerIdRaw) {
        console.log('[ElevenLabs] init-conversation anonymous caller');
        return res.json(fallbackResponse);
    }

    const normalized = normalizeItalianPhone(callerIdRaw);
    const callerIdSpelled = spellItalianPhoneDigits(normalized);

    try {
        const lookup = await findCustomerByPhone(normalized);
        if (!lookup.exists) {
            console.log('[ElevenLabs] init-conversation miss', { phone: normalized });
            return res.json({
                type: 'conversation_initiation_client_data',
                dynamic_variables: { ...baseDynamicVars, caller_id_spelled: callerIdSpelled },
                conversation_config_override: {
                    agent: { first_message: VOICE_FIRST_MESSAGE_FALLBACK },
                },
            });
        }

        const firstName = (lookup.first_name || '').trim();
        // Open-ended greeting for known callers: we can't assume they're
        // calling to book (they might want to change/cancel a reservation
        // or ask something out of scope). The agent classifies intent from
        // the reply — booking → normal flow, everything else → the AMBITO
        // redirect rule already in the prompt.
        const personalisedFirstMessage = firstName
            ? `Ciao ${firstName}, sono Sofia del Vecchio Frantoio, come posso aiutarti?`
            : VOICE_FIRST_MESSAGE_FALLBACK;

        console.log('[ElevenLabs] init-conversation hit', {
            phone: normalized,
            customer_id: lookup.customer_id,
            first_name: firstName,
        });
        return res.json({
            type: 'conversation_initiation_client_data',
            dynamic_variables: {
                customer_first_name: firstName,
                customer_full_name: lookup.customer_name || '',
                customer_id: String(lookup.customer_id || ''),
                caller_id_spelled: callerIdSpelled,
                customer_known: 'true',
                booking_status_message: '',
            },
            conversation_config_override: {
                agent: { first_message: personalisedFirstMessage },
            },
        });
    } catch (err) {
        console.error('[ElevenLabs] init-conversation error', err);
        // Always 200 — see comment at top of handler.
        return res.json({
            type: 'conversation_initiation_client_data',
            dynamic_variables: { ...baseDynamicVars, caller_id_spelled: callerIdSpelled },
            conversation_config_override: {
                agent: { first_message: VOICE_FIRST_MESSAGE_FALLBACK },
            },
        });
    }
});

// Tool 0 — lookup_customer  (defensive no-op fallback)
// Historically called by the agent at the very start of the call using
// {{system__caller_id}}. Now largely redundant: init-conversation webhook
// already injects the same data as dynamic variables before first_message
// is spoken. We keep this endpoint live so an old prompt that still
// references the tool continues to work, and so that a mid-call re-lookup
// (e.g. caller said "in realtà chiamatemi su un altro numero") still
// resolves. Returns `exists:false` for unknown numbers or anonymous
// callers; agent falls back to the standard "come si chiama?" opening.
// NB: no `greeting_phrase` field on purpose — the static `first_message`
// already greets the caller, and adding a second server-provided greeting
// caused the agent to say hello twice (once generic, once by name).
app.post('/webhook/elevenlabs/lookup-customer', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;
    if (!(await getFeatureFlag('voice_agent_enabled', true))) {
        return res.status(503).json({ error: 'voice_agent_disabled', message: VOICE_AGENT_DISABLED_MESSAGE });
    }

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;

    if (!phoneRaw) {
        console.log('[ElevenLabs] lookup-customer no phone provided');
        return res.json({
            exists: false,
            caller_id_spelled: '',
        });
    }

    // Pre-render the digit-by-digit Italian spelling so the agent can read
    // this string verbatim during phone confirmation instead of trying to
    // spell the digits itself (models hallucinate the prefix — see the
    // Luigi Noviello call, conv_1501kxjanqxffc2bthbchnnvm3dq).
    const normalized = normalizeItalianPhone(phoneRaw);
    const callerIdSpelled = spellItalianPhoneDigits(normalized);

    try {
        const lookup = await findCustomerByPhone(normalized);
        if (!lookup.exists) {
            console.log('[ElevenLabs] lookup-customer miss', { phone: normalized });
            return res.json({
                exists: false,
                caller_id_spelled: callerIdSpelled,
            });
        }

        console.log('[ElevenLabs] lookup-customer hit', {
            phone: normalized,
            customer_id: lookup.customer_id,
            first_name: lookup.first_name,
            last_visit: lookup.last_visit,
        });
        res.json({
            exists: true,
            customer_id: lookup.customer_id,
            customer_name: lookup.customer_name,
            first_name: lookup.first_name,
            last_visit: lookup.last_visit,
            caller_id_spelled: callerIdSpelled,
        });
    } catch (err) {
        console.error('[ElevenLabs] lookup-customer error', err);
        res.json({
            exists: false,
            caller_id_spelled: callerIdSpelled,
        });
    }
});

// Tool 1 — check_availability
// Body shape (per ElevenLabs tools spec): { parameters: { date, shift, guests }, conversation_id?, agent_id? }
// We also accept flat top-level fields as a fallback.
app.post('/webhook/elevenlabs/check-availability', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;
    if (!(await getFeatureFlag('voice_agent_enabled', true))) {
        return res.status(503).json({ error: 'voice_agent_disabled', message: VOICE_AGENT_DISABLED_MESSAGE });
    }
    {
        const state = await computeVoiceSuspensionState();
        if (state.suspended) {
            return res.status(503).json({ error: 'voice_bookings_suspended', message: buildVoiceSuspensionMessage(state.callbackTime) });
        }
    }

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const rawShift = String(p.shift ?? '').trim().toUpperCase();
    const guests = Number(p.guests);
    const rawLocation = String(p.location_preference ?? '').trim().toUpperCase();
    const locationPreference = rawLocation === 'INDOOR' || rawLocation === 'OUTDOOR'
        ? (rawLocation as 'INDOOR' | 'OUTDOOR')
        : undefined;

    // NOTE: user-actionable validation errors (bad date/time/shift/guests) are
    // returned as HTTP 200 with `available:false` and a human-readable
    // `message`. ElevenLabs does not surface HTTP 4xx response bodies to the
    // LLM as tool output, so returning 400 makes the agent fall back to a
    // generic "errore tecnico" reply instead of reading the message back to
    // the customer. Only true server errors stay as 5xx.
    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn('[ElevenLabs] check-availability rejected: unparseable date', { received: p.date });
        return res.json({
            available: false,
            free_tables_count: 0,
            error: 'invalid_date',
            message: 'Formato data non riconosciuto. Esempi accettati: 2026-05-14, 14/05/2026, "14 maggio 2026".'
        });
    }
    if (rawShift !== Shift.LUNCH && rawShift !== Shift.DINNER) {
        return res.json({
            available: false,
            free_tables_count: 0,
            error: 'invalid_shift',
            message: 'Il turno non è valido. Può indicare se si tratta di pranzo o cena?'
        });
    }
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
        return res.json({
            available: false,
            free_tables_count: 0,
            error: 'invalid_guests',
            message: 'Il numero di ospiti non è valido. Può ripetermi per quante persone vuole prenotare?'
        });
    }
    // Operator-blocked target date (fixed-menu holidays etc.): Sofia must not
    // book it — she reads back the callback invitation instead. Checked before
    // availability so the caller never hears table counts for a blocked day.
    {
        const voiceShift = rawShift as 'LUNCH' | 'DINNER';
        const dateBlock = findVoiceDateBlock(normalizedDate, voiceShift, await getVoiceDateBlocks());
        if (dateBlock) {
            console.log('[ElevenLabs] check-availability blocked date', { date: normalizedDate, shift: rawShift, block: dateBlock });
            return res.json({
                available: false,
                free_tables_count: 0,
                error: 'date_blocked',
                date_readback: formatItalianDateReadback(normalizedDate),
                message: buildVoiceDateBlockMessage(normalizedDate, voiceShift, dateBlock),
            });
        }
    }
    // Large-group handoff. Case in point: on 2026-07-17 the agent told a
    // caller that no tables were free for 11 people at lunch on 2026-07-24,
    // when in fact every room was empty — findAvailability filters by
    // `tables.seats >= guests`, so groups larger than the biggest single
    // table always come back empty even when total capacity is fine. Rather
    // than teach the agent to reason about merging tables, we cap the
    // self-serve flow at a configurable threshold (default 8) and hand
    // anything larger to a human. Editable from Settings → Canali.
    const voiceThreshold = await getVoiceLargeGroupThreshold();
    if (guests > voiceThreshold) {
        console.log('[ElevenLabs] check-availability handoff (large group)', { date: normalizedDate, shift: rawShift, guests, threshold: voiceThreshold });
        return res.json({
            available: false,
            free_tables_count: 0,
            error: 'large_group',
            message: `Per gruppi da ${voiceThreshold + 1} persone in su preferiamo gestire la prenotazione al telefono. Lascio un promemoria e la richiamiamo il prima possibile.`
        });
    }

    try {
        const result = await findAvailability({
            date: normalizedDate,
            shift: rawShift as Shift,
            guests: Math.trunc(guests),
            location_preference: locationPreference,
        });
        console.log('[ElevenLabs] check-availability', { date: normalizedDate, raw_date: p.date, shift: rawShift, guests, location_preference: locationPreference, result });
        // date_readback is the Italian "venerdì 10 luglio" string the agent
        // MUST use verbatim when confirming the date to the caller — LLMs
        // routinely mismatch weekday and day-of-month otherwise.
        res.json({ ...result, date_readback: formatItalianDateReadback(normalizedDate) });
    } catch (err) {
        console.error('[ElevenLabs] check-availability error', err);
        res.status(500).json({
            available: false,
            free_tables_count: 0,
            message: 'Si è verificato un errore tecnico, posso richiamarla?'
        });
    }
});

// Tool 2 — create_reservation
// Body shape: { parameters: { customer_name, phone, date (YYYY-MM-DD), time (HH:MM),
//                              shift (LUNCH|DINNER), guests, notes? }, conversation_id?, agent_id? }
// Writes a reservation with source=VOICE and requires_review=true so staff can sanity-check
// before the booking is treated as confirmed. Returns the Italian confirmation phrase the
// agent reads aloud at the end of the call.
app.post('/webhook/elevenlabs/create-reservation', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;
    if (!(await getFeatureFlag('voice_agent_enabled', true))) {
        return res.status(503).json({ error: 'voice_agent_disabled', message: VOICE_AGENT_DISABLED_MESSAGE });
    }
    {
        const state = await computeVoiceSuspensionState();
        if (state.suspended) {
            return res.status(503).json({ error: 'voice_bookings_suspended', message: buildVoiceSuspensionMessage(state.callbackTime) });
        }
    }

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const conversationId: string | undefined = req.body?.conversation_id || p.conversation_id;

    const customerName = normalizeCustomerName(String(p.customer_name ?? '').trim());
    // Phone: prefer `phone` (what the customer dictates or confirms), fall back
    // to `caller_id` (auto-captured from the SIP From: header by ElevenLabs).
    // The agent's system prompt pre-fills phone with {{system__caller_id}} and
    // reads it back for confirmation; if the customer corrects it, `phone`
    // wins. This branch is the safety net for when the agent forgets to
    // interpolate the variable or the caller ID is empty/anonymous.
    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;
    const phoneSource: 'customer' | 'caller_id' | 'none' = String(p.phone ?? '').trim()
        ? 'customer'
        : callerIdRaw ? 'caller_id' : 'none';
    const rawShift = String(p.shift ?? '').trim().toUpperCase();
    const guests = Number(p.guests);
    const childrenRaw = p.children;
    const notes = typeof p.notes === 'string' ? p.notes.trim() : undefined;
    const rawLocation = String(p.location_preference ?? '').trim().toUpperCase();
    const locationPreference = rawLocation === 'INDOOR' || rawLocation === 'OUTDOOR'
        ? (rawLocation as 'INDOOR' | 'OUTDOOR')
        : undefined;

    // See note in check-availability: user-actionable validation errors are
    // returned as HTTP 200 with `success:false` so ElevenLabs surfaces the
    // Italian `message` to the LLM (it drops 4xx bodies).
    if (!customerName) {
        return res.json({
            success: false,
            error: 'invalid_customer_name',
            message: 'Non ho colto il nome per la prenotazione. Può ripetermi il nome del cliente?'
        });
    }
    // Placeholder guard: when the LLM skips the name-collection step it fills
    // the required param with a generic filler ("Cliente") instead of a real
    // name. Reject it so the agent is forced to actually ask the caller —
    // the Italian message is read back to the LLM and drives the retry.
    const NAME_PLACEHOLDERS = new Set(['cliente', 'customer', 'ospite', 'guest', 'anonimo', 'sconosciuto', 'signore', 'signora', 'sig', 'n/a', 'na', 'test', 'nome', 'nome cognome']);
    if (NAME_PLACEHOLDERS.has(customerName.toLowerCase().trim())) {
        console.warn('[ElevenLabs] create-reservation rejected: placeholder name', { received: customerName });
        return res.json({
            success: false,
            error: 'invalid_customer_name',
            message: 'Serve il nome reale del cliente per registrare la prenotazione. Chieda nome e cognome al cliente e riprovi.'
        });
    }
    if (!phoneRaw) {
        return res.json({
            success: false,
            error: 'invalid_phone',
            message: 'Non ho un numero di telefono per la prenotazione. Può dettarmelo?'
        });
    }
    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn('[ElevenLabs] create-reservation rejected: unparseable date', { received: p.date });
        return res.json({
            success: false,
            error: 'invalid_date',
            message: 'Formato data non riconosciuto. Esempi accettati: 2026-05-14, 14/05/2026, "14 maggio 2026".'
        });
    }
    const normalizedTime = parseFlexibleTime(p.time);
    if (!normalizedTime) {
        console.warn('[ElevenLabs] create-reservation rejected: unparseable time', { received: p.time });
        return res.json({
            success: false,
            error: 'invalid_time',
            message: 'Formato orario non riconosciuto. Esempi accettati: 20:30, "20 e 30", "20 e mezza".'
        });
    }
    if (rawShift !== Shift.LUNCH && rawShift !== Shift.DINNER) {
        return res.json({
            success: false,
            error: 'invalid_shift',
            message: 'Il turno non è valido. Può indicare se si tratta di pranzo o cena?'
        });
    }
    // Defense-in-depth mirror of the date-block guard in check-availability:
    // an LLM that skips the availability step must still not be able to book
    // a date the operator reserved for manual handling.
    {
        const voiceShift = rawShift as 'LUNCH' | 'DINNER';
        const dateBlock = findVoiceDateBlock(normalizedDate, voiceShift, await getVoiceDateBlocks());
        if (dateBlock) {
            console.log('[ElevenLabs] create-reservation blocked date', { date: normalizedDate, shift: rawShift, block: dateBlock, conversation_id: conversationId });
            return res.json({
                success: false,
                error: 'date_blocked',
                message: buildVoiceDateBlockMessage(normalizedDate, voiceShift, dateBlock),
            });
        }
    }
    // Constrain the booking time to the restaurant's slot grid so voice
    // bookings round-trip through the manual edit form without falling back
    // to a different time option. The grid is derived from the
    // opening_hours + special_closures tables (see utils/slots.ts), so it
    // changes per weekday and can be temporarily closed for holidays.
    const validSlots = await getAvailableSlots(normalizedDate, rawShift as Shift);
    if (!validSlots.includes(normalizedTime)) {
        const shiftLabel = (rawShift as Shift) === Shift.LUNCH ? 'il pranzo' : 'la cena';
        console.warn('[ElevenLabs] create-reservation rejected: invalid_slot', {
            received_time: p.time, normalized_time: normalizedTime, shift: rawShift,
            available_slots: validSlots,
        });
        const message = validSlots.length === 0
            ? `Mi dispiace, ${shiftLabel} di quel giorno non è disponibile. Possiamo provare un altro giorno?`
            : `Per ${shiftLabel} possiamo prenotare solo alle ${formatSlotListItalian(validSlots)}. Quale orario preferisce?`;
        return res.json({
            success: false,
            error: 'invalid_slot',
            available_slots: validSlots,
            message,
        });
    }
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
        return res.json({
            success: false,
            error: 'invalid_guests',
            message: 'Il numero di ospiti non è valido. Può ripetermi per quante persone vuole prenotare?'
        });
    }
    // Defense-in-depth for the self-serve cap enforced in check-availability
    // (see comment there for the underlying reason). Prevents an LLM
    // hallucination from bypassing the handoff by calling create-reservation
    // directly without a prior availability check. Threshold is dynamic —
    // editable from Settings → Canali.
    const voiceThresholdCreate = await getVoiceLargeGroupThreshold();
    if (guests > voiceThresholdCreate) {
        console.log('[ElevenLabs] create-reservation blocked (large group)', { guests, threshold: voiceThresholdCreate, conversation_id: conversationId });
        return res.json({
            success: false,
            error: 'large_group',
            message: `Per gruppi da ${voiceThresholdCreate + 1} persone in su preferiamo gestire la prenotazione al telefono. Lascio un promemoria e la richiamiamo il prima possibile.`
        });
    }
    const childrenNum = Number(childrenRaw);
    const children = Number.isFinite(childrenNum) && childrenNum > 0
        ? Math.max(0, Math.min(Math.trunc(childrenNum), Math.trunc(guests)))
        : 0;

    // Build an ISO datetime; the DB column is TIMESTAMPTZ so we let Postgres
    // interpret as the server's configured timezone (Europe/Rome in prod).
    const reservationTime = `${normalizedDate}T${normalizedTime}:00`;

    try {
        console.log('[ElevenLabs] create-reservation start', {
            customer_name: customerName, raw_date: p.date, raw_time: p.time,
            normalized_date: normalizedDate, normalized_time: normalizedTime,
            shift: rawShift, guests, children, conversation_id: conversationId,
            location_preference: locationPreference, phone_source: phoneSource,
        });
        const created = await createVoiceReservation({
            customer_name: customerName,
            phone: phoneRaw,
            reservation_time: reservationTime,
            shift: rawShift as Shift,
            guests: Math.trunc(guests),
            children,
            notes,
            conversation_id: conversationId,
            location_preference: locationPreference,
        });

        // Link the (eventual) call audit row to this reservation. Fire-and-forget
        // so a missing voice_calls table (pre-migration) doesn't break booking.
        if (conversationId) {
            recordVoiceCall({
                conversation_id: conversationId,
                phone: normalizeItalianPhone(phoneRaw),
                reservation_id: created.id,
            }).catch(err => console.warn('[ElevenLabs] recordVoiceCall (create) failed:', err?.message || err));
        }

        // Auto-save the caller into the rubrica. Voice bookings are the most
        // common way a brand-new customer first appears in our system, so the
        // upsert here is what keeps the rubrica in sync with reality.
        await upsertCustomerFromReservation(customerName, phoneRaw, null, null);

        // Activity log: no authenticated user, attribute to the voice agent.
        LogService.logActivity(
            null,
            'voice-agent@elevenlabs',
            'Agent vocale',
            ActivityAction.CREATE,
            ResourceType.RESERVATION,
            created.id,
            created.customer_name,
            {
                source: 'VOICE',
                conversation_id: conversationId,
                requires_review: created.requires_review,
                guests: created.guests,
                children: created.children,
                reservation_time: created.reservation_time,
                shift: created.shift,
            }
        );

        // Broadcast to live dashboards so the new booking pops up without refresh.
        if (socketService) {
            try {
                socketService.broadcastReservationCreated(created as any);
            } catch (err) {
                console.warn('[ElevenLabs] broadcastReservationCreated failed:', err);
            }
        }

        const reservationLabel = reservationPushLabel(asUtcInstant(created.reservation_time));
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: 'Nuova prenotazione vocale',
                body: `${toTitleCase(created.customer_name)} · ${created.guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${created.id}`,
                tag: `reservation-${created.id}`,
            },
            { excludeUserId: null }
        ).catch(err => console.error('Push (voice reservation) failed:', err));

        const confirmationPhrase = formatItalianConfirmation(created);
        console.log('[ElevenLabs] create-reservation OK', {
            id: created.id, conversation_id: conversationId, customer: created.customer_name,
            table_id: created.table_id, table_name: created.table_name,
            room: created.room_name, location: created.room_location,
        });
        res.json({
            success: true,
            reservation_id: created.id,
            requires_review: created.requires_review,
            confirmation_phrase: confirmationPhrase,
            // date_readback is the Italian "venerdì 10 luglio" string the
            // agent MUST use verbatim to name the day in its final readback.
            date_readback: formatItalianDateReadback(normalizedDate),
            table_id: created.table_id,
            table_name: created.table_name,
            room_name: created.room_name,
            room_location: created.room_location,
        });
    } catch (err: any) {
        console.error('[ElevenLabs] create-reservation error', err);
        res.status(500).json({
            success: false,
            message: 'Si è verificato un errore tecnico nel salvare la prenotazione, posso richiamarla?'
        });
    }
});

// Cancel a reservation made by the caller. The agent should ask the caller
// for date (and optionally time) and confirm by repeating the customer name
// before invoking this tool. Soft cancel — sets reservation_status=CANCELLED
// so the row remains for audit and can be linked to the conversation.
app.post('/webhook/elevenlabs/cancel-reservation', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;
    if (!(await getFeatureFlag('voice_agent_enabled', true))) {
        return res.status(503).json({ error: 'voice_agent_disabled', message: VOICE_AGENT_DISABLED_MESSAGE });
    }

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const conversationId: string | undefined = req.body?.conversation_id || p.conversation_id;

    // Same phone/caller_id fallback as create-reservation.
    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;
    const phoneSource: 'customer' | 'caller_id' | 'none' = String(p.phone ?? '').trim()
        ? 'customer'
        : callerIdRaw ? 'caller_id' : 'none';
    // See note in check-availability: user-actionable validation errors are
    // returned as HTTP 200 with `success:false` so ElevenLabs surfaces the
    // Italian `message` to the LLM (it drops 4xx bodies).
    if (!phoneRaw) {
        return res.json({
            success: false,
            error: 'invalid_phone',
            message: 'Non ho un numero di telefono a cui associare la prenotazione. Può dettarmelo?'
        });
    }
    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn('[ElevenLabs] cancel-reservation rejected: unparseable date', { received: p.date });
        return res.json({
            success: false,
            error: 'invalid_date',
            message: 'Formato data non riconosciuto. Esempi accettati: 2026-05-14, 14/05/2026, "14 maggio 2026".'
        });
    }
    // Time is optional — only used to disambiguate when the caller has more
    // than one booking on the same day.
    let normalizedTime: string | undefined;
    if (p.time !== undefined && p.time !== null && String(p.time).trim() !== '') {
        const t = parseFlexibleTime(p.time);
        if (!t) {
            console.warn('[ElevenLabs] cancel-reservation rejected: unparseable time', { received: p.time });
            return res.json({
                success: false,
                error: 'invalid_time',
                message: 'Formato orario non riconosciuto. Esempi accettati: 20:30, "20 e 30", "20 e mezza".'
            });
        }
        normalizedTime = t;
    }

    try {
        console.log('[ElevenLabs] cancel-reservation start', {
            phone_raw: phoneRaw, phone_source: phoneSource,
            normalized_date: normalizedDate,
            normalized_time: normalizedTime, conversation_id: conversationId,
        });
        const outcome = await cancelVoiceReservation({
            phone: phoneRaw,
            date: normalizedDate,
            time: normalizedTime,
            conversation_id: conversationId,
        });

        if (outcome.status === 'not_found') {
            console.log('[ElevenLabs] cancel-reservation: no match', {
                phone: normalizeItalianPhone(phoneRaw), date: normalizedDate, time: normalizedTime,
            });
            return res.json({
                success: false,
                status: 'not_found',
                message: 'Non trovo una prenotazione a questo numero per la data indicata. Può confermarmi la data esatta?'
            });
        }

        if (outcome.status === 'already_cancelled') {
            const { timeLabel } = formatBookingDateTime(asUtcInstant(outcome.reservation.reservation_time));
            console.log('[ElevenLabs] cancel-reservation: already cancelled', {
                id: outcome.reservation.id, conversation_id: conversationId,
            });
            return res.json({
                success: false,
                status: 'already_cancelled',
                reservation_id: outcome.reservation.id,
                message: `La prenotazione di ${outcome.reservation.customer_name} delle ${timeLabel} risulta già annullata. C'è altro che posso fare?`
            });
        }

        if (outcome.status === 'ambiguous') {
            const list = outcome.candidates.map(c => {
                const { timeLabel } = formatBookingDateTime(asUtcInstant(c.reservation_time));
                return `${timeLabel} per ${c.guests}`;
            }).join(', ');
            console.log('[ElevenLabs] cancel-reservation: ambiguous', {
                count: outcome.candidates.length, candidates: outcome.candidates.map(c => c.id),
            });
            return res.json({
                success: false,
                status: 'ambiguous',
                candidates: outcome.candidates,
                message: `Ho trovato più prenotazioni per quel giorno (${list}). Mi conferma l'orario di quella da annullare?`
            });
        }

        const cancelled = outcome.reservation;

        // Link the audit row so the cancellation conversation is traceable.
        if (conversationId) {
            recordVoiceCall({
                conversation_id: conversationId,
                phone: normalizeItalianPhone(phoneRaw),
                reservation_id: cancelled.id,
            }).catch(err => console.warn('[ElevenLabs] recordVoiceCall (cancel) failed:', err?.message || err));
        }

        LogService.logActivity(
            null,
            'voice-agent@elevenlabs',
            'Agent vocale',
            ActivityAction.DELETE,
            ResourceType.RESERVATION,
            cancelled.id,
            cancelled.customer_name,
            {
                source: 'VOICE',
                conversation_id: conversationId,
                cancelled_via: 'voice_agent',
                reservation_time: cancelled.reservation_time,
                shift: cancelled.shift,
                guests: cancelled.guests,
            }
        );

        if (socketService) {
            try {
                socketService.broadcastReservationUpdated({
                    ...cancelled,
                    reservation_status: 'CANCELLED',
                } as any);
            } catch (err) {
                console.warn('[ElevenLabs] broadcastReservationUpdated failed:', err);
            }
        }

        const reservationLabel = reservationPushLabel(asUtcInstant(cancelled.reservation_time));
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: 'Prenotazione cancellata (voce)',
                body: `${toTitleCase(cancelled.customer_name)} · ${cancelled.guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${cancelled.id}`,
                tag: `reservation-${cancelled.id}`,
            },
            { excludeUserId: null }
        ).catch(err => console.error('Push (voice cancellation) failed:', err));

        const confirmationPhrase = formatItalianCancellation(cancelled);
        console.log('[ElevenLabs] cancel-reservation OK', {
            id: cancelled.id, conversation_id: conversationId, customer: cancelled.customer_name,
        });
        return res.json({
            success: true,
            status: 'cancelled',
            reservation_id: cancelled.id,
            confirmation_phrase: confirmationPhrase,
        });
    } catch (err: any) {
        console.error('[ElevenLabs] cancel-reservation error', err);
        return res.status(500).json({
            success: false,
            message: 'Si è verificato un errore tecnico, posso richiamarla per cancellare la prenotazione?'
        });
    }
});

// Modify an existing reservation (change date/time/shift/guests/location/notes).
// Same identify-by-phone-and-date pattern as cancel-reservation. Only the
// `new_*` fields that are actually being changed need to be present in the
// request body; anything omitted keeps its current value.
app.post('/webhook/elevenlabs/modify-reservation', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;
    if (!(await getFeatureFlag('voice_agent_enabled', true))) {
        return res.status(503).json({ error: 'voice_agent_disabled', message: VOICE_AGENT_DISABLED_MESSAGE });
    }

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const conversationId: string | undefined = req.body?.conversation_id || p.conversation_id;

    const callerIdRaw = String(p.caller_id ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim() || callerIdRaw;
    if (!phoneRaw) {
        return res.json({
            success: false,
            error: 'invalid_phone',
            message: 'Non ho un numero di telefono a cui associare la prenotazione. Può dettarmelo?'
        });
    }
    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        return res.json({
            success: false,
            error: 'invalid_date',
            message: 'Formato data della prenotazione da modificare non riconosciuto. Esempi: 2026-05-14, 14/05/2026, "14 maggio 2026".'
        });
    }
    let normalizedTime: string | undefined;
    if (p.time !== undefined && p.time !== null && String(p.time).trim() !== '') {
        const t = parseFlexibleTime(p.time);
        if (!t) {
            return res.json({
                success: false,
                error: 'invalid_time',
                message: 'Formato orario della prenotazione non riconosciuto. Esempi: 20:30, "20 e 30", "20 e mezza".'
            });
        }
        normalizedTime = t;
    }

    // Parse the "new_*" overrides — each field is optional.
    let newDate: string | undefined;
    if (p.new_date !== undefined && p.new_date !== null && String(p.new_date).trim() !== '') {
        newDate = parseFlexibleDate(p.new_date) || undefined;
        if (!newDate) {
            return res.json({
                success: false,
                error: 'invalid_new_date',
                message: 'Formato nuova data non riconosciuto. Esempi: 2026-05-14, 14/05/2026, "14 maggio 2026".'
            });
        }
    }
    let newTime: string | undefined;
    if (p.new_time !== undefined && p.new_time !== null && String(p.new_time).trim() !== '') {
        newTime = parseFlexibleTime(p.new_time) || undefined;
        if (!newTime) {
            return res.json({
                success: false,
                error: 'invalid_new_time',
                message: 'Formato nuovo orario non riconosciuto. Esempi: 20:30, "20 e 30", "20 e mezza".'
            });
        }
    }
    let newShift: Shift | undefined;
    if (p.new_shift !== undefined && p.new_shift !== null && String(p.new_shift).trim() !== '') {
        const s = String(p.new_shift).trim().toUpperCase();
        if (s !== Shift.LUNCH && s !== Shift.DINNER) {
            return res.json({
                success: false,
                error: 'invalid_new_shift',
                message: 'Il nuovo turno non è valido. Può indicare se si tratta di pranzo o cena?'
            });
        }
        newShift = s as Shift;
    }
    let newGuests: number | undefined;
    if (p.new_guests !== undefined && p.new_guests !== null && String(p.new_guests).trim() !== '') {
        const g = Number(p.new_guests);
        if (!Number.isFinite(g) || g < 1 || g > 50) {
            return res.json({
                success: false,
                error: 'invalid_new_guests',
                message: 'Il nuovo numero di ospiti non è valido. Può ripetermi per quante persone?'
            });
        }
        newGuests = Math.trunc(g);
    }
    let newLocation: 'INDOOR' | 'OUTDOOR' | undefined;
    if (p.new_location_preference !== undefined && p.new_location_preference !== null) {
        const l = String(p.new_location_preference).trim().toUpperCase();
        if (l === 'INDOOR' || l === 'OUTDOOR') newLocation = l as 'INDOOR' | 'OUTDOOR';
    }
    const newNotes = typeof p.new_notes === 'string' && p.new_notes.trim() !== ''
        ? p.new_notes.trim()
        : undefined;

    if (!newDate && !newTime && !newShift && newGuests === undefined && !newLocation && !newNotes) {
        return res.json({
            success: false,
            error: 'no_changes_provided',
            message: 'Cosa vuole modificare della prenotazione? Data, orario, numero di persone, zona (interno o esterno) o note?'
        });
    }

    // If the new time crosses shift boundaries and the shift wasn't specified,
    // derive it so the agent doesn't have to worry about it.
    if (newTime && !newShift) {
        const hh = parseInt(newTime.split(':')[0], 10);
        if (Number.isFinite(hh)) {
            newShift = (hh >= 11 && hh < 17) ? Shift.LUNCH : Shift.DINNER;
        }
    }

    try {
        console.log('[ElevenLabs] modify-reservation start', {
            phone_raw: phoneRaw, normalized_date: normalizedDate, normalized_time: normalizedTime,
            new_date: newDate, new_time: newTime, new_shift: newShift, new_guests: newGuests,
            new_location: newLocation, has_new_notes: !!newNotes, conversation_id: conversationId,
        });
        const outcome = await modifyVoiceReservation({
            phone: phoneRaw,
            date: normalizedDate,
            time: normalizedTime,
            conversation_id: conversationId,
            new_date: newDate,
            new_time: newTime,
            new_shift: newShift,
            new_guests: newGuests,
            new_location_preference: newLocation,
            new_notes: newNotes,
        });

        if (outcome.status === 'not_found') {
            return res.json({
                success: false,
                status: 'not_found',
                message: 'Non trovo una prenotazione a questo numero per la data indicata. Può confermarmi la data esatta?'
            });
        }
        if (outcome.status === 'already_cancelled') {
            return res.json({
                success: false,
                status: 'already_cancelled',
                reservation_id: outcome.reservation.id,
                message: `La prenotazione di ${outcome.reservation.customer_name} risulta annullata: non posso modificarla. Vuole fare una nuova prenotazione?`
            });
        }
        if (outcome.status === 'ambiguous') {
            const list = outcome.candidates.map(c => {
                const { timeLabel } = formatBookingDateTime(asUtcInstant(c.reservation_time));
                return `${timeLabel} per ${c.guests}`;
            }).join(', ');
            return res.json({
                success: false,
                status: 'ambiguous',
                candidates: outcome.candidates,
                message: `Ho trovato più prenotazioni per quel giorno (${list}). Mi conferma l'orario di quella da modificare?`
            });
        }
        if (outcome.status === 'no_change') {
            return res.json({
                success: false,
                status: 'no_change',
                message: 'I dati che mi ha indicato coincidono con quelli già registrati. Non c\'è nulla da modificare.'
            });
        }
        if (outcome.status === 'unavailable') {
            return res.json({
                success: false,
                status: 'unavailable',
                message: 'Mi dispiace, non abbiamo disponibilità per la nuova configurazione richiesta. Vuole provare un altro orario o un\'altra data?'
            });
        }

        // outcome.status === 'modified'
        const { before, after } = outcome;

        // Link the audit row so the modification is traceable.
        if (conversationId) {
            recordVoiceCall({
                conversation_id: conversationId,
                phone: normalizeItalianPhone(phoneRaw),
                reservation_id: after.id,
            }).catch(err => console.warn('[ElevenLabs] recordVoiceCall (modify) failed:', err?.message || err));
        }

        LogService.logActivity(
            null,
            'voice-agent@elevenlabs',
            'Agent vocale',
            ActivityAction.UPDATE,
            ResourceType.RESERVATION,
            after.id,
            after.customer_name,
            {
                source: 'VOICE',
                conversation_id: conversationId,
                modified_via: 'voice_agent',
                before: {
                    reservation_time: before.reservation_time,
                    shift: before.shift,
                    guests: before.guests,
                },
                after: {
                    reservation_time: after.reservation_time,
                    shift: after.shift,
                    guests: after.guests,
                    table_id: after.table_id,
                },
            }
        );

        if (socketService) {
            try {
                socketService.broadcastReservationUpdated(after as any);
            } catch (err) {
                console.warn('[ElevenLabs] broadcastReservationUpdated (modify) failed:', err);
            }
        }

        const reservationLabel = reservationPushLabel(asUtcInstant(after.reservation_time));
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: 'Prenotazione modificata (voce)',
                body: `${toTitleCase(after.customer_name)} · ${after.guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${after.id}`,
                tag: `reservation-${after.id}`,
            },
            { excludeUserId: null }
        ).catch(err => console.error('Push (voice modification) failed:', err));

        const confirmationPhrase = formatItalianModification(after);
        console.log('[ElevenLabs] modify-reservation OK', {
            id: after.id, conversation_id: conversationId, customer: after.customer_name,
        });
        // after.reservation_time is a Date object; String(Date) gives
        // "Fri Jan 15 2027 ..." which is not ISO. Use toISOString().
        const rt: any = after.reservation_time;
        const afterIso: string = rt instanceof Date ? rt.toISOString() : String(rt);
        return res.json({
            success: true,
            status: 'modified',
            reservation_id: after.id,
            confirmation_phrase: confirmationPhrase,
            date_readback: formatItalianDateReadback(afterIso.slice(0, 10)),
        });
    } catch (err: any) {
        console.error('[ElevenLabs] modify-reservation error', err);
        return res.status(500).json({
            success: false,
            message: 'Si è verificato un errore tecnico nel modificare la prenotazione, posso richiamarla?'
        });
    }
});

// Post-call webhook — fires when the conversation ends.
// ElevenLabs sends slightly different shapes depending on agent version and
// "event vs payload" wrappers. We accept all of:
//   { conversation_id, ... }
//   { data: { conversation_id, ... } }
//   { event: "post_call_transcript", data: { conversation_id, transcript: [...] } }
// and extract conversation_id / transcript / summary / phone / duration from
// wherever they live.
app.post('/webhook/elevenlabs/post-call', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;

    const body = req.body || {};
    const data = (body.data && typeof body.data === 'object') ? body.data : body;

    const conversationId: string | undefined =
        body.conversation_id ||
        data.conversation_id ||
        data.conversation?.id ||
        data.convai_session_id;

    if (!conversationId) {
        // Don't fail the webhook — ElevenLabs will retry forever on 4xx/5xx.
        // Log the whole payload (truncated) once so we can adjust extraction.
        const raw = JSON.stringify(body).slice(0, 2000);
        console.warn('[ElevenLabs] post-call: conversation_id missing — body shape:', raw);
        return res.status(200).json({ ok: true, note: 'conversation_id not extracted; payload logged' });
    }

    // Transcript may be a string (rare) or an array of turns. Coerce to string.
    let transcript: string | undefined;
    const rawTranscript = data.transcript ?? body.transcript;
    if (typeof rawTranscript === 'string') {
        transcript = rawTranscript;
    } else if (Array.isArray(rawTranscript)) {
        transcript = rawTranscript
            .map((t: any) => {
                const who = t.role || t.speaker || 'unknown';
                const text = t.message ?? t.text ?? t.content ?? '';
                return `${who}: ${text}`;
            })
            .join('\n');
    }

    const summary: string | undefined =
        (typeof data.summary === 'string' ? data.summary : undefined) ??
        (typeof data.analysis?.summary === 'string' ? data.analysis.summary : undefined) ??
        (typeof body.summary === 'string' ? body.summary : undefined);

    const duration = Number(data.duration_seconds ?? body.duration_seconds ?? data.metadata?.call_duration_seconds);
    // For SIP calls the number lives at metadata.phone_call.external_number;
    // the other keys are legacy/dashboard-set fallbacks.
    const phoneRaw: string | undefined =
        data.metadata?.phone_call?.external_number ||
        body.metadata?.phone_call?.external_number ||
        data.metadata?.phone_number ||
        body.metadata?.phone_number ||
        data.metadata?.phone ||
        body.metadata?.phone ||
        data.phone ||
        body.phone ||
        data.caller_id ||
        body.caller_id;

    // Acknowledge fast — ElevenLabs retries on timeout. Side-effects below are fire-and-forget.
    res.status(200).json({ ok: true });
    console.log('[ElevenLabs] post-call', {
        conversation_id: conversationId,
        has_transcript: !!transcript,
        has_summary: !!summary,
        duration_seconds: Number.isFinite(duration) ? duration : null,
        phone: phoneRaw || null,
    });

    try {
        await recordVoiceCall({
            conversation_id: conversationId,
            phone: phoneRaw ? normalizeItalianPhone(phoneRaw) : undefined,
            duration_seconds: Number.isFinite(duration) ? Math.trunc(duration) : undefined,
            transcript,
            summary,
        });
    } catch (err: any) {
        console.warn('[ElevenLabs] post-call recordVoiceCall failed:', err?.message || err);
    }

    // Safety net for LLM hallucinations: the agent sometimes says
    // "prenotazione confermata" to the caller without ever invoking
    // create-reservation. We detect this by scanning the transcript for
    // confirmation language in an agent turn while no reservation is linked,
    // then flag the row and page the managers with a distinct URGENT push
    // so they can call the customer back before they show up expecting a
    // table that doesn't exist.
    try {
        if (transcript && detectPhantomConfirmation(transcript)) {
            const phantomRow = await queryWithRetry(
                `UPDATE voice_calls
                 SET phantom_confirmation = TRUE
                 WHERE conversation_id = $1
                   AND reservation_id IS NULL
                   AND phantom_confirmation = FALSE
                 RETURNING id, phone`,
                [conversationId]
            );
            if (phantomRow.rowCount && phantomRow.rowCount > 0) {
                const row = phantomRow.rows[0];
                const displayPhone = row.phone || phoneRaw || 'numero sconosciuto';
                pushSendToRoles(
                    ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
                    {
                        category: 'voice',
                        title: '⚠️ Prenotazione da recuperare',
                        body: `L'agent ha detto "confermata" ma NON c'è prenotazione. Chiama ${displayPhone}.`,
                        url: '/?view=CONVERSAZIONI',
                        tag: `voice-phantom-${conversationId}`,
                    },
                    { excludeUserId: null }
                ).catch(err => console.error('Push (phantom confirmation) failed:', err));
                console.warn('[ElevenLabs] PHANTOM CONFIRMATION detected on', conversationId, 'phone=', displayPhone);
            }
        }
    } catch (err: any) {
        console.warn('[ElevenLabs] post-call phantom detection failed:', err?.message || err);
    }

    // Large-group handoff detection. If the agent read the callback phrase
    // ("gestire la prenotazione al telefono") we flag the row so the
    // Conversazioni card displays a dedicated "gruppo grande" badge — this
    // is a callback request, not a plain missed booking. No push here: the
    // caller has already been told they'll be called back and it's not
    // time-critical the same way phantom confirmations are.
    try {
        if (transcript && detectLargeGroupHandoff(transcript)) {
            await queryWithRetry(
                `UPDATE voice_calls
                 SET large_group_handoff = TRUE
                 WHERE conversation_id = $1
                   AND large_group_handoff = FALSE`,
                [conversationId]
            );
            console.log('[ElevenLabs] large-group handoff detected on', conversationId);
        }
    } catch (err: any) {
        console.warn('[ElevenLabs] post-call large-group detection failed:', err?.message || err);
    }

    // Look up any reservation linked to this conversation (set during create_reservation).
    // If found and we have a phone, send the WhatsApp recap.
    try {
        const linked = await queryWithRetry(
            // Sala sì, tavolo no: i messaggi al cliente non nominano mai il
            // tavolo assegnato (dato operativo, cambia fino all'arrivo).
            `SELECT r.id, r.customer_name, r.phone, r.reservation_time, r.guests,
                    rm.name AS room_name
             FROM voice_calls vc
             JOIN reservations r ON r.id = vc.reservation_id
             LEFT JOIN tables t ON t.id = r.table_id
             LEFT JOIN rooms rm ON rm.id = t.room_id
             WHERE vc.conversation_id = $1`,
            [conversationId]
        );
        const row = linked.rows[0];
        if (row && row.phone) {
            const message = buildConfirmationMessage(row.customer_name, row.reservation_time, row.guests, row.room_name);
            const whatsappTemplate = buildBookingConfirmedTemplate(row.customer_name, row.reservation_time, row.guests);
            sendBookingConfirmation(row.phone, message, row.id, { whatsappTemplate }).catch(err =>
                console.warn('[ElevenLabs] post-call confirmation send failed:', err?.message || err)
            );
        }
    } catch (err: any) {
        console.warn('[ElevenLabs] post-call recap lookup failed:', err?.message || err);
    }

    // If the call ended without a booking, alert managers so they can call the
    // customer back before they try another restaurant. Skipped if staff has
    // already marked the call as CONTACTED (webhook retry after manual handling).
    try {
        const pending = await queryWithRetry(
            `SELECT vc.phone,
                    cust.name AS customer_name
             FROM voice_calls vc
             LEFT JOIN LATERAL (
                 SELECT c.name
                 FROM customers c
                 WHERE vc.phone IS NOT NULL
                   AND c.phone IS NOT NULL
                   AND length(regexp_replace(c.phone, '\\D', '', 'g')) >= 8
                   AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10)
                     = right(regexp_replace(vc.phone, '\\D', '', 'g'), 10)
                 LIMIT 1
             ) cust ON true
             WHERE vc.conversation_id = $1
               AND vc.reservation_id IS NULL
               AND (vc.follow_up_status IS NULL OR vc.follow_up_status = 'PENDING')`,
            [conversationId]
        );
        const row = pending.rows[0];
        if (row) {
            const label = row.customer_name || row.phone || 'Numero sconosciuto';
            const bodyLine = row.customer_name && row.phone ? `${row.customer_name} · ${row.phone}` : label;
            pushSendToRoles(
                ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
                {
                    category: 'voice',
                    title: 'Chiamata da ricontattare',
                    body: bodyLine,
                    url: '/?view=CONVERSAZIONI',
                    tag: `voice-followup-${conversationId}`,
                },
                { excludeUserId: null }
            ).catch(err => console.error('Push (voice follow-up) failed:', err));
        }
    } catch (err: any) {
        console.warn('[ElevenLabs] post-call follow-up push failed:', err?.message || err);
    }
});

// ============================================
// PROTECTED ENDPOINTS
// ============================================

// Returns true if the table belongs to a closed room.
async function isTableInClosedRoom(tableId: number | null | undefined): Promise<boolean> {
    if (tableId == null) return false;
    const result = await queryWithRetry(
        'SELECT r.is_closed FROM tables t JOIN rooms r ON t.room_id = r.id WHERE t.id = $1',
        [tableId]
    );
    return result.rows[0]?.is_closed === true;
}

// Re-select the given reservations with the same enrichment the GET
// /reservations list uses (VIP/preferred-table/payment joins) and broadcast a
// `reservation:updated` for each, so every connected client patches its
// reservations array in place — no full refresh. Used when a NON-reservation
// route mutates denormalized reservation fields (e.g. a customer rename or
// merge cascades customer_name/phone onto matching reservations). Best-effort:
// a broadcast failure must never fail the originating request.
async function broadcastReservationsUpdatedByIds(ids: number[]): Promise<void> {
    if (!socketService || ids.length === 0) return;
    try {
        const result = await queryWithRetry(`
            SELECT r.*, u.full_name AS created_by_user_name,
                   c.is_vip AS customer_is_vip,
                   c.preferred_table_id AS customer_preferred_table_id,
                   pt.name AS customer_preferred_table_name,
                   c.dietary_notes AS customer_dietary_notes,
                   c.preferences_notes AS customer_preferences_notes,
                   lp.id AS latest_payment_id,
                   lp.status AS latest_payment_status,
                   lp.amount_cents AS latest_payment_amount_cents,
                   lp.currency AS latest_payment_currency,
                   lp.provider AS latest_payment_provider,
                   lp.delivery_channel AS latest_payment_delivery_channel,
                   lp.created_at AS latest_payment_created_at,
                   lp.completed_at AS latest_payment_completed_at
            FROM reservations r
            LEFT JOIN users u ON r.created_by_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT cc.is_vip, cc.preferred_table_id, cc.dietary_notes, cc.preferences_notes
                FROM customers cc
                WHERE r.phone IS NOT NULL
                  AND cc.phone IS NOT NULL
                  AND regexp_replace(r.phone, '\\D', '', 'g') = regexp_replace(cc.phone, '\\D', '', 'g')
                ORDER BY cc.is_vip DESC NULLS LAST, (cc.preferred_table_id IS NULL), cc.id ASC
                LIMIT 1
            ) c ON true
            LEFT JOIN tables pt ON pt.id = c.preferred_table_id
            LEFT JOIN LATERAL (
                SELECT pr.id, pr.status, pr.amount_cents, pr.currency, pr.provider,
                       pr.delivery_channel, pr.created_at, pr.completed_at
                FROM payment_requests pr
                WHERE pr.reservation_id = r.id
                ORDER BY pr.created_at DESC
                LIMIT 1
            ) lp ON true
            WHERE r.id = ANY($1::int[])
        `, [ids]);
        for (const row of result.rows) {
            socketService.broadcastReservationSynced(row);
        }
    } catch (err) {
        console.warn('[sync] broadcastReservationsUpdatedByIds failed:', err);
    }
}

// Find tables already booked on a given date+shift, either by a reservation
// or by another banquet. Used to prevent overbooking across both sections.
// Returns one row per (table_id, source) conflict; an empty result means free.
interface TableConflict {
    table_id: number;
    table_name: string;
    source: 'reservation' | 'banquet';
    source_id: number;
    source_name: string;
}

// Shift-default duration used when a reservation has no explicit
// duration_minutes. Kept in sync with defaultDurationForShift() on the client.
const SHIFT_DEFAULT_DURATION_SQL = `CASE WHEN r.shift = 'LUNCH' THEN 90 ELSE 120 END`;

async function findTableConflicts(
    eventDate: string,
    shift: string | null | undefined,
    tableIds: number[],
    options?: {
        excludeBanquetId?: number;
        excludeReservationId?: number;
        /**
         * When set, reservation-vs-reservation conflicts are decided by
         * time-window overlap ([start, start+duration)) instead of the
         * shift-wide equality check. Enables double-seating on the same
         * table when the earlier party leaves before the later one arrives.
         * When left undefined (e.g. a banquet requester), we fall back to
         * shift-wide matching so the caller still blocks any overlap.
         */
        reservationStart?: string;
        reservationDurationMin?: number;
    }
): Promise<TableConflict[]> {
    if (!eventDate || !shift || !Array.isArray(tableIds) || tableIds.length === 0) return [];

    const conflicts: TableConflict[] = [];

    const useWindow = options?.reservationStart != null && options?.reservationDurationMin != null;
    const resParams: any[] = [tableIds, eventDate];
    let resWhere = `r.table_id = ANY($1::int[])
                    AND DATE(r.reservation_time) = $2::date
                    AND COALESCE(r.arrival_status, 'WAITING') <> 'DEPARTED'
                    AND COALESCE(r.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')`;
    if (useWindow) {
        // Overlap: r.start < new.end AND r.end > new.start
        resParams.push(options!.reservationStart);
        const startIdx = resParams.length;
        resParams.push(options!.reservationDurationMin);
        const durIdx = resParams.length;
        resWhere += ` AND r.reservation_time < ($${startIdx}::timestamptz + ($${durIdx} || ' minutes')::interval)
                      AND (r.reservation_time + (COALESCE(r.duration_minutes, ${SHIFT_DEFAULT_DURATION_SQL}) || ' minutes')::interval) > $${startIdx}::timestamptz`;
    } else {
        resParams.push(shift);
        resWhere += ` AND r.shift = $${resParams.length}`;
    }
    if (options?.excludeReservationId) {
        resParams.push(options.excludeReservationId);
        resWhere += ` AND r.id <> $${resParams.length}`;
    }
    const resResult = await queryWithRetry(
        `SELECT r.id, r.customer_name, r.table_id, t.name AS table_name
         FROM reservations r
         JOIN tables t ON t.id = r.table_id
         WHERE ${resWhere}`,
        resParams
    );
    for (const row of resResult.rows) {
        conflicts.push({
            table_id: row.table_id,
            table_name: row.table_name,
            source: 'reservation',
            source_id: row.id,
            source_name: row.customer_name,
        });
    }

    const banParams: any[] = [eventDate, shift, tableIds];
    let banWhere = `b.event_date = $1::date AND b.shift = $2 AND b.table_ids && $3::int[]`;
    if (options?.excludeBanquetId) {
        banParams.push(options.excludeBanquetId);
        banWhere += ` AND b.id <> $${banParams.length}`;
    }
    const banResult = await queryWithRetry(
        `SELECT b.id, b.name, b.table_ids FROM banquet_menus b WHERE ${banWhere}`,
        banParams
    );
    for (const row of banResult.rows) {
        const overlap: number[] = (row.table_ids || []).filter((tid: number) => tableIds.includes(tid));
        if (overlap.length === 0) continue;
        const tableNames = await queryWithRetry(
            'SELECT id, name FROM tables WHERE id = ANY($1::int[])',
            [overlap]
        );
        for (const t of tableNames.rows) {
            conflicts.push({
                table_id: t.id,
                table_name: t.name,
                source: 'banquet',
                source_id: row.id,
                source_name: row.name,
            });
        }
    }

    return conflicts;
}

const buildConflictMessage = (conflicts: TableConflict[]): string => {
    const parts = conflicts.map(c => {
        const what = c.source === 'reservation' ? 'prenotazione di' : 'banchetto';
        return `Tavolo ${c.table_name} occupato (${what} ${c.source_name})`;
    });
    return parts.join('; ');
};

// Reservations - require authentication
app.get('/reservations', authenticate, async (req, res) => {
    try {
        // Enrich each reservation with the matching rubrica entry, joined on the
        // digit-only phone so "+39 333 1234567" and "3331234567" align. Used by
        // the booking card to render VIP/preferred-table chips without an extra
        // round-trip per row.
        // LATERAL + LIMIT 1 so a rubrica with duplicate phones doesn't multiply
        // the same reservation into N rows. Tie-break: VIP first, then anyone
        // with a preferred_table, then oldest id.
        const result = await queryWithRetry(`
            SELECT r.*, u.full_name AS created_by_user_name,
                   c.is_vip AS customer_is_vip,
                   c.preferred_table_id AS customer_preferred_table_id,
                   pt.name AS customer_preferred_table_name,
                   c.dietary_notes AS customer_dietary_notes,
                   c.preferences_notes AS customer_preferences_notes,
                   lp.id AS latest_payment_id,
                   lp.status AS latest_payment_status,
                   lp.amount_cents AS latest_payment_amount_cents,
                   lp.currency AS latest_payment_currency,
                   lp.provider AS latest_payment_provider,
                   lp.delivery_channel AS latest_payment_delivery_channel,
                   lp.created_at AS latest_payment_created_at,
                   lp.completed_at AS latest_payment_completed_at
            FROM reservations r
            LEFT JOIN users u ON r.created_by_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT cc.is_vip, cc.preferred_table_id, cc.dietary_notes, cc.preferences_notes
                FROM customers cc
                WHERE r.phone IS NOT NULL
                  AND cc.phone IS NOT NULL
                  AND regexp_replace(r.phone, '\\D', '', 'g') = regexp_replace(cc.phone, '\\D', '', 'g')
                ORDER BY cc.is_vip DESC NULLS LAST, (cc.preferred_table_id IS NULL), cc.id ASC
                LIMIT 1
            ) c ON true
            LEFT JOIN tables pt ON pt.id = c.preferred_table_id
            LEFT JOIN LATERAL (
                SELECT pr.id, pr.status, pr.amount_cents, pr.currency, pr.provider,
                       pr.delivery_channel, pr.created_at, pr.completed_at
                FROM payment_requests pr
                WHERE pr.reservation_id = r.id
                ORDER BY pr.created_at DESC
                LIMIT 1
            ) lp ON true
            ORDER BY r.reservation_time DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/reservations', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, duration_minutes, consent_marketing, consent_data_health } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        // GDPR consents (optional). Stamp consent_updated_at whenever the client
        // sent an explicit boolean for either consent — that's the moment of proof.
        const consentMarketing = typeof consent_marketing === 'boolean' ? consent_marketing : null;
        const consentDataHealth = typeof consent_data_health === 'boolean' ? consent_data_health : null;
        const consentUpdatedAt = (consentMarketing !== null || consentDataHealth !== null) ? new Date().toISOString() : null;
        // Explicit table hold; NULL means "use shift default" on lookups.
        const rawDuration = duration_minutes == null || duration_minutes === '' ? null : Number(duration_minutes);
        const durationValue: number | null = Number.isFinite(rawDuration) && rawDuration! > 0 ? Math.min(600, Math.max(15, Math.round(rawDuration!))) : null;
        const effectiveDurationForCheck = durationValue ?? (shift === 'LUNCH' ? 90 : 120);

        // If the client didn't pick a table but the caller is a known rubrica
        // entry with a preferred_table_id, try to honor that preference. The
        // preferred table must (a) exist, (b) seat the party, (c) be in an open
        // room, and (d) be free for the requested date+shift. Any miss leaves
        // table_id untouched — the booking lands unassigned and the floor card
        // will surface the "Tavolo preferito non disponibile" chip.
        let effectiveTableId: number | null = table_id != null ? Number(table_id) : null;
        if (effectiveTableId == null && phone && String(phone).trim() && reservation_time && shift) {
            const phoneDigits = String(phone).replace(/\D/g, '');
            if (phoneDigits) {
                const customerRow = await queryWithRetry(
                    `SELECT c.preferred_table_id, t.seats, t.max_seats
                     FROM customers c
                     LEFT JOIN tables t ON t.id = c.preferred_table_id
                     WHERE c.phone IS NOT NULL
                       AND regexp_replace(c.phone, '\\D', '', 'g') = $1
                     LIMIT 1`,
                    [phoneDigits]
                );
                const row = customerRow.rows[0];
                if (row && row.preferred_table_id) {
                    const capacity = Number(row.max_seats || row.seats || 0);
                    const fitsGuests = !guests || !capacity || Number(guests) <= capacity;
                    if (fitsGuests && !(await isTableInClosedRoom(row.preferred_table_id))) {
                        const eventDate = new Date(reservation_time).toISOString().substring(0, 10);
                        const conflicts = await findTableConflicts(eventDate, shift, [Number(row.preferred_table_id)], {
                            reservationStart: reservation_time,
                            reservationDurationMin: effectiveDurationForCheck,
                        });
                        if (conflicts.length === 0) {
                            effectiveTableId = Number(row.preferred_table_id);
                        }
                    }
                }
            }
        }

        if (await isTableInClosedRoom(effectiveTableId)) {
            return res.status(400).json({ error: 'La sala selezionata è chiusa. Scegli un tavolo in una sala aperta.' });
        }
        if (effectiveTableId != null && reservation_time && shift) {
            const eventDate = new Date(reservation_time).toISOString().substring(0, 10);
            const conflicts = await findTableConflicts(eventDate, shift, [effectiveTableId], {
                reservationStart: reservation_time,
                reservationDurationMin: effectiveDurationForCheck,
            });
            if (conflicts.length > 0) {
                return res.status(409).json({
                    error: buildConflictMessage(conflicts),
                    conflicts,
                });
            }
        }
        const result = await queryWithRetry(
            `WITH ins AS (
                INSERT INTO reservations (customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, duration_minutes, created_by_user_id, consent_marketing, consent_data_health, consent_updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                RETURNING *
            )
            SELECT ins.*, u.full_name AS created_by_user_name,
                   c.is_vip AS customer_is_vip,
                   c.preferred_table_id AS customer_preferred_table_id,
                   pt.name AS customer_preferred_table_name,
                   c.dietary_notes AS customer_dietary_notes,
                   c.preferences_notes AS customer_preferences_notes
            FROM ins
            LEFT JOIN users u ON ins.created_by_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT cc.is_vip, cc.preferred_table_id, cc.dietary_notes, cc.preferences_notes
                FROM customers cc
                WHERE ins.phone IS NOT NULL
                  AND cc.phone IS NOT NULL
                  AND regexp_replace(ins.phone, '\\D', '', 'g') = regexp_replace(cc.phone, '\\D', '', 'g')
                ORDER BY cc.is_vip DESC NULLS LAST, (cc.preferred_table_id IS NULL), cc.id ASC
                LIMIT 1
            ) c ON true
            LEFT JOIN tables pt ON pt.id = c.preferred_table_id`,
            [
                customer_name,
                reservation_time,
                shift,
                guests,
                childrenCount,
                effectiveTableId,
                notes ?? null,
                email ?? null,
                phone ?? null,
                payment_status ?? 'PENDING',
                arrival_status ?? 'WAITING',
                reservation_status ?? 'CONFIRMED',
                durationValue,
                req.user?.userId ?? null,
                consentMarketing,
                consentDataHealth,
                consentUpdatedAt,
            ]
        );
        const newReservation = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.RESERVATION,
                newReservation.id,
                customer_name,
                { guests, reservation_time, shift }
            );
        }

        // Auto-save contact to the customer rubrica if a phone was provided
        // and no matching customer exists. Side-effect — never fails the route.
        await upsertCustomerFromReservation(
            customer_name,
            phone,
            email,
            req.user ? { userId: req.user.userId, email: req.user.email } : null
        );
        // Propagate marketing consent to the (now-existing) customer record.
        await setCustomerMarketingConsent(phone, consentMarketing);

        // Broadcast to all connected clients except the one who created it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationCreated(newReservation, socketId);

        // reservation_time here is the client's naive Rome wall-clock string:
        // no asUtcInstant, the naive branch reads it verbatim (see fix #85).
        const reservationLabel = reservationPushLabel(reservation_time);
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: 'Nuova prenotazione',
                body: `${toTitleCase(customer_name)} · ${guests} ospiti · ${reservationLabel}`,
                url: `/?view=RESERVATIONS&reservationId=${newReservation.id}`,
                tag: `reservation-${newReservation.id}`,
            },
            { excludeUserId: req.user?.userId ?? null }
        ).catch(err => console.error('Push (new reservation) failed:', err));

        res.status(201).json(newReservation);
    } catch (err: any) {
        console.error('POST /reservations error:', err);
        console.error('  body:', JSON.stringify(req.body));
        res.status(500).json({
            error: 'Internal server error',
            detail: err?.message,
            code: err?.code,
            constraint: err?.constraint,
        });
    }
});

app.put('/reservations/:id', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, duration_minutes, consent_marketing, consent_data_health } = req.body;
        // Consents are non-destructive: only touched when the client sends an
        // explicit boolean. Missing → keep the stored value (COALESCE).
        const consentMarketing = typeof consent_marketing === 'boolean' ? consent_marketing : null;
        const consentDataHealth = typeof consent_data_health === 'boolean' ? consent_data_health : null;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        const rawDuration = duration_minutes == null || duration_minutes === '' ? null : Number(duration_minutes);
        const durationValue: number | null = Number.isFinite(rawDuration) && rawDuration! > 0 ? Math.min(600, Math.max(15, Math.round(rawDuration!))) : null;
        const effectiveDurationForCheck = durationValue ?? (shift === 'LUNCH' ? 90 : 120);
        if (await isTableInClosedRoom(table_id)) {
            return res.status(400).json({ error: 'La sala selezionata è chiusa. Scegli un tavolo in una sala aperta.' });
        }
        // Both CANCELLED and DECLINED free the assigned table so it can be
        // reused, and skip the conflict check (the row is no longer live).
        const releasesTable = reservation_status === 'CANCELLED' || reservation_status === 'DECLINED';
        const effectiveTableId = releasesTable ? null : (table_id ?? null);
        if (!releasesTable && table_id != null && reservation_time && shift) {
            const eventDate = new Date(reservation_time).toISOString().substring(0, 10);
            const conflicts = await findTableConflicts(eventDate, shift, [Number(table_id)], {
                excludeReservationId: Number(id),
                reservationStart: reservation_time,
                reservationDurationMin: effectiveDurationForCheck,
            });
            if (conflicts.length > 0) {
                return res.status(409).json({
                    error: buildConflictMessage(conflicts),
                    conflicts,
                });
            }
        }
        // Capture the previous reservation_status in the same statement so we
        // can detect transitions (e.g. → CANCELLED) without an extra round-trip
        // and without a race with concurrent updates.
        const result = await queryWithRetry(
            `WITH old AS (
                SELECT reservation_status AS prev_status FROM reservations WHERE id = $14
            ), upd AS (
                UPDATE reservations
                SET customer_name = $1, reservation_time = $2, shift = $3, guests = $4, children = $5, table_id = $6, notes = $7, email = $8, phone = $9, payment_status = $10, arrival_status = $11, reservation_status = $12, duration_minutes = $13,
                    consent_marketing = COALESCE($15, consent_marketing),
                    consent_data_health = COALESCE($16, consent_data_health),
                    consent_updated_at = CASE WHEN ($15 IS NOT NULL OR $16 IS NOT NULL) THEN CURRENT_TIMESTAMP ELSE consent_updated_at END
                WHERE id = $14
                RETURNING *
            )
            SELECT upd.*, u.full_name AS created_by_user_name, (SELECT prev_status FROM old) AS prev_status,
                   c.is_vip AS customer_is_vip,
                   c.preferred_table_id AS customer_preferred_table_id,
                   pt.name AS customer_preferred_table_name,
                   c.dietary_notes AS customer_dietary_notes,
                   c.preferences_notes AS customer_preferences_notes
            FROM upd
            LEFT JOIN users u ON upd.created_by_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT cc.is_vip, cc.preferred_table_id, cc.dietary_notes, cc.preferences_notes
                FROM customers cc
                WHERE upd.phone IS NOT NULL
                  AND cc.phone IS NOT NULL
                  AND regexp_replace(upd.phone, '\\D', '', 'g') = regexp_replace(cc.phone, '\\D', '', 'g')
                ORDER BY cc.is_vip DESC NULLS LAST, (cc.preferred_table_id IS NULL), cc.id ASC
                LIMIT 1
            ) c ON true
            LEFT JOIN tables pt ON pt.id = c.preferred_table_id`,
            [
                customer_name,
                reservation_time,
                shift,
                guests,
                childrenCount,
                effectiveTableId,
                notes ?? null,
                email ?? null,
                phone ?? null,
                payment_status ?? 'PENDING',
                arrival_status ?? 'WAITING',
                reservation_status ?? 'CONFIRMED',
                durationValue,
                id,
                consentMarketing,
                consentDataHealth,
            ]
        );
        const updatedReservation = result.rows[0];
        const previousStatus: string | null = updatedReservation?.prev_status ?? null;
        if (updatedReservation && 'prev_status' in updatedReservation) {
            delete (updatedReservation as any).prev_status;
        }

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.RESERVATION,
                parseInt(id, 10),
                customer_name,
                { guests, reservation_time, shift, payment_status, arrival_status, reservation_status }
            );
        }

        // Auto-save the contact to the rubrica if a phone was provided and no
        // matching customer exists. If one already exists, sync the name (and
        // email) so the rubrica reflects edits made on the reservation. Both
        // are side-effects — never fail the route.
        const actor = req.user ? { userId: req.user.userId, email: req.user.email } : null;
        await upsertCustomerFromReservation(customer_name, phone, email, actor);
        await syncCustomerFromReservation(customer_name, phone, email, actor);
        // Propagate marketing consent to the customer record (only when provided).
        await setCustomerMarketingConsent(phone, consentMarketing);

        // Broadcast to all connected clients except the one who updated it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationUpdated(updatedReservation, socketId);

        // Notify managers when a booking transitions to CANCELLED (soft cancel).
        // Skip if it was already CANCELLED — avoids duplicate notifications on
        // saves that don't change the status.
        if (previousStatus !== 'CANCELLED' && reservation_status === 'CANCELLED' && updatedReservation) {
            const reservationLabel = reservationPushLabel(asUtcInstant(updatedReservation.reservation_time));
            pushSendToRoles(
                ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
                {
                    category: 'reservation',
                    title: 'Prenotazione annullata',
                    body: `${toTitleCase(updatedReservation.customer_name)} · ${updatedReservation.guests} ospiti · ${reservationLabel}`,
                    url: `/?view=RESERVATIONS&reservationId=${updatedReservation.id}`,
                    tag: `reservation-${updatedReservation.id}`,
                },
                { excludeUserId: req.user?.userId ?? null }
            ).catch(err => console.error('Push (cancellation) failed:', err));
        }

        // Auto-send the customer confirmation on PENDING → CONFIRMED. Public/
        // WhatsApp bookings land as PENDING; flipping them to CONFIRMED in the
        // UI is the signal that the table is reserved and the guest can be
        // told. Channel is SMS while Meta verification is pending, WhatsApp
        // after (see sendBookingConfirmation). Fire and forget — never fail
        // the route.
        if (
            previousStatus === 'PENDING' &&
            reservation_status === 'CONFIRMED' &&
            (updatedReservation?.phone || updatedReservation?.email)
        ) {
            const roomName = await resolveReservationRoomName(updatedReservation);
            if (updatedReservation.phone) {
                sendBookingConfirmation(
                    updatedReservation.phone,
                    buildConfirmationMessage(
                        updatedReservation.customer_name,
                        updatedReservation.reservation_time,
                        updatedReservation.guests,
                        roomName
                    ),
                    updatedReservation.id,
                    {
                        whatsappTemplate: buildBookingConfirmedTemplate(
                            updatedReservation.customer_name,
                            updatedReservation.reservation_time,
                            updatedReservation.guests
                        ),
                    }
                ).catch(err => console.error('Auto-confirmation send failed:', err));
            }
            // Fire the email confirmation in parallel if the guest gave us an
            // email address. Non-blocking; failures are logged in
            // outbound_messages so staff can see them in the timeline.
            if (updatedReservation.email) {
                (async () => {
                    try {
                        if (!(await isSmtpConfigured())) return;
                        const emailStatus = await getSmtpConfigStatus().catch(() => null);
                        const emailProvider: 'smtp' | 'resend' = emailStatus?.provider === 'resend' ? 'resend' : 'smtp';
                        const { subject, text, html } = buildBookingConfirmationEmail({
                            customerName: updatedReservation.customer_name,
                            reservationTime: updatedReservation.reservation_time,
                            guests: updatedReservation.guests,
                            roomName,
                        });
                        try {
                            const sent = await sendMail({ to: String(updatedReservation.email), subject, text, html });
                            await logOutboundEmail({
                                provider: emailProvider,
                                to: String(updatedReservation.email),
                                subject,
                                body: text,
                                messageId: sent.messageId || null,
                                reservationId: updatedReservation.id,
                            });
                        } catch (sendErr: any) {
                            await logOutboundEmail({
                                provider: emailProvider,
                                to: String(updatedReservation.email),
                                subject,
                                body: text,
                                reservationId: updatedReservation.id,
                                errorMessage: sendErr?.message || String(sendErr),
                            });
                            throw sendErr;
                        }
                    } catch (err: any) {
                        console.error('Auto-confirmation email failed:', err?.message || err);
                    }
                })();
            }
        }

        // Auto-send the decline notice on any → DECLINED. The guest is told the
        // request could not be accepted and invited to call for an alternative
        // date/time. Same dispatcher as the confirmation path (SMS while Meta
        // WhatsApp is pending). Fire and forget.
        if (
            previousStatus !== 'DECLINED' &&
            reservation_status === 'DECLINED' &&
            updatedReservation?.phone
        ) {
            sendBookingConfirmation(
                updatedReservation.phone,
                buildDeclineMessage(
                    updatedReservation.customer_name,
                    updatedReservation.reservation_time,
                    updatedReservation.guests
                ),
                updatedReservation.id,
                {
                    whatsappTemplate: buildBookingDeclinedTemplate(
                        updatedReservation.customer_name,
                        updatedReservation.reservation_time,
                        updatedReservation.guests
                    ),
                }
            ).catch(err => console.error('Auto-decline send failed:', err));
        }

        res.json(updatedReservation);
    } catch (err: any) {
        console.error('PUT /reservations/:id error:', err);
        console.error('  body:', JSON.stringify(req.body));
        res.status(500).json({
            error: 'Internal server error',
            detail: err?.message,
            code: err?.code,
            constraint: err?.constraint,
        });
    }
});

app.delete('/reservations/:id', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get reservation name before deleting
        const existing = await queryWithRetry('SELECT customer_name FROM reservations WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.customer_name;

        await queryWithRetry('DELETE FROM reservations WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.RESERVATION,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients except the one who deleted it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationDeleted(Number(id), socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Atomic table swap: two reservations exchange their table assignments in a
// single transaction. The host picks the second reservation from the
// assign-table picker by tapping an occupied tile. Doing it in one TX avoids
// the intermediate state where both bookings briefly point at the same table
// (which the application-level conflict check would reject).
app.post('/reservations/:id/swap-table', authenticate, requirePermission('reservations:full'), async (req, res) => {
    const client = await pool.connect();
    try {
        const aId = Number(req.params.id);
        const bId = Number(req.body?.other_id);
        if (!Number.isFinite(aId) || !Number.isFinite(bId) || aId === bId) {
            return res.status(400).json({ error: 'Identificativi prenotazione non validi' });
        }

        await client.query('BEGIN');

        const rows = await client.query(
            `SELECT id, table_id, customer_name FROM reservations WHERE id = ANY($1::int[]) FOR UPDATE`,
            [[aId, bId]]
        );
        if (rows.rows.length !== 2) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Prenotazione non trovata' });
        }
        const a = rows.rows.find((r: any) => r.id === aId);
        const b = rows.rows.find((r: any) => r.id === bId);
        if (!a?.table_id || !b?.table_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Entrambe le prenotazioni devono avere un tavolo assegnato per essere scambiate' });
        }

        await client.query(
            `UPDATE reservations
                SET table_id = CASE id WHEN $1 THEN $4::int WHEN $2 THEN $3::int END
              WHERE id IN ($1, $2)`,
            [aId, bId, a.table_id, b.table_id]
        );

        const enriched = await client.query(
            `SELECT r.*, u.full_name AS created_by_user_name,
                    c.is_vip AS customer_is_vip,
                    c.preferred_table_id AS customer_preferred_table_id,
                    pt.name AS customer_preferred_table_name,
                    c.dietary_notes AS customer_dietary_notes,
                    c.preferences_notes AS customer_preferences_notes
               FROM reservations r
               LEFT JOIN users u ON r.created_by_user_id = u.id
               LEFT JOIN LATERAL (
                   SELECT cc.is_vip, cc.preferred_table_id, cc.dietary_notes, cc.preferences_notes
                   FROM customers cc
                   WHERE r.phone IS NOT NULL
                     AND cc.phone IS NOT NULL
                     AND regexp_replace(r.phone, '\\D', '', 'g') = regexp_replace(cc.phone, '\\D', '', 'g')
                   ORDER BY cc.is_vip DESC NULLS LAST, (cc.preferred_table_id IS NULL), cc.id ASC
                   LIMIT 1
               ) c ON true
               LEFT JOIN tables pt ON pt.id = c.preferred_table_id
              WHERE r.id = ANY($1::int[])`,
            [[aId, bId]]
        );

        await client.query('COMMIT');

        const updatedA = enriched.rows.find((r: any) => r.id === aId);
        const updatedB = enriched.rows.find((r: any) => r.id === bId);

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.RESERVATION,
                aId,
                a.customer_name,
                { swapped_with: bId, new_table_id: updatedA?.table_id }
            );
        }

        if (socketService) {
            socketService.broadcastReservationUpdated(updatedA);
            socketService.broadcastReservationUpdated(updatedB);
        }

        res.json({ a: updatedA, b: updatedB });
    } catch (err: any) {
        try { await client.query('ROLLBACK'); } catch { /* noop */ }
        console.error('POST /reservations/:id/swap-table error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    } finally {
        client.release();
    }
});

// Send a booking confirmation to the customer. Legacy URL keeps "whatsapp" in
// the path so the frontend keeps working; the channel is decided at runtime
// by sendBookingConfirmation (SMS while Meta verification is pending,
// WhatsApp after).
// Flip a reservation from PENDING to CONFIRMED after a confirmation
// message has been successfully sent to the customer. Idempotent: does
// nothing if the reservation isn't PENDING (already CONFIRMED, or in a
// terminal state like CANCELLED/DECLINED — we never resurrect those).
// Returns true when a status change actually happened, so the caller
// can include it in the response and toast the operator accordingly.
// Returns the promoted row when the flip happened, null otherwise. Callers use
// the row to echo the fresh CONFIRMED state back in the HTTP response so the
// originating client patches its cache immediately — the socket broadcast is
// still fired for other clients but isn't the sole source of truth for the
// caller anymore (mobile Safari on shaky wifi was dropping the event
// occasionally, leaving the card stuck on "Da confermare").
async function promoteReservationIfPending(reservationId: number): Promise<any | null> {
    try {
        const upd = await queryWithRetry(
            `UPDATE reservations
             SET reservation_status = 'CONFIRMED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND reservation_status = 'PENDING'
             RETURNING *`,
            [reservationId]
        );
        if (upd.rows.length === 0) return null;
        // Live views listen on this event to update badges/status pills.
        if (socketService) {
            try { socketService.broadcastReservationUpdated(upd.rows[0]); }
            catch (err) { console.warn('[confirm] broadcast failed:', (err as any)?.message || err); }
        }
        return upd.rows[0];
    } catch (err) {
        console.warn('[confirm] promoteReservationIfPending failed:', (err as any)?.message || err);
        return null;
    }
}

app.post('/reservations/:id/confirm-whatsapp', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;
        // Optional `channel` query/body param: 'sms' forces Twilio SMS, 'whatsapp'
        // forces Twilio WhatsApp, anything else (default) falls back to the
        // auto-pick logic in sendBookingConfirmation.
        const rawChannel = String(req.query.channel ?? req.body?.channel ?? '').toLowerCase();
        const channelChoice: 'sms' | 'whatsapp' | 'auto' =
            rawChannel === 'sms' ? 'sms' :
            rawChannel === 'whatsapp' ? 'whatsapp' :
            'auto';

        const result = await queryWithRetry(
            'SELECT id, customer_name, reservation_time, guests, phone, table_id, notes FROM reservations WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Reservation not found' });
        }

        const reservation = result.rows[0];

        if (!reservation.phone) {
            return res.status(400).json({ error: 'No phone number for this reservation' });
        }

        const roomName = await resolveReservationRoomName(reservation);
        const message = buildConfirmationMessage(
            reservation.customer_name,
            reservation.reservation_time,
            reservation.guests,
            roomName
        );

        let outcome: OutboundConfirmationResult;
        if (channelChoice === 'sms') {
            if (!isTwilioSmsConfigured()) {
                return res.status(400).json({ error: 'SMS non configurato' });
            }
            outcome = await sendTwilioSms(reservation.phone, message, reservation.id);
            recordConfirmationSent(reservation.id, outcome).catch(err =>
                console.warn('[confirmation] recordConfirmationSent failed:', err?.message || err)
            );
        } else if (channelChoice === 'whatsapp') {
            if (!isTwilioWhatsAppConfigured() && !isMetaWhatsAppConfigured()) {
                return res.status(400).json({ error: 'WhatsApp non configurato' });
            }
            // Manual "Invia WhatsApp" from the CRM: freeform sends fail
            // asynchronously with errCode 63016 outside the 24h window, so
            // always attach the approved template (identical to the auto
            // branch below). When the env var is unset the template helper
            // returns undefined and Twilio would reject with 63016 again —
            // but that only happens during a broken rollout.
            const whatsappTemplate = buildBookingConfirmedTemplate(
                reservation.customer_name,
                reservation.reservation_time,
                reservation.guests
            );
            outcome = await sendWhatsAppText(reservation.phone, message, reservation.id, whatsappTemplate);
            recordConfirmationSent(reservation.id, outcome).catch(err =>
                console.warn('[confirmation] recordConfirmationSent failed:', err?.message || err)
            );
        } else {
            outcome = await sendBookingConfirmation(reservation.phone, message, reservation.id, {
                whatsappTemplate: buildBookingConfirmedTemplate(
                    reservation.customer_name,
                    reservation.reservation_time,
                    reservation.guests
                ),
            });
        }

        const label = outcome.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
        console.log(`[${label}] ✅ Confirmation sent for reservation ${id} to ${reservation.phone}`);
        // Flip PENDING → CONFIRMED now that the "your booking is confirmed"
        // message is actually out — the CRM status is only allowed to lag
        // reality, never precede it.
        const promoted = await promoteReservationIfPending(reservation.id);
        res.json({
            success: true,
            message: `Confirmation sent via ${label}`,
            channel: outcome.channel,
            status_changed: !!promoted,
            reservation: promoted || undefined,
        });
    } catch (err: any) {
        console.error('Error sending confirmation:', err);
        res.status(500).json({ error: err?.message || 'Failed to send confirmation' });
    }
});

// Send a booking confirmation via email through the configured SMTP server.
// Records confirmation_status/channel/sent_at on the reservation, mirroring
// the SMS/WhatsApp path — with channel='email' and provider_sid=messageId.
app.post('/reservations/:id/confirm-email', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry(
            'SELECT id, customer_name, reservation_time, guests, phone, email, table_id, notes FROM reservations WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Reservation not found' });
        }
        const reservation = result.rows[0];
        if (!reservation.email) {
            return res.status(400).json({ error: 'Nessuna email per questa prenotazione' });
        }
        if (!(await isSmtpConfigured())) {
            return res.status(400).json({ error: 'SMTP non è configurato. Configura il server email in Impostazioni.' });
        }

        const roomName = await resolveReservationRoomName(reservation);
        const { subject, text, html } = buildBookingConfirmationEmail({
            customerName: reservation.customer_name,
            reservationTime: reservation.reservation_time,
            guests: reservation.guests,
            roomName,
        });

        const emailStatus = await getSmtpConfigStatus().catch(() => null);
        const emailProvider: 'smtp' | 'resend' = emailStatus?.provider === 'resend' ? 'resend' : 'smtp';
        let sent;
        try {
            sent = await sendMail({
                to: String(reservation.email),
                subject,
                text,
                html,
            });
        } catch (sendErr: any) {
            await logOutboundEmail({
                provider: emailProvider,
                to: String(reservation.email),
                subject,
                body: text,
                reservationId: reservation.id,
                errorMessage: sendErr?.message || String(sendErr),
            });
            throw sendErr;
        }

        await logOutboundEmail({
            provider: emailProvider,
            to: String(reservation.email),
            subject,
            body: text,
            messageId: sent.messageId || null,
            reservationId: reservation.id,
        });

        const updated = await queryWithRetry(
            `UPDATE reservations
             SET confirmation_status = 'sent',
                 confirmation_channel = 'email',
                 confirmation_provider_sid = $1,
                 confirmation_sent_at = CURRENT_TIMESTAMP,
                 confirmation_delivered_at = NULL,
                 confirmation_error = NULL
             WHERE id = $2
             RETURNING *`,
            [sent.messageId || null, reservation.id]
        );
        if (updated.rows[0] && socketService) {
            try { socketService.broadcastReservationUpdated(updated.rows[0]); }
            catch (err) { console.warn('[confirmation] email broadcast failed:', err); }
        }

        console.log(`[Email] ✅ Confirmation sent for reservation ${id} to ${reservation.email}`);
        // Same PENDING → CONFIRMED promotion as the SMS/WhatsApp branch: the
        // customer just received a "you're booked" email, so the CRM must
        // stop showing "Da confermare".
        const promoted = await promoteReservationIfPending(reservation.id);
        res.json({
            success: true,
            message: 'Confirmation sent via Email',
            channel: 'email',
            status_changed: !!promoted,
            reservation: promoted || undefined,
        });
    } catch (err: any) {
        console.error('Error sending email confirmation:', err);
        res.status(500).json({ error: err?.message || 'Failed to send email confirmation' });
    }
});

// Free-form email — staff writes subject + body, we wrap in the branded
// template and send to reservation.email. Used for corrections (e.g. an
// automated email announced the wrong time), one-off updates, or any reply
// that doesn't fit the templated flows. Logged into outbound_messages the
// same way as confirmation/decline so it shows up in the customer timeline.
app.post('/reservations/:id/send-custom-email', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
        const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';

        if (subject.length === 0 || subject.length > 200) {
            return res.status(400).json({ error: 'Oggetto non valido (1‑200 caratteri).' });
        }
        if (body.length === 0 || body.length > 5000) {
            return res.status(400).json({ error: 'Corpo email non valido (1‑5000 caratteri).' });
        }

        const result = await queryWithRetry(
            'SELECT id, customer_name, email FROM reservations WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Reservation not found' });
        }
        const reservation = result.rows[0];
        if (!reservation.email) {
            return res.status(400).json({ error: 'Nessuna email per questa prenotazione' });
        }
        if (!(await isSmtpConfigured())) {
            return res.status(400).json({ error: 'SMTP non è configurato. Configura il server email in Impostazioni.' });
        }

        const { subject: finalSubject, text, html } = buildCustomEmail({
            customerName: reservation.customer_name,
            subject,
            body,
        });

        const emailStatus = await getSmtpConfigStatus().catch(() => null);
        const emailProvider: 'smtp' | 'resend' = emailStatus?.provider === 'resend' ? 'resend' : 'smtp';

        let sent;
        try {
            sent = await sendMail({
                to: String(reservation.email),
                subject: finalSubject,
                text,
                html,
            });
        } catch (sendErr: any) {
            await logOutboundEmail({
                provider: emailProvider,
                to: String(reservation.email),
                subject: finalSubject,
                body: text,
                reservationId: reservation.id,
                errorMessage: sendErr?.message || String(sendErr),
            });
            throw sendErr;
        }

        await logOutboundEmail({
            provider: emailProvider,
            to: String(reservation.email),
            subject: finalSubject,
            body: text,
            messageId: sent.messageId || null,
            reservationId: reservation.id,
        });

        console.log(`[Email] ✅ Custom email sent for reservation ${id} to ${reservation.email}`);
        res.json({ success: true, message: 'Custom email sent', channel: 'email' });
    } catch (err: any) {
        console.error('Error sending custom email:', err);
        res.status(500).json({ error: err?.message || 'Failed to send custom email' });
    }
});

// Outbound SMS/WhatsApp/email history for a reservation. Matches messages
// tagged with this reservation_id OR sent to the same phone (last 10 digits)
// OR sent to the same email address, so historical messages sent before we
// started stamping reservation_id still surface for the customer.
app.get('/reservations/:id/messages', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const resRow = await queryWithRetry(
            'SELECT phone, email FROM reservations WHERE id = $1',
            [id]
        );
        if (resRow.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const phone: string | null = resRow.rows[0].phone;
        const email: string | null = resRow.rows[0].email;
        const digits = phone ? String(phone).replace(/\D/g, '') : '';
        const suffix = digits.length >= 8 ? digits.slice(-10) : null;

        const conditions: string[] = ['reservation_id = $1'];
        const params: any[] = [id];
        if (suffix) {
            params.push(suffix);
            conditions.push(`right(to_phone_digits, 10) = $${params.length}`);
        }
        if (email) {
            params.push(email);
            conditions.push(`lower(to_email) = lower($${params.length})`);
        }

        const result = await queryWithRetry(
            `SELECT id, provider, channel, direction, to_phone, to_email, from_email,
                    subject, body, status, provider_sid, message_id, in_reply_to,
                    reservation_id, sent_at, delivered_at, failed_at,
                    error_code, error_message
             FROM outbound_messages
             WHERE ${conditions.join(' OR ')}
             ORDER BY sent_at DESC
             LIMIT 50`,
            params
        );
        res.json({ items: result.rows });
    } catch (err) {
        console.error('GET /reservations/:id/messages error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Read-only view of the pay-at-table bill for a given reservation.
// Returns the bill row (if any) plus the ordered list of splits and the
// running totals the UI would otherwise re-derive. 404 when the
// reservation has no active bill — the caller uses that to render the
// "Apri conto" CTA. Voided/closed bills are not surfaced here (we only
// return the most recent OPEN/LOCKED/SETTLED* one, since a table can be
// reopened and past bills are historical).
app.get('/reservations/:id/bill', authenticate, requirePermission('payments:view'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const billResult = await queryWithRetry(
            `SELECT id, reservation_id, table_id, total_cents, covers, currency,
                    items, status, share_token, opened_at, closed_at,
                    opened_by_user_id, closed_by_user_id, external_ref,
                    cash_settled_cents, tip_cents, notes
             FROM table_bills
             WHERE reservation_id = $1
               AND status IN ('OPEN', 'LOCKED', 'SETTLED', 'SETTLED_PARTIAL')
             ORDER BY opened_at DESC
             LIMIT 1`,
            [id]
        );
        if (billResult.rows.length === 0) {
            return res.status(404).json({ error: 'No active bill for this reservation' });
        }
        const bill = billResult.rows[0];

        const splitsResult = await queryWithRetry(
            `SELECT id, table_bill_id, kind, amount_cents, item_ids,
                    claimant_label, claimed_at, expires_at,
                    payment_request_id, status, paid_at, released_at
             FROM table_bill_splits
             WHERE table_bill_id = $1
             ORDER BY claimed_at ASC`,
            [bill.id]
        );

        // Compute totals server-side so the UI can render without touching
        // the (possibly filtered) splits array.
        const totals = splitsResult.rows.reduce(
            (acc, s) => {
                if (s.status === 'PAID') acc.paid_cents += s.amount_cents;
                if (s.status === 'CLAIMED') acc.claimed_cents += s.amount_cents;
                return acc;
            },
            { paid_cents: 0, claimed_cents: 0 }
        );
        const residual_cents = Math.max(0, bill.total_cents - totals.paid_cents - totals.claimed_cents);

        res.json({
            bill,
            splits: splitsResult.rows,
            paid_cents: totals.paid_cents,
            claimed_cents: totals.claimed_cents,
            residual_cents,
        });
    } catch (err: any) {
        console.error('GET /reservations/:id/bill error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Apre un bill al tavolo. Il cameriere fornisce l'importo totale e il
// numero di coperti (default: guests della prenotazione). Rifiutiamo se
// esiste già un bill attivo sulla stessa prenotazione per evitare due
// QR concorrenti — il cameriere deve prima chiudere o annullare quello
// vecchio. Lo `share_token` è opaco (32 char base64url ≈ 192 bit di
// entropia), va nell'URL pubblico che stampiamo sul QR.
app.post('/reservations/:id/bill', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(403).json({
                error: 'feature_disabled',
                message: 'Il conto al tavolo è disattivato. Attivalo da Impostazioni → Conto al tavolo.',
            });
        }

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid reservation id' });

        const totalCents = Number(req.body?.total_cents);
        if (!Number.isFinite(totalCents) || totalCents <= 0) {
            return res.status(400).json({ error: 'total_cents must be a positive integer' });
        }
        const totalRounded = Math.round(totalCents);

        const resRow = await queryWithRetry(
            'SELECT id, guests, table_id FROM reservations WHERE id = $1',
            [id]
        );
        if (resRow.rows.length === 0) return res.status(404).json({ error: 'Reservation not found' });

        // covers: usa quello passato dal cameriere se valido, altrimenti
        // fallback ai guests della prenotazione. Serve al pubblico per
        // proporre lo split equo di default.
        const requestedCovers = req.body?.covers != null ? Number(req.body.covers) : NaN;
        const fallbackCovers = Number(resRow.rows[0].guests);
        const covers = Number.isFinite(requestedCovers) && requestedCovers > 0
            ? Math.round(requestedCovers)
            : (Number.isFinite(fallbackCovers) && fallbackCovers > 0 ? fallbackCovers : 1);

        // Un bill "attivo" (OPEN/LOCKED/SETTLED*) blocca l'apertura di uno
        // nuovo per evitare che il pubblico veda due QR/URL diversi.
        const existing = await queryWithRetry(
            `SELECT id, status FROM table_bills
             WHERE reservation_id = $1
               AND status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL')
             LIMIT 1`,
            [id]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({
                error: 'Reservation already has an active bill',
                existing_bill_id: existing.rows[0].id,
                existing_bill_status: existing.rows[0].status,
            });
        }

        const shareToken = crypto.randomBytes(24).toString('base64url');

        const inserted = await queryWithRetry(
            `INSERT INTO table_bills
                (reservation_id, table_id, total_cents, covers, share_token, opened_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, reservation_id, table_id, total_cents, covers, currency,
                       items, status, share_token, opened_at, closed_at,
                       opened_by_user_id, closed_by_user_id, external_ref,
                       cash_settled_cents, tip_cents, notes`,
            [id, resRow.rows[0].table_id, totalRounded, covers, shareToken, req.user?.userId ?? null]
        );
        const bill = inserted.rows[0];

        try { socketService?.broadcastToAll('bill:opened', bill); } catch (_) {}

        res.status(201).json({
            bill,
            splits: [],
            paid_cents: 0,
            claimed_cents: 0,
            residual_cents: bill.total_cents,
        });
    } catch (err: any) {
        console.error('POST /reservations/:id/bill error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Notifica al cliente il link del conto al tavolo. Idempotente rispetto
// al bill (non ne crea di nuovi), ma NON idempotente sul canale: ogni
// chiamata invia un nuovo messaggio, così il cameriere può "reinviare"
// se il primo tentativo si è perso. La consegna è sincrona qui — a
// differenza di /payments/requests — perché la UI mostra un toast
// esplicito con il canale usato.
app.post('/reservations/:id/bill/notify', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(403).json({
                error: 'feature_disabled',
                message: 'Il conto al tavolo è disattivato. Attivalo da Impostazioni → Conto al tavolo.',
            });
        }

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid reservation id' });

        const resvRow = await queryWithRetry(
            'SELECT id, customer_name, phone FROM reservations WHERE id = $1',
            [id]
        );
        if (resvRow.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });
        const reservation = resvRow.rows[0];
        if (!reservation.phone) {
            return res.status(400).json({ error: 'La prenotazione non ha un numero di telefono' });
        }

        const billRow = await queryWithRetry(
            `SELECT id, total_cents, covers, share_token, status
             FROM table_bills
             WHERE reservation_id = $1
               AND status IN ('OPEN','LOCKED')
             ORDER BY opened_at DESC
             LIMIT 1`,
            [id]
        );
        if (billRow.rowCount === 0) {
            return res.status(404).json({ error: 'Nessun conto aperto per questa prenotazione' });
        }
        const bill = billRow.rows[0];
        if (!bill.share_token) {
            return res.status(409).json({ error: 'Il conto non ha un link pubblico attivo' });
        }

        const publicUrl = `${payAtTableBaseUrl()}/pay/${bill.share_token}`;
        const message = buildTableBillLinkMessage(
            reservation.customer_name,
            Number(bill.total_cents),
            Number(bill.covers) || 1,
            publicUrl
        );

        try {
            const delivery = await sendBookingConfirmation(reservation.phone, message, reservation.id, {
                whatsappTemplate: buildTableBillLinkTemplate(
                    reservation.customer_name,
                    Number(bill.covers) || 1,
                    Number(bill.total_cents),
                    bill.share_token
                ),
            });
            if (req.user) {
                LogService.logActivity(
                    req.user.userId,
                    req.user.email,
                    req.user.email,
                    ActivityAction.CREATE,
                    ResourceType.RESERVATION,
                    reservation.id,
                    `${reservation.customer_name} — inviato link conto al tavolo (${delivery.channel})`
                );
            }
            res.json({
                ok: true,
                bill_id: bill.id,
                channel: delivery.channel,
                provider_sid: delivery.sid || null,
                public_url: publicUrl,
            });
        } catch (err: any) {
            console.error('[bill:notify] delivery failed:', err?.message || err);
            res.status(502).json({
                error: 'delivery_failed',
                message: err?.message || 'Invio del messaggio non riuscito',
            });
        }
    } catch (err: any) {
        console.error('POST /reservations/:id/bill/notify error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Chiude un bill (tipicamente perché è stato saldato al 100%, o perché
// il cameriere forza la chiusura registrando l'incasso mancante come
// contante/POS al tavolo). `cash_settled_cents` e `tip_cents` sono
// opzionali: servono al breakdown per la contabilità (in Fase 2 saranno
// il payload della POST /chiudi-conto verso Passepartout). Il token
// pubblico viene invalidato subito (SET NULL) così un QR fotografato
// prima non funziona più.
app.post('/bills/:id/close', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid bill id' });

        const cashRaw = req.body?.cash_settled_cents;
        const tipRaw = req.body?.tip_cents;
        const cashCents = cashRaw != null ? Number(cashRaw) : 0;
        const tipCents = tipRaw != null ? Number(tipRaw) : 0;
        if (!Number.isFinite(cashCents) || cashCents < 0) {
            return res.status(400).json({ error: 'cash_settled_cents must be >= 0' });
        }
        if (!Number.isFinite(tipCents) || tipCents < 0) {
            return res.status(400).json({ error: 'tip_cents must be >= 0' });
        }
        const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : null;

        // Need the current total + sum of PAID splits to decide between
        // CLOSED and SETTLED_PARTIAL and to sanity-check the caller's
        // cash/tip values. Fetch under a lock so a webhook-triggered
        // PAID→SETTLED promotion can't race us and flip status underneath.
        const client = await pool.connect();
        let updatedRow: any = null;
        try {
            await client.query('BEGIN');
            const billRs = await client.query(
                `SELECT id, total_cents, status FROM table_bills WHERE id = $1 FOR UPDATE`,
                [id]
            );
            if (billRs.rowCount === 0 || !['OPEN','LOCKED','SETTLED','SETTLED_PARTIAL'].includes(billRs.rows[0].status)) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Bill not found or already closed/voided' });
            }
            const totalCents: number = billRs.rows[0].total_cents;

            // Sanity caps: a tip above the bill total or a cash-settled
            // above 2x is almost certainly a typo. 2x on cash covers the
            // waiter who accidentally records the tip inside cash — still
            // wrong, but not a data-loss-level typo.
            if (tipCents > totalCents) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'tip_cents exceeds total (max 100%)', max_allowed_cents: totalCents });
            }
            if (cashCents > totalCents * 2) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'cash_settled_cents implausible (>200% of total)', max_allowed_cents: totalCents * 2 });
            }

            const paidRs = await client.query(
                `SELECT COALESCE(SUM(amount_cents), 0)::int AS paid_cents
                 FROM table_bill_splits
                 WHERE table_bill_id = $1 AND status = 'PAID'`,
                [id]
            );
            const paidViaSplits: number = paidRs.rows[0].paid_cents;
            const totalSettled = paidViaSplits + Math.round(cashCents);
            const finalStatus = totalSettled >= totalCents ? 'CLOSED' : 'SETTLED_PARTIAL';

            // Stamp an audit prefix on notes when closing with a shortfall
            // so the accounting readout has a machine-parseable delta. The
            // waiter-supplied `notes` still wins if provided; otherwise the
            // existing DB notes stay put.
            let notesForDb: string | null = notes;
            if (finalStatus === 'SETTLED_PARTIAL') {
                const delta = totalCents - totalSettled;
                const shortfallTag = `[shortfall:${delta}]`;
                notesForDb = notes ? `${shortfallTag} ${notes}` : shortfallTag;
            }

            const upd = await client.query(
                `UPDATE table_bills
                 SET status = $2,
                     closed_at = CURRENT_TIMESTAMP,
                     closed_by_user_id = $3,
                     cash_settled_cents = $4,
                     tip_cents = $5,
                     notes = COALESCE($6, notes),
                     share_token = NULL
                 WHERE id = $1
                 RETURNING id, reservation_id, table_id, total_cents, covers, currency,
                           items, status, share_token, opened_at, closed_at,
                           opened_by_user_id, closed_by_user_id, external_ref,
                           cash_settled_cents, tip_cents, notes`,
                [id, finalStatus, req.user?.userId ?? null, Math.round(cashCents), Math.round(tipCents), notesForDb]
            );
            updatedRow = upd.rows[0];
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK').catch(() => {});
            throw txErr;
        } finally {
            client.release();
        }

        try { socketService?.broadcastToAll('bill:closed', updatedRow); } catch (_) {}

        res.json(updatedRow);
    } catch (err: any) {
        console.error('POST /bills/:id/close error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Annulla un bill (errore di battitura del cameriere, tavolo che se n'è
// andato prima di ricevere il QR, ecc.). I claim/PAID splits restano in
// tabella per audit; il token pubblico è invalidato immediatamente.
// Non fa refund automatico degli split PAID — se ne è già stato saldato
// qualcuno, il cameriere deve rimborsare a mano (Fase 5 aggiungerà
// endpoint refund dedicato).
app.post('/bills/:id/void', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid bill id' });

        const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : null;

        const updated = await queryWithRetry(
            `UPDATE table_bills
             SET status = 'VOIDED',
                 closed_at = CURRENT_TIMESTAMP,
                 closed_by_user_id = $2,
                 notes = COALESCE($3, notes),
                 share_token = NULL
             WHERE id = $1
               AND status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL')
             RETURNING id, reservation_id, table_id, total_cents, covers, currency,
                       items, status, share_token, opened_at, closed_at,
                       opened_by_user_id, closed_by_user_id, external_ref,
                       cash_settled_cents, tip_cents, notes`,
            [id, req.user?.userId ?? null, notes]
        );
        if (updated.rows.length === 0) {
            return res.status(404).json({ error: 'Bill not found or already closed/voided' });
        }

        try { socketService?.broadcastToAll('bill:voided', updated.rows[0]); } catch (_) {}

        res.json(updated.rows[0]);
    } catch (err: any) {
        console.error('POST /bills/:id/void error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// PR 6 — rimborso di una quota. Copre due casi:
//   a) split PAID normale: refund sul gateway, split → REFUNDED, e se il
//      conto era SETTLED riapre (OPEN) per l'importo rimborsato;
//   b) overpayment (split ABANDONED ma pagamento COMPLETED, il caso del
//      checkout completato dopo la scadenza del claim): refund sul gateway
//      e marcatura REFUNDED, il conto non si tocca perché la quota non
//      contribuiva al saldo.
// Il refund parte PRIMA della scrittura DB: se il gateway fallisce non
// cambiamo nulla; se la scrittura fallisse dopo, i log del gateway restano
// la fonte di verità e un retry dell'endpoint è idempotente lato nostro
// (lo split non è più in stato rimborsabile).
app.post('/bills/splits/:id/refund', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        const splitId = parseInt(req.params.id, 10);
        if (!Number.isFinite(splitId)) return res.status(400).json({ error: 'Invalid split id' });

        const rs = await queryWithRetry(
            `SELECT s.id, s.status AS split_status, s.amount_cents, s.claimant_label, s.table_bill_id,
                    b.status AS bill_status, b.reservation_id, b.total_cents, b.currency,
                    pr.id AS payment_request_id, pr.status AS pr_status, pr.provider,
                    pr.provider_order_id, pr.metadata AS pr_metadata
             FROM table_bill_splits s
             JOIN table_bills b ON b.id = s.table_bill_id
             LEFT JOIN payment_requests pr ON pr.id = s.payment_request_id
             WHERE s.id = $1`,
            [splitId]
        );
        if (rs.rowCount === 0) return res.status(404).json({ error: 'Quota non trovata' });
        const row = rs.rows[0];

        const prPaid = ['COMPLETED', 'PAID'].includes(String(row.pr_status || '').toUpperCase());
        const refundablePaid = row.split_status === 'PAID';
        const refundableOverpaid = row.split_status === 'ABANDONED' && prPaid;
        if (!refundablePaid && !refundableOverpaid) {
            return res.status(409).json({ error: `La quota non è rimborsabile (stato ${row.split_status})` });
        }
        if (!isPaymentProvider(row.provider) || !row.provider_order_id) {
            return res.status(409).json({ error: 'Nessun ordine di pagamento collegato alla quota' });
        }

        // Refund through the provider that took the money, not the one that
        // happens to be active now.
        await refundPaymentOrder(
            row.provider,
            row.provider_order_id,
            row.amount_cents,
            row.currency || 'EUR',
            `Rimborso quota${row.claimant_label ? ' ' + row.claimant_label : ''} - conto #${row.table_bill_id}`,
            row.pr_metadata?.sumup_transaction_id ?? null
        );

        const updSplit = await queryWithRetry(
            `UPDATE table_bill_splits
             SET status = 'REFUNDED', released_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, table_bill_id, amount_cents`,
            [splitId]
        );
        let updatedPr: any = null;
        if (row.payment_request_id) {
            const prUpd = await queryWithRetry(
                `UPDATE payment_requests
                 SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [row.payment_request_id]
            );
            updatedPr = prUpd.rows[0] || null;
            if (updatedPr?.reservation_id) broadcastReservationsUpdatedByIds([updatedPr.reservation_id]).catch(() => {});
        }

        // Il conto torna incassabile per la parte rimborsata solo se la
        // quota contava nel saldo (caso a) e il conto era SETTLED.
        let reopened = false;
        if (refundablePaid && row.bill_status === 'SETTLED') {
            const billUpd = await queryWithRetry(
                `UPDATE table_bills SET status = 'OPEN', closed_at = NULL
                 WHERE id = $1 AND status = 'SETTLED'
                 RETURNING *`,
                [row.table_bill_id]
            );
            reopened = (billUpd.rowCount ?? 0) > 0;
            if (reopened && socketService) {
                try { socketService.broadcastToAll('bill:opened', billUpd.rows[0]); } catch (_) {}
            }
        }

        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) {
            try {
                socketService.broadcastToAll('bill:split-refunded', {
                    bill_id: row.table_bill_id, split_id: splitId, amount_cents: row.amount_cents,
                }, socketId);
                if (updatedPr) socketService.broadcastToAll('paymentRequest:updated', updatedPr);
            } catch (_) {}
        }

        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.UPDATE, ResourceType.RESERVATION,
                row.reservation_id,
                `Rimborsata quota ${formatEuroMinor(row.amount_cents)}${row.claimant_label ? ' di ' + row.claimant_label : ''} (conto #${row.table_bill_id}${reopened ? ', conto riaperto' : ''})`
            );
        }

        res.json({ ok: true, split_id: splitId, bill_id: row.table_bill_id, reopened });
    } catch (err: any) {
        console.error('POST /bills/splits/:id/refund error:', err);
        res.status(502).json({ error: 'Rimborso non riuscito', detail: err?.message });
    }
});


// ============================================
// PUBLIC PAY-AT-TABLE (no auth, share_token gated)
// ============================================
// The endpoints below back the /pay/:token mobile page guests hit after
// scanning the QR. No login: the opaque `share_token` (~192 bit entropy,
// nulled on close/void) is the only credential. We rate-limit per IP to
// discourage token-brute-forcing and to shield Revolut from claim
// storms; the token itself is unguessable so the limit is generous.

const publicPayLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Troppe richieste, riprova tra qualche secondo.' },
});

// Second, tighter limit specifically for the claim endpoint keyed by
// share_token: an attacker who knows one token can't lock every split by
// spamming CLAIMED+release cycles (each claim briefly holds capacity for
// the 5-min TTL). Applied *in addition* to publicPayLimiter — the IP
// limit stays as a broader shield against token-enumeration.
const publicPayClaimLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `token:${req.params.token || 'unknown'}`,
    message: { error: 'rate_limited', message: 'Troppe richieste per questo conto, riprova tra qualche secondo.' },
});

// Sanitizes a split for public consumption: hides ids that could enable
// tampering, keeps only what the UI needs to render "someone claimed X€".
const publicSplitView = (s: any) => ({
    kind: s.kind,
    amount_cents: s.amount_cents,
    claimant_label: s.claimant_label,
    status: s.status,
});

// Helper: fetches a bill by share_token limited to active states. Returns
// null if not found / not active — callers respond with 404 in both cases
// so we don't leak whether the token ever existed.
async function loadBillByToken(token: string) {
    const rs = await queryWithRetry(
        `SELECT id, reservation_id, table_id, total_cents, covers, currency,
                items, status, share_token, opened_at, closed_at,
                opened_by_user_id, closed_by_user_id, external_ref,
                cash_settled_cents, tip_cents, notes
         FROM table_bills
         WHERE share_token = $1
           AND status IN ('OPEN','LOCKED')
         LIMIT 1`,
        [token]
    );
    return rs.rows[0] || null;
}

// GET /pay/:token — the mobile page fetches this on load and after any
// action. Response mirrors the authenticated GET, minus internal ids on
// the splits.
app.get('/pay/:token', publicPayLimiter, async (req, res) => {
    try {
        const token = String(req.params.token || '');
        if (!token || token.length < 20) return res.status(404).json({ error: 'Not found' });

        // When the operator disables the feature mid-service, guests scanning
        // a still-valid QR get a 404 like any expired token — the waiter
        // handles the payment through the normal channel.
        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(404).json({ error: 'Not found' });
        }

        const bill = await loadBillByToken(token);
        if (!bill) return res.status(404).json({ error: 'Not found' });

        const splitsRows = await queryWithRetry(
            `SELECT kind, amount_cents, claimant_label, status
             FROM table_bill_splits
             WHERE table_bill_id = $1
             ORDER BY claimed_at ASC`,
            [bill.id]
        );
        const paidCents = splitsRows.rows
            .filter((r: any) => r.status === 'PAID')
            .reduce((sum: number, r: any) => sum + Number(r.amount_cents || 0), 0);
        const claimedCents = splitsRows.rows
            .filter((r: any) => r.status === 'CLAIMED' || r.status === 'PAID')
            .reduce((sum: number, r: any) => sum + Number(r.amount_cents || 0), 0);
        const residual = Math.max(0, bill.total_cents - claimedCents);

        // Righe del conto e quali sono già prese: sbloccano lo split per
        // piatto, che è il modo in cui la gente divide davvero il conto
        // ("io ho preso solo l'antipasto"). Disponibile solo quando il
        // dettaglio esiste (comanda dal gestionale) e la somma delle righe
        // coincide col totale: con uno sconto in mezzo, pagare "la propria
        // riga" addebiterebbe più del dovuto.
        const claimedItemRows = await queryWithRetry(
            `SELECT item_ids FROM table_bill_splits
             WHERE table_bill_id = $1 AND status IN ('CLAIMED','PAID') AND item_ids IS NOT NULL`,
            [bill.id]
        );
        const takenItemIds = new Set<number>();
        for (const r of claimedItemRows.rows) {
            for (const id of (Array.isArray(r.item_ids) ? r.item_ids : [])) takenItemIds.add(Number(id));
        }
        const billItems: any[] = Array.isArray(bill.items) ? bill.items : [];
        const itemsSum = billItems.reduce(
            (n: number, i: any) => n + Number(i.unit_price_cents || 0) * Number(i.qty || 0), 0
        );
        const perItemAvailable = billItems.length > 0 && itemsSum === bill.total_cents;

        res.json({
            bill: {
                total_cents: bill.total_cents,
                covers: bill.covers,
                currency: bill.currency,
                status: bill.status,
            },
            splits: splitsRows.rows.map(publicSplitView),
            paid_cents: paidCents,
            claimed_cents: claimedCents,
            residual_cents: residual,
            per_item_available: perItemAvailable,
            items: perItemAvailable
                ? billItems.map((i: any) => ({
                    id: Number(i.order_item_id),
                    name: i.name,
                    qty: Number(i.qty),
                    total_cents: Number(i.unit_price_cents) * Number(i.qty),
                    taken: takenItemIds.has(Number(i.order_item_id)),
                }))
                : [],
        });
    } catch (err: any) {
        console.error('GET /pay/:token error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /pay/:token/qr.png — publicly-fetchable PNG of the pay page URL,
// used as the header media in the WhatsApp template so guests see the
// QR inline in the chat. Deliberately does NOT load the bill: the QR
// only encodes the same URL that was already in the request path (no
// data leak), and Meta's template approval / cache warm-up hits this
// endpoint with the sample token, which won't correspond to any real
// bill. Gated on the feature flag and on a minimum token shape.
app.get('/pay/:token/qr.png', publicPayLimiter, async (req, res) => {
    try {
        const token = String(req.params.token || '');
        if (!token || token.length < 20 || !/^[A-Za-z0-9_-]+$/.test(token)) {
            return res.status(404).send('Not found');
        }
        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(404).send('Not found');
        }
        const publicUrl = `${payAtTableBaseUrl()}/pay/${token}`;
        const png = await QRCode.toBuffer(publicUrl, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 512,
        });
        res.setHeader('Content-Type', 'image/png');
        // Long cache: the PNG is a pure function of the token, so it
        // never changes; freshness only matters when a bill is voided,
        // and in that case Meta has already delivered the message.
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.send(png);
    } catch (err: any) {
        console.error('GET /pay/:token/qr.png error:', err);
        res.status(500).send('Internal server error');
    }
});

// POST /pay/:token/claim — reserves a split and creates a Revolut order.
// Body: { kind: 'equal_share'|'fixed_amount', amount_cents?: number,
//         claimant_label?: string }
//   - equal_share → amount = ceil(total/covers) (per invariance we round
//     up so the last claimant doesn't get stuck with a fractional euro;
//     residual is still enforced by the trigger)
//   - fixed_amount → uses the supplied amount_cents
// Concurrency: SELECT ... FOR UPDATE on the bill row serializes concurrent
// claims (two guests scanning at the same instant). The trigger from PR 1
// is the ultimate authority — if it fires we surface a 409 with the
// current max_allowed.
app.post('/pay/:token/claim', publicPayLimiter, publicPayClaimLimiter, async (req, res) => {
    const client = await pool.connect();
    try {
        const token = String(req.params.token || '');
        if (!token || token.length < 20) return res.status(404).json({ error: 'Not found' });

        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(404).json({ error: 'Not found' });
        }

        const kind = String(req.body?.kind || '');
        if (kind !== 'equal_share' && kind !== 'fixed_amount' && kind !== 'per_item') {
            return res.status(400).json({ error: 'kind must be equal_share, fixed_amount or per_item' });
        }
        const rawLabel = typeof req.body?.claimant_label === 'string' ? req.body.claimant_label.trim().slice(0, 40) : '';
        const claimantLabel = rawLabel || null;

        await client.query('BEGIN');

        // Lock the bill row so a parallel claim can't oversubscribe.
        // t.name is the REAL table number shown in the room (e.g. "23"), not
        // the internal id — it feeds the payment descriptions below.
        const billRs = await client.query(
            `SELECT b.id, b.total_cents, b.covers, b.status, b.reservation_id, b.items,
                    t.name AS table_name
             FROM table_bills b
             LEFT JOIN tables t ON t.id = b.table_id
             WHERE b.share_token = $1
               AND b.status IN ('OPEN','LOCKED')
             FOR UPDATE OF b`,
            [token]
        );
        if (billRs.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }
        const bill = billRs.rows[0];
        const billLabel = bill.table_name ? `tavolo ${bill.table_name}` : `conto #${bill.id}`;

        // Compute claimed_cents under the lock so the residual is
        // authoritative at insert time.
        const sumRs = await client.query(
            `SELECT COALESCE(SUM(amount_cents), 0)::int AS claimed_cents
             FROM table_bill_splits
             WHERE table_bill_id = $1 AND status IN ('CLAIMED','PAID')`,
            [bill.id]
        );
        const claimed = Number(sumRs.rows[0].claimed_cents || 0);
        const residual = bill.total_cents - claimed;
        if (residual <= 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Bill already fully claimed', max_allowed_cents: 0 });
        }

        let amount: number;
        let claimedItemIds: number[] | null = null;
        if (kind === 'per_item') {
            const requested = Array.isArray(req.body?.item_ids)
                ? req.body.item_ids.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
                : [];
            if (requested.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'item_ids must be a non-empty array' });
            }
            const billItems: any[] = Array.isArray(bill.items) ? bill.items : [];
            const itemsSum = billItems.reduce(
                (n: number, i: any) => n + Number(i.unit_price_cents || 0) * Number(i.qty || 0), 0
            );
            // Con uno sconto sul conto la somma delle righe non torna: pagare
            // "la propria riga" addebiterebbe più del dovuto, quindi lo split
            // per piatto non è disponibile.
            if (billItems.length === 0 || itemsSum !== bill.total_cents) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Per-item split not available for this bill' });
            }

            // Righe già impegnate da altri: due ospiti non possono pagare lo
            // stesso piatto.
            const takenRs = await client.query(
                `SELECT item_ids FROM table_bill_splits
                 WHERE table_bill_id = $1 AND status IN ('CLAIMED','PAID') AND item_ids IS NOT NULL`,
                [bill.id]
            );
            const taken = new Set<number>();
            for (const r of takenRs.rows) {
                for (const id of (Array.isArray(r.item_ids) ? r.item_ids : [])) taken.add(Number(id));
            }
            const conflict = requested.filter((id: number) => taken.has(id));
            if (conflict.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Some items are already claimed', conflicting_item_ids: conflict });
            }

            const byId = new Map(billItems.map((i: any) => [Number(i.order_item_id), i]));
            let sum = 0;
            for (const id of requested) {
                const it = byId.get(id);
                if (!it) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Unknown item', item_id: id });
                }
                sum += Number(it.unit_price_cents) * Number(it.qty);
            }
            if (sum <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Selected items total zero' });
            }
            if (sum > residual) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Amount exceeds residual', max_allowed_cents: residual });
            }
            amount = sum;
            claimedItemIds = requested;
        } else if (kind === 'equal_share') {
            const covers = Math.max(1, Number(bill.covers) || 1);
            amount = Math.min(residual, Math.ceil(bill.total_cents / covers));
        } else {
            const raw = Number(req.body?.amount_cents);
            if (!Number.isFinite(raw) || raw <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'amount_cents must be a positive integer' });
            }
            amount = Math.round(raw);
            if (amount > residual) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Amount exceeds residual', max_allowed_cents: residual });
            }
        }

        // 5-minute TTL on the reservation. Reconcile job (PR 4) will flip
        // stale CLAIMED rows to ABANDONED so their capacity is released.
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        let splitId: number;
        try {
            const ins = await client.query(
                `INSERT INTO table_bill_splits
                    (table_bill_id, kind, amount_cents, claimant_label, expires_at, status, item_ids)
                 VALUES ($1, $2, $3, $4, $5, 'CLAIMED', $6::jsonb)
                 RETURNING id`,
                [bill.id, kind, amount, claimantLabel, expiresAt.toISOString(),
                 claimedItemIds ? JSON.stringify(claimedItemIds) : null]
            );
            splitId = ins.rows[0].id;
        } catch (err: any) {
            // Trigger enforces sum ≤ total: if a parallel writer slipped
            // between our SELECT and INSERT (shouldn't happen given the
            // FOR UPDATE but the trigger is our belt-and-braces), surface
            // a friendly 409.
            await client.query('ROLLBACK');
            if (err?.code === '23514') {
                return res.status(409).json({ error: 'Bill capacity changed, retry', detail: err?.message });
            }
            throw err;
        }

        await client.query('COMMIT');

        // Create the gateway order AFTER commit — if the API call fails
        // the split stays CLAIMED and the reconcile job will abandon it
        // once expires_at passes, freeing the capacity.
        let checkoutUrl: string | null = null;
        let paymentRequestId: number | null = null;
        try {
            if (!(await isPaymentConfigured())) {
                throw new Error(`${providerLabel(await getActivePaymentProvider())} not configured`);
            }
            const order = await createPaymentOrder({
                amount,
                currency: 'EUR',
                description: `Conto ${billLabel} - quota${claimantLabel ? ' ' + claimantLabel : ''}`,
                reference: `bill_split:${splitId}`,
                // Back to the bill page after checkout (whatever method the
                // guest picked), so they see the progress bar advance
                // instead of landing on the provider default.
                redirectUrl: `${payAtTableBaseUrl()}/pay/${token}`,
            });
            checkoutUrl = order.checkoutUrl;

            const prIns = await queryWithRetry(
                `INSERT INTO payment_requests
                    (reservation_id, amount_cents, currency, description, status, provider,
                     provider_order_id, checkout_url, table_bill_split_id, metadata)
                 VALUES ($1, $2, 'EUR', $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    bill.reservation_id || null,
                    amount,
                    `Conto ${billLabel}`,
                    order.status,
                    order.provider,
                    order.id,
                    order.checkoutUrl,
                    splitId,
                    JSON.stringify({ ...order.metadata, bill_split_id: splitId }),
                ]
            );
            paymentRequestId = prIns.rows[0].id;

            await queryWithRetry(
                `UPDATE table_bill_splits SET payment_request_id = $1 WHERE id = $2`,
                [paymentRequestId, splitId]
            );
        } catch (err: any) {
            console.error('[pay] payment order creation failed for split', splitId, err?.message || err);
            // Non-fatal for the API response: the client gets the split
            // but no checkout_url — the UI can offer "riprova" via a new
            // claim after release.
        }

        try {
            socketService?.broadcastToAll('bill:split-claimed', {
                bill_id: bill.id,
                split_id: splitId,
                kind,
                amount_cents: amount,
                claimant_label: claimantLabel,
            });
        } catch (_) {}

        res.status(201).json({
            split_id: splitId,
            amount_cents: amount,
            claimant_label: claimantLabel,
            expires_at: expiresAt.toISOString(),
            checkout_url: checkoutUrl,
            payment_request_id: paymentRequestId,
        });
    } catch (err: any) {
        try { await client.query('ROLLBACK'); } catch { /* noop */ }
        console.error('POST /pay/:token/claim error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    } finally {
        client.release();
    }
});

// POST /pay/:token/release — voluntarily gives up an unpaid claim. Both
// the split_id and the token must match — this prevents someone with the
// token from cancelling a split they didn't create (still not
// authenticated, but at least you need to know the id you're releasing).
app.post('/pay/:token/release', publicPayLimiter, async (req, res) => {
    try {
        const token = String(req.params.token || '');
        if (!token || token.length < 20) return res.status(404).json({ error: 'Not found' });

        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(404).json({ error: 'Not found' });
        }

        const splitId = Number(req.body?.split_id);
        if (!Number.isFinite(splitId) || splitId <= 0) {
            return res.status(400).json({ error: 'split_id required' });
        }

        const bill = await loadBillByToken(token);
        if (!bill) return res.status(404).json({ error: 'Not found' });

        const upd = await queryWithRetry(
            `UPDATE table_bill_splits
             SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP
             WHERE id = $1
               AND table_bill_id = $2
               AND status = 'CLAIMED'
             RETURNING id`,
            [splitId, bill.id]
        );
        if (upd.rowCount === 0) {
            return res.status(409).json({ error: 'Split not found or not releasable' });
        }

        try {
            socketService?.broadcastToAll('bill:split-released', {
                bill_id: bill.id,
                split_id: splitId,
            });
        } catch (_) {}

        res.json({ released: true, split_id: splitId });
    } catch (err: any) {
        console.error('POST /pay/:token/release error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ============================================
// INBOX (SMS / WhatsApp conversations)
// ============================================
// Conversations are grouped by the last 10 digits of the customer phone so
// that +39 / 39 / 0 prefix variants collapse into a single thread. We union
// outbound.to_phone_digits with inbound.from_phone_digits, pick the most
// recent message per group, and left-join reservations to surface the most
// recent customer_name for that number.

app.get('/messages/conversations', authenticate, requirePermission('reservations:view'), async (_req, res) => {
    try {
        const result = await queryWithRetry(`
            WITH pairs AS (
                SELECT id, provider, channel, direction, body, sent_at, read_at,
                       reservation_id,
                       COALESCE(from_phone_digits, to_phone_digits) AS digits,
                       COALESCE(from_phone, to_phone) AS phone
                FROM outbound_messages
                WHERE channel IN ('sms','whatsapp')
                  AND COALESCE(from_phone_digits, to_phone_digits) IS NOT NULL
            ),
            keyed AS (
                SELECT *, right(digits, 10) AS phone_key
                FROM pairs
                WHERE length(digits) >= 8
            ),
            latest AS (
                SELECT DISTINCT ON (phone_key)
                    phone_key, phone, channel, direction, body, sent_at, reservation_id
                FROM keyed
                ORDER BY phone_key, sent_at DESC
            ),
            counts AS (
                SELECT phone_key,
                       COUNT(*) FILTER (WHERE direction = 'inbound' AND read_at IS NULL)::int AS unread_count,
                       MAX(sent_at) FILTER (WHERE direction = 'inbound') AS last_inbound_at
                FROM keyed
                GROUP BY phone_key
            )
            SELECT l.phone_key AS phone_digits,
                   l.phone,
                   l.channel      AS last_channel,
                   l.direction    AS last_direction,
                   l.body         AS last_body,
                   l.sent_at      AS last_sent_at,
                   l.reservation_id AS last_reservation_id,
                   COALESCE(c.unread_count, 0)::int AS unread_count,
                   c.last_inbound_at,
                   r.customer_name
            FROM latest l
            LEFT JOIN counts c ON c.phone_key = l.phone_key
            LEFT JOIN LATERAL (
                SELECT customer_name FROM reservations
                WHERE right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 10) = l.phone_key
                ORDER BY reservation_time DESC
                LIMIT 1
            ) r ON true
            ORDER BY l.sent_at DESC
            LIMIT 200
        `);
        res.json({ conversations: result.rows });
    } catch (err) {
        console.error('GET /messages/conversations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Total unread inbound messages. Same number the InboxPage's header shows
// (sum of unread_count across all conversations) so both badges agree.
app.get('/messages/unread-count', authenticate, requirePermission('reservations:view'), async (_req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT COUNT(*)::int AS count
            FROM outbound_messages
            WHERE direction = 'inbound'
              AND channel IN ('sms','whatsapp')
              AND read_at IS NULL
              AND from_phone_digits IS NOT NULL
              AND length(from_phone_digits) >= 8
        `);
        res.json({ count: result.rows[0]?.count ?? 0 });
    } catch (err) {
        console.error('GET /messages/unread-count error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/messages/conversations/:phoneDigits', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const key = String(req.params.phoneDigits).replace(/\D/g, '').slice(-10);
        if (!key) return res.status(400).json({ error: 'Invalid phone_digits' });
        const result = await queryWithRetry(
            `SELECT id, provider, channel, direction, from_phone, to_phone, body,
                    status, provider_sid, reservation_id, sent_at, delivered_at,
                    failed_at, read_at, error_code, error_message
             FROM outbound_messages
             WHERE channel IN ('sms','whatsapp')
               AND (right(to_phone_digits, 10) = $1::text
                    OR right(from_phone_digits, 10) = $1::text)
             ORDER BY sent_at ASC
             LIMIT 500`,
            [key]
        );
        res.json({ messages: result.rows });
    } catch (err) {
        console.error('GET /messages/conversations/:phoneDigits error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/messages/conversations/:phoneDigits/read', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const key = String(req.params.phoneDigits).replace(/\D/g, '').slice(-10);
        if (!key) return res.status(400).json({ error: 'Invalid phone_digits' });
        const updated = await queryWithRetry(
            `UPDATE outbound_messages
             SET read_at = CURRENT_TIMESTAMP
             WHERE direction = 'inbound'
               AND read_at IS NULL
               AND channel IN ('sms','whatsapp')
               AND right(from_phone_digits, 10) = $1::text
             RETURNING id`,
            [key]
        );
        // Broadcast so every open CRM tab (this operator and any other) can
        // decrement its nav badge without a re-fetch.
        if (updated.rows.length > 0 && socketService) {
            socketService.broadcastToAll('message:read', {
                phone_digits: key,
                count: updated.rows.length,
            });
        }
        res.json({ ok: true, marked: updated.rows.length });
    } catch (err) {
        console.error('POST /messages/conversations/:phoneDigits/read error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// INBOX (Email conversations) — parallel to the SMS/WhatsApp block above.
// Threads are keyed by lowercased email address (union of from_email +
// to_email); customer name comes from the most recent reservation for that
// address. Same DISTINCT ON + unread_count + last_inbound_at shape so the
// EmailPage can reuse the InboxPage layout with minimal changes.
// ============================================

app.get('/email/threads', authenticate, requirePermission('reservations:view'), async (_req, res) => {
    try {
        const result = await queryWithRetry(`
            WITH pairs AS (
                SELECT id, provider, channel, direction, subject, body, sent_at, read_at,
                       reservation_id,
                       lower(COALESCE(from_email, to_email)) AS email_key,
                       COALESCE(from_email, to_email) AS email
                FROM outbound_messages
                WHERE channel = 'email'
                  AND COALESCE(from_email, to_email) IS NOT NULL
            ),
            latest AS (
                SELECT DISTINCT ON (email_key)
                    email_key, email, direction, subject, body, sent_at, reservation_id
                FROM pairs
                ORDER BY email_key, sent_at DESC
            ),
            counts AS (
                SELECT email_key,
                       COUNT(*) FILTER (WHERE direction = 'inbound' AND read_at IS NULL)::int AS unread_count,
                       MAX(sent_at) FILTER (WHERE direction = 'inbound') AS last_inbound_at
                FROM pairs
                GROUP BY email_key
            )
            SELECT l.email_key,
                   l.email,
                   l.direction    AS last_direction,
                   l.subject      AS last_subject,
                   l.body         AS last_body,
                   l.sent_at      AS last_sent_at,
                   l.reservation_id AS last_reservation_id,
                   COALESCE(c.unread_count, 0)::int AS unread_count,
                   c.last_inbound_at,
                   r.customer_name
            FROM latest l
            LEFT JOIN counts c ON c.email_key = l.email_key
            LEFT JOIN LATERAL (
                SELECT customer_name FROM reservations
                WHERE lower(email) = l.email_key
                ORDER BY reservation_time DESC
                LIMIT 1
            ) r ON true
            ORDER BY l.sent_at DESC
            LIMIT 200
        `);
        res.json({ threads: result.rows });
    } catch (err) {
        console.error('GET /email/threads error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/email/unread-count', authenticate, requirePermission('reservations:view'), async (_req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT COUNT(*)::int AS count
            FROM outbound_messages
            WHERE direction = 'inbound'
              AND channel = 'email'
              AND read_at IS NULL
              AND from_email IS NOT NULL
        `);
        res.json({ count: result.rows[0]?.count ?? 0 });
    } catch (err) {
        console.error('GET /email/unread-count error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/email/threads/:emailKey', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const key = String(req.params.emailKey).trim().toLowerCase();
        if (!key || !key.includes('@')) return res.status(400).json({ error: 'Invalid email_key' });
        const result = await queryWithRetry(
            `SELECT id, provider, channel, direction, from_email, to_email, subject, body,
                    status, provider_sid, message_id, in_reply_to, reservation_id,
                    sent_at, delivered_at, failed_at, read_at, error_code, error_message
             FROM outbound_messages
             WHERE channel = 'email'
               AND (lower(to_email) = $1 OR lower(from_email) = $1)
             ORDER BY sent_at ASC
             LIMIT 500`,
            [key]
        );
        res.json({ messages: result.rows });
    } catch (err) {
        console.error('GET /email/threads/:emailKey error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/email/threads/:emailKey/read', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const key = String(req.params.emailKey).trim().toLowerCase();
        if (!key || !key.includes('@')) return res.status(400).json({ error: 'Invalid email_key' });
        const updated = await queryWithRetry(
            `UPDATE outbound_messages
             SET read_at = CURRENT_TIMESTAMP
             WHERE direction = 'inbound'
               AND read_at IS NULL
               AND channel = 'email'
               AND lower(from_email) = $1
             RETURNING id`,
            [key]
        );
        if (updated.rows.length > 0 && socketService) {
            socketService.broadcastToAll('email:read', {
                email_key: key,
                count: updated.rows.length,
            });
        }
        res.json({ ok: true, marked: updated.rows.length });
    } catch (err) {
        console.error('POST /email/threads/:emailKey/read error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send an outbound email from the EmailPage composer. Free-form (subject +
// body), optionally attached to a reservation for continuity. The
// buildCustomEmail template wraps the body in the branded HTML shell — the
// same one used by /reservations/:id/send-custom-email so both flows look
// identical to the recipient.
app.post('/email/send', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { to, subject, body, reservation_id, in_reply_to } = req.body || {};
        const toEmail = typeof to === 'string' ? to.trim() : '';
        const subj = typeof subject === 'string' ? subject.trim() : '';
        const bod = typeof body === 'string' ? body.trim() : '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
            return res.status(400).json({ error: 'Destinatario email non valido' });
        }
        if (!subj || subj.length > 200) return res.status(400).json({ error: 'Oggetto richiesto (max 200)' });
        if (!bod || bod.length > 5000) return res.status(400).json({ error: 'Corpo richiesto (max 5000)' });
        if (!(await isSmtpConfigured())) {
            return res.status(503).json({ error: 'SMTP non configurato — vai in Impostazioni' });
        }
        // Reservation_id from the client may be stale (thread summary points
        // to a reservation that got deleted between fetch and send). If the
        // row no longer exists, clear the FK so the INSERT doesn't blow up —
        // the email still lands in the thread, just without the reservation
        // link. The composer prefill (customer_name) collapses to "cliente".
        let reservationId: number | null = Number.isFinite(Number(reservation_id))
            ? Math.trunc(Number(reservation_id))
            : null;
        let customerName: string | null = null;
        if (reservationId != null) {
            const r = await queryWithRetry(
                'SELECT customer_name FROM reservations WHERE id = $1', [reservationId]
            );
            if (r.rows.length === 0) {
                reservationId = null;
            } else {
                customerName = r.rows[0]?.customer_name ?? null;
            }
        }
        const inReplyTo = typeof in_reply_to === 'string' && in_reply_to.trim() ? in_reply_to.trim() : null;

        const template = buildCustomEmail({
            customerName: customerName || 'cliente',
            subject: subj,
            body: bod,
        });
        const sendResult = await sendMail({
            to: toEmail,
            subject: template.subject,
            text: template.text,
            html: template.html,
        });
        // in_reply_to is persisted for our own thread reconstruction even if
        // the underlying provider doesn't propagate the RFC header — it's a
        // hint about the composer's intent, not authoritative Message-ID
        // threading data.
        const inserted = await queryWithRetry(
            `INSERT INTO outbound_messages
                (provider, channel, direction, to_email, subject, body, status,
                 message_id, in_reply_to, reservation_id, sent_at)
             VALUES ('smtp', 'email', 'outbound', $1, $2, $3, 'sent',
                     $4, $5, $6, CURRENT_TIMESTAMP)
             RETURNING id, provider, channel, direction, from_email, to_email,
                       subject, body, status, provider_sid, message_id, in_reply_to,
                       reservation_id, sent_at`,
            [toEmail, subj, bod, sendResult.messageId || null, inReplyTo, reservationId]
        );
        const message = inserted.rows[0];

        if (socketService) {
            try { socketService.broadcastToAll('email:new', { email_key: toEmail.toLowerCase(), message }); }
            catch (err) { console.warn('[email/send] socket broadcast failed:', (err as any)?.message || err); }
        }
        res.json({ ok: true, message });
    } catch (err: any) {
        console.error('POST /email/send error:', err);
        res.status(500).json({ error: err?.message || 'Send failed' });
    }
});

// Send an outbound reply from the inbox composer. Enforces Meta's 24h window
// for WhatsApp freeform (needs an inbound < 24h ago); SMS has no constraint.
// The customer-service window check is deliberately done server-side so the
// UI can render a "window closed" banner without duplicating the rule.
app.post('/messages/send', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { phone, text, channel } = req.body || {};
        if (!phone || !text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'phone and non-empty text required' });
        }
        const desiredChannel: 'whatsapp' | 'sms' = channel === 'sms' ? 'sms' : 'whatsapp';
        const key = String(phone).replace(/\D/g, '').slice(-10);
        if (!key) return res.status(400).json({ error: 'invalid phone' });

        if (desiredChannel === 'whatsapp') {
            const win = await queryWithRetry(
                `SELECT MAX(sent_at) AS last_inbound_at
                 FROM outbound_messages
                 WHERE direction = 'inbound' AND channel = 'whatsapp'
                   AND right(from_phone_digits, 10) = $1::text`,
                [key]
            );
            const lastInbound = win.rows[0]?.last_inbound_at as Date | null;
            const withinWindow = !!lastInbound
                && (Date.now() - new Date(lastInbound).getTime()) < 24 * 3600 * 1000;
            if (!withinWindow) {
                return res.status(409).json({
                    error: 'window_closed',
                    message: 'Fuori dalla finestra 24h WhatsApp: serve un template approvato.',
                });
            }
        }

        const send = desiredChannel === 'whatsapp' ? sendWhatsAppText : sendTwilioSms;
        const result = await send(phone, text.trim());

        let row: any = null;
        if (result.sid) {
            const r = await queryWithRetry(
                `SELECT * FROM outbound_messages WHERE provider_sid = $1 LIMIT 1`,
                [result.sid]
            );
            row = r.rows[0] ?? null;
        }
        if (row && socketService) {
            socketService.broadcastToAll('message:outbound', row);
        }
        res.json({ ok: true, message: row, channel: result.channel, sid: result.sid ?? null });
    } catch (err: any) {
        console.error('POST /messages/send error:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
    }
});


// ============================================
// PAYMENT LINK REQUESTS (Revolut hosted checkout)
// ============================================

// Format an amount in minor units as an Italian euro string ("€ 15,00").
function formatEuroMinor(cents: number): string {
    return `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

// Base URL where the SPA is served (the pay-at-table page lives at
// {base}/pay/{token}). Read from CRM_APP_BASE_URL first so it can be
// pointed at a preview/dev deploy; falls back to the production domain
// so the flow works out of the box. Defined in paymentProviderService
// because the gateway modules build redirect/callback URLs from it too.
function payAtTableBaseUrl(): string {
    return publicBaseUrl();
}

// Message sent to the guest when the waiter forwards the pay-at-table
// link from the reservation modal. Free-form (SMS or WhatsApp inside the
// 24h window) because we don't have a Meta-approved template for this
// flow yet — keep it short so a single SMS segment covers it.
function buildTableBillLinkMessage(customerName: string, amountCents: number, covers: number, url: string): string {
    const amount = formatEuroMinor(amountCents);
    const coversLabel = covers === 1 ? '1 coperto' : `${covers} coperti`;
    return `Ciao ${toTitleCase(customerName)}, ecco il link per pagare al tavolo (${coversLabel} · totale ${amount}): ${url}\nGrazie!`;
}

// Compose the message we send to the customer with the Revolut checkout link.
// Kept intentionally short so it fits comfortably inside an SMS segment when
// WhatsApp isn't available.
function buildPaymentMessage(customerName: string, amountCents: number, url: string, description?: string | null): string {
    const amount = formatEuroMinor(amountCents);
    const desc = (description || '').trim();
    const intro = `Ciao ${toTitleCase(customerName)}, per completare la prenotazione al Vecchio Frantoio serve un anticipo di ${amount}.`;
    const line = desc ? `${intro}\n${desc}` : intro;
    return `${line}\nPuoi pagare in sicurezza qui: ${url}\n\nGrazie!`;
}

// Ack sent to the customer when a public web booking with >8 guests triggers
// an automatic deposit request (€10/person). Combines the "richiesta ricevuta"
// wording with the Revolut checkout link so the guest knows exactly what to
// do next.
function buildDepositRequestMessage(
    customerName: string,
    guestsLabel: string,
    dateLabel: string,
    time: string,
    amountCents: number,
    checkoutUrl: string
): string {
    const amount = formatEuroMinor(amountCents);
    return `Ciao ${toTitleCase(customerName)}, per confermare la prenotazione per ${guestsLabel} il ${dateLabel} alle ${time} serve una caparra di ${amount} (€ 10 a persona).\nPaga in sicurezza qui: ${checkoutUrl}\n\nAppena riceviamo il pagamento ti confermeremo il tavolo. Grazie!`;
}

// Message sent to the customer as soon as the Revolut ORDER_COMPLETED webhook
// arrives on a reservation-linked payment. Confirms both the deposit receipt
// and the reservation itself (which we auto-flip to CONFIRMED at the same time).
function buildDepositConfirmationMessage(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined,
    amountCents: number,
    roomName?: string | null
): string {
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
    const fullName = toTitleCase(customerName);
    const greeting = fullName ? `Ciao ${fullName}` : 'Ciao';
    const guestsNum = Math.max(1, Math.trunc(Number(guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    const room = (roomName ?? '').trim();
    const roomPart = room ? ` in ${room}` : '';
    const amount = formatEuroMinor(amountCents);
    return `${greeting}, abbiamo ricevuto la caparra di ${amount}. La tua prenotazione per ${guestsNum} ${persone} il ${dateLabel} alle ${timeLabel}${roomPart} e' confermata. A presto!`;
}

// Sent to the guest when staff refund a deposit from the Pagamenti page.
//
// Deliberately says nothing about the booking itself: refunding a deposit and
// cancelling a table are separate decisions here (the reservation keeps its
// status), so promising either "confermata" or "annullata" would be a guess.
// It states the fact, sets the expectation that the money takes a few days to
// land — the question staff would otherwise get by phone — and invites a reply.
//
// Accented characters are avoided on purpose, as in every other customer
// message: they'd force UCS-2 encoding and halve the SMS length budget.
function buildRefundNotificationMessage(
    customerName: string | null | undefined,
    amountCents: number,
    reservationTime?: string | Date | null
): string {
    const fullName = toTitleCase(customerName);
    const greeting = fullName ? `Ciao ${fullName}` : 'Ciao';
    const amount = formatEuroMinor(amountCents);
    let when = '';
    if (reservationTime) {
        const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
        when = ` della prenotazione del ${dateLabel} alle ${timeLabel}`;
    }
    return `${greeting}, ti abbiamo rimborsato la caparra di ${amount}${when}. `
        + `L'accredito puo' richiedere qualche giorno lavorativo, secondo la tua banca. `
        + `Per qualsiasi dubbio rispondi a questo messaggio. Grazie!`;
}

// Global list of payment requests across all reservations, powering the
// dedicated /pagamenti page. Supports the same filter vocabulary as the
// UI: free-text search on customer/description/order id, status filter
// (comma-separated), and a date range on created_at.
app.get('/payments', authenticate, requirePermission('payments:view'), async (req, res) => {
    try {
        const { from, to, q, status } = req.query as Record<string, string | undefined>;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 200);
        const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

        const where: string[] = [];
        const params: any[] = [];

        if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
            params.push(from);
            where.push(`pr.created_at >= $${params.length}::date`);
        }
        if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
            params.push(to);
            where.push(`pr.created_at < ($${params.length}::date + INTERVAL '1 day')`);
        }
        if (q && q.trim()) {
            params.push(`%${q.trim()}%`);
            const idx = params.length;
            where.push(
                `(r.customer_name ILIKE $${idx}
                  OR r.phone ILIKE $${idx}
                  OR pr.description ILIKE $${idx}
                  OR pr.provider_order_id ILIKE $${idx})`
            );
        }
        if (status && status.trim()) {
            // Comma-separated, case-insensitive; we store uppercase status
            // so we upper() both sides.
            const values = status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            if (values.length > 0) {
                const placeholders = values.map(v => {
                    params.push(v);
                    return `$${params.length}`;
                }).join(',');
                where.push(`upper(pr.status) IN (${placeholders})`);
            }
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        params.push(limit);
        params.push(offset);

        const result = await queryWithRetry(
            `SELECT pr.id, pr.reservation_id, pr.amount_cents, pr.currency, pr.description,
                    pr.status, pr.provider, pr.provider_order_id, pr.checkout_url,
                    pr.delivery_channel, pr.delivery_provider_sid, pr.delivery_error,
                    pr.created_at, pr.updated_at, pr.completed_at,
                    r.customer_name AS reservation_customer_name,
                    r.phone AS reservation_phone,
                    r.reservation_time AS reservation_time,
                    r.guests AS reservation_guests,
                    r.reservation_status AS reservation_status,
                    pr.table_bill_split_id AS table_bill_split_id,
                    tbs.table_bill_id AS table_bill_id,
                    tbs.claimant_label AS claimant_label,
                    tb.total_cents AS bill_total_cents,
                    tb.status AS bill_status,
                    t.name AS table_name
             FROM payment_requests pr
             LEFT JOIN reservations r ON r.id = pr.reservation_id
             LEFT JOIN table_bill_splits tbs ON tbs.id = pr.table_bill_split_id
             LEFT JOIN table_bills tb ON tb.id = tbs.table_bill_id
             LEFT JOIN tables t ON t.id = tb.table_id
             ${whereSql}
             ORDER BY pr.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        const countResult = await queryWithRetry(
            `SELECT COUNT(*)::int AS total
             FROM payment_requests pr
             LEFT JOIN reservations r ON r.id = pr.reservation_id
             ${whereSql}`,
            params.slice(0, params.length - 2)
        );

        res.json({
            items: result.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit,
            offset,
        });
    } catch (err: any) {
        console.error('GET /payments error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Badge sidebar "Pagamenti": conta gli incassi (COMPLETED/PAID) non ancora
// visti. La colonna seen_at viene marcata da /payments/mark-seen quando
// l'operatore apre la pagina — così il conteggio è condiviso tra dispositivi
// (a differenza di un last-seen in localStorage).
app.get('/payments/unseen-count', authenticate, requirePermission('payments:view'), async (_req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT COUNT(*)::int AS count
             FROM payment_requests
             WHERE upper(status) IN ('COMPLETED','PAID') AND seen_at IS NULL`
        );
        res.json({ count: result.rows[0]?.count ?? 0 });
    } catch (err: any) {
        console.error('GET /payments/unseen-count error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Marca visti SOLO i pagati: un PENDING che si completa più tardi deve poter
// tornare a far salire il badge.
app.post('/payments/mark-seen', authenticate, requirePermission('payments:view'), async (req, res) => {
    try {
        const result = await queryWithRetry(
            `UPDATE payment_requests SET seen_at = NOW()
             WHERE upper(status) IN ('COMPLETED','PAID') AND seen_at IS NULL
             RETURNING id`
        );
        if (result.rows.length > 0) {
            const socketId = req.headers['x-socket-id'] as string;
            if (socketService) socketService.broadcastToAll('payments:seen', { count: result.rows.length }, socketId);
        }
        res.json({ marked: result.rows.length });
    } catch (err: any) {
        console.error('POST /payments/mark-seen error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Messages associated with a payment. Since payments don't have their own
// FK on outbound_messages we surface the whole reservation timeline — the
// UI can spot the ones that actually relate to the payment (they contain
// the checkout URL). Same shape as GET /reservations/:id/messages.
app.get('/payments/:id/messages', authenticate, requirePermission('payments:view'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const payRow = await queryWithRetry(
            `SELECT pr.reservation_id, pr.checkout_url, r.phone, r.email
             FROM payment_requests pr
             LEFT JOIN reservations r ON r.id = pr.reservation_id
             WHERE pr.id = $1`,
            [id]
        );
        if (payRow.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const row = payRow.rows[0];
        const reservationId: number | null = row.reservation_id;
        const phone: string | null = row.phone;
        const email: string | null = row.email;
        const checkoutUrl: string | null = row.checkout_url;

        const digits = phone ? String(phone).replace(/\D/g, '') : '';
        const suffix = digits.length >= 8 ? digits.slice(-10) : null;

        const conditions: string[] = [];
        const params: any[] = [];
        if (reservationId != null) {
            params.push(reservationId);
            conditions.push(`reservation_id = $${params.length}`);
        }
        if (suffix) {
            params.push(suffix);
            conditions.push(`right(to_phone_digits, 10) = $${params.length}`);
        }
        if (email) {
            params.push(email);
            conditions.push(`lower(to_email) = lower($${params.length})`);
        }
        if (conditions.length === 0) return res.json({ items: [], checkout_url: checkoutUrl });

        const result = await queryWithRetry(
            `SELECT id, provider, channel, to_phone, to_email, subject, body, status, provider_sid,
                    reservation_id, sent_at, delivered_at, failed_at,
                    error_code, error_message
             FROM outbound_messages
             WHERE ${conditions.join(' OR ')}
             ORDER BY sent_at DESC
             LIMIT 100`,
            params
        );
        // Attach `is_payment_link` so the client can highlight rows that
        // actually contain this payment's checkout URL — the reservation
        // timeline may also carry booking confirmations, reminders, etc.
        const items = result.rows.map((m: any) => ({
            ...m,
            is_payment_link: !!(checkoutUrl && m.body && String(m.body).includes(checkoutUrl)),
        }));
        res.json({ items, checkout_url: checkoutUrl });
    } catch (err: any) {
        console.error('GET /payments/:id/messages error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// List all payment requests attached to a reservation. Powers the small
// history list rendered inside the reservation modal.
app.get('/payments/requests', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const reservationId = req.query.reservation_id ? parseInt(String(req.query.reservation_id), 10) : NaN;
        if (!Number.isFinite(reservationId)) {
            return res.status(400).json({ error: 'reservation_id is required' });
        }
        const result = await queryWithRetry(
            `SELECT id, reservation_id, amount_cents, currency, description, status, provider,
                    provider_order_id, checkout_url, delivery_channel, delivery_provider_sid,
                    delivery_error, created_by_user_id, created_at, updated_at, completed_at, metadata
             FROM payment_requests
             WHERE reservation_id = $1
             ORDER BY created_at DESC`,
            [reservationId]
        );
        res.json(result.rows);
    } catch (err: any) {
        console.error('GET /payments/requests error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Create a payment link for a reservation. Body: { reservation_id, amount, description? }
// where `amount` is in euros (accepts decimal). Sends the link over
// WhatsApp/SMS with the same dispatcher used for booking confirmations, so
// the channel decision (SMS while Meta verification is pending, WhatsApp
// after) mirrors reservation confirmations exactly.
app.post('/payments/requests', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        if (!(await isPaymentConfigured())) {
            const active = await getActivePaymentProvider();
            return res.status(503).json({ error: `${providerLabel(active)} non è configurato (credenziali mancanti)` });
        }

        const { reservation_id, amount, description } = req.body ?? {};
        const reservationId = parseInt(String(reservation_id), 10);
        const amountEur = Number(amount);
        if (!Number.isFinite(reservationId)) return res.status(400).json({ error: 'reservation_id is required' });
        if (!Number.isFinite(amountEur) || amountEur <= 0) return res.status(400).json({ error: 'amount must be > 0' });

        const amountCents = Math.round(amountEur * 100);
        if (amountCents < 50) return res.status(400).json({ error: 'importo minimo € 0,50' });

        // Fetch the reservation so we can pre-fill the message and require a
        // phone number (otherwise there's no channel to deliver the link).
        const resvResult = await queryWithRetry(
            'SELECT id, customer_name, phone, reservation_time, guests FROM reservations WHERE id = $1',
            [reservationId]
        );
        if (resvResult.rowCount === 0) return res.status(404).json({ error: 'Prenotazione non trovata' });
        const reservation = resvResult.rows[0];
        if (!reservation.phone) return res.status(400).json({ error: 'La prenotazione non ha un numero di telefono' });

        // Create the gateway order first — if the API call fails we don't
        // want to persist a half-baked row. The `reference` is how the
        // webhook will correlate the event back to our reservation.
        const orderDescription = (typeof description === 'string' && description.trim())
            ? description.trim()
            : `Prenotazione #${reservation.id} - ${reservation.guests} persone`;
        const order = await createPaymentOrder({
            amount: amountCents,
            currency: 'EUR',
            description: orderDescription,
            reference: `reservation:${reservation.id}`,
        });

        const inserted = await queryWithRetry(
            `INSERT INTO payment_requests
                (reservation_id, amount_cents, currency, description, status, provider,
                 provider_order_id, checkout_url, created_by_user_id, metadata)
             VALUES ($1, $2, 'EUR', $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                reservation.id,
                amountCents,
                orderDescription,
                order.status,
                order.provider,
                order.id,
                order.checkoutUrl,
                req.user?.userId ?? null,
                JSON.stringify(order.metadata),
            ]
        );
        const paymentRequest = inserted.rows[0];

        // Fire-and-forget delivery: same channel policy as booking
        // confirmations. Failures update delivery_error but don't fail the
        // API call — the operator can still copy the link from the UI.
        const message = buildPaymentMessage(reservation.customer_name, amountCents, order.checkoutUrl, orderDescription);
        sendBookingConfirmation(reservation.phone, message, reservation.id).then(async (delivery) => {
            try {
                await queryWithRetry(
                    `UPDATE payment_requests
                     SET delivery_channel = $1, delivery_provider_sid = $2, delivery_error = NULL, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [delivery.channel || null, delivery.sid || null, paymentRequest.id]
                );
            } catch (err) {
                console.warn('[payments] delivery persist failed:', (err as any)?.message || err);
            }
        }).catch(async (err) => {
            console.error('[payments] delivery send failed:', err?.message || err);
            try {
                await queryWithRetry(
                    `UPDATE payment_requests
                     SET delivery_error = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [String(err?.message || err).slice(0, 500), paymentRequest.id]
                );
            } catch { /* ignore */ }
        });

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.RESERVATION,
                reservation.id,
                `${reservation.customer_name} — richiesta pagamento ${formatEuroMinor(amountCents)}`
            );
        }

        try { socketService?.broadcastToAll('paymentRequest:created', paymentRequest); }
        catch (err) { console.warn('[payments] socket broadcast failed:', (err as any)?.message || err); }

        // The booking card's payment badge reads latest_payment_* off the
        // reservation row: without this nudge the icon only appeared after a
        // full page reload.
        broadcastReservationsUpdatedByIds([reservation.id]).catch(() => {});

        res.status(201).json(paymentRequest);
    } catch (err: any) {
        console.error('POST /payments/requests error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Propagate a payment order transition down to the table_bill_splits row
// (and, on full payment, to the parent bill). Idempotent: the CLAIMED
// guard on UPDATE means replaying an already-PAID split is a no-op.
// Kept separate from applyPaymentOrderTransition so the split logic can
// evolve without touching the deposit flow.
async function applyBillSplitTransition(
    splitId: number,
    event: string,
    isFirstCompletion: boolean,
): Promise<void> {
    // First: find the parent bill_id so we can broadcast and, on
    // completion, promote the bill to SETTLED under a single query.
    const splitRs = await queryWithRetry(
        `SELECT table_bill_id, amount_cents, status FROM table_bill_splits WHERE id = $1`,
        [splitId]
    );
    if (splitRs.rowCount === 0) {
        console.warn('[bill-split] transition: split not found', splitId);
        return;
    }
    const { table_bill_id: billId, amount_cents: amount } = splitRs.rows[0];

    if (event === 'ORDER_COMPLETED') {
        if (!isFirstCompletion) return;

        let upd = await queryWithRetry(
            `UPDATE table_bill_splits
             SET status = 'PAID', paid_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'CLAIMED'
             RETURNING id`,
            [splitId]
        );
        if (upd.rowCount === 0) {
            // Not CLAIMED anymore. If the claim was ABANDONED but the guest
            // paid anyway (checkout kept open past the TTL), the money IS
            // collected: resurrect the split when the bill still has room —
            // the sum trigger rejects the UPDATE if it doesn't.
            try {
                upd = await queryWithRetry(
                    `UPDATE table_bill_splits
                     SET status = 'PAID', paid_at = CURRENT_TIMESTAMP
                     WHERE id = $1 AND status = 'ABANDONED'
                     RETURNING id`,
                    [splitId]
                );
            } catch (resErr: any) {
                // Trigger refused: capacity was re-claimed and paid by
                // someone else → this is a real overpayment. Make it loud:
                // the staff must refund it by hand (until the dedicated
                // refund endpoint lands).
                console.error('[bill-split] OVERPAYMENT: split', splitId, 'paid after abandon, bill', billId, 'has no capacity left:', resErr?.message);
                pushSendToRoles(['OWNER', 'GENERAL_MANAGER', 'MANAGER'], {
                    category: 'payment',
                    title: 'Pagamento in eccesso da rimborsare',
                    body: `${formatEuroMinor(amount)} pagati su un conto già saldato (conto #${billId}). Serve un rimborso manuale da Revolut.`,
                    url: `/?view=PAGAMENTI`,
                    tag: `bill-overpaid-${splitId}`,
                }, { excludeUserId: null }).catch(() => {});
                return;
            }
            if (upd.rowCount === 0) {
                // Already PAID (webhook replay) or RELEASED/REFUNDED —
                // nothing to do.
                return;
            }
        }

        try {
            socketService?.broadcastToAll('bill:split-paid', {
                bill_id: billId, split_id: splitId, amount_cents: amount,
            });
        } catch (_) {}

        // SETTLED promotion: total_cents == sum of PAID splits. Guard on
        // status IN OPEN/LOCKED so a manually-closed bill doesn't get
        // clobbered. Race-safe because it's a single UPDATE ... WHERE
        // comparing against a sub-select computed atomically by PG.
        const settled = await queryWithRetry(
            `UPDATE table_bills b
             SET status = 'SETTLED'
             WHERE b.id = $1
               AND b.status IN ('OPEN','LOCKED')
               AND b.total_cents = (
                   SELECT COALESCE(SUM(amount_cents), 0)
                   FROM table_bill_splits
                   WHERE table_bill_id = $1 AND status = 'PAID'
               )
             RETURNING id, reservation_id, table_id, total_cents, covers, status`,
            [billId]
        );
        if ((settled.rowCount ?? 0) > 0) {
            try { socketService?.broadcastToAll('bill:settled', settled.rows[0]); } catch (_) {}
        }
        return;
    }

    if (event === 'ORDER_CANCELLED' || event === 'ORDER_PAYMENT_DECLINED' || event === 'ORDER_PAYMENT_FAILED') {
        const upd = await queryWithRetry(
            `UPDATE table_bill_splits
             SET status = 'ABANDONED'
             WHERE id = $1 AND status = 'CLAIMED'
             RETURNING id`,
            [splitId]
        );
        if ((upd.rowCount ?? 0) > 0) {
            try {
                socketService?.broadcastToAll('bill:split-abandoned', {
                    bill_id: billId, split_id: splitId,
                });
            } catch (_) {}
        }
    }
}

// Shared side-effect pipeline for a payment order state change, in the
// provider-neutral ORDER_* vocabulary (see services/paymentProviderService.ts
// — SumUp's PAID/FAILED/EXPIRED are normalised onto it before they get here).
// Called by both webhook receivers and the manual reconcile endpoint.
// Idempotent: gated on `completed_at` under a row-level lock so replaying an
// already-processed transition is a no-op — customer confirmation fires only
// on the FIRST ORDER_COMPLETED, no matter how many times we're called.
//
// `extraMetadata` is merged into payment_requests.metadata when present; it
// carries provider details we only learn at transition time (the SumUp
// transaction id, which later refunds are keyed on).
type PaymentTransitionResult =
    | { status: 'applied'; row: any; isFirstCompletion: boolean }
    | { status: 'ignored'; reason: string };
async function applyPaymentOrderTransition(
    orderId: string,
    event: string,
    extraMetadata?: Record<string, unknown> | null
): Promise<PaymentTransitionResult> {
    let nextStatus: string | null = null;
    let markCompleted = false;
    switch (event) {
        case 'ORDER_COMPLETED':
            nextStatus = 'COMPLETED';
            markCompleted = true;
            break;
        case 'ORDER_AUTHORISED':
            nextStatus = 'AUTHORISED';
            break;
        case 'ORDER_CANCELLED':
            nextStatus = 'CANCELLED';
            break;
        case 'ORDER_PAYMENT_DECLINED':
        case 'ORDER_PAYMENT_FAILED':
            nextStatus = 'FAILED';
            break;
        default:
            console.log('[payments] unhandled event:', event);
            return { status: 'ignored', reason: event };
    }

    const client = await pool.connect();
    let row: any;
    let wasCompleted = false;
    try {
        await client.query('BEGIN');
        const before = await client.query(
            `SELECT id, status, completed_at, reservation_id
             FROM payment_requests WHERE provider_order_id = $1 FOR UPDATE`,
            [orderId]
        );
        if (before.rowCount === 0) {
            await client.query('ROLLBACK');
            console.warn('[payments] transition: no payment_request found for order_id', orderId);
            return { status: 'ignored', reason: 'unknown order' };
        }
        wasCompleted = before.rows[0].completed_at !== null;
        const updated = await client.query(
            `UPDATE payment_requests
             SET status = $1,
                 completed_at = CASE WHEN $2 AND completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE completed_at END,
                 metadata = CASE WHEN $3::jsonb IS NULL THEN metadata
                                 ELSE COALESCE(metadata, '{}'::jsonb) || $3::jsonb END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [
                nextStatus,
                markCompleted,
                extraMetadata && Object.keys(extraMetadata).length > 0 ? JSON.stringify(extraMetadata) : null,
                before.rows[0].id,
            ]
        );
        row = updated.rows[0];
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    try { socketService?.broadcastToAll('paymentRequest:updated', row); }
    catch (err) { console.warn('[payments] socket broadcast failed:', (err as any)?.message || err); }

    // Keep the booking card's payment badge live on webhook transitions
    // (paid/failed/expired land without any operator action).
    if (row.reservation_id) broadcastReservationsUpdatedByIds([row.reservation_id]).catch(() => {});

    const isFirstCompletion = markCompleted && !wasCompleted;
    const billSplitId: number | null = row.table_bill_split_id ?? null;

    // Bill split side effects: if the payment is attached to a
    // table_bill_splits row, propagate the transition. Runs on both
    // first-completion (mark PAID + check SETTLED) and on
    // cancelled/failed (mark ABANDONED so the capacity is freed).
    if (billSplitId) {
        try {
            await applyBillSplitTransition(billSplitId, event, isFirstCompletion);
        } catch (err: any) {
            console.error('[payments] bill split transition failed for split', billSplitId, err?.message || err);
        }
    }

    // The deposit-confirmation flow below is only for prenotazione
    // deposits, not for pay-at-table splits — the split guest doesn't
    // want a "grazie, la tua prenotazione è confermata" WhatsApp.
    if (isFirstCompletion && !billSplitId) {
        const bodyLine = `${formatEuroMinor(row.amount_cents)} da prenotazione #${row.reservation_id ?? '?'}`;
        pushSendToRoles(['OWNER', 'GENERAL_MANAGER', 'MANAGER'], {
            category: 'payment',
            title: 'Pagamento ricevuto',
            body: bodyLine,
            url: row.reservation_id ? `/?view=RESERVATIONS&reservationId=${row.reservation_id}` : `/?view=RESERVATIONS`,
            tag: `payment-${row.id}`,
        }, { excludeUserId: null }).catch(err => {
            console.warn('[payments] push send failed:', err?.message || err);
        });
    }

    if (isFirstCompletion && row.reservation_id && !billSplitId) {
        (async () => {
            try {
                const resvRes = await queryWithRetry(
                    `SELECT id, customer_name, phone, reservation_time, guests,
                            reservation_status, table_id, notes
                     FROM reservations WHERE id = $1`,
                    [row.reservation_id]
                );
                if (resvRes.rowCount === 0) return;
                const reservation = resvRes.rows[0];

                if (reservation.reservation_status === 'PENDING') {
                    const upd = await queryWithRetry(
                        `UPDATE reservations
                         SET reservation_status = 'CONFIRMED',
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1
                         RETURNING *`,
                        [reservation.id]
                    );
                    if (upd.rows[0] && socketService) {
                        try { socketService.broadcastReservationUpdated(upd.rows[0]); }
                        catch (err) { console.warn('[payments] reservation broadcast failed:', err); }
                    }
                }

                if (reservation.phone &&
                    (reservation.reservation_status === 'PENDING' ||
                     reservation.reservation_status === 'CONFIRMED')) {
                    const roomName = await resolveReservationRoomName(reservation);
                    const message = buildDepositConfirmationMessage(
                        reservation.customer_name,
                        reservation.reservation_time,
                        reservation.guests,
                        row.amount_cents,
                        roomName
                    );
                    await sendBookingConfirmation(reservation.phone, message, reservation.id, {
                        whatsappTemplate: buildBookingDepositConfirmedTemplate(
                            reservation.customer_name,
                            reservation.reservation_time,
                            reservation.guests,
                            row.amount_cents
                        ),
                    });
                }
            } catch (err: any) {
                console.error('[payments] deposit confirmation flow failed:', err?.message || err);
            }
        })();
    }

    return { status: 'applied', row, isFirstCompletion };
}

// Revolut webhook receiver. HMAC signature is validated against the raw
// request body captured by the global express.json verify hook. Idempotent:
// duplicate events (Revolut retries until 2xx) update the same row without
// side-effects because we key on `provider_order_id` and gate the
// "first-completion" side-effects on the old `completed_at` being NULL under
// a row-level lock.
app.post('/webhook/revolut', async (req, res) => {
    const verification = await verifyRevolutWebhook(req);
    if (!verification.valid) {
        console.warn('[Revolut] webhook rejected:', verification.reason);
        return res.status(401).json({ error: 'invalid signature', reason: verification.reason });
    }

    try {
        const body = req.body || {};
        const event = String(body.event || '').toUpperCase();
        const orderId: string | undefined = body.order_id || body.data?.order_id || body.data?.id;
        if (!orderId) {
            console.warn('[Revolut] webhook missing order_id, event=', event);
            return res.status(200).json({ ok: true, ignored: 'missing order_id' });
        }

        const result = await applyPaymentOrderTransition(orderId, event);
        if (result.status === 'ignored') return res.status(200).json({ ok: true, ignored: result.reason });
        return res.status(200).json({ ok: true });
    } catch (err: any) {
        console.error('POST /webhook/revolut error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// SumUp callback receiver. SumUp pings the `return_url` we register on each
// checkout when its status changes, but — unlike Revolut — that request is
// NOT signed, so nothing in the body can be trusted. Two defences:
//
//  1. the URL carries an opaque token only we and SumUp know, compared in
//     constant time (cheap filter against random internet traffic);
//  2. the body is used solely to learn WHICH checkout moved. The status is
//     then re-read from SumUp's API, so a forged payload can at worst make
//     us re-check a checkout, never mark one paid.
//
// Idempotent for the same reason the Revolut receiver is: we key on
// provider_order_id and gate first-completion side-effects on completed_at.
app.post('/webhook/sumup/:token', async (req, res) => {
    try {
        const expected = await getSumUpCallbackSecret();
        if (!callbackTokenMatches(req.params.token, expected)) {
            console.warn('[SumUp] callback rejected: token mismatch');
            return res.status(401).json({ error: 'invalid token' });
        }

        // SumUp has shipped a few payload shapes over the years (and wraps
        // the resource under `payload`/`data` in some of them), so probe the
        // plausible spots rather than pinning one.
        const body = req.body || {};
        const checkoutId: string | undefined =
            body.id || body.checkout_id ||
            body.payload?.id || body.payload?.checkout_id ||
            body.data?.id || body.data?.checkout_id;
        if (!checkoutId) {
            console.warn('[SumUp] callback missing checkout id, body keys=', Object.keys(body));
            return res.status(200).json({ ok: true, ignored: 'missing checkout id' });
        }

        // Answer SumUp before doing the work: the status re-read plus the
        // downstream confirmation flow (WhatsApp/SMS) can take seconds, and a
        // slow 200 just earns us a retry storm. Failures are logged and the
        // reconcile paths (manual button, bill-split job) remain the backstop.
        res.status(200).json({ ok: true });

        try {
            const fetched = await fetchPaymentOrder('sumup', checkoutId);
            if (!fetched.event) {
                console.log('[SumUp] callback: checkout', checkoutId, 'still', fetched.state, '— nothing to apply');
                return;
            }
            await applyPaymentOrderTransition(
                checkoutId,
                fetched.event,
                transitionMetadata('sumup', fetched.raw)
            );
        } catch (err: any) {
            console.error('[SumUp] callback processing failed for checkout', checkoutId, err?.message || err);
        }
    } catch (err: any) {
        console.error('POST /webhook/sumup error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Manual reconciliation: poll the gateway for the current state of the order
// associated with a payment_request and apply the corresponding transition.
// Used when a webhook was missed — e.g. an order created before the webhook
// endpoint existed, or a delivery the provider permanently gave up on. Same
// side-effects as the real webhook (broadcast + push + deposit confirmation)
// so the UI reflects reality after one click.
app.post('/payments/:id/reconcile', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const paymentRes = await queryWithRetry(
            `SELECT id, provider, provider_order_id FROM payment_requests WHERE id = $1`,
            [id]
        );
        if (paymentRes.rowCount === 0) return res.status(404).json({ error: 'Payment not found' });
        const payment = paymentRes.rows[0];

        // Reconcile through the provider that created the order, so a
        // payment opened before an operator switched gateways still resolves.
        if (!isPaymentProvider(payment.provider)) {
            return res.status(400).json({ error: `Reconcile non supportato per provider ${payment.provider}` });
        }
        const provider: PaymentProvider = payment.provider;
        const label = providerLabel(provider);
        if (!payment.provider_order_id) {
            return res.status(400).json({ error: 'Nessun order ID associato al pagamento' });
        }
        if (!(await isProviderConfigured(provider))) {
            return res.status(503).json({ error: `${label} non è configurato (credenziali mancanti)` });
        }

        let fetched;
        try {
            fetched = await fetchPaymentOrder(provider, payment.provider_order_id);
        } catch (err: any) {
            console.error('[payments] reconcile fetch failed:', err?.message || err);
            return res.status(502).json({ error: `Lettura ordine ${label} fallita`, detail: err?.message || String(err) });
        }

        if (!fetched.event) {
            return res.status(200).json({
                ok: true,
                changed: false,
                provider,
                provider_state: fetched.state,
                revolut_state: fetched.state,
                message: `Stato ${label} "${fetched.state}" non richiede aggiornamenti`,
            });
        }

        const result = await applyPaymentOrderTransition(
            payment.provider_order_id,
            fetched.event,
            transitionMetadata(provider, fetched.raw)
        );
        if (result.status === 'ignored') {
            return res.status(200).json({
                ok: true,
                changed: false,
                ignored: result.reason,
                provider,
                provider_state: fetched.state,
                revolut_state: fetched.state,
            });
        }

        return res.status(200).json({
            ok: true,
            changed: true,
            provider,
            provider_state: fetched.state,
            // Kept alongside provider_state so older clients that read
            // `revolut_state` keep rendering the reconcile result.
            revolut_state: fetched.state,
            first_completion: result.isFirstCompletion,
            payment_request: result.row,
        });
    } catch (err: any) {
        console.error('POST /payments/:id/reconcile error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Full refund of a standalone payment request (a deposit / payment link).
// Split-linked payments deliberately go through /bills/splits/:id/refund
// instead: that path also reopens the bill when the refund drops it below
// its total, which this one has no business doing.
//
// Refund FIRST, then write: if the gateway refuses, nothing changed on our
// side. If the write failed after a successful refund the gateway's records
// remain the source of truth, and a retry is a no-op for us because the row
// is no longer in a refundable state.
app.post('/payments/:id/refund', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const paymentRes = await queryWithRetry(
            `SELECT id, provider, provider_order_id, status, amount_cents, currency,
                    description, reservation_id, table_bill_split_id, metadata
             FROM payment_requests WHERE id = $1`,
            [id]
        );
        if (paymentRes.rowCount === 0) return res.status(404).json({ error: 'Pagamento non trovato' });
        const payment = paymentRes.rows[0];

        if (payment.table_bill_split_id != null) {
            return res.status(409).json({
                error: 'Questo pagamento è una quota di un conto: usa il rimborso della quota, che riapre anche il conto',
            });
        }
        if (!['COMPLETED', 'PAID'].includes(String(payment.status || '').toUpperCase())) {
            return res.status(409).json({ error: `Il pagamento non è rimborsabile (stato ${payment.status})` });
        }
        if (!isPaymentProvider(payment.provider) || !payment.provider_order_id) {
            return res.status(409).json({ error: 'Nessun ordine di pagamento collegato' });
        }
        const provider: PaymentProvider = payment.provider;
        if (!(await isProviderConfigured(provider))) {
            return res.status(503).json({ error: `${providerLabel(provider)} non è configurato (credenziali mancanti)` });
        }

        try {
            await refundPaymentOrder(
                provider,
                payment.provider_order_id,
                payment.amount_cents,
                payment.currency || 'EUR',
                payment.description || `Rimborso pagamento #${payment.id}`,
                // Captured when the payment completed; SumUp refunds are keyed
                // on the transaction, not the checkout.
                payment.metadata?.sumup_transaction_id ?? null
            );
        } catch (err: any) {
            console.error('[payments] refund failed:', err?.message || err);
            // The provider services already produce an operator-readable
            // reason; use it as the message rather than burying it behind a
            // generic wrapper, which read as "Rimborso SumUp fallito: SumUp
            // ha rifiutato il rimborso: …" in the UI banner.
            const reason = err?.message ? String(err.message) : '';
            return res.status(502).json({
                error: reason || `Rimborso ${providerLabel(provider)} fallito`,
                detail: reason ? undefined : String(err),
            });
        }

        const updated = await queryWithRetry(
            `UPDATE payment_requests
             SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [payment.id]
        );
        const row = updated.rows[0];

        try { socketService?.broadcastToAll('paymentRequest:updated', row); }
        catch (err) { console.warn('[payments] refund broadcast failed:', (err as any)?.message || err); }

        if (row.reservation_id) broadcastReservationsUpdatedByIds([row.reservation_id]).catch(() => {});

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.RESERVATION,
                payment.reservation_id ?? undefined,
                `Rimborso ${formatEuroMinor(payment.amount_cents)} (${providerLabel(provider)}) — pagamento #${payment.id}`
            );
        }

        // Tell the guest their money is on the way back. Fire-and-forget on
        // purpose: the refund already went through at the gateway, so a
        // Twilio hiccup must not turn a successful refund into a 5xx. The
        // send is recorded in outbound_messages either way, so it shows up in
        // the payment's "Comunicazioni con il cliente" timeline.
        if (payment.reservation_id) {
            (async () => {
                try {
                    const resv = await queryWithRetry(
                        'SELECT customer_name, phone, reservation_time FROM reservations WHERE id = $1',
                        [payment.reservation_id]
                    );
                    const reservation = resv.rows[0];
                    if (!reservation?.phone) return;
                    const message = buildRefundNotificationMessage(
                        reservation.customer_name,
                        payment.amount_cents,
                        reservation.reservation_time
                    );
                    // No Meta-approved template exists for refunds, so this
                    // goes out as SMS (sendBookingConfirmation only attempts
                    // WhatsApp when given a template).
                    const delivery = await sendBookingConfirmation(reservation.phone, message, payment.reservation_id);
                    console.log(`[payments] refund notice sent for payment ${payment.id} via ${delivery.channel}`);
                } catch (err: any) {
                    console.error('[payments] refund notice failed for payment', payment.id, err?.message || err);
                }
            })();
        }

        res.json({ ok: true, payment_request: row });
    } catch (err: any) {
        console.error('POST /payments/:id/refund error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});


// Tables - require authentication
app.get('/tables', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM tables ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/tables', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { name, shape, seats, x, y, room_id, status, rotation } = req.body;
        const result = await queryWithRetry(
            'INSERT INTO tables (name, shape, seats, x, y, room_id, status, rotation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [name, shape, seats, x, y, room_id, status, rotation || 0]
        );
        const newTable = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.TABLE,
                newTable.id,
                name,
                { shape, seats, room_id }
            );
        }

        // Broadcast to all connected clients except the one who created it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastTableCreated(newTable, socketId);

        res.status(201).json(newTable);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/tables/:id', authenticate, requirePermission('floorplan:update_status'), async (req, res) => {
    try {
        const { id } = req.params;

        console.log('PUT /tables/:id - Request body:', JSON.stringify(req.body, null, 2));

        // Build dynamic update query based on provided fields
        const fields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        const allowedFields = ['name', 'shape', 'seats', 'x', 'y', 'room_id', 'status', 'is_locked', 'merged_with', 'temp_lock_expires_at', 'rotation', 'width_cm', 'length_cm', 'notes'];

        allowedFields.forEach(field => {
            if (req.body.hasOwnProperty(field)) {
                fields.push(`${field} = $${paramIndex}`);

                // Special handling for merged_with - ensure it's null if undefined/empty
                if (field === 'merged_with') {
                    const mergedWith = req.body[field];
                    values.push(mergedWith && Array.isArray(mergedWith) && mergedWith.length > 0 ? mergedWith : null);
                    console.log('Setting merged_with to:', values[values.length - 1]);
                } else {
                    values.push(req.body[field]);
                }

                paramIndex++;
            }
        });

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);
        const query = `UPDATE tables SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

        console.log('SQL Query:', query);
        console.log('Values:', values);

        const result = await queryWithRetry(query, values);
        const updatedTable = result.rows[0];

        console.log('Updated table merged_with:', updatedTable.merged_with);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.TABLE,
                parseInt(id, 10),
                updatedTable.name,
                req.body
            );
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastTableUpdated(updatedTable, socketId);

        res.json(updatedTable);
    } catch (err) {
        console.error('Error updating table:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/tables/:id', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get table name before deleting
        const existing = await queryWithRetry('SELECT name FROM tables WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await queryWithRetry('DELETE FROM tables WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.TABLE,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastTableDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ============================================
// PER-SHIFT TABLE MERGES
// ============================================

// GET /table-merges?date=YYYY-MM-DD&shift=LUNCH|DINNER
app.get('/table-merges', authenticate, async (req, res) => {
    try {
        const { date, shift } = req.query;
        if (!date || !shift) {
            return res.status(400).json({ error: 'date and shift query params are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }
        const result = await queryWithRetry(
            'SELECT id, date, shift, primary_id, merged_ids FROM table_merges WHERE date = $1 AND shift = $2',
            [date, shift]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching table merges:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /table-merges  body: { date, shift, primary_id, merged_ids }
// Idempotent — replaces an existing merge for the same (date, shift, primary_id).
app.post('/table-merges', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, primary_id, merged_ids } = req.body;
        if (!date || !shift || primary_id == null || !Array.isArray(merged_ids) || merged_ids.length === 0) {
            return res.status(400).json({ error: 'date, shift, primary_id and non-empty merged_ids are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }
        const result = await queryWithRetry(
            `INSERT INTO table_merges (date, shift, primary_id, merged_ids)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (date, shift, primary_id)
             DO UPDATE SET merged_ids = EXCLUDED.merged_ids
             RETURNING id, date, shift, primary_id, merged_ids`,
            [date, shift, primary_id, merged_ids]
        );
        const merge = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.TABLE,
                primary_id,
                `Merge ${date} ${shift}`,
                { date, shift, merged_ids }
            );
        }

        // Broadcast to ALL clients (including originator) so the originating
        // client's local merge state updates from the socket event without
        // needing an extra refetch. The client listener upserts idempotently.
        if (socketService) socketService.broadcastTableMergeCreated(merge);

        res.status(201).json(merge);
    } catch (err) {
        console.error('Error creating table merge:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /table-merges  body: { date, shift, primary_id }
app.delete('/table-merges', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, primary_id } = req.body;
        if (!date || !shift || primary_id == null) {
            return res.status(400).json({ error: 'date, shift and primary_id are required' });
        }
        const result = await queryWithRetry(
            `DELETE FROM table_merges
             WHERE date = $1 AND shift = $2 AND primary_id = $3
             RETURNING id, date, shift, primary_id, merged_ids`,
            [date, shift, primary_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Merge not found' });
        }
        const deleted = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.TABLE,
                primary_id,
                `Unmerge ${date} ${shift}`,
                { date, shift }
            );
        }

        if (socketService) socketService.broadcastTableMergeDeleted(deleted);

        res.json(deleted);
    } catch (err) {
        console.error('Error deleting table merge:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ============================================
// PER-SHIFT HIDDEN TABLES
// ============================================

// GET /table-hidden?date=YYYY-MM-DD&shift=LUNCH|DINNER
// If neither param is supplied, returns future overrides (or all with scope=all)
// ordered by (date, shift) — used by the "Chiusure programmate" panel.
app.get('/table-hidden', authenticate, async (req, res) => {
    try {
        const { date, shift, scope } = req.query;
        if (date || shift) {
            if (!date || !shift) {
                return res.status(400).json({ error: 'date and shift query params are required together' });
            }
            if (shift !== 'LUNCH' && shift !== 'DINNER') {
                return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
            }
            const result = await queryWithRetry(
                'SELECT id, date, shift, table_id FROM table_hidden_overrides WHERE date = $1 AND shift = $2',
                [date, shift]
            );
            return res.json(result.rows);
        }
        const whereClause = scope === 'all' ? '' : 'WHERE date >= CURRENT_DATE';
        const result = await queryWithRetry(
            `SELECT id, date, shift, table_id FROM table_hidden_overrides ${whereClause}
             ORDER BY date ASC, shift ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching hidden tables:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /table-hidden body: { date, shift, table_id }
// Refuses to hide a table that has a reservation or is in an active merge
// for the same (date, shift) — caller must reassign/split first.
app.post('/table-hidden', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, table_id } = req.body;
        if (!date || !shift || table_id == null) {
            return res.status(400).json({ error: 'date, shift and table_id are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }

        // Block if a reservation is on this table for the given date+shift.
        const reservationCheck = await queryWithRetry(
            `SELECT id, customer_name FROM reservations
             WHERE table_id = $1
               AND shift = $2
               AND DATE(reservation_time AT TIME ZONE 'Europe/Rome') = $3`,
            [table_id, shift, date]
        );
        if (reservationCheck.rowCount && reservationCheck.rowCount > 0) {
            return res.status(409).json({
                error: 'Tavolo con prenotazioni',
                detail: `Il tavolo ha ${reservationCheck.rowCount} prenotazione/i per questo turno. Riassegnale prima di nascondere il tavolo.`,
                blocking_reservation_ids: reservationCheck.rows.map((r: any) => r.id),
            });
        }

        // Block if the table participates in an active merge for the given date+shift,
        // either as primary or inside merged_ids.
        const mergeCheck = await queryWithRetry(
            `SELECT id, primary_id, merged_ids FROM table_merges
             WHERE date = $1 AND shift = $2 AND ($3 = primary_id OR $3 = ANY(merged_ids))`,
            [date, shift, table_id]
        );
        if (mergeCheck.rowCount && mergeCheck.rowCount > 0) {
            return res.status(409).json({
                error: 'Tavolo unito',
                detail: 'Il tavolo fa parte di un\'unione attiva per questo turno. Dividi prima di nascondere.',
            });
        }

        const result = await queryWithRetry(
            `INSERT INTO table_hidden_overrides (date, shift, table_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (date, shift, table_id) DO UPDATE SET date = EXCLUDED.date
             RETURNING id, date, shift, table_id`,
            [date, shift, table_id]
        );
        const hidden = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.TABLE,
                table_id,
                `Hide ${date} ${shift}`,
                { date, shift }
            );
        }

        if (socketService) socketService.broadcastTableHiddenCreated(hidden);

        res.status(201).json(hidden);
    } catch (err) {
        console.error('Error hiding table:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /table-hidden body: { date, shift, table_id }
app.delete('/table-hidden', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, table_id } = req.body;
        if (!date || !shift || table_id == null) {
            return res.status(400).json({ error: 'date, shift and table_id are required' });
        }
        const result = await queryWithRetry(
            `DELETE FROM table_hidden_overrides
             WHERE date = $1 AND shift = $2 AND table_id = $3
             RETURNING id, date, shift, table_id`,
            [date, shift, table_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Hidden override not found' });
        }
        const deleted = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.TABLE,
                table_id,
                `Unhide ${date} ${shift}`,
                { date, shift }
            );
        }

        if (socketService) socketService.broadcastTableHiddenDeleted(deleted);

        res.json(deleted);
    } catch (err) {
        console.error('Error unhiding table:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ============================================
// PER-SHIFT ROOM CLOSURE
// ============================================

// GET /room-closed?date=YYYY-MM-DD&shift=LUNCH|DINNER
// If neither param is supplied, returns all future overrides ordered by
// (date, shift) so the "Chiusure programmate" panel can render the aggregate
// list without one round-trip per (date, shift) tuple.
app.get('/room-closed', authenticate, async (req, res) => {
    try {
        const { date, shift, scope } = req.query;
        if (date || shift) {
            if (!date || !shift) {
                return res.status(400).json({ error: 'date and shift query params are required together' });
            }
            if (shift !== 'LUNCH' && shift !== 'DINNER') {
                return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
            }
            const result = await queryWithRetry(
                'SELECT id, date, shift, room_id FROM room_closed_overrides WHERE date = $1 AND shift = $2',
                [date, shift]
            );
            return res.json(result.rows);
        }
        // Aggregate list. scope=all returns everything, otherwise only future
        // (date >= today) rows so the panel defaults to what's actionable.
        const whereClause = scope === 'all' ? '' : 'WHERE date >= CURRENT_DATE';
        const result = await queryWithRetry(
            `SELECT id, date, shift, room_id FROM room_closed_overrides ${whereClause}
             ORDER BY date ASC, shift ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching room closed overrides:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /room-closed body: { date, shift, room_id }
// Refuses to close a room that has active reservations (not CANCELLED /
// DECLINED) for the same (date, shift) — caller must reassign/cancel first.
app.post('/room-closed', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, room_id } = req.body;
        if (!date || !shift || room_id == null) {
            return res.status(400).json({ error: 'date, shift and room_id are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }

        // Block if any active reservation is on a table of this room for the
        // given date+shift. Uses the same "active" semantics as public/rooms:
        // CANCELLED and DECLINED don't count.
        const reservationCheck = await queryWithRetry(
            `SELECT res.id, res.customer_name
             FROM reservations res
             JOIN tables t ON t.id = res.table_id
             WHERE t.room_id = $1
               AND res.shift = $2
               AND DATE(res.reservation_time AT TIME ZONE 'Europe/Rome') = $3
               AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')`,
            [room_id, shift, date]
        );
        if (reservationCheck.rowCount && reservationCheck.rowCount > 0) {
            return res.status(409).json({
                error: 'Sala con prenotazioni',
                detail: `La sala ha ${reservationCheck.rowCount} prenotazione/i attive per questo turno. Riassegnale prima di chiudere la sala.`,
                blocking_reservation_ids: reservationCheck.rows.map((r: any) => r.id),
            });
        }

        const result = await queryWithRetry(
            `INSERT INTO room_closed_overrides (date, shift, room_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (date, shift, room_id) DO UPDATE SET date = EXCLUDED.date
             RETURNING id, date, shift, room_id`,
            [date, shift, room_id]
        );
        const closed = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.ROOM,
                room_id,
                `Close ${date} ${shift}`,
                { date, shift }
            );
        }

        if (socketService) socketService.broadcastRoomClosedCreated(closed);

        res.status(201).json(closed);
    } catch (err) {
        console.error('Error closing room:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /room-closed body: { date, shift, room_id }
app.delete('/room-closed', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { date, shift, room_id } = req.body;
        if (!date || !shift || room_id == null) {
            return res.status(400).json({ error: 'date, shift and room_id are required' });
        }
        const result = await queryWithRetry(
            `DELETE FROM room_closed_overrides
             WHERE date = $1 AND shift = $2 AND room_id = $3
             RETURNING id, date, shift, room_id`,
            [date, shift, room_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Room closed override not found' });
        }
        const deleted = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.ROOM,
                room_id,
                `Reopen ${date} ${shift}`,
                { date, shift }
            );
        }

        if (socketService) socketService.broadcastRoomClosedDeleted(deleted);

        res.json(deleted);
    } catch (err) {
        console.error('Error reopening room:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Rooms - require authentication
app.get('/rooms', authenticate, async (req, res) => {
    try {
        // Custom display order: Veranda, Macine, Fiume, Fuori, Tettoia, Pergolato.
        // Names not in the list fall to the end, alphabetically.
        const result = await queryWithRetry(`
            SELECT * FROM rooms
            ORDER BY
                CASE LOWER(TRIM(name))
                    WHEN 'veranda'   THEN 1
                    WHEN 'macine'    THEN 2
                    WHEN 'fiume'     THEN 3
                    WHEN 'fuori'     THEN 4
                    WHEN 'tettoia'   THEN 5
                    WHEN 'pergolato' THEN 6
                    ELSE 99
                END,
                name
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/rooms', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { name, width, height } = req.body;
        const result = await queryWithRetry(
            'INSERT INTO rooms (name, width, height) VALUES ($1, $2, $3) RETURNING *',
            [name, width, height]
        );
        const newRoom = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.ROOM,
                newRoom.id,
                name,
                { width, height }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastRoomCreated(newRoom);

        res.status(201).json(newRoom);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.patch('/rooms/:id', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { is_closed } = req.body;
        if (typeof is_closed !== 'boolean') {
            return res.status(400).json({ error: 'is_closed must be boolean' });
        }
        const result = await queryWithRetry(
            'UPDATE rooms SET is_closed = $1 WHERE id = $2 RETURNING *',
            [is_closed, id]
        );
        const updatedRoom = result.rows[0];
        if (!updatedRoom) {
            return res.status(404).json({ error: 'Room not found' });
        }

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.ROOM,
                parseInt(id, 10),
                updatedRoom.name,
                { is_closed }
            );
        }

        if (socketService) socketService.broadcastRoomUpdated(updatedRoom);

        res.json(updatedRoom);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/rooms/:id', authenticate, requirePermission('floorplan:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get room name before deleting
        const existing = await queryWithRetry('SELECT name FROM rooms WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await queryWithRetry('DELETE FROM rooms WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.ROOM,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastRoomDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Dishes - require authentication
app.get('/dishes', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM dishes ORDER BY category, name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/dishes', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { name, description, price, category, allergens, photo_url } = req.body;
        const result = await queryWithRetry(
            'INSERT INTO dishes (name, description, price, category, allergens, photo_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [name, description, price, category, allergens, photo_url || null]
        );
        const newDish = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.DISH,
                newDish.id,
                name,
                { price, category }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishCreated(newDish);

        res.status(201).json(newDish);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/dishes/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, category, allergens, photo_url } = req.body;
        const result = await queryWithRetry(
            'UPDATE dishes SET name = $1, description = $2, price = $3, category = $4, allergens = $5, photo_url = $6 WHERE id = $7 RETURNING *',
            [name, description, price, category, allergens, photo_url || null, id]
        );
        const updatedDish = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.DISH,
                parseInt(id, 10),
                name,
                { price, category }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishUpdated(updatedDish);

        res.json(updatedDish);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/dishes/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get dish name before deleting
        const existing = await queryWithRetry('SELECT name FROM dishes WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await queryWithRetry('DELETE FROM dishes WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.DISH,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastDishDeleted(Number(id));

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ============================================
// BANQUET KITCHEN REMINDER TODOS
// ============================================
const BANQUET_REMINDER_WINDOWS = [72, 48, 24] as const;

const TODO_FULL_SELECT = `
    id,
    title,
    description,
    completed,
    priority,
    category,
    TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
    created_at as "createdAt",
    completed_at as "completedAt",
    linked_reservation_id as "linkedReservationId",
    linked_banquet_ids as "linkedBanquetIds",
    banquet_reminder_hours as "banquetReminderHours",
    auto_kind as "autoKind",
    assigned_to_user_id as "assignedToUserId",
    assigned_to_user_name as "assignedToUserName",
    assigned_to_team as "assignedToTeam",
    created_by_user_id as "createdByUserId",
    created_by_user_name as "createdByUserName"
`;

const computeReminderDueDate = (eventDateIso: string, hoursBefore: number): string => {
    const event = new Date(eventDateIso + 'T00:00:00Z');
    event.setUTCDate(event.getUTCDate() - hoursBefore / 24);
    return event.toISOString().substring(0, 10);
};

const formatItalianDateLong = (iso: string): string => {
    try {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    } catch { return iso; }
};

const buildReminderTitle = (eventDate: string, hoursBefore: number): string =>
    `Ordinare merce — banchetti del ${formatItalianDateLong(eventDate)} (${hoursBefore}h prima)`;

const buildReminderDescription = (eventDate: string): string =>
    `Ricorda di ordinare la merce necessaria per i banchetti programmati il ${formatItalianDateLong(eventDate)}.`;

const reminderPriority = (hoursBefore: number): 'LOW' | 'MEDIUM' | 'HIGH' => {
    if (hoursBefore <= 24) return 'HIGH';
    if (hoursBefore <= 48) return 'MEDIUM';
    return 'LOW';
};

async function addBanquetToReminders(banquetId: number, eventDate: string): Promise<void> {
    for (const hours of BANQUET_REMINDER_WINDOWS) {
        const dueDate = computeReminderDueDate(eventDate, hours);

        const existing = await queryWithRetry(`
            SELECT ${TODO_FULL_SELECT}
            FROM todos
            WHERE banquet_reminder_hours = $1
              AND due_date = $2
              AND assigned_to_team = 'KITCHEN'
              AND completed = false
            LIMIT 1
        `, [hours, dueDate]);

        if (existing.rows.length > 0) {
            const todo = existing.rows[0];
            const ids: number[] = Array.isArray(todo.linkedBanquetIds) ? todo.linkedBanquetIds : [];
            if (ids.includes(banquetId)) continue;
            const newIds = [...ids, banquetId];
            const updated = await queryWithRetry(`
                UPDATE todos
                SET linked_banquet_ids = $1, title = $2, description = $3
                WHERE id = $4
                RETURNING ${TODO_FULL_SELECT}
            `, [newIds, buildReminderTitle(eventDate, hours), buildReminderDescription(eventDate), todo.id]);
            if (socketService && updated.rows[0]) socketService.broadcastToAll('todo:updated', updated.rows[0]);
        } else {
            const created = await queryWithRetry(`
                INSERT INTO todos (
                    title, description, priority, category, due_date,
                    assigned_to_team, linked_banquet_ids, banquet_reminder_hours
                ) VALUES ($1, $2, $3, $4, $5, 'KITCHEN', $6, $7)
                RETURNING ${TODO_FULL_SELECT}
            `, [
                buildReminderTitle(eventDate, hours),
                buildReminderDescription(eventDate),
                reminderPriority(hours),
                'INVENTORY',
                dueDate,
                [banquetId],
                hours,
            ]);
            if (socketService && created.rows[0]) socketService.broadcastToAll('todo:created', created.rows[0]);
            if (created.rows[0]) {
                pushSendToRoles(
                    ['KITCHEN'],
                    {
                        category: 'system',
                        title: 'Promemoria cucina',
                        body: created.rows[0].title,
                        url: '/?view=DASHBOARD',
                        tag: `kitchen-reminder-${dueDate}-${hours}`,
                    }
                ).catch(err => console.error('Push (kitchen reminder) failed:', err));
            }
        }
    }
}

async function removeBanquetFromReminders(banquetId: number): Promise<void> {
    const todos = await queryWithRetry(`
        SELECT ${TODO_FULL_SELECT}
        FROM todos
        WHERE banquet_reminder_hours IS NOT NULL
          AND $1 = ANY(linked_banquet_ids)
    `, [banquetId]);

    for (const todo of todos.rows) {
        const ids: number[] = Array.isArray(todo.linkedBanquetIds) ? todo.linkedBanquetIds : [];
        const newIds = ids.filter((id: number) => id !== banquetId);

        if (newIds.length === 0) {
            await queryWithRetry('DELETE FROM todos WHERE id = $1', [todo.id]);
            if (socketService) socketService.broadcastToAll('todo:deleted', { id: todo.id });
        } else {
            const updated = await queryWithRetry(`
                UPDATE todos
                SET linked_banquet_ids = $1
                WHERE id = $2
                RETURNING ${TODO_FULL_SELECT}
            `, [newIds, todo.id]);
            if (socketService && updated.rows[0]) socketService.broadcastToAll('todo:updated', updated.rows[0]);
        }
    }
}

async function syncBanquetReminders(banquetId: number, newEventDate: string): Promise<void> {
    await removeBanquetFromReminders(banquetId);
    await addBanquetToReminders(banquetId, newEventDate);
}

// ============================================
// DAILY BREAD REMINDER (OWNER team, fires at 20:00 Europe/Rome)
// ============================================
const BREAD_AUTO_KIND = 'BREAD_DAILY';
const BREAD_TARGET_TZ = 'Europe/Rome';
const BREAD_TRIGGER_HOUR = 20;

const getItalianDateParts = (date: Date): { year: string; month: string; day: string; hour: string; minute: string } => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: BREAD_TARGET_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
};

const getItalianTodayIso = (date: Date = new Date()): string => {
    const { year, month, day } = getItalianDateParts(date);
    return `${year}-${month}-${day}`;
};

const addDaysIso = (iso: string, days: number): string => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
};

async function runDailyBreadReminder(targetRoles: string[] = ['OWNER']): Promise<void> {
    const todayIso = getItalianTodayIso();
    const tomorrowIso = addDaysIso(todayIso, 1);

    // Sum guests for tomorrow's covers. Banquets live in their own table
    // (banquet_menus, keyed by event_date) and are NOT stored as reservation
    // rows, so they must be added explicitly — otherwise a banquet's covers are
    // silently missing from the bread count.
    const result = await queryWithRetry(
        `SELECT (
            COALESCE((
                SELECT SUM(guests) FROM reservations
                WHERE DATE(reservation_time) = $1
                  AND COALESCE(reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
            ), 0)
            + COALESCE((
                SELECT SUM(guests) FROM banquet_menus
                WHERE event_date = $1
            ), 0)
         )::int AS total`,
        [tomorrowIso]
    );
    const totalGuests: number = result.rows[0]?.total ?? 0;
    const kg = Math.max(1, Math.ceil(totalGuests / 10));

    const tomorrowPretty = formatItalianDateLong(tomorrowIso);
    const title = totalGuests > 0
        ? `Ordinare ${kg} kg di pane per domani (${totalGuests} coperti)`
        : `Ordinare pane per domani (nessuna prenotazione)`;
    const description = totalGuests > 0
        ? `Pane previsto per ${tomorrowPretty}: ${kg} kg (1 kg ogni 10 coperti, ${totalGuests} coperti previsti).`
        : `Nessuna prenotazione registrata per ${tomorrowPretty}. Valutare se ordinare comunque una scorta minima.`;

    // Upsert: one OWNER bread reminder per due_date
    const existing = await queryWithRetry(`
        SELECT ${TODO_FULL_SELECT}
        FROM todos
        WHERE auto_kind = $1
          AND due_date = $2
          AND assigned_to_team = 'OWNER'
        LIMIT 1
    `, [BREAD_AUTO_KIND, tomorrowIso]);

    // Upsert the todo record. Skip only if the todo already exists AND has
    // been completed by the owner — in that case they've already acted on
    // it and re-firing the notification would be spam.
    let todoAlreadyDone = false;
    if (existing.rows.length > 0) {
        const todo = existing.rows[0];
        if (todo.completed) {
            todoAlreadyDone = true;
        } else {
            const updated = await queryWithRetry(`
                UPDATE todos
                SET title = $1, description = $2
                WHERE id = $3
                RETURNING ${TODO_FULL_SELECT}
            `, [title, description, todo.id]);
            if (socketService && updated.rows[0]) socketService.broadcastToAll('todo:updated', updated.rows[0]);
        }
    } else {
        const created = await queryWithRetry(`
            INSERT INTO todos (
                title, description, priority, category, due_date,
                assigned_to_team, auto_kind
            ) VALUES ($1, $2, 'HIGH', 'INVENTORY', $3, 'OWNER', $4)
            RETURNING ${TODO_FULL_SELECT}
        `, [title, description, tomorrowIso, BREAD_AUTO_KIND]);
        if (socketService && created.rows[0]) socketService.broadcastToAll('todo:created', created.rows[0]);
    }

    // Always fire the push (unless the todo is already completed): the push
    // IS the reminder. Previously the push lived inside the INSERT branch,
    // so if a prior tick had already created tomorrow's todo (e.g. after a
    // deploy at midnight) the operator never got the notification when the
    // reminder was actually scheduled to fire. Tag stays stable per day so
    // the browser (and our notifications table) deduplicate on retries.
    if (!todoAlreadyDone) {
        const roles = (targetRoles && targetRoles.length > 0) ? targetRoles : ['OWNER'];
        pushSendToRoles(
            roles,
            {
                category: 'system',
                title: 'Promemoria pane',
                body: title,
                url: '/?view=DASHBOARD',
                tag: `bread-${tomorrowIso}`,
            }
        ).catch(err => console.error('Push (bread reminder) failed:', err));
    }
    console.log(`🥖 Bread reminder for ${tomorrowIso}: ${kg}kg (${totalGuests} coperti)`);
}

// Pay-at-table reconcile: every 60s scans CLAIMED splits whose 5-min TTL
// has elapsed and either (a) polls the gateway to see if a webhook was
// dropped, (b) marks the split ABANDONED so its capacity is released.
// Runs in-process because we're already single-instance on Railway; if
// that changes, wrap the loop with an advisory lock so only one node
// processes each split.
const startBillSplitReconcileScheduler = () => {
    const tick = async () => {
        try {
            const stale = await queryWithRetry(
                `SELECT s.id AS split_id, s.payment_request_id,
                        pr.provider, pr.provider_order_id
                 FROM table_bill_splits s
                 LEFT JOIN payment_requests pr ON pr.id = s.payment_request_id
                 WHERE s.status = 'CLAIMED'
                   AND s.expires_at IS NOT NULL
                   AND s.expires_at < NOW()
                 LIMIT 50`
            );
            if (stale.rowCount === 0) return;

            for (const row of stale.rows) {
                const orderId: string | null = row.provider_order_id || null;
                // Talk to the provider that created this order, whatever is
                // active now.
                const provider: PaymentProvider = isPaymentProvider(row.provider) ? row.provider : 'revolut';
                let handled = false;

                // Recover missed webhook: ask the gateway what state the
                // order is really in and reapply the transition.
                if (orderId) {
                    try {
                        const fetched = await fetchPaymentOrder(provider, orderId);
                        if (fetched.event) {
                            await applyPaymentOrderTransition(orderId, fetched.event, transitionMetadata(provider, fetched.raw));
                            handled = true;
                        } else {
                            // Order still payable (PENDING/AUTHORISED-ish).
                            // CANCEL it before freeing the capacity: an
                            // abandoned claim with a live checkout lets the
                            // guest pay a share someone else re-claims →
                            // double incasso (successo davvero, conto #12).
                            try {
                                await cancelPaymentOrder(provider, orderId);
                                await applyPaymentOrderTransition(orderId, 'ORDER_CANCELLED');
                                handled = true;
                            } catch (cancelErr: any) {
                                // Cancel refused: maybe it completed in the
                                // race window. Re-read and apply the truth;
                                // if the gateway is unreachable keep the
                                // claim — next tick retries. NEVER free
                                // capacity while a payable order is out there.
                                try {
                                    const fresh = await fetchPaymentOrder(provider, orderId);
                                    if (fresh.event) {
                                        await applyPaymentOrderTransition(orderId, fresh.event, transitionMetadata(provider, fresh.raw));
                                    } else {
                                        console.warn('[bill-reconcile] cancel failed, order still', fresh.state, '— will retry split', row.split_id);
                                    }
                                } catch (_) {
                                    console.warn('[bill-reconcile] cancel+refetch failed for split', row.split_id, cancelErr?.message || cancelErr);
                                }
                                handled = true; // retried next tick; don't fall through to blind ABANDON
                            }
                        }
                    } catch (err: any) {
                        // Gateway unreachable: keep the claim and retry next
                        // tick rather than abandoning with a live checkout.
                        console.warn('[bill-reconcile] order lookup failed for split', row.split_id, err?.message || err);
                        handled = true;
                    }
                }

                // Fallback: only for splits with NO linked order (order
                // creation had failed at claim time) — nothing payable
                // exists, so freeing the capacity is safe.
                if (!handled) {
                    const upd = await queryWithRetry(
                        `UPDATE table_bill_splits
                         SET status = 'ABANDONED'
                         WHERE id = $1 AND status = 'CLAIMED'
                         RETURNING id, table_bill_id`,
                        [row.split_id]
                    );
                    if ((upd.rowCount ?? 0) > 0) {
                        try {
                            socketService?.broadcastToAll('bill:split-abandoned', {
                                bill_id: upd.rows[0].table_bill_id,
                                split_id: upd.rows[0].id,
                            });
                        } catch (_) {}
                    }
                }
            }
        } catch (err: any) {
            console.error('[bill-reconcile] scheduler tick failed:', err?.message || err);
        }
    };
    tick();
    setInterval(tick, 60 * 1000);
};

// Payment reconcile: every 2 minutes, poll the gateway for payment_requests
// that are still open and apply whatever transition the provider reports.
//
// Why this exists: webhooks are best-effort. Revolut signs and retries its
// own, but SumUp's notification is an unsigned POST to the `return_url` we
// register per checkout, with no delivery guarantee — and one that never
// arrives (bad CRM_APP_BASE_URL, a deploy restart mid-delivery, a network
// blip) used to leave a *paid* deposit stuck on "In attesa" forever, because
// nothing else ever re-checked it. Bill splits already had a poller; standalone
// payment links had none. This closes that gap for both providers.
//
// Split-linked rows are skipped: startBillSplitReconcileScheduler owns those,
// and its cancel-before-abandon logic must stay the only writer for them.
// Bounded by age and row count so the job stays cheap: abandoned checkouts
// nobody ever paid shouldn't be polled forever.
const startPaymentRequestReconcileScheduler = () => {
    const tick = async () => {
        try {
            const open = await queryWithRetry(
                `SELECT id, provider, provider_order_id
                 FROM payment_requests
                 WHERE status IN ('PENDING', 'AUTHORISED')
                   AND provider_order_id IS NOT NULL
                   AND table_bill_split_id IS NULL
                   AND created_at > NOW() - INTERVAL '3 days'
                 ORDER BY created_at DESC
                 LIMIT 25`
            );
            if (open.rowCount === 0) return;

            for (const row of open.rows) {
                if (!isPaymentProvider(row.provider)) continue;
                const provider: PaymentProvider = row.provider;
                try {
                    if (!(await isProviderConfigured(provider))) continue;
                    const fetched = await fetchPaymentOrder(provider, row.provider_order_id);
                    if (!fetched.event) continue; // still genuinely pending
                    const result = await applyPaymentOrderTransition(
                        row.provider_order_id,
                        fetched.event,
                        transitionMetadata(provider, fetched.raw)
                    );
                    if (result.status === 'applied') {
                        console.log(
                            `[payment-reconcile] payment ${row.id} (${provider}) → ${fetched.state}`,
                            result.isFirstCompletion ? '(first completion)' : ''
                        );
                    }
                } catch (err: any) {
                    // Gateway unreachable or the order is unknown to it: log
                    // and move on, the next tick retries.
                    console.warn(`[payment-reconcile] payment ${row.id} lookup failed:`, err?.message || err);
                }
            }
        } catch (err: any) {
            console.error('[payment-reconcile] scheduler tick failed:', err?.message || err);
        }
    };
    tick();
    setInterval(tick, 2 * 60 * 1000);
};

// Registry of hardcoded handlers for reminders that need dynamic content
// (e.g. Pane computes kg from tomorrow's coperti at fire time). Keyed by
// the `system_key` column; a reminder row with a matching key delegates
// firing to the handler, so title/description edits in the UI don't
// clobber the auto-computed body. Rows without a system_key just push
// their stored title/description verbatim.
type ReminderHandler = (reminder: ReminderRow) => Promise<void>;
const SYSTEM_REMINDER_HANDLERS: Record<string, ReminderHandler> = {
    // Forward the reminder's target_roles so the operator's Impostazioni
    // choice ("Chi riceve?") is honoured by the system handler as well.
    BREAD_DAILY: async (r) => { await runDailyBreadReminder(r.target_roles); },
};

interface ReminderRow {
    id: number;
    title: string;
    description: string | null;
    kind: 'ONE_OFF' | 'RECURRING';
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | null;
    schedule_time: string;      // 'HH:MM'
    schedule_date: string | null; // 'YYYY-MM-DD' (ONE_OFF)
    weekdays: string[] | null;    // ['MON','TUE',...] (WEEKLY)
    month_day: number | null;     // 1..28 (MONTHLY)
    target_roles: string[];
    active: boolean;
    system_key: string | null;
    last_run_at: Date | null;
}

const WEEKDAY_CODES = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

// Decide if a reminder should fire NOW (current Italian time), given its
// schedule + last_run_at. Returns true when:
//   - schedule_time has already passed for today AND
//   - the applicable day-of-week / day-of-month / date matches today AND
//   - the reminder didn't already fire today
// The "already fired today" check is what protects against re-firing at
// every 5-min tick after the trigger hour.
function isReminderDue(r: ReminderRow, now: Date): boolean {
    const { year, month, day, hour, minute } = getItalianDateParts(now);
    const todayIso = `${year}-${month}-${day}`;
    const [schedH, schedM] = r.schedule_time.split(':').map(x => parseInt(x, 10));
    if (!Number.isFinite(schedH) || !Number.isFinite(schedM)) return false;
    const nowMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);
    const schedMinutes = schedH * 60 + schedM;
    if (nowMinutes < schedMinutes) return false;

    // Compare last_run_at as YYYY-MM-DD in Italian time — a fire earlier
    // today (from a previous tick) means "already done".
    if (r.last_run_at) {
        const lastParts = getItalianDateParts(r.last_run_at);
        if (`${lastParts.year}-${lastParts.month}-${lastParts.day}` === todayIso) return false;
    }

    if (r.kind === 'ONE_OFF') {
        return r.schedule_date === todayIso;
    }
    // RECURRING
    if (r.frequency === 'DAILY') return true;
    if (r.frequency === 'WEEKLY') {
        if (!r.weekdays || r.weekdays.length === 0) return false;
        const dow = new Date(`${todayIso}T00:00:00Z`).getUTCDay();
        return r.weekdays.includes(WEEKDAY_CODES[dow]);
    }
    if (r.frequency === 'MONTHLY') {
        return r.month_day === parseInt(day, 10);
    }
    return false;
}

async function fireReminder(r: ReminderRow): Promise<void> {
    const handler = r.system_key ? SYSTEM_REMINDER_HANDLERS[r.system_key] : undefined;
    if (handler) {
        await handler(r);
    } else {
        // Generic path: push the reminder's own title/description to the
        // chosen target roles. Body falls back to title if description is
        // empty so the push isn't rendered blank.
        const roles = (r.target_roles && r.target_roles.length > 0) ? r.target_roles : ['OWNER'];
        await pushSendToRoles(roles, {
            category: 'system',
            title: r.title,
            body: r.description || r.title,
            url: '/?view=DASHBOARD',
            tag: `reminder-${r.id}-${new Date().toISOString().slice(0, 10)}`,
        }).catch(err => console.error(`Reminder ${r.id} push failed:`, err));
    }
}

const startRemindersScheduler = () => {
    const tick = async () => {
        try {
            const result = await queryWithRetry(
                `SELECT id, title, description, kind, frequency, schedule_time,
                        to_char(schedule_date, 'YYYY-MM-DD') AS schedule_date,
                        weekdays, month_day, target_roles, active, system_key, last_run_at
                 FROM reminders
                 WHERE active = TRUE`
            );
            const now = new Date();
            for (const row of result.rows as ReminderRow[]) {
                if (!isReminderDue(row, now)) continue;
                try {
                    await fireReminder(row);
                    await queryWithRetry(
                        `UPDATE reminders
                         SET last_run_at = CURRENT_TIMESTAMP,
                             active = CASE WHEN kind = 'ONE_OFF' THEN FALSE ELSE active END,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1`,
                        [row.id]
                    );
                    console.log(`⏰ Reminder fired: #${row.id} "${row.title}" (kind=${row.kind}, system_key=${row.system_key ?? '-'})`);
                } catch (err) {
                    console.error(`Reminder #${row.id} fire failed:`, err);
                }
            }
        } catch (err) {
            console.error('Reminders scheduler error:', err);
        }
    };
    tick();
    setInterval(tick, 5 * 60 * 1000);
};

// ============================================
// CUSTOMERS (rubrica) - require authentication
// ============================================

// Title-case Italian names: "MARIO ROSSI" / "mario rossi" / "d'angelo"
// → "Mario Rossi" / "Mario Rossi" / "D'Angelo". Splits on whitespace,
// apostrophes (' and ’) and hyphens, preserving the separators.
const normalizeCustomerName = (raw: string): string => {
    return raw
        .toLowerCase()
        .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
};

// Auto-add the reservation contact to the rubrica when a phone is provided and
// no customer with the same digits-only phone already exists. Failures are
// swallowed: the reservation save must succeed even if this side-effect fails.
const upsertCustomerFromReservation = async (
    customerName: string | null | undefined,
    phone: string | null | undefined,
    email: string | null | undefined,
    actor: { userId: number; email: string } | null | undefined
): Promise<void> => {
    try {
        if (!phone || !String(phone).trim()) return;
        if (!customerName || !String(customerName).trim()) return;
        const trimmedPhone = String(phone).trim();
        const phoneDigits = trimmedPhone.replace(/\D/g, '');
        if (!phoneDigits) return;

        const existing = await queryWithRetry(
            `SELECT id FROM customers
             WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
             LIMIT 1`,
            [phoneDigits]
        );
        if (existing.rows.length > 0) return;

        const inserted = await queryWithRetry(
            `INSERT INTO customers (name, phone, email)
             VALUES ($1, $2, $3)
             RETURNING id, name`,
            [
                normalizeCustomerName(String(customerName).trim()),
                trimmedPhone,
                email && String(email).trim() ? String(email).trim() : null,
            ]
        );
        const newCustomer = inserted.rows[0];

        if (actor && newCustomer) {
            LogService.logActivity(
                actor.userId,
                actor.email,
                actor.email,
                ActivityAction.CREATE,
                ResourceType.CUSTOMER,
                newCustomer.id,
                newCustomer.name,
                { source: 'reservation_autosave' }
            );
        }
    } catch (err) {
        console.error('upsertCustomerFromReservation failed:', err);
    }
};

// Propagate the marketing consent captured at booking to the customer rubrica
// (matched by phone-digits) so it can be used to filter marketing sends. Only
// runs when an explicit boolean was provided. Side-effect — never throws.
const setCustomerMarketingConsent = async (
    phone: string | null | undefined,
    consent: boolean | null | undefined
): Promise<void> => {
    try {
        if (consent === null || consent === undefined) return;
        if (!phone || !String(phone).trim()) return;
        const phoneDigits = String(phone).replace(/\D/g, '');
        if (!phoneDigits) return;
        await queryWithRetry(
            `UPDATE customers
             SET consent_marketing = $2, consent_marketing_updated_at = CURRENT_TIMESTAMP
             WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1`,
            [phoneDigits, consent]
        );
    } catch (err) {
        console.error('setCustomerMarketingConsent failed:', err);
    }
};

// Keep the rubrica name in sync when a reservation is renamed. Looks up the
// customer by phone-digits match and updates the name (and email if newly
// provided) when they differ. Failures are swallowed.
const syncCustomerFromReservation = async (
    customerName: string | null | undefined,
    phone: string | null | undefined,
    email: string | null | undefined,
    actor: { userId: number; email: string } | null | undefined
): Promise<void> => {
    try {
        if (!phone || !String(phone).trim()) return;
        if (!customerName || !String(customerName).trim()) return;
        const phoneDigits = String(phone).trim().replace(/\D/g, '');
        if (!phoneDigits) return;

        const existing = await queryWithRetry(
            `SELECT id, name, email FROM customers
             WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
             LIMIT 1`,
            [phoneDigits]
        );
        if (existing.rows.length === 0) return;

        const current = existing.rows[0];
        const normalizedName = normalizeCustomerName(String(customerName).trim());
        const newEmail = email && String(email).trim() ? String(email).trim() : null;

        const nameChanged = normalizedName !== current.name;
        const emailChanged = newEmail && newEmail !== current.email;

        if (!nameChanged && !emailChanged) return;

        await queryWithRetry(
            `UPDATE customers SET
                name = $1,
                email = COALESCE($2, email),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [normalizedName, newEmail, current.id]
        );

        if (actor) {
            LogService.logActivity(
                actor.userId,
                actor.email,
                actor.email,
                ActivityAction.UPDATE,
                ResourceType.CUSTOMER,
                current.id,
                normalizedName,
                { source: 'reservation_sync', previous_name: current.name }
            );
        }
    } catch (err) {
        console.error('syncCustomerFromReservation failed:', err);
    }
};

app.get('/customers', authenticate, requirePermission('customers:view'), async (req, res) => {
    try {
        const { q, limit } = req.query as { q?: string; limit?: string };
        // Bumped from 500/1000 to 5000/10000 after 245 customers (alphabetically
        // past the old cap) went invisible on the frontend list — data was in
        // the DB, just paginated out. Rubrica is a private endpoint on a
        // relatively small table, no need to be stingy.
        const cap = Math.min(Math.max(parseInt(limit || '5000', 10) || 5000, 1), 10000);
        // Sub-select counts past NO_SHOW reservations matching this customer's phone.
        // Phone is required on rubrica records, so this is the reliable identifier.
        const noShowSubquery = `(
            SELECT COUNT(*)::int
            FROM reservations r
            WHERE r.reservation_status = 'NO_SHOW'
              AND r.phone IS NOT NULL
              AND REGEXP_REPLACE(r.phone, '\\D', '', 'g') = REGEXP_REPLACE(c.phone, '\\D', '', 'g')
        ) AS no_show_count`;
        if (q && q.trim()) {
            const term = `%${q.trim().toLowerCase()}%`;
            const result = await queryWithRetry(
                `SELECT id, name, phone, email, address, city, postal_code, notes, created_at, updated_at,
                        preferred_table_id, preferences_notes, dietary_notes, is_vip,
                        consent_marketing, consent_marketing_updated_at,
                        ${noShowSubquery}
                 FROM customers c
                 WHERE phone IS NOT NULL AND TRIM(phone) <> ''
                   AND (LOWER(name) LIKE $1 OR LOWER(phone) LIKE $1 OR LOWER(COALESCE(email, '')) LIKE $1)
                 ORDER BY name
                 LIMIT $2`,
                [term, cap]
            );
            return res.json(result.rows);
        }
        const result = await queryWithRetry(
            `SELECT id, name, phone, email, address, city, postal_code, notes, created_at, updated_at,
                    preferred_table_id, preferences_notes, dietary_notes, is_vip,
                    consent_marketing, consent_marketing_updated_at,
                    ${noShowSubquery}
             FROM customers c
             WHERE phone IS NOT NULL AND TRIM(phone) <> ''
             ORDER BY name
             LIMIT $1`,
            [cap]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /customers error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Marketing audience — the ONLY sanctioned entry point for promotional sends.
// By construction it returns just the customers who (a) gave marketing consent
// and (b) have a usable channel, so non-consenting contacts are excluded
// automatically. Disabled when the legal layer runs in "simple" mode.
app.get('/customers/marketing-audience', authenticate, requirePermission('customers:view'), async (_req, res) => {
    try {
        const legal = await getLegalConfig();
        if (legal.legal_mode !== 'advanced') {
            return res.status(409).json({
                error: 'marketing_disabled',
                message: 'La modalità legale è impostata su "semplice": i flussi di marketing sono disattivati.',
            });
        }
        const result = await queryWithRetry(
            `SELECT id, name, phone, email, consent_marketing_updated_at
             FROM customers
             WHERE consent_marketing = TRUE
               AND ((phone IS NOT NULL AND TRIM(phone) <> '') OR (email IS NOT NULL AND TRIM(email) <> ''))
             ORDER BY name`
        );
        res.json({ mode: legal.legal_mode, count: result.rows.length, recipients: result.rows });
    } catch (err) {
        console.error('GET /customers/marketing-audience error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/customers', authenticate, requirePermission('customers:full'), async (req, res) => {
    try {
        const { name, phone, email, address, city, postal_code, notes, preferred_table_id, preferences_notes, dietary_notes, is_vip } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        if (!phone || !String(phone).trim()) {
            return res.status(400).json({ error: 'phone is required' });
        }

        const normalizedPreferredTableId: number | null = preferred_table_id != null && preferred_table_id !== '' && Number.isFinite(Number(preferred_table_id))
            ? Number(preferred_table_id)
            : null;
        const normalizedIsVip: boolean = is_vip === true || is_vip === 'true';

        // Dedupe on the digit-only form of the phone — strips spaces, "+",
        // dashes, etc. so "+39 333 1234567" and "3331234567" match. Phone
        // is required, so it's a reliable identifier.
        const trimmedPhone = String(phone).trim();
        const phoneDigits = trimmedPhone.replace(/\D/g, '');
        if (phoneDigits) {
            const existing = await queryWithRetry(
                `SELECT id, name, phone, email, address, city, postal_code, notes, created_at, updated_at,
                        preferred_table_id, preferences_notes, dietary_notes, is_vip
                 FROM customers
                 WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
                 LIMIT 1`,
                [phoneDigits]
            );
            if (existing.rows.length > 0) {
                return res.status(200).json(existing.rows[0]);
            }
        }

        const result = await queryWithRetry(
            `INSERT INTO customers (name, phone, email, address, city, postal_code, notes, preferred_table_id, preferences_notes, dietary_notes, is_vip)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, name, phone, email, address, city, postal_code, notes, created_at, updated_at,
                       preferred_table_id, preferences_notes, dietary_notes, is_vip`,
            [
                normalizeCustomerName(String(name).trim()),
                trimmedPhone || null,
                email ? String(email).trim() : null,
                address ?? null,
                city ?? null,
                postal_code ?? null,
                notes ?? null,
                normalizedPreferredTableId,
                preferences_notes ?? null,
                dietary_notes ?? null,
                normalizedIsVip,
            ]
        );
        const newCustomer = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.CUSTOMER,
                newCustomer.id,
                newCustomer.name
            );
        }

        res.status(201).json(newCustomer);
    } catch (err: any) {
        console.error('POST /customers error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/customers/:id', authenticate, requirePermission('customers:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, email, address, city, postal_code, notes, preferred_table_id, preferences_notes, dietary_notes, is_vip } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        if (!phone || !String(phone).trim()) {
            return res.status(400).json({ error: 'phone is required' });
        }
        const normalizedPreferredTableId: number | null = preferred_table_id != null && preferred_table_id !== '' && Number.isFinite(Number(preferred_table_id))
            ? Number(preferred_table_id)
            : null;
        const normalizedIsVip: boolean = is_vip === true || is_vip === 'true';

        // Reject if another customer already owns this phone (digits-only match).
        // Without this, the UPDATE would silently create a duplicate that
        // breaks the reservation→customer JOIN (multiplies rows in the list).
        const trimmedPhone = String(phone).trim();
        const phoneDigits = trimmedPhone.replace(/\D/g, '');
        if (phoneDigits) {
            const conflict = await queryWithRetry(
                `SELECT id, name FROM customers
                 WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
                   AND id <> $2
                 LIMIT 1`,
                [phoneDigits, id]
            );
            if (conflict.rows.length > 0) {
                const other = conflict.rows[0];
                return res.status(409).json({
                    error: `Questo numero è già associato a "${other.name}" in rubrica.`,
                    existing_customer_id: other.id,
                    existing_customer_name: other.name,
                });
            }
        }

        // Transaction: update the customer row AND cascade the changed
        // name/phone into the reservations that were tagged with the old
        // phone. Reservations don't hold a FK to customers — the join is
        // by phone digits — so a name typo fix here wouldn't otherwise
        // propagate to the customer's booking history.
        const client = await pool.connect();
        let updated: any;
        let cascadedReservationIds: number[] = [];
        try {
            await client.query('BEGIN');
            const prev = await client.query(
                'SELECT name, phone, is_vip, preferred_table_id, dietary_notes, preferences_notes FROM customers WHERE id = $1 FOR UPDATE',
                [id]
            );
            if (prev.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Customer not found' });
            }
            const oldName = prev.rows[0].name || '';
            const oldPhone = prev.rows[0].phone || '';
            const oldPhoneDigits = oldPhone.replace(/\D/g, '');
            const newName = normalizeCustomerName(String(name).trim());
            const newPhone = phone ? String(phone).trim() : null;

            const result = await client.query(
                `UPDATE customers SET
                    name = $1,
                    phone = $2,
                    email = $3,
                    address = $4,
                    city = $5,
                    postal_code = $6,
                    notes = $7,
                    preferred_table_id = $8,
                    preferences_notes = $9,
                    dietary_notes = $10,
                    is_vip = $11,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = $12
                 RETURNING id, name, phone, email, address, city, postal_code, notes, created_at, updated_at,
                           preferred_table_id, preferences_notes, dietary_notes, is_vip`,
                [
                    newName,
                    newPhone,
                    email ? String(email).trim() : null,
                    address ?? null,
                    city ?? null,
                    postal_code ?? null,
                    notes ?? null,
                    normalizedPreferredTableId,
                    preferences_notes ?? null,
                    dietary_notes ?? null,
                    normalizedIsVip,
                    id,
                ]
            );
            updated = result.rows[0];

            // Propagate name/phone corrections to the reservations previously
            // filed under this customer. Match by phone digits (not exact
            // string) so historical rows with different formatting (e.g. old
            // "+39 " prefix) still get updated. Only touch reservations if
            // either field actually changed — avoid needless writes.
            const nameChanged = newName !== oldName;
            const phoneChanged = (newPhone || '') !== oldPhone;
            if (oldPhoneDigits.length >= 6 && (nameChanged || phoneChanged)) {
                const cascade = await client.query(
                    `UPDATE reservations
                     SET customer_name = $1,
                         phone = $2
                     WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $3
                     RETURNING id`,
                    [newName, newPhone, oldPhoneDigits]
                );
                cascadedReservationIds = cascade.rows.map(r => Number(r.id));
                if (cascade.rowCount && cascade.rowCount > 0) {
                    console.log(`[customers] cascade updated ${cascade.rowCount} reservations for customer #${id} (name: "${oldName}" → "${newName}", phone: "${oldPhone}" → "${newPhone || ''}")`);
                }
            }

            // The booking card also shows joined (not denormalized) customer
            // fields — VIP star, preferred-table chip, dietary/preference notes.
            // When only those change (name/phone untouched, so no cascade), the
            // reservation rows don't change but the joined values do; collect
            // the phone-matched reservations so they still re-broadcast and
            // re-render with the fresh join.
            const joinedFieldsChanged =
                normalizedIsVip !== (prev.rows[0].is_vip === true) ||
                normalizedPreferredTableId !== (prev.rows[0].preferred_table_id ?? null) ||
                (dietary_notes ?? null) !== (prev.rows[0].dietary_notes ?? null) ||
                (preferences_notes ?? null) !== (prev.rows[0].preferences_notes ?? null);
            if (cascadedReservationIds.length === 0 && joinedFieldsChanged && oldPhoneDigits.length >= 6) {
                const match = await client.query(
                    `SELECT id FROM reservations
                     WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1`,
                    [oldPhoneDigits]
                );
                cascadedReservationIds = match.rows.map(r => Number(r.id));
            }

            await client.query('COMMIT');
        } catch (txErr) {
            try { await client.query('ROLLBACK'); } catch { /* ignore */ }
            throw txErr;
        } finally {
            client.release();
        }

        // After the transaction commits, tell every connected client which
        // reservations changed so their booking cards update in place (the
        // denormalized customer_name/phone lives on the reservation row).
        await broadcastReservationsUpdatedByIds(cascadedReservationIds);

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.CUSTOMER,
                updated.id,
                updated.name
            );
        }

        res.json(updated);
    } catch (err: any) {
        console.error('PUT /customers/:id error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// List customer duplicates grouped by the last 10 digits of the phone. Used
// by the rubrica "Duplicati" panel to surface pairs that slipped past the
// per-row unique index (e.g. different country-code prefixes on the same
// underlying number).
app.get('/customers/duplicates', authenticate, requirePermission('customers:view'), async (_req, res) => {
    try {
        const result = await queryWithRetry(
            `WITH digits AS (
                 SELECT id,
                        regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') AS d
                 FROM customers
                 WHERE phone IS NOT NULL
                   AND length(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')) >= 8
             ),
             groups AS (
                 SELECT right(d, 10) AS key,
                        array_agg(id ORDER BY id) AS ids
                 FROM digits
                 GROUP BY right(d, 10)
                 HAVING count(*) > 1
             )
             SELECT g.key,
                    json_agg(
                        json_build_object(
                            'id', c.id,
                            'name', c.name,
                            'phone', c.phone,
                            'email', c.email,
                            'is_vip', c.is_vip,
                            'created_at', c.created_at,
                            'updated_at', c.updated_at
                        )
                        ORDER BY c.id
                    ) AS customers
             FROM groups g
             JOIN customers c ON c.id = ANY(g.ids)
             GROUP BY g.key
             ORDER BY g.key`
        );
        res.json({ groups: result.rows });
    } catch (err: any) {
        console.error('GET /customers/duplicates error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Merge one customer into another. Reservations linked to the source's phone
// are re-tagged to the target (so the merged customer keeps the history),
// banquet_menus are re-parented, and empty fields on the target are backfilled
// from the source before the source row is deleted.
app.post('/customers/:sourceId/merge-into/:targetId', authenticate, requirePermission('customers:full'), async (req, res) => {
    const sourceId = parseInt(req.params.sourceId, 10);
    const targetId = parseInt(req.params.targetId, 10);
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) {
        return res.status(400).json({ error: 'Invalid ids' });
    }
    if (sourceId === targetId) {
        return res.status(400).json({ error: 'Cannot merge a customer into itself' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const src = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [sourceId]);
        const tgt = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [targetId]);
        if (src.rowCount === 0 || tgt.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Customer not found' });
        }
        const source = src.rows[0];
        const target = tgt.rows[0];

        // Re-tag reservations that used the source's phone so the merged
        // customer inherits the history (the stats aggregator joins on phone).
        let cascadedReservationIds: number[] = [];
        if (source.phone) {
            const cascade = await client.query(
                `UPDATE reservations
                 SET phone = $1,
                     customer_name = $2
                 WHERE phone = $3
                 RETURNING id`,
                [target.phone || source.phone, target.name, source.phone]
            );
            cascadedReservationIds = cascade.rows.map(r => Number(r.id));
        }

        // Re-parent banquet menus (real FK, ON DELETE SET NULL — we want to
        // preserve the association).
        await client.query(
            `UPDATE banquet_menus SET customer_id = $1 WHERE customer_id = $2`,
            [targetId, sourceId]
        );

        // Backfill target fields that are empty from the source. Notes are
        // concatenated when both have content.
        const mergedNotes = [target.notes, source.notes]
            .map(n => (n || '').trim())
            .filter(Boolean)
            .join('\n');

        const updated = await client.query(
            `UPDATE customers
             SET email = COALESCE(NULLIF(email, ''), $2),
                 address = COALESCE(NULLIF(address, ''), $3),
                 city = COALESCE(NULLIF(city, ''), $4),
                 postal_code = COALESCE(NULLIF(postal_code, ''), $5),
                 notes = NULLIF($6, ''),
                 preferred_table_id = COALESCE(preferred_table_id, $7),
                 preferences_notes = COALESCE(NULLIF(preferences_notes, ''), $8),
                 dietary_notes = COALESCE(NULLIF(dietary_notes, ''), $9),
                 is_vip = is_vip OR $10,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, name, phone, email, address, city, postal_code, notes, created_at, updated_at,
                       preferred_table_id, preferences_notes, dietary_notes, is_vip`,
            [
                targetId,
                source.email || null,
                source.address || null,
                source.city || null,
                source.postal_code || null,
                mergedNotes,
                source.preferred_table_id || null,
                source.preferences_notes || null,
                source.dietary_notes || null,
                source.is_vip === true,
            ]
        );

        await client.query('DELETE FROM customers WHERE id = $1', [sourceId]);
        await client.query('COMMIT');

        // Push the re-tagged reservations to every client so booking cards
        // reflect the merged customer's name without a refresh.
        await broadcastReservationsUpdatedByIds(cascadedReservationIds);

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.CUSTOMER,
                targetId,
                `${target.name} (merged from #${sourceId} "${source.name}")`
            );
        }

        res.json(updated.rows[0]);
    } catch (err: any) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        console.error('POST /customers/:sourceId/merge-into/:targetId error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    } finally {
        client.release();
    }
});

app.delete('/customers/:id', authenticate, requirePermission('customers:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await queryWithRetry('SELECT name FROM customers WHERE id = $1', [id]);
        if (existing.rowCount === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        const resourceName = existing.rows[0].name;

        await queryWithRetry('DELETE FROM customers WHERE id = $1', [id]);

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.CUSTOMER,
                parseInt(id, 10),
                resourceName
            );
        }

        res.status(204).send();
    } catch (err) {
        console.error('DELETE /customers/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// INVENTORY (rubrica magazzino) - require authentication
// ============================================

const ALLOWED_INVENTORY_AREAS = new Set(['CUCINA', 'SALA', 'BAR']);
const ALLOWED_MOVEMENT_REASONS = new Set(['CARICO', 'SCARICO', 'RETTIFICA', 'TRASFERIMENTO']);
const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_ALERT_ROLES = ['OWNER', 'GENERAL_MANAGER', 'KITCHEN'];

// GET /inventory/locations?area=CUCINA — all locations, optionally filtered.
app.get('/inventory/locations', authenticate, requirePermission('inventory:view'), async (req, res) => {
    try {
        const { area } = req.query as { area?: string };
        const params: any[] = [];
        let where = '';
        if (area) {
            if (!ALLOWED_INVENTORY_AREAS.has(area)) {
                return res.status(400).json({ error: 'Invalid area' });
            }
            params.push(area);
            where = 'WHERE area = $1';
        }
        const result = await queryWithRetry(
            `SELECT id, area, name, sort_order, created_at
             FROM inventory_locations
             ${where}
             ORDER BY area, sort_order, name`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /inventory/locations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/inventory/locations', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { area, name, sort_order } = req.body;
        if (!area || !ALLOWED_INVENTORY_AREAS.has(area)) {
            return res.status(400).json({ error: 'Invalid area' });
        }
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const result = await queryWithRetry(
            `INSERT INTO inventory_locations (area, name, sort_order)
             VALUES ($1, $2, $3)
             RETURNING id, area, name, sort_order, created_at`,
            [area, String(name).trim(), Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0]
        );
        const created = result.rows[0];
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.CREATE, ResourceType.INVENTORY_LOCATION,
                created.id, `${area} · ${created.name}`
            );
        }
        res.status(201).json(created);
    } catch (err: any) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'Location with this name already exists in the area' });
        }
        console.error('POST /inventory/locations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/inventory/locations/:id', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, sort_order } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const result = await queryWithRetry(
            `UPDATE inventory_locations
             SET name = $1, sort_order = $2
             WHERE id = $3
             RETURNING id, area, name, sort_order, created_at`,
            [String(name).trim(), Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }
        const updated = result.rows[0];
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.UPDATE, ResourceType.INVENTORY_LOCATION,
                updated.id, `${updated.area} · ${updated.name}`
            );
        }
        res.json(updated);
    } catch (err: any) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'Location with this name already exists in the area' });
        }
        console.error('PUT /inventory/locations/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/inventory/locations/:id', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await queryWithRetry('SELECT area, name FROM inventory_locations WHERE id = $1', [id]);
        if (existing.rowCount === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }
        // ON DELETE CASCADE on inventory_stock + inventory_movements drops the
        // related rows. Stock is destroyed — confirm on the client side.
        await queryWithRetry('DELETE FROM inventory_locations WHERE id = $1', [id]);
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.DELETE, ResourceType.INVENTORY_LOCATION,
                parseInt(id, 10), `${existing.rows[0].area} · ${existing.rows[0].name}`
            );
        }
        res.status(204).send();
    } catch (err) {
        console.error('DELETE /inventory/locations/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ----- Categories CRUD -----
app.get('/inventory/categories', authenticate, requirePermission('inventory:view'), async (req, res) => {
    try {
        const { area } = req.query as { area?: string };
        const params: any[] = [];
        let where = '';
        if (area) {
            if (!ALLOWED_INVENTORY_AREAS.has(area)) {
                return res.status(400).json({ error: 'Invalid area' });
            }
            params.push(area);
            where = 'WHERE area = $1';
        }
        const result = await queryWithRetry(
            `SELECT id, area, name, sort_order, created_at
             FROM inventory_categories
             ${where}
             ORDER BY area, sort_order, name`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /inventory/categories error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/inventory/categories', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { area, name, sort_order } = req.body;
        if (!area || !ALLOWED_INVENTORY_AREAS.has(area)) {
            return res.status(400).json({ error: 'Invalid area' });
        }
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const result = await queryWithRetry(
            `INSERT INTO inventory_categories (area, name, sort_order)
             VALUES ($1, $2, $3)
             RETURNING id, area, name, sort_order, created_at`,
            [area, String(name).trim(), Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0]
        );
        const created = result.rows[0];
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.CREATE, ResourceType.INVENTORY_CATEGORY,
                created.id, `${area} · ${created.name}`
            );
        }
        res.status(201).json(created);
    } catch (err: any) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'Category with this name already exists in the area' });
        }
        console.error('POST /inventory/categories error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/inventory/categories/:id', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, sort_order } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const result = await queryWithRetry(
            `UPDATE inventory_categories
             SET name = $1, sort_order = $2
             WHERE id = $3
             RETURNING id, area, name, sort_order, created_at`,
            [String(name).trim(), Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }
        const updated = result.rows[0];
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.UPDATE, ResourceType.INVENTORY_CATEGORY,
                updated.id, `${updated.area} · ${updated.name}`
            );
        }
        res.json(updated);
    } catch (err: any) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'Category with this name already exists in the area' });
        }
        console.error('PUT /inventory/categories/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/inventory/categories/:id', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await queryWithRetry('SELECT area, name FROM inventory_categories WHERE id = $1', [id]);
        if (existing.rowCount === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }
        // ON DELETE SET NULL on inventory_products.category_id keeps products
        // alive but unassigned.
        await queryWithRetry('DELETE FROM inventory_categories WHERE id = $1', [id]);
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.DELETE, ResourceType.INVENTORY_CATEGORY,
                parseInt(id, 10), `${existing.rows[0].area} · ${existing.rows[0].name}`
            );
        }
        res.status(204).send();
    } catch (err) {
        console.error('DELETE /inventory/categories/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /inventory/products?area=CUCINA
app.get('/inventory/products', authenticate, requirePermission('inventory:view'), async (req, res) => {
    try {
        const { area } = req.query as { area?: string };
        const params: any[] = [];
        let where = '';
        if (area) {
            if (!ALLOWED_INVENTORY_AREAS.has(area)) {
                return res.status(400).json({ error: 'Invalid area' });
            }
            params.push(area);
            where = 'WHERE p.area = $1';
        }
        const result = await queryWithRetry(
            `SELECT p.id, p.area, p.name, p.unit, p.notes, p.category_id, c.name AS category_name, p.created_at
             FROM inventory_products p
             LEFT JOIN inventory_categories c ON c.id = p.category_id
             ${where}
             ORDER BY p.area, p.name`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /inventory/products error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/inventory/products', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { area, name, unit, notes, category_id } = req.body;
        if (!area || !ALLOWED_INVENTORY_AREAS.has(area)) {
            return res.status(400).json({ error: 'Invalid area' });
        }
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        // Validate category_id belongs to the same area, if provided.
        let validCategoryId: number | null = null;
        if (category_id != null && category_id !== '') {
            const catCheck = await queryWithRetry(
                'SELECT area FROM inventory_categories WHERE id = $1',
                [category_id]
            );
            if (catCheck.rowCount === 0) {
                return res.status(400).json({ error: 'Invalid category' });
            }
            if (catCheck.rows[0].area !== area) {
                return res.status(400).json({ error: 'Category belongs to a different area' });
            }
            validCategoryId = Number(category_id);
        }
        const result = await queryWithRetry(
            `WITH inserted AS (
               INSERT INTO inventory_products (area, name, unit, notes, category_id)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, area, name, unit, notes, category_id, created_at
             )
             SELECT i.*, c.name AS category_name
             FROM inserted i
             LEFT JOIN inventory_categories c ON c.id = i.category_id`,
            [
                area,
                String(name).trim(),
                unit ? String(unit).trim() : null,
                notes ? String(notes).trim() : null,
                validCategoryId,
            ]
        );
        const created = result.rows[0];
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.CREATE, ResourceType.INVENTORY_PRODUCT,
                created.id, `${area} · ${created.name}`
            );
        }
        res.status(201).json(created);
    } catch (err: any) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'A product with this name already exists in the area' });
        }
        console.error('POST /inventory/products error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/inventory/products/:id', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, unit, notes, category_id } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        // Look up product area to validate category_id stays in the same area.
        const prod = await queryWithRetry('SELECT area FROM inventory_products WHERE id = $1', [id]);
        if (prod.rowCount === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        let validCategoryId: number | null = null;
        if (category_id != null && category_id !== '') {
            const catCheck = await queryWithRetry(
                'SELECT area FROM inventory_categories WHERE id = $1',
                [category_id]
            );
            if (catCheck.rowCount === 0) {
                return res.status(400).json({ error: 'Invalid category' });
            }
            if (catCheck.rows[0].area !== prod.rows[0].area) {
                return res.status(400).json({ error: 'Category belongs to a different area' });
            }
            validCategoryId = Number(category_id);
        }
        const result = await queryWithRetry(
            `WITH updated AS (
               UPDATE inventory_products
               SET name = $1, unit = $2, notes = $3, category_id = $4
               WHERE id = $5
               RETURNING id, area, name, unit, notes, category_id, created_at
             )
             SELECT u.*, c.name AS category_name
             FROM updated u
             LEFT JOIN inventory_categories c ON c.id = u.category_id`,
            [
                String(name).trim(),
                unit ? String(unit).trim() : null,
                notes ? String(notes).trim() : null,
                validCategoryId,
                id,
            ]
        );
        const updated = result.rows[0];
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.UPDATE, ResourceType.INVENTORY_PRODUCT,
                updated.id, `${updated.area} · ${updated.name}`
            );
        }
        res.json(updated);
    } catch (err: any) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'A product with this name already exists in the area' });
        }
        console.error('PUT /inventory/products/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/inventory/products/:id', authenticate, requirePermission('inventory:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await queryWithRetry('SELECT area, name FROM inventory_products WHERE id = $1', [id]);
        if (existing.rowCount === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        await queryWithRetry('DELETE FROM inventory_products WHERE id = $1', [id]);
        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.DELETE, ResourceType.INVENTORY_PRODUCT,
                parseInt(id, 10), `${existing.rows[0].area} · ${existing.rows[0].name}`
            );
        }
        res.status(204).send();
    } catch (err) {
        console.error('DELETE /inventory/products/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /inventory/stock?area=CUCINA — full per-(product, location) breakdown.
// Always returns numeric values (not strings) so the client can sum on read.
app.get('/inventory/stock', authenticate, requirePermission('inventory:view'), async (req, res) => {
    try {
        const { area } = req.query as { area?: string };
        const params: any[] = [];
        let where = '';
        if (area) {
            if (!ALLOWED_INVENTORY_AREAS.has(area)) {
                return res.status(400).json({ error: 'Invalid area' });
            }
            params.push(area);
            where = 'WHERE p.area = $1';
        }
        const result = await queryWithRetry(
            `SELECT s.product_id, s.location_id, s.quantity::float AS quantity
             FROM inventory_stock s
             JOIN inventory_products p ON p.id = s.product_id
             ${where}`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /inventory/stock error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /inventory/low-stock?area=CUCINA — products whose total quantity across
// all locations is at or below LOW_STOCK_THRESHOLD. Includes products with no
// stock rows at all (treated as 0).
app.get('/inventory/low-stock', authenticate, requirePermission('inventory:view'), async (req, res) => {
    try {
        const { area } = req.query as { area?: string };
        const params: any[] = [LOW_STOCK_THRESHOLD];
        let where = '';
        if (area) {
            if (!ALLOWED_INVENTORY_AREAS.has(area)) {
                return res.status(400).json({ error: 'Invalid area' });
            }
            params.push(area);
            where = 'WHERE p.area = $2';
        }
        const result = await queryWithRetry(
            `SELECT p.id, p.area, p.name, p.unit, p.category_id,
                    c.name AS category_name,
                    COALESCE(SUM(s.quantity), 0)::float AS total_quantity
             FROM inventory_products p
             LEFT JOIN inventory_categories c ON c.id = p.category_id
             LEFT JOIN inventory_stock s     ON s.product_id = p.id
             ${where}
             GROUP BY p.id, c.name
             HAVING COALESCE(SUM(s.quantity), 0) <= $1
             ORDER BY total_quantity ASC, p.name`,
            params
        );
        res.json({ threshold: LOW_STOCK_THRESHOLD, items: result.rows });
    } catch (err) {
        console.error('GET /inventory/low-stock error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /inventory/movements — apply a delta to (product, location).
// delta > 0 = carico, delta < 0 = scarico. The stock row is upserted in a
// transaction so concurrent +/- never lose updates.
app.post('/inventory/movements', authenticate, requirePermission('inventory:full'), async (req, res) => {
    const { product_id, location_id, delta, reason, notes } = req.body;
    const productId = Number(product_id);
    const locationId = Number(location_id);
    const deltaNum = Number(delta);
    if (!Number.isFinite(productId) || !Number.isFinite(locationId)) {
        return res.status(400).json({ error: 'product_id and location_id are required' });
    }
    if (!Number.isFinite(deltaNum) || deltaNum === 0) {
        return res.status(400).json({ error: 'delta must be a non-zero number' });
    }
    if (!reason || !ALLOWED_MOVEMENT_REASONS.has(reason)) {
        return res.status(400).json({ error: 'Invalid reason' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Make sure product and location exist and belong to the same area.
        const validation = await client.query(
            `SELECT p.area AS p_area, l.area AS l_area, p.name AS p_name, l.name AS l_name, p.unit AS p_unit
             FROM inventory_products p, inventory_locations l
             WHERE p.id = $1 AND l.id = $2`,
            [productId, locationId]
        );
        if (validation.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Product or location not found' });
        }
        const v = validation.rows[0];
        if (v.p_area !== v.l_area) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Product and location must belong to the same area' });
        }

        // Snapshot the total stock before the update so we can detect a
        // threshold-crossing once the delta lands.
        const totalBeforeRes = await client.query(
            `SELECT COALESCE(SUM(quantity), 0)::float AS total
             FROM inventory_stock WHERE product_id = $1`,
            [productId]
        );
        const totalBefore: number = totalBeforeRes.rows[0]?.total ?? 0;

        // Upsert the stock row. Negative results are allowed so carico/scarico
        // never silently fails — the UI surfaces a warning when total < 0.
        const upsert = await client.query(
            `INSERT INTO inventory_stock (product_id, location_id, quantity, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (product_id, location_id)
             DO UPDATE SET quantity = inventory_stock.quantity + EXCLUDED.quantity,
                           updated_at = CURRENT_TIMESTAMP
             RETURNING quantity::float AS quantity`,
            [productId, locationId, deltaNum]
        );

        const movement = await client.query(
            `INSERT INTO inventory_movements (product_id, location_id, delta, reason, notes, user_id, user_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, product_id, location_id, delta::float AS delta, reason, notes, user_id, user_name, created_at`,
            [
                productId,
                locationId,
                deltaNum,
                reason,
                notes ? String(notes).trim() : null,
                req.user?.userId ?? null,
                req.user?.email ?? null,
            ]
        );

        await client.query('COMMIT');

        if (req.user) {
            LogService.logActivity(
                req.user.userId, req.user.email, req.user.email,
                ActivityAction.CREATE, ResourceType.INVENTORY_MOVEMENT,
                movement.rows[0].id, `${v.p_name} @ ${v.l_name}`,
                { delta: deltaNum, reason }
            );
        }

        // Push alert when this movement crosses the low-stock threshold.
        const totalAfter = totalBefore + deltaNum;
        if (totalBefore > LOW_STOCK_THRESHOLD && totalAfter <= LOW_STOCK_THRESHOLD) {
            const unit = v.p_unit ? ` ${v.p_unit}` : '';
            const qtyText = Number.isInteger(totalAfter) ? String(totalAfter) : totalAfter.toFixed(1);
            pushSendToRoles(
                LOW_STOCK_ALERT_ROLES,
                {
                    category: 'system',
                    title: 'Scorta bassa',
                    body: `${v.p_name}: ${qtyText}${unit} rimanenti`,
                    url: '/?view=INVENTARIO',
                    tag: `low-stock-${productId}`,
                }
            ).catch(err => console.error('Push (low stock) failed:', err));
        }

        res.status(201).json({
            movement: movement.rows[0],
            stock: { product_id: productId, location_id: locationId, quantity: upsert.rows[0].quantity },
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /inventory/movements error:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Banquet Menus - require authentication
app.get('/banquet-menus', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT b.id, b.name, b.description, b.price_per_person, b.dish_ids, b.courses,
                    TO_CHAR(b.event_date, 'YYYY-MM-DD') AS event_date, b.shift, b.deposit_amount,
                    b.guests, b.children, b.children_price, b.notes_courses, b.notes_service,
                    b.notes_mise_en_place, b.customer_id, b.table_ids,
                    b.discount_type, b.discount_value,
                    COALESCE((SELECT SUM(amount) FROM banquet_payments WHERE banquet_id = b.id), 0)::float AS total_paid
             FROM banquet_menus b
             ORDER BY b.event_date NULLS LAST, b.name`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/banquet-menus', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { name, description, price_per_person, dish_ids, courses, event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids, discount_type, discount_value } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        const childrenPrice = children_price != null && children_price !== '' ? Number(children_price) : null;
        const normalizedDiscountType: 'PERCENT' | 'AMOUNT' | null =
            discount_type === 'PERCENT' || discount_type === 'AMOUNT' ? discount_type : null;
        const normalizedDiscountValue: number | null = normalizedDiscountType && discount_value != null && discount_value !== '' && Number.isFinite(Number(discount_value))
            ? Math.max(0, Number(discount_value))
            : null;
        if (!event_date) {
            return res.status(400).json({ error: 'event_date is required' });
        }
        // Derive flat dish_ids from courses if courses provided, else use the supplied flat list
        const flatDishIds: number[] = Array.isArray(courses) && courses.length > 0
            ? courses.flatMap((c: any) => Array.isArray(c.dish_ids) ? c.dish_ids : [])
            : (Array.isArray(dish_ids) ? dish_ids : []);
        const coursesJson = Array.isArray(courses) ? JSON.stringify(courses) : null;
        const tableIdsArr: number[] = Array.isArray(table_ids)
            ? table_ids.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
            : [];
        if (tableIdsArr.length > 0 && shift) {
            const conflicts = await findTableConflicts(event_date, shift, tableIdsArr);
            if (conflicts.length > 0) {
                return res.status(409).json({
                    error: buildConflictMessage(conflicts),
                    conflicts,
                });
            }
        }
        const result = await queryWithRetry(
            "INSERT INTO banquet_menus (name, description, price_per_person, dish_ids, courses, event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids, discount_type, discount_value) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids, discount_type, discount_value",
            [name, description, price_per_person, flatDishIds, coursesJson, event_date, shift ?? null, deposit_amount ?? null, guests ?? null, childrenCount, childrenPrice, notes_courses ?? null, notes_service ?? null, notes_mise_en_place ?? null, customer_id ?? null, tableIdsArr.length > 0 ? tableIdsArr : null, normalizedDiscountType, normalizedDiscountValue]
        );
        const newMenu = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.BANQUET_MENU,
                newMenu.id,
                name,
                { price_per_person, dish_count: flatDishIds.length }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetCreated(newMenu);

        // Generate kitchen reminder todos (72h/48h/24h before event_date)
        addBanquetToReminders(newMenu.id, newMenu.event_date).catch(err => {
            console.error('Failed to create banquet reminder todos:', err);
        });

        res.status(201).json(newMenu);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/banquet-menus/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price_per_person, dish_ids, courses, event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids, discount_type, discount_value } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        const childrenPrice = children_price != null && children_price !== '' ? Number(children_price) : null;
        const normalizedDiscountType: 'PERCENT' | 'AMOUNT' | null =
            discount_type === 'PERCENT' || discount_type === 'AMOUNT' ? discount_type : null;
        const normalizedDiscountValue: number | null = normalizedDiscountType && discount_value != null && discount_value !== '' && Number.isFinite(Number(discount_value))
            ? Math.max(0, Number(discount_value))
            : null;
        if (!event_date) {
            return res.status(400).json({ error: 'event_date is required' });
        }
        const flatDishIds: number[] = Array.isArray(courses) && courses.length > 0
            ? courses.flatMap((c: any) => Array.isArray(c.dish_ids) ? c.dish_ids : [])
            : (Array.isArray(dish_ids) ? dish_ids : []);
        const coursesJson = Array.isArray(courses) ? JSON.stringify(courses) : null;
        const tableIdsArr: number[] = Array.isArray(table_ids)
            ? table_ids.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
            : [];
        if (tableIdsArr.length > 0 && shift) {
            const conflicts = await findTableConflicts(event_date, shift, tableIdsArr, { excludeBanquetId: Number(id) });
            if (conflicts.length > 0) {
                return res.status(409).json({
                    error: buildConflictMessage(conflicts),
                    conflicts,
                });
            }
        }
        const result = await queryWithRetry(
            "UPDATE banquet_menus SET name = $1, description = $2, price_per_person = $3, dish_ids = $4, courses = $5::jsonb, event_date = $6, shift = $7, deposit_amount = $8, guests = $9, children = $10, children_price = $11, notes_courses = $12, notes_service = $13, notes_mise_en_place = $14, customer_id = $15, table_ids = $16, discount_type = $17, discount_value = $18 WHERE id = $19 RETURNING id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids, discount_type, discount_value",
            [name, description, price_per_person, flatDishIds, coursesJson, event_date, shift ?? null, deposit_amount ?? null, guests ?? null, childrenCount, childrenPrice, notes_courses ?? null, notes_service ?? null, notes_mise_en_place ?? null, customer_id ?? null, tableIdsArr.length > 0 ? tableIdsArr : null, normalizedDiscountType, normalizedDiscountValue, id]
        );
        const updatedMenu = result.rows[0];

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.BANQUET_MENU,
                parseInt(id, 10),
                name,
                { price_per_person, dish_count: flatDishIds.length }
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetUpdated(updatedMenu);

        // Re-sync kitchen reminder todos (handles event_date changes)
        syncBanquetReminders(parseInt(id, 10), updatedMenu.event_date).catch(err => {
            console.error('Failed to sync banquet reminder todos:', err);
        });

        res.json(updatedMenu);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/banquet-menus/:id', authenticate, requirePermission('menu:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get menu name before deleting
        const existing = await queryWithRetry('SELECT name FROM banquet_menus WHERE id = $1', [id]);
        const resourceName = existing.rows[0]?.name;

        await queryWithRetry('DELETE FROM banquet_menus WHERE id = $1', [id]);

        // Log activity
        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.BANQUET_MENU,
                parseInt(id, 10),
                resourceName
            );
        }

        // Broadcast to all connected clients
        if (socketService) socketService.broadcastBanquetDeleted(Number(id));

        // Remove banquet from kitchen reminder todos
        removeBanquetFromReminders(Number(id)).catch(err => {
            console.error('Failed to remove banquet from reminder todos:', err);
        });

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// BANQUET PAYMENTS - require authentication; mutations require banquet:manage_payments
// ============================================
app.get('/banquet-menus/:id/payments', authenticate, requirePermission('banquet:manage_payments'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry(
            `SELECT p.id, p.banquet_id, p.amount, TO_CHAR(p.payment_date, 'YYYY-MM-DD') AS payment_date,
                    p.payment_type, p.payment_method, p.notes, p.created_by_user_id, p.created_at,
                    u.full_name AS created_by_user_name
             FROM banquet_payments p
             LEFT JOIN users u ON p.created_by_user_id = u.id
             WHERE p.banquet_id = $1
             ORDER BY p.payment_date DESC, p.id DESC`,
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /banquet-menus/:id/payments error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/banquet-menus/:id/payments', authenticate, requirePermission('banquet:manage_payments'), async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, payment_date, payment_type, payment_method, notes } = req.body;
        if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) {
            return res.status(400).json({ error: 'amount must be a positive number' });
        }
        if (!payment_date) {
            return res.status(400).json({ error: 'payment_date is required' });
        }
        const validTypes = ['DEPOSIT', 'BALANCE', 'OTHER'];
        const validMethods = ['CASH', 'CARD', 'TRANSFER', 'OTHER'];
        if (!validTypes.includes(payment_type)) {
            return res.status(400).json({ error: 'invalid payment_type' });
        }
        if (!validMethods.includes(payment_method)) {
            return res.status(400).json({ error: 'invalid payment_method' });
        }

        const banquetCheck = await queryWithRetry('SELECT id, name FROM banquet_menus WHERE id = $1', [id]);
        if (banquetCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Banquet not found' });
        }
        const banquetName = banquetCheck.rows[0].name;

        const result = await queryWithRetry(
            `INSERT INTO banquet_payments (banquet_id, amount, payment_date, payment_type, payment_method, notes, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, banquet_id, amount, TO_CHAR(payment_date, 'YYYY-MM-DD') AS payment_date,
                       payment_type, payment_method, notes, created_by_user_id, created_at`,
            [id, amount, payment_date, payment_type, payment_method, notes ?? null, req.user?.userId ?? null]
        );
        const newPayment = result.rows[0];

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.CREATE,
                ResourceType.BANQUET_MENU,
                parseInt(id, 10),
                banquetName,
                { sub_action: 'payment_added', payment_id: newPayment.id, amount: Number(amount), payment_type, payment_method, payment_date }
            );
        }

        // Re-fetch banquet with new total_paid and broadcast so all clients refresh
        const refreshed = await queryWithRetry(
            `SELECT b.id, b.name, b.description, b.price_per_person, b.dish_ids, b.courses,
                    TO_CHAR(b.event_date, 'YYYY-MM-DD') AS event_date, b.shift, b.deposit_amount,
                    b.guests, b.children, b.children_price, b.notes_courses, b.notes_service,
                    b.notes_mise_en_place, b.customer_id, b.table_ids,
                    b.discount_type, b.discount_value,
                    COALESCE((SELECT SUM(amount) FROM banquet_payments WHERE banquet_id = b.id), 0)::float AS total_paid
             FROM banquet_menus b WHERE b.id = $1`,
            [id]
        );
        if (socketService && refreshed.rows[0]) socketService.broadcastBanquetUpdated(refreshed.rows[0]);

        res.status(201).json(newPayment);
    } catch (err) {
        console.error('POST /banquet-menus/:id/payments error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/banquet-menus/:id/payments/:paymentId', authenticate, requirePermission('banquet:manage_payments'), async (req, res) => {
    try {
        const { id, paymentId } = req.params;
        const existing = await queryWithRetry(
            `SELECT p.amount, p.payment_type, b.name AS banquet_name
             FROM banquet_payments p
             JOIN banquet_menus b ON p.banquet_id = b.id
             WHERE p.id = $1 AND p.banquet_id = $2`,
            [paymentId, id]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        const { amount, payment_type, banquet_name } = existing.rows[0];

        await queryWithRetry('DELETE FROM banquet_payments WHERE id = $1 AND banquet_id = $2', [paymentId, id]);

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.DELETE,
                ResourceType.BANQUET_MENU,
                parseInt(id, 10),
                banquet_name,
                { sub_action: 'payment_deleted', payment_id: parseInt(paymentId, 10), amount: Number(amount), payment_type }
            );
        }

        const refreshed = await queryWithRetry(
            `SELECT b.id, b.name, b.description, b.price_per_person, b.dish_ids, b.courses,
                    TO_CHAR(b.event_date, 'YYYY-MM-DD') AS event_date, b.shift, b.deposit_amount,
                    b.guests, b.children, b.children_price, b.notes_courses, b.notes_service,
                    b.notes_mise_en_place, b.customer_id, b.table_ids,
                    b.discount_type, b.discount_value,
                    COALESCE((SELECT SUM(amount) FROM banquet_payments WHERE banquet_id = b.id), 0)::float AS total_paid
             FROM banquet_menus b WHERE b.id = $1`,
            [id]
        );
        if (socketService && refreshed.rows[0]) socketService.broadcastBanquetUpdated(refreshed.rows[0]);

        res.status(204).send();
    } catch (err) {
        console.error('DELETE /banquet-menus/:id/payments/:paymentId error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// TODOS - require authentication
// ============================================
app.get('/todos', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        let query = `
            SELECT
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                linked_banquet_ids as "linkedBanquetIds",
                banquet_reminder_hours as "banquetReminderHours",
                auto_kind as "autoKind",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
            FROM todos
        `;
        const params: string[] = [];

        if (date) {
            query += ' WHERE due_date = $1';
            params.push(date as string);
        }

        query += ' ORDER BY created_at DESC';

        const result = await queryWithRetry(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/todos/my', authenticate, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const userRole = req.user?.role;

        const result = await queryWithRetry(`
            SELECT
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                linked_banquet_ids as "linkedBanquetIds",
                banquet_reminder_hours as "banquetReminderHours",
                auto_kind as "autoKind",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
            FROM todos
            WHERE (assigned_to_user_id = $1 OR assigned_to_team = $2)
              AND completed = false
            ORDER BY
                CASE priority
                    WHEN 'HIGH' THEN 1
                    WHEN 'MEDIUM' THEN 2
                    WHEN 'LOW' THEN 3
                END,
                due_date ASC NULLS LAST,
                created_at DESC
        `, [userId, userRole]);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/todos', authenticate, async (req, res) => {
    try {
        const {
            title,
            description,
            priority,
            category,
            dueDate,
            assignedToUserId,
            assignedToUserName,
            assignedToTeam,
            linkedReservationId,
            linkedBanquetIds,
            banquetReminderHours
        } = req.body;

        const actorRole = req.user?.role;
        if (actorRole) {
            if (assignedToTeam && !canAssignToRole(actorRole, assignedToTeam)) {
                return res.status(403).json({ error: 'Non puoi assegnare task a questo team' });
            }
            if (assignedToUserId) {
                const target = await queryWithRetry(
                    'SELECT role FROM users WHERE id = $1',
                    [assignedToUserId]
                );
                const targetRole = target.rows[0]?.role as UserRole | undefined;
                if (!targetRole || !canAssignToRole(actorRole, targetRole)) {
                    return res.status(403).json({ error: 'Non puoi assegnare task a questo utente' });
                }
            }
        }

        const result = await queryWithRetry(`
            INSERT INTO todos (
                title, description, priority, category, due_date,
                assigned_to_user_id, assigned_to_user_name, assigned_to_team,
                linked_reservation_id, linked_banquet_ids, banquet_reminder_hours,
                created_by_user_id, created_by_user_name
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                linked_banquet_ids as "linkedBanquetIds",
                banquet_reminder_hours as "banquetReminderHours",
                auto_kind as "autoKind",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [
            title,
            description || null,
            priority || 'MEDIUM',
            category || 'GENERAL',
            dueDate || null,
            assignedToUserId || null,
            assignedToUserName || null,
            assignedToTeam || null,
            linkedReservationId || null,
            Array.isArray(linkedBanquetIds) && linkedBanquetIds.length > 0 ? linkedBanquetIds : null,
            banquetReminderHours ?? null,
            req.user?.userId || null,
            req.user?.email || null
        ]);

        const newTodo = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        console.log('📝 Broadcasting todo:created', { todoId: newTodo.id, socketService: !!socketService });
        if (socketService) {
            socketService.broadcastToAll('todo:created', newTodo, socketId);
        } else {
            console.error('📝 socketService is undefined, cannot broadcast!');
        }

        if (newTodo.assignedToUserId && newTodo.assignedToUserId !== req.user?.userId) {
            pushSendToUser(newTodo.assignedToUserId, {
                category: 'system',
                title: 'Nuovo todo assegnato',
                body: newTodo.title,
                url: '/?view=DASHBOARD',
                tag: `todo-${newTodo.id}`,
            }).catch(err => console.error('Push (todo assigned) failed:', err));
        }

        res.status(201).json(newTodo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/todos/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title,
            description,
            priority,
            category,
            dueDate,
            completed,
            assignedToUserId,
            assignedToUserName,
            assignedToTeam
        } = req.body;

        const actorRole = req.user?.role;
        if (actorRole) {
            if (req.body.hasOwnProperty('assignedToTeam') && assignedToTeam && !canAssignToRole(actorRole, assignedToTeam)) {
                return res.status(403).json({ error: 'Non puoi assegnare task a questo team' });
            }
            if (req.body.hasOwnProperty('assignedToUserId') && assignedToUserId) {
                const target = await queryWithRetry(
                    'SELECT role FROM users WHERE id = $1',
                    [assignedToUserId]
                );
                const targetRole = target.rows[0]?.role as UserRole | undefined;
                if (!targetRole || !canAssignToRole(actorRole, targetRole)) {
                    return res.status(403).json({ error: 'Non puoi assegnare task a questo utente' });
                }
            }
        }

        // Build dynamic update query
        const fields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        const fieldMappings: Record<string, { dbField: string; value: any }> = {
            title: { dbField: 'title', value: title },
            description: { dbField: 'description', value: description },
            priority: { dbField: 'priority', value: priority },
            category: { dbField: 'category', value: category },
            dueDate: { dbField: 'due_date', value: dueDate },
            completed: { dbField: 'completed', value: completed },
            assignedToUserId: { dbField: 'assigned_to_user_id', value: assignedToUserId },
            assignedToUserName: { dbField: 'assigned_to_user_name', value: assignedToUserName },
            assignedToTeam: { dbField: 'assigned_to_team', value: assignedToTeam },
            linkedBanquetIds: {
                dbField: 'linked_banquet_ids',
                value: Array.isArray(req.body.linkedBanquetIds) && req.body.linkedBanquetIds.length > 0
                    ? req.body.linkedBanquetIds
                    : null,
            },
            banquetReminderHours: { dbField: 'banquet_reminder_hours', value: req.body.banquetReminderHours },
        };

        for (const [key, mapping] of Object.entries(fieldMappings)) {
            if (req.body.hasOwnProperty(key)) {
                fields.push(`${mapping.dbField} = $${paramIndex}`);
                values.push(mapping.value ?? null);
                paramIndex++;
            }
        }

        // Handle completed_at based on completed status
        if (req.body.hasOwnProperty('completed')) {
            if (completed) {
                fields.push(`completed_at = CURRENT_TIMESTAMP`);
            } else {
                fields.push(`completed_at = NULL`);
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        let previousAssignee: number | null = null;
        if (req.body.hasOwnProperty('assignedToUserId')) {
            const prev = await queryWithRetry(
                'SELECT assigned_to_user_id FROM todos WHERE id = $1',
                [id]
            );
            previousAssignee = prev.rows[0]?.assigned_to_user_id ?? null;
        }

        values.push(id);
        const query = `
            UPDATE todos
            SET ${fields.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                linked_banquet_ids as "linkedBanquetIds",
                banquet_reminder_hours as "banquetReminderHours",
                auto_kind as "autoKind",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `;

        const result = await queryWithRetry(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Todo not found' });
        }

        const updatedTodo = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('todo:updated', updatedTodo, socketId);

        const newAssignee = updatedTodo.assignedToUserId ?? null;
        if (
            req.body.hasOwnProperty('assignedToUserId')
            && newAssignee
            && newAssignee !== previousAssignee
            && newAssignee !== req.user?.userId
        ) {
            pushSendToUser(newAssignee, {
                category: 'system',
                title: 'Todo assegnato a te',
                body: updatedTodo.title,
                url: '/?view=DASHBOARD',
                tag: `todo-${updatedTodo.id}`,
            }).catch(err => console.error('Push (todo reassigned) failed:', err));
        }

        res.json(updatedTodo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/todos/:id/toggle', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await queryWithRetry(`
            UPDATE todos
            SET
                completed = NOT completed,
                completed_at = CASE
                    WHEN NOT completed THEN CURRENT_TIMESTAMP
                    ELSE NULL
                END
            WHERE id = $1
            RETURNING
                id,
                title,
                description,
                completed,
                priority,
                category,
                TO_CHAR(due_date, 'YYYY-MM-DD') as "dueDate",
                created_at as "createdAt",
                completed_at as "completedAt",
                linked_reservation_id as "linkedReservationId",
                linked_banquet_ids as "linkedBanquetIds",
                banquet_reminder_hours as "banquetReminderHours",
                auto_kind as "autoKind",
                assigned_to_user_id as "assignedToUserId",
                assigned_to_user_name as "assignedToUserName",
                assigned_to_team as "assignedToTeam",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Todo not found' });
        }

        const updatedTodo = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('todo:updated', updatedTodo, socketId);

        res.json(updatedTodo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/todos/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await queryWithRetry('DELETE FROM todos WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Todo not found' });
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('todo:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// DEV BOARD — pagina Development, riservata all'account admin
// ============================================
// Non passa da role_permissions: il board è uno strumento di sviluppo del
// progetto legato a un account preciso, non a un ruolo del ristorante.
const DEV_BOARD_ADMIN_EMAIL = (process.env.DEV_BOARD_ADMIN_EMAIL || 'admin@ristomanager.com').toLowerCase();
const requireDevBoardAdmin = (req: any, res: any, next: any) => {
    if ((req.user?.email || '').toLowerCase() !== DEV_BOARD_ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Accesso riservato' });
    }
    next();
};

const DEV_BOARD_COLUMNS = ['in_progress', 'review', 'nice_to_have', 'paused', 'done'];
// Palette chiusa, allineata a LABELS in DevelopmentPage.tsx: chiavi libere a
// DB renderebbero chip senza colore né nome sulla board.
const DEV_BOARD_LABELS = ['comande', 'prenotazioni', 'pagamenti', 'stampa', 'bug', 'infra'];
const sanitizeDevBoardLabels = (input: any): string[] | null =>
    Array.isArray(input)
        ? [...new Set(input.filter((l: any) => DEV_BOARD_LABELS.includes(l)))]
        : null;

app.get('/dev-board/cards', authenticate, requireDevBoardAdmin, async (req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT id, title, description, column_key, position, labels, created_at, updated_at
             FROM dev_board_cards
             ORDER BY column_key, position, id`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/dev-board/cards', authenticate, requireDevBoardAdmin, async (req, res) => {
    try {
        const { title, description, column_key } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: 'Titolo obbligatorio' });
        }
        const column = DEV_BOARD_COLUMNS.includes(column_key) ? column_key : 'in_progress';
        const labels = sanitizeDevBoardLabels(req.body?.labels) ?? [];
        const result = await queryWithRetry(
            `INSERT INTO dev_board_cards (title, description, column_key, position, labels)
             VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), -1) + 1 FROM dev_board_cards WHERE column_key = $3), $4)
             RETURNING id, title, description, column_key, position, labels, created_at, updated_at`,
            [String(title).trim(), description ? String(description).trim() || null : null, column, labels]
        );
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('devboard:changed', {}, socketId);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/dev-board/cards/:id', authenticate, requireDevBoardAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, column_key } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: 'Titolo obbligatorio' });
        }
        if (column_key !== undefined && !DEV_BOARD_COLUMNS.includes(column_key)) {
            return res.status(400).json({ error: 'Colonna non valida' });
        }
        // Cambio colonna da edit → la card va in coda alla colonna di arrivo.
        const labels = sanitizeDevBoardLabels(req.body?.labels);
        const result = await queryWithRetry(
            `UPDATE dev_board_cards SET
                title = $1,
                description = $2,
                position = CASE WHEN $3::varchar IS NOT NULL AND $3::varchar <> column_key
                    THEN (SELECT COALESCE(MAX(position), -1) + 1 FROM dev_board_cards WHERE column_key = $3::varchar)
                    ELSE position END,
                column_key = COALESCE($3::varchar, column_key),
                labels = COALESCE($5::text[], labels),
                updated_at = NOW()
             WHERE id = $4
             RETURNING id, title, description, column_key, position, labels, created_at, updated_at`,
            [String(title).trim(), description ? String(description).trim() || null : null, column_key ?? null, id, labels]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Card non trovata' });
        }
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('devboard:changed', {}, socketId);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Drop di un drag&drop: sposta la card in una colonna e rinumera l'intera
// colonna di destinazione secondo l'ordine inviato dal client.
app.put('/dev-board/cards/:id/move', authenticate, requireDevBoardAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { column_key, ordered_ids } = req.body;
        if (!DEV_BOARD_COLUMNS.includes(column_key) || !Array.isArray(ordered_ids)) {
            return res.status(400).json({ error: 'Parametri non validi' });
        }
        await client.query('BEGIN');
        const moved = await client.query(
            `UPDATE dev_board_cards SET column_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
            [column_key, id]
        );
        if (moved.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Card non trovata' });
        }
        for (let i = 0; i < ordered_ids.length; i++) {
            await client.query(
                `UPDATE dev_board_cards SET position = $1 WHERE id = $2 AND column_key = $3`,
                [i, ordered_ids[i], column_key]
            );
        }
        await client.query('COMMIT');
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('devboard:changed', {}, socketId);
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

app.delete('/dev-board/cards/:id', authenticate, requireDevBoardAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry('DELETE FROM dev_board_cards WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Card non trovata' });
        }
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('devboard:changed', {}, socketId);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// SHOPPING LIST - require authentication
// ============================================
app.get('/shopping', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        let query = `
            SELECT
                si.id,
                si.name,
                si.category,
                si.checked,
                TO_CHAR(si.date, 'YYYY-MM-DD') as date,
                si.created_at as "createdAt",
                si.created_by_user_id as "createdByUserId",
                si.created_by_user_name as "createdByUserName",
                si.supplier_id as "supplierId",
                s.name as "supplierName",
                si.quantity::float8 as quantity,
                si.unit as unit
            FROM shopping_items si
            LEFT JOIN suppliers s ON s.id = si.supplier_id
        `;
        const params: string[] = [];

        if (date) {
            query += ' WHERE si.date = $1';
            params.push(date as string);
        }

        query += `
            ORDER BY
                CASE si.category
                    WHEN 'CUCINA' THEN 1
                    WHEN 'BAR' THEN 2
                    WHEN 'ALTRO' THEN 3
                END,
                si.created_at ASC
        `;

        const result = await queryWithRetry(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const VALID_UNITS = ['kg', 'g', 'l', 'ml', 'pz', 'conf', 'cassetta', 'cartone'] as const;
type Unit = (typeof VALID_UNITS)[number];

// Coerces incoming quantity/unit into a clean pair: both set, or both NULL.
const normalizeQuantityUnit = (q: unknown, u: unknown): { quantity: number | null; unit: Unit | null; error?: string } => {
    const hasQ = q !== undefined && q !== null && q !== '';
    const hasU = u !== undefined && u !== null && u !== '';
    if (!hasQ && !hasU) return { quantity: null, unit: null };
    let qty: number | null = null;
    if (hasQ) {
        const n = typeof q === 'number' ? q : parseFloat(String(q).replace(',', '.'));
        if (!isFinite(n) || n < 0) return { quantity: null, unit: null, error: 'quantity must be a non-negative number' };
        qty = n > 0 ? n : null;
    }
    let unit: Unit | null = null;
    if (hasU) {
        if (!VALID_UNITS.includes(u as Unit)) return { quantity: null, unit: null, error: `unit must be one of ${VALID_UNITS.join(', ')}` };
        unit = u as Unit;
    }
    // Pair them: if only one is set, fill the other sensibly.
    if (qty != null && unit == null) unit = 'pz';
    if (qty == null && unit != null) unit = null;
    return { quantity: qty, unit };
};

app.post('/shopping', authenticate, async (req, res) => {
    try {
        const { name, category, date, supplierId, quantity, unit } = req.body;

        console.log('🛒 POST /shopping - req.user:', req.user);

        if (!name || !date) {
            return res.status(400).json({ error: 'Name and date are required' });
        }

        const finalCategory = category || 'ALTRO';

        // If a supplier is provided, validate it exists and serves the same category
        if (supplierId) {
            const supRes = await queryWithRetry('SELECT categories FROM suppliers WHERE id = $1', [supplierId]);
            if (supRes.rows.length === 0) {
                return res.status(400).json({ error: 'Supplier not found' });
            }
            const supCategories: string[] = supRes.rows[0].categories || [];
            if (!supCategories.includes(finalCategory)) {
                return res.status(400).json({ error: 'Supplier does not serve the selected category' });
            }
        }

        const qu = normalizeQuantityUnit(quantity, unit);
        if (qu.error) return res.status(400).json({ error: qu.error });

        const creatorEmail = req.user?.email || null;
        console.log('🛒 Creator email:', creatorEmail);

        const inserted = await queryWithRetry(`
            INSERT INTO shopping_items (name, category, date, created_by_user_id, created_by_user_name, supplier_id, quantity, unit)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [name, finalCategory, date, req.user?.userId || null, creatorEmail, supplierId || null, qu.quantity, qu.unit]);

        const newId = inserted.rows[0].id;

        const result = await queryWithRetry(`
            SELECT
                si.id,
                si.name,
                si.category,
                si.checked,
                TO_CHAR(si.date, 'YYYY-MM-DD') as date,
                si.created_at as "createdAt",
                si.created_by_user_id as "createdByUserId",
                si.created_by_user_name as "createdByUserName",
                si.supplier_id as "supplierId",
                s.name as "supplierName",
                si.quantity::float8 as quantity,
                si.unit as unit
            FROM shopping_items si
            LEFT JOIN suppliers s ON s.id = si.supplier_id
            WHERE si.id = $1
        `, [newId]);

        console.log('🛒 Created item:', result.rows[0]);

        const newItem = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        console.log('🛒 Broadcasting shopping:created', { itemId: newItem.id, socketService: !!socketService, excludeSocketId: socketId });
        if (socketService) {
            socketService.broadcastToAll('shopping:created', newItem, socketId);
            console.log('🛒 Broadcast sent successfully');
        } else {
            console.error('🛒 socketService is undefined, cannot broadcast!');
        }

        res.status(201).json(newItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/shopping/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, category, supplierId, quantity, unit } = req.body;

        if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
            return res.status(400).json({ error: 'name must be a non-empty string' });
        }
        if (category !== undefined && !['CUCINA', 'BAR', 'ALTRO'].includes(category)) {
            return res.status(400).json({ error: 'category must be CUCINA, BAR, or ALTRO' });
        }
        // quantity / unit are paired: if either is touched, treat as a unit-and-quantity edit
        const quantityTouched = quantity !== undefined || unit !== undefined;
        let normalizedQU: { quantity: number | null; unit: Unit | null } | null = null;
        if (quantityTouched) {
            const qu = normalizeQuantityUnit(quantity, unit);
            if (qu.error) return res.status(400).json({ error: qu.error });
            normalizedQU = { quantity: qu.quantity, unit: qu.unit };
        }
        if (name === undefined && category === undefined && supplierId === undefined && !quantityTouched) {
            return res.status(400).json({ error: 'At least one of name, category, supplierId, or quantity/unit is required' });
        }

        // When supplierId is provided (non-null), ensure it serves the (possibly new) category
        if (supplierId) {
            const supRes = await queryWithRetry('SELECT categories FROM suppliers WHERE id = $1', [supplierId]);
            if (supRes.rows.length === 0) {
                return res.status(400).json({ error: 'Supplier not found' });
            }
            // Resolve effective category: incoming category, or existing one
            let effectiveCategory = category;
            if (!effectiveCategory) {
                const itemRes = await queryWithRetry('SELECT category FROM shopping_items WHERE id = $1', [id]);
                if (itemRes.rows.length === 0) {
                    return res.status(404).json({ error: 'Item not found' });
                }
                effectiveCategory = itemRes.rows[0].category;
            }
            const supCategories: string[] = supRes.rows[0].categories || [];
            if (!supCategories.includes(effectiveCategory)) {
                return res.status(400).json({ error: 'Supplier does not serve the selected category' });
            }
        }

        // Build dynamic update so we can distinguish "not provided" from "explicit null" on supplier_id
        const sets: string[] = [];
        const params: any[] = [];
        let p = 1;
        if (name !== undefined) { sets.push(`name = $${p++}`); params.push(name.trim()); }
        if (category !== undefined) { sets.push(`category = $${p++}`); params.push(category); }
        if (supplierId !== undefined) { sets.push(`supplier_id = $${p++}`); params.push(supplierId || null); }
        // If category changed without an explicit supplierId, clear supplier_id (it'd otherwise be stale)
        if (category !== undefined && supplierId === undefined) {
            sets.push(`supplier_id = NULL`);
        }
        if (normalizedQU) {
            sets.push(`quantity = $${p++}`); params.push(normalizedQU.quantity);
            sets.push(`unit = $${p++}`); params.push(normalizedQU.unit);
        }
        params.push(id);

        const updateRes = await queryWithRetry(
            `UPDATE shopping_items SET ${sets.join(', ')} WHERE id = $${p} RETURNING id`,
            params
        );

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const result = await queryWithRetry(`
            SELECT
                si.id,
                si.name,
                si.category,
                si.checked,
                TO_CHAR(si.date, 'YYYY-MM-DD') as date,
                si.created_at as "createdAt",
                si.created_by_user_id as "createdByUserId",
                si.created_by_user_name as "createdByUserName",
                si.supplier_id as "supplierId",
                s.name as "supplierName",
                si.quantity::float8 as quantity,
                si.unit as unit
            FROM shopping_items si
            LEFT JOIN suppliers s ON s.id = si.supplier_id
            WHERE si.id = $1
        `, [id]);

        const updatedItem = result.rows[0];

        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:updated', updatedItem, socketId);

        res.json(updatedItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/shopping/:id/toggle', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const toggleRes = await queryWithRetry(`
            UPDATE shopping_items
            SET checked = NOT checked
            WHERE id = $1
            RETURNING id
        `, [id]);

        if (toggleRes.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const result = await queryWithRetry(`
            SELECT
                si.id,
                si.name,
                si.category,
                si.checked,
                TO_CHAR(si.date, 'YYYY-MM-DD') as date,
                si.created_at as "createdAt",
                si.created_by_user_id as "createdByUserId",
                si.created_by_user_name as "createdByUserName",
                si.supplier_id as "supplierId",
                s.name as "supplierName",
                si.quantity::float8 as quantity,
                si.unit as unit
            FROM shopping_items si
            LEFT JOIN suppliers s ON s.id = si.supplier_id
            WHERE si.id = $1
        `, [id]);

        const updatedItem = result.rows[0];

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:updated', updatedItem, socketId);

        res.json(updatedItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// NOTE: keep this route BEFORE the /shopping/:id route — Express matches in
// declaration order, otherwise "clear-checked" is captured as :id.
app.delete('/shopping/clear-checked', authenticate, async (req, res) => {
    try {
        const { date } = req.query;

        if (date) {
            await queryWithRetry('DELETE FROM shopping_items WHERE date = $1 AND checked = true', [date]);
        } else {
            await queryWithRetry('DELETE FROM shopping_items WHERE checked = true');
        }

        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:cleared', { date: date || null }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/shopping/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await queryWithRetry('DELETE FROM shopping_items WHERE id = $1 RETURNING id, TO_CHAR(date, \'YYYY-MM-DD\') as date', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shopping:deleted', { id, date: result.rows[0].date }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// SUPPLIERS (fornitori, possono appartenere a 1+ shopping categories)
// ============================================
const VALID_SUPPLIER_CATEGORIES = ['CUCINA', 'BAR', 'ALTRO'] as const;
type SupplierCategory = (typeof VALID_SUPPLIER_CATEGORIES)[number];

const normalizeCategoriesInput = (input: unknown): { categories?: SupplierCategory[]; error?: string } => {
    if (!Array.isArray(input)) {
        return { error: 'categories must be a non-empty array of CUCINA, BAR, or ALTRO' };
    }
    const cleaned: SupplierCategory[] = [];
    const seen = new Set<string>();
    for (const c of input) {
        if (typeof c !== 'string' || !VALID_SUPPLIER_CATEGORIES.includes(c as SupplierCategory)) {
            return { error: 'categories must contain only CUCINA, BAR, or ALTRO' };
        }
        if (!seen.has(c)) {
            seen.add(c);
            cleaned.push(c as SupplierCategory);
        }
    }
    if (cleaned.length === 0) {
        return { error: 'categories must be a non-empty array of CUCINA, BAR, or ALTRO' };
    }
    return { categories: cleaned };
};

app.get('/suppliers', authenticate, async (_req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT
                id,
                name,
                categories,
                phone,
                note,
                created_at as "createdAt"
            FROM suppliers
            ORDER BY LOWER(name) ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/suppliers', authenticate, async (req, res) => {
    try {
        const { name, categories, phone, note } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const norm = normalizeCategoriesInput(categories);
        if (norm.error) return res.status(400).json({ error: norm.error });

        const result = await queryWithRetry(`
            INSERT INTO suppliers (name, categories, phone, note)
            VALUES ($1, $2::varchar(20)[], $3, $4)
            RETURNING id, name, categories, phone, note, created_at as "createdAt"
        `, [name.trim(), norm.categories, phone?.trim() || null, note?.trim() || null]);

        const supplier = result.rows[0];
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('supplier:created', supplier, socketId);

        res.status(201).json(supplier);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/suppliers/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, categories, phone, note } = req.body;

        if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
            return res.status(400).json({ error: 'name must be a non-empty string' });
        }
        let normalizedCategories: SupplierCategory[] | undefined;
        if (categories !== undefined) {
            const norm = normalizeCategoriesInput(categories);
            if (norm.error) return res.status(400).json({ error: norm.error });
            normalizedCategories = norm.categories;
        }
        if (name === undefined && categories === undefined && phone === undefined && note === undefined) {
            return res.status(400).json({ error: 'At least one of name, categories, phone, or note is required' });
        }

        const sets: string[] = [];
        const params: any[] = [];
        let p = 1;
        if (name !== undefined) { sets.push(`name = $${p++}`); params.push(name.trim()); }
        if (normalizedCategories !== undefined) { sets.push(`categories = $${p++}::varchar(20)[]`); params.push(normalizedCategories); }
        if (phone !== undefined) { sets.push(`phone = $${p++}`); params.push(phone?.trim() || null); }
        if (note !== undefined) { sets.push(`note = $${p++}`); params.push(note?.trim() || null); }
        params.push(id);

        const result = await queryWithRetry(
            `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${p}
             RETURNING id, name, categories, phone, note, created_at as "createdAt"`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }

        const supplier = result.rows[0];
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('supplier:updated', supplier, socketId);

        // If categories were narrowed, orphan supplier_id on items whose category is no longer served
        if (normalizedCategories !== undefined) {
            await queryWithRetry(
                `UPDATE shopping_items
                 SET supplier_id = NULL
                 WHERE supplier_id = $1 AND NOT (category = ANY ($2::varchar(20)[]))`,
                [id, normalizedCategories]
            );
        }

        res.json(supplier);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/suppliers/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry('DELETE FROM suppliers WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }

        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('supplier:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF MANAGEMENT ROUTES
// ============================================

// Get all staff members
app.get('/staff', authenticate, async (req, res) => {
    try {
        const { category } = req.query;
        let query = 'SELECT * FROM staff_members';
        const params: any[] = [];

        if (category) {
            query += ' WHERE category = $1';
            params.push(category);
        }

        query += ' ORDER BY surname, name';

        const result = await queryWithRetry(query, params);

        const staff = result.rows.map(row => ({
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));

        res.json(staff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create staff member
app.post('/staff', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { name, surname, category, staffType, phone, email, role, hireDate, contractEndDate, weeklyRestDay, notes } = req.body;

        if (!name || !surname || !category || !staffType) {
            return res.status(400).json({ error: 'Name, surname, category, and staffType are required' });
        }

        const result = await queryWithRetry(
            `INSERT INTO staff_members (name, surname, category, staff_type, phone, email, role, hire_date, contract_end_date, weekly_rest_day, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [name, surname, category, staffType, phone || null, email || null, role || null, hireDate || null, contractEndDate || null, weeklyRestDay ?? null, notes || null]
        );

        const row = result.rows[0];
        const staffMember = {
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('staff:created', staffMember, socketId);

        res.status(201).json(staffMember);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF SHIFTS ROUTES
// IMPORTANT: These specific paths must be defined BEFORE /staff/:id routes
// otherwise Express will match /staff/shifts as /staff/:id with id="shifts"
// ============================================

// Get shifts (optionally filtered by date and/or staffId)
app.get('/staff/shifts', authenticate, async (req, res) => {
    try {
        const { date, staffId, startDate, endDate } = req.query;
        let query = 'SELECT * FROM staff_shifts WHERE 1=1';
        const params: any[] = [];
        let paramCount = 0;

        if (date) {
            paramCount++;
            query += ` AND date = $${paramCount}`;
            params.push(date);
        }

        if (startDate && endDate) {
            paramCount++;
            query += ` AND date >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
            query += ` AND date <= $${paramCount}`;
            params.push(endDate);
        }

        if (staffId) {
            paramCount++;
            query += ` AND staff_id = $${paramCount}`;
            params.push(staffId);
        }

        query += ' ORDER BY date, shift';

        const result = await queryWithRetry(query, params);

        const shifts = result.rows.map(row => ({
            id: row.id,
            staffId: row.staff_id,
            date: row.date,
            shift: row.shift,
            present: row.present,
            notes: row.notes,
            createdAt: row.created_at
        }));

        res.json(shifts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create shift
app.post('/staff/shifts', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { staffId, date, shift, present, notes } = req.body;

        if (!staffId || !date || !shift) {
            return res.status(400).json({ error: 'staffId, date, and shift are required' });
        }

        const result = await queryWithRetry(
            `INSERT INTO staff_shifts (staff_id, date, shift, present, notes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (staff_id, date, shift) DO UPDATE SET present = $4, notes = $5
             RETURNING *`,
            [staffId, date, shift, present !== false, notes || null]
        );

        const row = result.rows[0];
        const shiftData = {
            id: row.id,
            staffId: row.staff_id,
            date: row.date,
            shift: row.shift,
            present: row.present,
            notes: row.notes,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shift:created', shiftData, socketId);

        res.status(201).json(shiftData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Bulk create shifts
app.post('/staff/shifts/bulk', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { shifts } = req.body;

        if (!Array.isArray(shifts) || shifts.length === 0) {
            return res.status(400).json({ error: 'shifts array is required' });
        }

        const createdShifts = [];
        for (const shift of shifts) {
            const result = await queryWithRetry(
                `INSERT INTO staff_shifts (staff_id, date, shift, present, notes)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (staff_id, date, shift) DO UPDATE SET present = $4, notes = $5
                 RETURNING *`,
                [shift.staffId, shift.date, shift.shift, shift.present !== false, shift.notes || null]
            );
            const row = result.rows[0];
            createdShifts.push({
                id: row.id,
                staffId: row.staff_id,
                date: row.date,
                shift: row.shift,
                present: row.present,
                notes: row.notes,
                createdAt: row.created_at
            });
        }

        res.status(201).json(createdShifts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update shift
app.put('/staff/shifts/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { present, notes } = req.body;

        const result = await queryWithRetry(
            `UPDATE staff_shifts SET
                present = COALESCE($1, present),
                notes = COALESCE($2, notes)
             WHERE id = $3
             RETURNING *`,
            [present, notes, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        const row = result.rows[0];
        const shiftData = {
            id: row.id,
            staffId: row.staff_id,
            date: row.date,
            shift: row.shift,
            present: row.present,
            notes: row.notes,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shift:updated', shiftData, socketId);

        res.json(shiftData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete shift
app.delete('/staff/shifts/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry('DELETE FROM staff_shifts WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('shift:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF TIME OFF ROUTES
// ============================================

// Get time off (optionally filtered by staffId and date range)
app.get('/staff/time-off', authenticate, async (req, res) => {
    try {
        const { staffId, startDate, endDate } = req.query;
        let query = 'SELECT * FROM staff_time_off WHERE 1=1';
        const params: any[] = [];
        let paramCount = 0;

        if (staffId) {
            paramCount++;
            query += ` AND staff_id = $${paramCount}`;
            params.push(staffId);
        }

        if (startDate && endDate) {
            paramCount++;
            query += ` AND start_date <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
            query += ` AND end_date >= $${paramCount}`;
            params.push(startDate);
        }

        query += ' ORDER BY start_date DESC';

        const result = await queryWithRetry(query, params);

        const timeOffs = result.rows.map(row => ({
            id: row.id,
            staffId: row.staff_id,
            startDate: row.start_date,
            endDate: row.end_date,
            type: row.type,
            shift: row.shift,
            notes: row.notes,
            approved: row.approved,
            createdAt: row.created_at
        }));

        res.json(timeOffs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create time off
app.post('/staff/time-off', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { staffId, startDate, endDate, type, shift, notes, approved } = req.body;

        if (!staffId || !startDate || !endDate || !type) {
            return res.status(400).json({ error: 'staffId, startDate, endDate, and type are required' });
        }

        if (shift && shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH, DINNER, or null' });
        }

        const result = await queryWithRetry(
            `INSERT INTO staff_time_off (staff_id, start_date, end_date, type, shift, notes, approved)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [staffId, startDate, endDate, type, shift || null, notes || null, approved !== false]
        );

        const row = result.rows[0];
        const timeOff = {
            id: row.id,
            staffId: row.staff_id,
            startDate: row.start_date,
            endDate: row.end_date,
            type: row.type,
            shift: row.shift,
            notes: row.notes,
            approved: row.approved,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('timeoff:created', timeOff, socketId);

        res.status(201).json(timeOff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update time off
app.put('/staff/time-off/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate, type, shift, notes, approved } = req.body;

        if (shift !== undefined && shift !== null && shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH, DINNER, or null' });
        }

        // shift is set unconditionally when the key is present in the body so the
        // client can clear it (full day) by sending null; COALESCE wouldn't allow that.
        const shiftProvided = 'shift' in req.body;

        const result = await queryWithRetry(
            `UPDATE staff_time_off SET
                start_date = COALESCE($1, start_date),
                end_date = COALESCE($2, end_date),
                type = COALESCE($3, type),
                shift = CASE WHEN $4::boolean THEN $5 ELSE shift END,
                notes = COALESCE($6, notes),
                approved = COALESCE($7, approved)
             WHERE id = $8
             RETURNING *`,
            [startDate, endDate, type, shiftProvided, shift ?? null, notes, approved, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Time off record not found' });
        }

        const row = result.rows[0];
        const timeOff = {
            id: row.id,
            staffId: row.staff_id,
            startDate: row.start_date,
            endDate: row.end_date,
            type: row.type,
            shift: row.shift,
            notes: row.notes,
            approved: row.approved,
            createdAt: row.created_at
        };

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('timeoff:updated', timeOff, socketId);

        res.json(timeOff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete time off
app.delete('/staff/time-off/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry('DELETE FROM staff_time_off WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Time off record not found' });
        }

        // Broadcast
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('timeoff:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get staff presence for a specific date.
// FISSO staff are implicitly present on both shifts during their hire period
// unless covered by a time-off entry or an explicit shift with present=false.
app.get('/staff/presence', authenticate, async (req, res) => {
    try {
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({ error: 'date is required' });
        }

        const dateStr = String(date);

        const [staffResult, shiftsResult, timeOffResult] = await Promise.all([
            queryWithRetry('SELECT * FROM staff_members WHERE is_active = true ORDER BY category, surname, name'),
            queryWithRetry('SELECT staff_id, shift, present FROM staff_shifts WHERE date = $1', [dateStr]),
            queryWithRetry('SELECT staff_id, shift FROM staff_time_off WHERE start_date <= $1 AND end_date >= $1', [dateStr])
        ]);

        // A NULL shift in time_off means the whole day is off; otherwise only the
        // specific shift is off, leaving the other one available as usual.
        const onTimeOffFullDay = new Set<string>();
        const onTimeOffShift = new Set<string>(); // key: `${staffId}-${shift}`
        for (const r of timeOffResult.rows) {
            if (r.shift) {
                onTimeOffShift.add(`${r.staff_id}-${r.shift}`);
            } else {
                onTimeOffFullDay.add(r.staff_id);
            }
        }

        const explicitShifts = new Map<string, boolean>();
        for (const row of shiftsResult.rows) {
            explicitShifts.set(`${row.staff_id}-${row.shift}`, row.present);
        }

        const staffByShift = {
            sala: { lunch: [] as any[], dinner: [] as any[] },
            cucina: { lunch: [] as any[], dinner: [] as any[] }
        };

        // Day of week for the requested date (0=Sunday … 6=Saturday)
        const dayOfWeek = new Date(`${dateStr}T00:00:00`).getDay();

        for (const row of staffResult.rows) {
            if (onTimeOffFullDay.has(row.id)) continue;
            // Weekly rest day overrides implicit presence (explicit shifts can still override below)
            const isWeeklyRest = row.weekly_rest_day !== null && row.weekly_rest_day === dayOfWeek;

            const isFisso = row.staff_type === 'FISSO';
            // Open boundaries: no hire_date means "always active until contract end",
            // no contract_end_date means "no end". Without this, a FISSO added without
            // explicit dates would never appear in the presence list.
            const inHirePeriod = isFisso
                && !isWeeklyRest
                && (!row.hire_date || row.hire_date <= dateStr)
                && (!row.contract_end_date || row.contract_end_date >= dateStr);

            const staff = {
                id: row.id,
                name: row.name,
                surname: row.surname,
                category: row.category,
                staffType: row.staff_type,
                role: row.role
            };

            const categoryKey = row.category === 'SALA' ? 'sala' : 'cucina';

            for (const shift of ['LUNCH', 'DINNER'] as const) {
                if (onTimeOffShift.has(`${row.id}-${shift}`)) continue;
                const explicit = explicitShifts.get(`${row.id}-${shift}`);
                const present = explicit !== undefined ? explicit : inHirePeriod;
                if (present) {
                    const shiftKey = shift === 'LUNCH' ? 'lunch' : 'dinner';
                    staffByShift[categoryKey][shiftKey].push(staff);
                }
            }
        }

        res.json(staffByShift);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STAFF MEMBER BY-ID ROUTES
// IMPORTANT: These parameterized routes must be defined AFTER all specific
// /staff/* paths (shifts, time-off, presence) to avoid route shadowing
// ============================================

// Get single staff member
app.get('/staff/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry('SELECT * FROM staff_members WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        const row = result.rows[0];
        res.json({
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update staff member
app.put('/staff/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, surname, category, staffType, phone, email, role, hireDate, contractEndDate, weeklyRestDay, notes, isActive } = req.body;

        // weeklyRestDay needs explicit handling so the client can clear it (null clears, undefined keeps)
        const result = await queryWithRetry(
            `UPDATE staff_members SET
                name = COALESCE($1, name),
                surname = COALESCE($2, surname),
                category = COALESCE($3, category),
                staff_type = COALESCE($4, staff_type),
                phone = COALESCE($5, phone),
                email = COALESCE($6, email),
                role = COALESCE($7, role),
                hire_date = COALESCE($8, hire_date),
                contract_end_date = COALESCE($9, contract_end_date),
                weekly_rest_day = CASE WHEN $10::text = 'KEEP' THEN weekly_rest_day ELSE $11::smallint END,
                notes = COALESCE($12, notes),
                is_active = COALESCE($13, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $14
             RETURNING *`,
            [
                name, surname, category, staffType, phone, email, role, hireDate, contractEndDate,
                weeklyRestDay === undefined ? 'KEEP' : 'SET',
                weeklyRestDay === undefined ? null : weeklyRestDay,
                notes, isActive, id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        const row = result.rows[0];
        const staffMember = {
            id: row.id,
            name: row.name,
            surname: row.surname,
            category: row.category,
            staffType: row.staff_type,
            phone: row.phone,
            email: row.email,
            role: row.role,
            hireDate: row.hire_date,
            contractEndDate: row.contract_end_date,
            weeklyRestDay: row.weekly_rest_day,
            notes: row.notes,
            isActive: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('staff:updated', staffMember, socketId);

        res.json(staffMember);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete staff member
app.delete('/staff/:id', authenticate, requirePermission('staff:full'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await queryWithRetry('DELETE FROM staff_members WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        // Broadcast to all connected clients
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastToAll('staff:deleted', { id }, socketId);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// PUSH NOTIFICATIONS (Web Push / VAPID)
// ============================================

app.get('/push/vapid-public-key', (_req, res) => {
    if (!isPushConfigured()) {
        return res.status(503).json({ error: 'Push notifications not configured' });
    }
    res.json({ publicKey: getVapidPublicKey() });
});

app.post('/push/subscribe', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { endpoint, keys, userAgent } = req.body || {};
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ error: 'Invalid subscription payload' });
        }

        await queryWithRetry(
            `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (endpoint) DO UPDATE
             SET user_id = EXCLUDED.user_id,
                 p256dh = EXCLUDED.p256dh,
                 auth = EXCLUDED.auth,
                 user_agent = EXCLUDED.user_agent`,
            [userId, endpoint, keys.p256dh, keys.auth, userAgent || null]
        );

        res.status(201).json({ ok: true });
    } catch (err) {
        console.error('POST /push/subscribe error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/push/unsubscribe', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { endpoint } = req.body || {};
        if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

        await queryWithRetry(
            'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
            [endpoint, userId]
        );

        res.json({ ok: true });
    } catch (err) {
        console.error('POST /push/unsubscribe error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/push/debug', authenticate, authorize(UserRole.OWNER, UserRole.GENERAL_MANAGER), async (_req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT ps.id, ps.user_id, u.email, u.full_name, u.role,
                    ps.user_agent, ps.created_at,
                    LEFT(ps.endpoint, 60) || '...' AS endpoint_preview
             FROM push_subscriptions ps
             JOIN users u ON u.id = ps.user_id
             ORDER BY u.full_name, ps.created_at DESC`
        );
        res.json({
            count: result.rows.length,
            subscriptions: result.rows,
        });
    } catch (err) {
        console.error('GET /push/debug error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/push/test', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const result = await pushSendToUser(userId, {
            title: 'Notifica di test',
            body: 'Le notifiche push funzionano correttamente.',
            url: '/',
            tag: 'test-notification'
        });

        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('POST /push/test error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// NOTIFICATIONS INBOX — persistent per-user history of push events
// ============================================
// The rows are populated by pushService.sendTo{User,Roles} *before* web-push
// delivery, so history survives closed browsers. Everything here is scoped
// to `req.user.userId` — no cross-user reads.

app.get('/notifications', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
        const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
        const includeDismissed = String(req.query.include_dismissed ?? '') === '1';
        const unreadOnly = String(req.query.unread ?? '') === '1';
        const category = typeof req.query.category === 'string' && req.query.category.trim() ? String(req.query.category).trim() : null;

        const where: string[] = ['recipient_user_id = $1'];
        const params: any[] = [userId];
        if (!includeDismissed) where.push('dismissed_at IS NULL');
        if (unreadOnly) where.push('read_at IS NULL');
        if (category) {
            params.push(category);
            where.push(`category = $${params.length}`);
        }
        params.push(limit); params.push(offset);
        const r = await queryWithRetry(
            `SELECT id, category, title, body, url, tag, metadata,
                    sent_at, read_at, dismissed_at
             FROM notifications
             WHERE ${where.join(' AND ')}
             ORDER BY sent_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        res.json({ notifications: r.rows });
    } catch (err) {
        console.error('GET /notifications error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/notifications/unread-count', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const r = await queryWithRetry(
            `SELECT COUNT(*)::int AS count FROM notifications
             WHERE recipient_user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL`,
            [userId]
        );
        res.json({ count: r.rows[0]?.count ?? 0 });
    } catch (err) {
        console.error('GET /notifications/unread-count error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Per-category counts for the NotifichePage filter chips. One query with
// FILTER clauses so the whole breakdown comes back in a single round-trip;
// scope is "notifiche non ancora rimosse" (same as the default list view).
app.get('/notifications/counts', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const r = await queryWithRetry(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread,
                COUNT(*) FILTER (WHERE category = 'reservation')::int AS reservation,
                COUNT(*) FILTER (WHERE category = 'voice')::int AS voice,
                COUNT(*) FILTER (WHERE category = 'payment')::int AS payment,
                COUNT(*) FILTER (WHERE category = 'message')::int AS message,
                COUNT(*) FILTER (WHERE category = 'email')::int AS email,
                COUNT(*) FILTER (WHERE category = 'system')::int AS system,
                COUNT(*) FILTER (
                    WHERE category IS NULL
                       OR category NOT IN ('reservation','voice','payment','message','email','system')
                )::int AS general
             FROM notifications
             WHERE recipient_user_id = $1 AND dismissed_at IS NULL`,
            [userId]
        );
        const row = r.rows[0] || {};
        res.json({
            total: row.total ?? 0,
            unread: row.unread ?? 0,
            by_category: {
                reservation: row.reservation ?? 0,
                voice: row.voice ?? 0,
                payment: row.payment ?? 0,
                message: row.message ?? 0,
                email: row.email ?? 0,
                system: row.system ?? 0,
                general: row.general ?? 0,
            },
        });
    } catch (err) {
        console.error('GET /notifications/counts error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/notifications/:id/read', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
        await queryWithRetry(
            `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
            [id, userId]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('POST /notifications/:id/read error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/notifications/read-all', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const r = await queryWithRetry(
            `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
             WHERE recipient_user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL
             RETURNING id`,
            [userId]
        );
        res.json({ ok: true, marked: r.rows.length });
    } catch (err) {
        console.error('POST /notifications/read-all error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/notifications/:id/dismiss', authenticate, async (req: any, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
        await queryWithRetry(
            `UPDATE notifications
             SET dismissed_at = CURRENT_TIMESTAMP, read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
             WHERE id = $1 AND recipient_user_id = $2 AND dismissed_at IS NULL`,
            [id, userId]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('POST /notifications/:id/dismiss error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// WHATSAPP HELPER FUNCTIONS
// ============================================

// Process WhatsApp booking message
async function processWhatsAppBooking(phoneNumber: string, messageText: string) {
    console.log(`[WhatsApp] Processing booking from ${phoneNumber}: ${messageText}`);

    // Parse the message
    const bookingData = parseBookingMessage(messageText);

    // Fire-and-forget WhatsApp replies. The booking itself must never be lost
    // because Twilio/Vonage rate-limited us or the network blipped — we save
    // first and reply on a best-effort basis.
    const replyAsync = (text: string) => {
        sendWhatsAppText(phoneNumber, text).catch(err =>
            console.error('[WhatsApp] reply send failed:', err)
        );
    };

    if (!bookingData) {
        replyAsync(
            "❌ Non ho capito il messaggio. Per favore usa questo formato:\n\n" +
            "DATA ORA OSPITI NOME\n\n" +
            "Esempio: 15/12 20:00 4 Marco Rossi"
        );
        return;
    }

    // Check if we have all required info
    const missingFields = [];
    if (!bookingData.date) missingFields.push("data");
    if (!bookingData.time) missingFields.push("ora");
    if (!bookingData.guests) missingFields.push("numero ospiti");
    if (!bookingData.name) missingFields.push("nome");

    if (missingFields.length > 0) {
        replyAsync(
            `⚠️ Mancano alcune informazioni: ${missingFields.join(", ")}\n\n` +
            "Per favore invia: DATA ORA OSPITI NOME\n\n" +
            "Esempio: 15/12 20:00 4 Marco Rossi"
        );
        return;
    }

    try {
        // TypeScript assertions - we've already validated these fields exist
        const date = bookingData.date!;
        const time = bookingData.time!;
        const name = bookingData.name!;
        const guests = bookingData.guests!;

        // Determine shift based on time
        const shift = determineShift(time);

        // Create reservation in database. WhatsApp bookings land as PENDING ("Da
        // confermare") — staff reviews them in the list and the confirmation
        // message is fired automatically when they flip the status to CONFIRMED.
        const result = await queryWithRetry(
            'INSERT INTO reservations (customer_name, reservation_time, shift, guests, phone, payment_status, arrival_status, reservation_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [
                name,
                `${date}T${time}`,
                shift,
                guests,
                phoneNumber,
                PaymentStatus.PENDING,
                'WAITING',
                'PENDING'
            ]
        );

        const newReservation = result.rows[0];

        // Broadcast via Socket.IO
        if (socketService) {
            socketService.broadcastReservationCreated(newReservation);
        }

        // Auto-save WhatsApp contact to the rubrica.
        await upsertCustomerFromReservation(name, phoneNumber, null, null);

        console.log(`[WhatsApp] ✅ Reservation created successfully for ${name}. Waiting for manual confirmation.`);

        // Ack the guest only after the booking is safely saved. Fire-and-forget
        // so a Twilio rate-limit or transient error can't roll back the work.
        replyAsync(
            "Grazie per la richiesta di prenotazione, a breve ricevera la conferma della disponibilita del tavolo per la data e ora richiesta."
        );

    } catch (error) {
        console.error('[WhatsApp] Error creating reservation:', error);
        replyAsync(
            "❌ Si è verificato un errore durante la creazione della prenotazione.\n\n" +
            "Per favore riprova o contattaci telefonicamente."
        );
    }
}

// Parse booking message (supports both structured and natural language)
function parseBookingMessage(text: string): { date: string | null, time: string | null, guests: number | null, name: string | null } | null {
    if (!text || text.trim().length === 0) return null;

    // Try structured format first: "15/12 20:00 4 Marco Rossi"
    const structuredMatch = text.match(/(\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s+(\d{1,2}:\d{2})\s+(\d+)\s+(.+)/i);
    if (structuredMatch) {
        return {
            date: normalizeDate(structuredMatch[1]),
            time: structuredMatch[2],
            guests: parseInt(structuredMatch[3]),
            name: structuredMatch[4].trim()
        };
    }

    // Try natural language patterns
    const dateMatch = text.match(/(\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
    const timeMatch = text.match(/(\d{1,2}:\d{2})/);
    const guestsMatch = text.match(/(\d+)\s*(?:persone?|ospiti?|pax)/i);
    const nameMatch = text.match(/(?:nome[:\s]+|per\s+)([A-Za-zÀ-ÿ\s]+?)(?:\s+tel|\s+\d|$)/i);

    if (dateMatch || timeMatch || guestsMatch || nameMatch) {
        return {
            date: dateMatch ? normalizeDate(dateMatch[1]) : null,
            time: timeMatch ? timeMatch[1] : null,
            guests: guestsMatch ? parseInt(guestsMatch[1]) : null,
            name: nameMatch ? nameMatch[1].trim() : null
        };
    }

    return null;
}

// Build the booking-confirmation message. Includes full name, date, time,
// party size and (when known) the room — the data points the guest needs to
// verify the booking. Shared by the manual /confirm-whatsapp endpoint, the
// auto-fire on PENDING→CONFIRMED in PUT /reservations/:id, the auto-confirmed
// web bookings and the voice-agent post-call.
//
// Il tavolo assegnato non entra MAI in questo messaggio: è un dato operativo
// che lo staff sposta fino all'ultimo, e comunicarlo crea solo aspettative da
// smentire all'arrivo. Al cliente basta la sala.
// Link breve del profilo Google Business del ristorante (scheda "Vecchio
// Frantoio", Buonvicino CS — entità /g/1tf45dt8). Lo stesso URL è nel bottone
// del template WhatsApp booking_confirmed_v3: cambiarlo qui NON aggiorna il
// template, che richiede un nuovo template e una nuova approvazione Meta.
const MAPS_DIRECTIONS_URL = 'https://maps.app.goo.gl/pf1DjUYzkhi1sStP8';

function buildConfirmationMessage(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined,
    roomName?: string | null
): string {
    // This builder is always fed a DB `timestamptz` (a UTC instant). If it
    // arrives as a bare naive string (no Z/offset), read it as UTC so the Rome
    // formatting shows the real wall-clock — a 20:30 Rome booking is stored
    // 18:30Z and must NOT display as 18:30. (formatBookingDateTime's naive
    // branch assumes wall-clock, which is correct only for the web-form input
    // used by the request email, not for DB-sourced confirmation times.)
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
    const fullName = toTitleCase(customerName);
    const greeting = fullName ? `Ciao ${fullName}, la tua` : 'La';
    const guestsNum = Math.max(1, Math.trunc(Number(guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    const room = (roomName ?? '').trim();
    const roomPart = room ? ` in ${room}` : '';
    // Niente link Maps qui: questo testo finisce negli SMS e il link — anche
    // in forma maps.app.goo.gl — porta il messaggio tipico oltre i 160
    // caratteri, cioè a 2 segmenti fatturati. Il link viaggia solo dove non
    // costa: bottone del template WhatsApp e email (contactBlockHtml).
    return `${greeting} prenotazione per ${guestsNum} ${persone} il ${dateLabel} alle ${timeLabel}${roomPart} e' confermata. A presto!`;
}

// Resolve the room name for a reservation, preferring the actually assigned
// room (via table_id JOIN) and falling back to the customer's requested room
// stored in notes as "Sala richiesta: <name>." by POST /public/reservations.
// Returns null when no room information is available.
async function resolveReservationRoomName(reservation: { table_id?: number | null; notes?: string | null }): Promise<string | null> {
    if (reservation.table_id) {
        try {
            const r = await queryWithRetry(
                `SELECT rm.name FROM tables t JOIN rooms rm ON rm.id = t.room_id WHERE t.id = $1`,
                [reservation.table_id]
            );
            const name = r.rows[0]?.name;
            if (typeof name === 'string' && name.trim()) return name.trim();
        } catch (err) {
            console.warn('[resolveReservationRoomName] JOIN lookup failed:', err);
        }
    }
    const notes = String(reservation.notes ?? '');
    const match = notes.match(/Sala richiesta:\s*([^.]+?)\./i);
    if (match) return match[1].trim();
    return null;
}

// Build the decline message sent when staff couldn't accept a booking request.
// Same four data points as the confirmation so the guest knows exactly which
// request was declined. Fired by the auto-send on → DECLINED in PUT /reservations/:id.
function buildDeclineMessage(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined
): string {
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
    const fullName = toTitleCase(customerName);
    const greeting = fullName ? `Ciao ${fullName}, purtroppo` : 'Purtroppo';
    const guestsNum = Math.max(1, Math.trunc(Number(guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    return `${greeting} non ci e' stato possibile confermare la tua richiesta di prenotazione per ${guestsNum} ${persone} il ${dateLabel} alle ${timeLabel}. Chiamaci allo 0985 876578 per verificare un'altra data/orario. Grazie e a presto!`;
}

// Template builders for the approved Twilio WA content templates. Each returns
// undefined when the corresponding TWILIO_WA_CONTENT_SID_* env var is not set —
// sendBookingConfirmation then falls back to SMS. Room name is intentionally
// excluded from all templates (Meta rejects empty variables); the SMS body still
// includes it when known. Empty-name guard sends '—' so a missing customer_name
// can't blow up the template with an empty var.
function templateGuestsLabel(guests: number | null | undefined): string {
    const n = Math.max(1, Math.trunc(Number(guests) || 1));
    return `${n} ${n === 1 ? 'persona' : 'persone'}`;
}
function templateName(customerName: string | null | undefined): string {
    const t = toTitleCase(customerName);
    return t || '—';
}
function buildBookingConfirmedTemplate(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined
): WhatsAppTemplateOpts | undefined {
    const contentSid = process.env.TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED;
    if (!contentSid) return undefined;
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
    return {
        contentSid,
        contentVariables: {
            '1': templateName(customerName),
            '2': templateGuestsLabel(guests),
            '3': dateLabel,
            '4': timeLabel,
        },
    };
}
function buildBookingDeclinedTemplate(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined
): WhatsAppTemplateOpts | undefined {
    const contentSid = process.env.TWILIO_WA_CONTENT_SID_BOOKING_DECLINED;
    if (!contentSid) return undefined;
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
    return {
        contentSid,
        contentVariables: {
            '1': templateName(customerName),
            '2': templateGuestsLabel(guests),
            '3': dateLabel,
            '4': timeLabel,
        },
    };
}
function buildBookingDepositConfirmedTemplate(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined,
    amountCents: number
): WhatsAppTemplateOpts | undefined {
    const contentSid = process.env.TWILIO_WA_CONTENT_SID_BOOKING_DEPOSIT_CONFIRMED;
    if (!contentSid) return undefined;
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(reservationTime));
    return {
        contentSid,
        contentVariables: {
            '1': templateName(customerName),
            '2': formatEuroMinor(amountCents),
            '3': templateGuestsLabel(guests),
            '4': dateLabel,
            '5': timeLabel,
        },
    };
}

// Twilio templates for the pay-at-table link. Two shapes are supported so
// we can switch as Meta approvals land:
//   - CTA (preferred, `TWILIO_WA_CONTENT_SID_TABLE_BILL_LINK_CTA`):
//     twilio/call-to-action, body {{1}}..{{3}} (name, covers, total),
//     button URL `https://crm.vecchiofrantoio.com/pay/{{4}}`.
//     Body starts at {{1}} so Meta's positional body-var mapping matches
//     Twilio's ContentVariables — the previous card template failed with
//     63028 because body started at {{2}} (media occupied {{1}}).
//   - QR card (`TWILIO_WA_CONTENT_SID_TABLE_BILL_LINK`, template
//     `table_bill_link_qr_v2`): twilio/card with media header + CTA.
//     Body {{1}}..{{3}}; media is `https://<railway>/{{4}}` where {{4}} is
//     the WHOLE path `pay/<token>/qr.png` — Twilio requires the media
//     variable to be the trailing suffix of the URL and to carry the file
//     extension; a variable mid-URL (the v1 shape) fails at send with 63028
//     even when the template is approved. Button uses {{5}} (token only).
// When both envs are set the CTA one wins.
function templateCoversLabel(covers: number | null | undefined): string {
    const n = Math.max(1, Math.trunc(Number(covers) || 1));
    return `${n} ${n === 1 ? 'coperto' : 'coperti'}`;
}
function buildTableBillLinkTemplate(
    customerName: string | null | undefined,
    covers: number | null | undefined,
    amountCents: number,
    shareToken: string
): WhatsAppTemplateOpts | undefined {
    if (!shareToken) return undefined;
    const name = templateName(customerName);
    const coversLabel = templateCoversLabel(covers);
    const total = formatEuroMinor(amountCents);
    const ctaSid = process.env.TWILIO_WA_CONTENT_SID_TABLE_BILL_LINK_CTA;
    if (ctaSid) {
        return {
            contentSid: ctaSid,
            contentVariables: {
                '1': name,
                '2': coversLabel,
                '3': total,
                '4': shareToken,
            },
        };
    }
    const cardSid = process.env.TWILIO_WA_CONTENT_SID_TABLE_BILL_LINK;
    if (!cardSid) return undefined;
    return {
        contentSid: cardSid,
        contentVariables: {
            '1': name,
            '2': coversLabel,
            '3': total,
            '4': `pay/${shareToken}/qr.png`,
            '5': shareToken,
        },
    };
}

// The booking_deposit_request template on Twilio is a Call-to-Action card:
// body has {{1}}..{{5}} (name, guests, date, time, amount), and the button
// URL is hardcoded as https://checkout.revolut.com/pay/{{6}} — so {{6}} must
// carry ONLY the trailing token, not the full URL. Returns undefined when
// the token can't be parsed (e.g. sandbox / unrecognised host) so the
// dispatcher can fall back to SMS instead of shipping a broken WA link.
//
// Because the host lives in the template and not in the variable, this MUST
// reject any checkout URL that isn't Revolut's: a SumUp link
// (checkout.sumup.com/pay/<id>) has the same path shape, and blindly lifting
// its token would produce a button pointing at checkout.revolut.com with a
// SumUp id — a dead link. Returning null instead degrades to SMS with the
// full URL, which is exactly the fallback described above.
const REVOLUT_CHECKOUT_HOSTS = new Set([
    'checkout.revolut.com',
    'sandbox-checkout.revolut.com',
]);
function extractRevolutCheckoutToken(checkoutUrl: string): string | null {
    try {
        const u = new URL(checkoutUrl);
        if (!REVOLUT_CHECKOUT_HOSTS.has(u.hostname.toLowerCase())) return null;
        const match = u.pathname.match(/\/pay\/([^\/?#]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}
function buildBookingDepositRequestTemplate(
    customerName: string | null | undefined,
    guestsLabel: string,
    dateLabel: string,
    timeLabel: string,
    amountCents: number,
    checkoutUrl: string
): WhatsAppTemplateOpts | undefined {
    const contentSid = process.env.TWILIO_WA_CONTENT_SID_BOOKING_DEPOSIT_REQUEST;
    if (!contentSid) return undefined;
    const token = extractRevolutCheckoutToken(checkoutUrl);
    if (!token) return undefined;
    return {
        contentSid,
        contentVariables: {
            '1': templateName(customerName),
            '2': guestsLabel,
            '3': dateLabel,
            '4': timeLabel,
            '5': formatEuroMinor(amountCents),
            '6': token,
        },
    };
}

// Absolute base URL for the running app — needed by email templates because
// mail clients don't resolve relative paths. Priority order matches the rest
// of the codebase (webhook > frontend). Returns null when nothing is set (dev
// without env), in which case the email header falls back to text only.
function publicAppBaseUrl(): string | null {
    const raw = process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.VITE_API_URL;
    if (!raw) return null;
    return raw.replace(/\/+$/, '');
}

// Shared HTML wrapper for customer-facing emails. Kept intentionally simple
// (inline styles, no external assets beyond the brand logo) so it renders
// identically across Gmail, Outlook, Apple Mail without a CSS-support
// surprise.
//
// Dark-mode handling: the logo artwork is monochrome, so a black-on-transparent
// PNG becomes invisible against a dark inbox background. We inline two <img>
// tags — the "light" variant is visible by default, the "dark" variant is
// hidden with display:none, and a @media (prefers-color-scheme: dark) rule
// flips them. Backing colors (background, text, card) are swapped in the same
// rule. Apple Mail and Gmail (iOS/Android) honour the media query; clients
// that ignore it (older Outlook) simply see the light version — still legible
// on their default light chrome.
function wrapEmailHtml(preheader: string, bodyBlocks: string): string {
    const base = publicAppBaseUrl();
    const logoLight = base
        ? `<img class="logo-light" src="${base}/prenota/logo.png" alt="Il Vecchio Frantoio" width="160" style="display:block;margin:0 auto;max-width:160px;height:auto;">`
        : '';
    const logoDark = base
        ? `<img class="logo-dark" src="${base}/prenota/logo-dark.png" alt="Il Vecchio Frantoio" width="160" style="display:none;margin:0 auto;max-width:160px;height:auto;">`
        : '';
    const preheaderText = escapeHtml(preheader);
    // Mail clients can't resolve relative paths, so the privacy link needs the
    // absolute base. When no base URL is configured (dev) we omit the link
    // rather than emit a broken href.
    const privacyLink = base
        ? ` · <a href="${base}/privacy" style="color:#a8a29e;text-decoration:underline;">Informativa privacy</a>`
        : '';
    return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Il Vecchio Frantoio</title>
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    .bg-wrap { background: #1c1917 !important; }
    .card { background: #292524 !important; box-shadow: none !important; }
    .card td, .card p, .card li, .card strong, .card em { color: #e7e5e4 !important; }
    .card .muted { color: #a8a29e !important; }
    .footer { border-top-color: #44403c !important; color: #78716c !important; }
    .detail-box { background: #1c1917 !important; }
    .confirm-box { background: rgba(16, 185, 129, 0.12) !important; border-color: rgba(16, 185, 129, 0.35) !important; }
    .confirm-box td { color: #6ee7b7 !important; }
    .logo-light { display: none !important; }
    .logo-dark { display: block !important; }
  }
</style>
</head>
<body class="bg-wrap" style="margin:0;padding:0;background:#fbf9f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#292524;">
<span style="display:none;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${preheaderText}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg-wrap" style="background:#fbf9f4;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" class="card" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);overflow:hidden;">
      <tr><td style="padding:36px 32px 20px;text-align:center;">
        ${logoLight}
        ${logoDark}
      </td></tr>
      <tr><td style="padding:8px 32px 32px;">${bodyBlocks}</td></tr>
      <tr><td class="footer muted" style="padding:16px 32px 28px;border-top:1px solid #f5f5f4;text-align:center;font-size:11px;color:#a8a29e;letter-spacing:0.24em;text-transform:uppercase;">Cucina Tradizionale${privacyLink}</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Rendered block with call/WhatsApp CTAs for the customer emails. Kept in one
// place so any future number change lives in a single spot. The WhatsApp link
// uses wa.me (works in Gmail, iOS Mail, most clients); the phone link uses
// tel: so a tap on mobile opens the dialer.
function contactBlockHtml(): string {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;">
        <tr>
          <td style="font-size:13px;line-height:1.6;color:#57534e;padding:8px 12px;border:1px solid #e7e5e4;border-radius:10px;background:#fbf9f4;">
            <strong style="color:#292524;">Contattaci direttamente:</strong><br>
            📞 <a href="tel:+390985876578" style="color:#065f46;text-decoration:none;">0985 876578</a>
            &nbsp;·&nbsp;
            💬 <a href="https://wa.me/393895916494" style="color:#065f46;text-decoration:none;">WhatsApp +39 389 591 6494</a>
            &nbsp;·&nbsp;
            📍 <a href="${MAPS_DIRECTIONS_URL}" style="color:#065f46;text-decoration:none;">Come raggiungerci</a>
          </td>
        </tr>
      </table>
    `;
}

// Small helper that formats reservation date/time in Italian for the customer
// emails. Returns { dateLabel: '15/07/2026', timeLabel: '20:30' }.
//
// Two input shapes need to work correctly:
//   1) DB-sourced timestamptz value (already a proper UTC instant, e.g.
//      "2026-07-24T19:00:00.000Z" for 21:00 CEST). We render it in
//      Europe/Rome and get "21:00" back.
//   2) Client-sourced naive datetime string (e.g. "2026-07-24T21:00:00",
//      no `Z`, no offset). Node runs with TZ=UTC on Railway, so passing this
//      to `new Date(...)` interprets it as UTC and `toLocaleTimeString` then
//      shifts it to Rome (+1h in CET, +2h in CEST) — that's the bug that
//      showed 23:00 in a request-ack email for a 21:00 booking. For naive
//      strings we extract the wall-clock parts directly, no Date detour.
// Coerce a DB-sourced reservation_time to a real instant. node-pg normally
// returns a Date, but a value can also reach a formatter as a bare naive ISO
// string (no Z/offset). For DB-sourced values that string is the UTC instant,
// so append 'Z' before it hits formatBookingDateTime's naive branch (which
// would otherwise read it as wall-clock and show the UTC hour). Date and
// already-marked strings pass through unchanged. Do NOT use this for the
// web-form input (buildBookingRequestEmail), whose naive string is Rome
// wall-clock — see fix #85.
function asUtcInstant(v: string | Date): string | Date {
    if (typeof v !== 'string') return v;
    const isNaive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)
        && !/Z$/.test(v)
        && !/[+-]\d{2}:?\d{2}$/.test(v);
    return isNaive ? v + 'Z' : v;
}

function formatBookingDateTime(reservationTime: string | Date): { dateLabel: string; timeLabel: string } {
    if (typeof reservationTime === 'string') {
        const isNaive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(reservationTime)
            && !/Z$/.test(reservationTime)
            && !/[+-]\d{2}:?\d{2}$/.test(reservationTime);
        if (isNaive) {
            const m = reservationTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
            if (m) {
                const [, year, month, day, hh, mm] = m;
                return { dateLabel: `${day}/${month}/${year}`, timeLabel: `${hh}:${mm}` };
            }
        }
    }
    const dt = reservationTime instanceof Date ? reservationTime : new Date(reservationTime);
    const dateLabel = dt.toLocaleDateString('it-IT', {
        timeZone: 'Europe/Rome',
        day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const timeLabel = dt.toLocaleTimeString('it-IT', {
        timeZone: 'Europe/Rome',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return { dateLabel, timeLabel };
}

// Compact "29 lug 13:30" label for reservation push notifications, always
// rendered in Europe/Rome (Railway runs Node with TZ=UTC, so the bare
// toLocale* calls previously showed the UTC hour — 13:30 became 11:30).
// Same naive-string contract as formatBookingDateTime: a string without
// Z/offset is Rome wall-clock (client input) and is read verbatim; DB-sourced
// values must pass through asUtcInstant at the call site.
function reservationPushLabel(reservationTime: string | Date): string {
    if (typeof reservationTime === 'string') {
        const m = reservationTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        const isNaive = !!m && !/Z$/.test(reservationTime) && !/[+-]\d{2}:?\d{2}$/.test(reservationTime);
        if (isNaive && m) {
            const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
            return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[4]}:${m[5]}`;
        }
    }
    const dt = reservationTime instanceof Date ? reservationTime : new Date(reservationTime);
    if (Number.isNaN(dt.getTime())) return String(reservationTime);
    const date = dt.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short' });
    const time = dt.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
}

// Booking-request acknowledgement email — sent immediately when a customer
// submits a reservation from /prenota with an email. The booking is still
// PENDING; the wording makes clear that a staff confirmation is coming.
function buildBookingRequestEmail(params: {
    customerName: string;
    reservationTime: string | Date;
    guests: number;
    roomName?: string | null;
    notes?: string | null;
}): { subject: string; text: string; html: string } {
    const { dateLabel, timeLabel } = formatBookingDateTime(params.reservationTime);
    const name = toTitleCase(params.customerName);
    const guestsNum = Math.max(1, Math.trunc(Number(params.guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    const room = (params.roomName || '').trim();
    const roomPart = room ? ` (${room})` : '';
    const subject = `Abbiamo ricevuto la tua richiesta — ${dateLabel} ${timeLabel}`;
    const greetingText = name ? `Ciao ${name},` : 'Ciao,';
    const text = `${greetingText}

abbiamo ricevuto la tua richiesta di prenotazione:

• Data: ${dateLabel}
• Ora: ${timeLabel}
• Ospiti: ${guestsNum} ${persone}${room ? `\n• Sala richiesta: ${room}` : ''}

Ti ricontatteremo a breve per confermarla via email, telefono o WhatsApp.

Per qualsiasi cambio puoi contattarci:
• Telefono: 0985 876578
• WhatsApp: +39 389 591 6494

Grazie e a presto!
Il Vecchio Frantoio`;

    const detailsHtml = `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${greetingText}<br>abbiamo ricevuto la tua richiesta di prenotazione.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" class="detail-box" style="width:100%;background:#fbf9f4;border-radius:12px;padding:16px;margin:0 0 16px;">
        <tr><td style="padding:6px 0;font-size:14px;"><strong>Data:</strong> ${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 0;font-size:14px;"><strong>Ora:</strong> ${escapeHtml(timeLabel)}</td></tr>
        <tr><td style="padding:6px 0;font-size:14px;"><strong>Ospiti:</strong> ${guestsNum} ${persone}${roomPart ? ` · ${escapeHtml(room)}` : ''}</td></tr>
      </table>
      <p class="muted" style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#57534e;">Ti ricontatteremo a breve per confermarla via email, telefono o WhatsApp.</p>
      ${contactBlockHtml()}
      <p style="margin:16px 0 0;font-size:14px;">Grazie e a presto!<br><em>Il Vecchio Frantoio</em></p>
    `;
    const html = wrapEmailHtml(`Richiesta prenotazione ricevuta per il ${dateLabel} alle ${timeLabel}`, detailsHtml);
    return { subject, text, html };
}

// Booking-confirmation email — sent when staff flips a PENDING reservation to
// CONFIRMED, or when the manual /confirm-email endpoint is invoked. Wraps the
// same one-line text used by SMS/WhatsApp in a proper HTML layout.
function buildBookingConfirmationEmail(params: {
    customerName: string;
    reservationTime: string | Date;
    guests: number;
    roomName?: string | null;
}): { subject: string; text: string; html: string } {
    // DB-sourced confirmation time → read a bare naive string as UTC (see
    // asUtcInstant). The request email above keeps the raw web-form input (#85).
    const { dateLabel, timeLabel } = formatBookingDateTime(asUtcInstant(params.reservationTime));
    const guestsNum = Math.max(1, Math.trunc(Number(params.guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    const room = (params.roomName || '').trim();
    const roomPart = room ? ` · ${escapeHtml(room)}` : '';
    const name = toTitleCase(params.customerName);
    const subject = `Conferma prenotazione — ${dateLabel} ${timeLabel}`;
    const shortConfirm = buildConfirmationMessage(params.customerName, params.reservationTime, params.guests, params.roomName ?? null);
    const text = `${shortConfirm}\n\nSe hai bisogno di modificare o annullare puoi rispondere a questa email oppure contattarci:\n• Telefono: 0985 876578\n• WhatsApp: +39 389 591 6494\n• Come raggiungerci: ${MAPS_DIRECTIONS_URL}`;

    const detailsHtml = `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${name ? `Ciao ${escapeHtml(name)},` : 'Ciao,'}<br>la tua prenotazione è <strong>confermata</strong>.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" class="confirm-box" style="width:100%;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px;margin:0 0 16px;">
        <tr><td style="padding:6px 0;font-size:14px;color:#065f46;"><strong>Data:</strong> ${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#065f46;"><strong>Ora:</strong> ${escapeHtml(timeLabel)}</td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#065f46;"><strong>Ospiti:</strong> ${guestsNum} ${persone}${roomPart}</td></tr>
      </table>
      <p class="muted" style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#57534e;">Ti aspettiamo a tavola. Se hai bisogno di modificare o annullare, rispondi a questa email o contattaci direttamente.</p>
      ${contactBlockHtml()}
      <p style="margin:16px 0 0;font-size:14px;">A presto!<br><em>Il Vecchio Frantoio</em></p>
    `;
    const html = wrapEmailHtml(`Prenotazione confermata per il ${dateLabel} alle ${timeLabel}`, detailsHtml);
    return { subject, text, html };
}

// Free-form email — staff-composed subject + body, wrapped in the shared
// branded template so the tone matches the automatic transactional mails.
// Line breaks in the body are preserved (each newline becomes a <br>). Used
// by POST /reservations/:id/send-custom-email for corrections, one-off
// updates, and manual replies that don't fit any of the templated flows.
function buildCustomEmail(params: {
    customerName?: string | null;
    subject: string;
    body: string;
}): { subject: string; text: string; html: string } {
    const name = toTitleCase(params.customerName);
    const subject = params.subject.trim();
    const rawBody = params.body.trim();
    const greeting = name ? `Ciao ${name},` : 'Ciao,';
    const text = `${greeting}\n\n${rawBody}\n\nGrazie e a presto!\nIl Vecchio Frantoio`;

    // Preserve author-intended line breaks. Consecutive newlines become
    // paragraph splits (blank <p>), single newlines become <br>. Every chunk
    // is escaped first so a body containing "<" doesn't inject markup.
    const paragraphs = rawBody.split(/\n{2,}/).map(block => {
        const inner = block.split('\n').map(escapeHtml).join('<br>');
        return `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${inner}</p>`;
    }).join('');

    const detailsHtml = `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
      ${paragraphs}
      <p style="margin:16px 0 0;font-size:14px;">Grazie e a presto!<br><em>Il Vecchio Frantoio</em></p>
    `;
    const html = wrapEmailHtml(subject, detailsHtml);
    return { subject, text, html };
}

// Normalize date to YYYY-MM-DD format
function normalizeDate(dateStr: string): string {
    const parts = dateStr.split('/');
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2] || new Date().getFullYear().toString();
    return `${year}-${month}-${day}`;
}

// Determine shift (LUNCH or DINNER) based on time
function determineShift(time: string): Shift {
    const hour = parseInt(time.split(':')[0]);
    return (hour >= 11 && hour < 17) ? Shift.LUNCH : Shift.DINNER;
}

// Send WhatsApp message via Vonage API
async function sendVonageWhatsApp(to: string, text: string): Promise<void> {
    const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
    const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
    const VONAGE_WHATSAPP_NUMBER = process.env.VONAGE_WHATSAPP_NUMBER;

    if (!VONAGE_API_KEY || !VONAGE_API_SECRET || !VONAGE_WHATSAPP_NUMBER) {
        console.error('[Vonage] Missing configuration. Set VONAGE_API_KEY, VONAGE_API_SECRET, and VONAGE_WHATSAPP_NUMBER');
        return;
    }

    // Ensure phone number is in E.164 format (with + prefix)
    const formattedTo = to.startsWith('+') ? to : `+${to}`;
    const formattedFrom = VONAGE_WHATSAPP_NUMBER.startsWith('+') ? VONAGE_WHATSAPP_NUMBER : `+${VONAGE_WHATSAPP_NUMBER}`;

    console.log(`[Vonage] Sending message to ${formattedTo} from ${formattedFrom}`);

    try {
        const auth = Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString('base64');

        const response = await fetch('https://messages-sandbox.nexmo.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            body: JSON.stringify({
                from: formattedFrom,
                to: formattedTo,
                message_type: 'text',
                text: text,
                channel: 'whatsapp'
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Vonage API error: ${response.status} - ${errorBody}`);
        }

        const result = await response.json();
        console.log(`[Vonage] ✅ Message sent to ${to}`, result);

    } catch (error) {
        console.error('[Vonage] ❌ Error sending message:', error);
        throw error;
    }
}

// Twilio WhatsApp — sandbox during testing, business number after porting.
// Recipients must "join <code>" via WhatsApp once before they can receive
// messages from the sandbox sender.
function isTwilioWhatsAppConfigured(): boolean {
    return !!(process.env.TWILIO_ACCOUNT_SID
        && process.env.TWILIO_AUTH_TOKEN
        && process.env.TWILIO_WHATSAPP_FROM);
}

// Result of an outbound Twilio send. `sid` is undefined for providers that
// don't return one (e.g. Vonage) — the caller can then skip delivery tracking.
interface OutboundConfirmationResult {
    sid?: string;
    channel: 'sms' | 'whatsapp';
}

// Pre-approved WhatsApp template — required by Meta for business-initiated
// messages (no customer inbound within 24h). Freeform WA sends outside that
// window return errCode 63016 asynchronously, so we don't even attempt WA
// unless the caller provides a template. `contentVariables` is a numeric-keyed
// map matching the {{1}} {{2}} ... placeholders in the approved body.
interface WhatsAppTemplateOpts {
    contentSid: string;
    contentVariables: Record<string, string>;
}

// Persist a row in outbound_messages so the operator can see the full
// SMS/WhatsApp history per customer without opening the Twilio console.
// Never lets a logging error break the actual send — errors are just warned.
async function logOutboundMessage(params: {
    provider: 'twilio' | 'vonage' | 'meta';
    channel: 'sms' | 'whatsapp';
    to: string;
    body: string;
    sid?: string | null;
    reservationId?: number | null;
    status?: string | null;
    errorMessage?: string | null;
}): Promise<void> {
    try {
        const digits = String(params.to).replace(/\D/g, '');
        const status = params.status
            ?? (params.errorMessage ? 'failed' : (params.sid ? 'queued' : 'sent'));
        await queryWithRetry(
            `INSERT INTO outbound_messages
             (provider, channel, to_phone, to_phone_digits, body, status, provider_sid, reservation_id, error_message, failed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                params.provider,
                params.channel,
                params.to,
                digits,
                params.body,
                status,
                params.sid ?? null,
                params.reservationId ?? null,
                params.errorMessage ?? null,
                params.errorMessage ? new Date() : null,
            ]
        );
    } catch (err: any) {
        console.warn('[outbound-log] insert failed:', err?.message || err);
    }
}

// Inbound SMS/WhatsApp persistence. Symmetric to logOutboundMessage but
// with from_phone(_digits) carrying the sender and to_phone(_digits) carrying
// our own number. Returns the inserted row so the caller can broadcast it via
// socket for the inbox UI. `to` is the account number the customer wrote to
// (e.g. our whatsapp:+39389…). Errors are logged but never thrown — a logging
// failure must not swallow the message.
async function logInboundMessage(params: {
    provider: 'twilio' | 'vonage' | 'meta';
    channel: 'sms' | 'whatsapp';
    from: string;
    to: string;
    body: string;
    sid?: string | null;
}): Promise<any | null> {
    try {
        const fromDigits = String(params.from).replace(/\D/g, '');
        const toDigits = String(params.to).replace(/\D/g, '');
        const result = await queryWithRetry(
            `INSERT INTO outbound_messages
             (provider, channel, direction, from_phone, from_phone_digits,
              to_phone, to_phone_digits, body, status, provider_sid)
             VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, 'received', $8)
             RETURNING *`,
            [
                params.provider,
                params.channel,
                params.from,
                fromDigits,
                params.to,
                toDigits,
                params.body,
                params.sid ?? null,
            ]
        );
        const row = result.rows[0] ?? null;

        // Wake up the PWA even a app chiusa: senza una push non arriva mai
        // il segnale al service worker, e il badge Inbox non si aggiorna.
        // Best-effort — se la push fallisce la logica del messaggio resta
        // corretta, solo il badge non si aggiorna finché l'utente non apre
        // l'app.
        if (row) {
            const channelLabel = params.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
            const preview = String(params.body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const fromDisplay = params.from || 'sconosciuto';
            pushSendToRoles(
                ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
                {
                    category: 'message',
                    title: `Nuovo messaggio ${channelLabel}`,
                    body: preview ? `${fromDisplay}: ${preview}` : `Da ${fromDisplay}`,
                    url: '/?view=MESSAGGI',
                    tag: `msg-inbound-${row.id}`,
                },
                { excludeUserId: null }
            ).catch(err => console.warn('[inbound-log] push failed:', err?.message || err));
        }

        return row;
    } catch (err: any) {
        console.warn('[inbound-log] insert failed:', err?.message || err);
        return null;
    }
}

// Email sibling of logOutboundMessage. Same table so the reservation-history
// timeline surfaces SMS/WhatsApp/Email in one chronological list. to_phone*
// columns are left NULL for email rows; to_email carries the recipient.
async function logOutboundEmail(params: {
    provider: 'smtp' | 'resend';
    to: string;
    subject: string;
    body: string;
    messageId?: string | null;
    reservationId?: number | null;
    errorMessage?: string | null;
}): Promise<void> {
    try {
        const status = params.errorMessage ? 'failed' : 'sent';
        await queryWithRetry(
            `INSERT INTO outbound_messages
             (provider, channel, to_email, subject, body, status, provider_sid, message_id, direction, reservation_id, error_message, failed_at)
             VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, 'outbound', $8, $9, $10)`,
            [
                params.provider,
                params.to,
                params.subject,
                params.body,
                status,
                params.messageId ?? null,
                params.messageId ?? null,
                params.reservationId ?? null,
                params.errorMessage ?? null,
                params.errorMessage ? new Date() : null,
            ]
        );
    } catch (err: any) {
        console.warn('[outbound-log] email insert failed:', err?.message || err);
    }
}

// Public URL used as StatusCallback for Twilio outbound messages so Twilio can
// notify us of delivery/failure. Falls back to VITE_API_URL, then null (no
// callback attached — messages still send, just no delivery tracking).
function twilioStatusCallbackUrl(): string | null {
    const base = process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.VITE_API_URL;
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/webhook/twilio-whatsapp-status`;
}

async function sendTwilioWhatsApp(
    to: string,
    text: string,
    reservationId?: number | null,
    template?: WhatsAppTemplateOpts
): Promise<OutboundConfirmationResult> {
    const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const FROM = process.env.TWILIO_WHATSAPP_FROM;

    if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM) {
        console.error('[Twilio] Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_FROM');
        throw new Error('Twilio not configured');
    }

    // Twilio expects "whatsapp:+E164" on both ends. Normalize Italian numbers
    // that arrive without the country prefix (10 digits starting with 3/0),
    // otherwise Twilio rejects "+3289630012" as an invalid Belgian number.
    const formattedTo = `whatsapp:${normalizeItalianPhone(String(to))}`;
    const formattedFrom = FROM.startsWith('whatsapp:') ? FROM : `whatsapp:${FROM.startsWith('+') ? FROM : `+${FROM}`}`;

    console.log(`[Twilio] Sending message to ${formattedTo} from ${formattedFrom}${template ? ` (template ${template.contentSid})` : ''}`);

    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    const body = new URLSearchParams({
        From: formattedFrom,
        To: formattedTo,
    });
    if (template) {
        // Meta business-initiated messages must use an approved template.
        // Body is ignored by Twilio when ContentSid is set.
        body.set('ContentSid', template.contentSid);
        body.set('ContentVariables', JSON.stringify(template.contentVariables));
    } else {
        body.set('Body', text);
    }
    const callback = twilioStatusCallbackUrl();
    if (callback) body.set('StatusCallback', callback);

    try {
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });

        const result = await response.json().catch(() => ({} as any)) as { sid?: string };
        if (!response.ok) {
            console.error('[Twilio] ❌ Error sending message:', result);
            await logOutboundMessage({
                provider: 'twilio', channel: 'whatsapp', to, body: text,
                reservationId, errorMessage: `Twilio API error: ${response.status} - ${JSON.stringify(result)}`,
            });
            throw new Error(`Twilio API error: ${response.status} - ${JSON.stringify(result)}`);
        }
        console.log(`[Twilio] ✅ Message sent to ${to} (sid=${result.sid})`);
        await logOutboundMessage({
            provider: 'twilio', channel: 'whatsapp', to, body: text,
            sid: result.sid, reservationId,
        });
        return { sid: result.sid, channel: 'whatsapp' };
    } catch (err: any) {
        if (err?.message && !err.message.startsWith('Twilio API error')) {
            await logOutboundMessage({
                provider: 'twilio', channel: 'whatsapp', to, body: text,
                reservationId, errorMessage: err.message,
            });
        }
        throw err;
    }
}

// Plain-text WhatsApp dispatcher. Prefers Twilio when configured, falls back
// to Vonage. Meta is template-only (separate path) so it isn't in this chain.
// When `template` is provided, uses Twilio's ContentSid/ContentVariables API
// (required for business-initiated messages outside the 24h window); Vonage
// doesn't support templates so it's skipped in that case.
async function sendWhatsAppText(
    to: string,
    text: string,
    reservationId?: number | null,
    template?: WhatsAppTemplateOpts
): Promise<OutboundConfirmationResult> {
    if (isTwilioWhatsAppConfigured()) {
        return sendTwilioWhatsApp(to, text, reservationId, template);
    }
    if (template) throw new Error('WhatsApp template requires Twilio (Vonage unsupported)');
    try {
        await sendVonageWhatsApp(to, text);
        await logOutboundMessage({ provider: 'vonage', channel: 'whatsapp', to, body: text, reservationId });
        return { channel: 'whatsapp' };
    } catch (err: any) {
        await logOutboundMessage({
            provider: 'vonage', channel: 'whatsapp', to, body: text, reservationId,
            errorMessage: err?.message || String(err),
        });
        throw err;
    }
}

// Twilio SMS — temporary stand-in for booking confirmations while Meta
// WhatsApp Business verification is pending. Same Messages API as
// sendTwilioWhatsApp, but Twilio bills as SMS. Sender resolves in this order:
//   1) TWILIO_MESSAGING_SERVICE_SID (required when using an alphanumeric
//      sender like "V Frantoio", since alpha senders live inside a service)
//   2) TWILIO_SMS_FROM as literal alphanumeric sender ID (contains letters)
//   3) TWILIO_SMS_FROM as E.164 phone number
function isTwilioSmsConfigured(): boolean {
    return !!(process.env.TWILIO_ACCOUNT_SID
        && process.env.TWILIO_AUTH_TOKEN
        && (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_SMS_FROM));
}

async function sendTwilioSms(to: string, text: string, reservationId?: number | null): Promise<OutboundConfirmationResult> {
    const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
    const FROM = process.env.TWILIO_SMS_FROM;

    if (!ACCOUNT_SID || !AUTH_TOKEN || (!MESSAGING_SERVICE_SID && !FROM)) {
        console.error('[Twilio SMS] Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or a sender (TWILIO_MESSAGING_SERVICE_SID / TWILIO_SMS_FROM)');
        throw new Error('Twilio SMS not configured');
    }

    // Normalize to E.164 assuming Italian numbers when the country code is
    // missing — a phone like "3289630012" would otherwise be sent as
    // "+3289630012" and Twilio rejects it as an invalid Belgian number.
    const formattedTo = normalizeItalianPhone(String(to));
    const body = new URLSearchParams({ To: formattedTo, Body: text });

    let senderDescription: string;
    if (MESSAGING_SERVICE_SID) {
        body.set('MessagingServiceSid', MESSAGING_SERVICE_SID);
        senderDescription = `service ${MESSAGING_SERVICE_SID}`;
    } else {
        const isAlphanumeric = /[A-Za-z]/.test(FROM!);
        const formattedFrom = isAlphanumeric
            ? FROM!
            : (FROM!.startsWith('+') ? FROM! : `+${FROM!.replace(/\D/g, '')}`);
        body.set('From', formattedFrom);
        senderDescription = `from ${formattedFrom}`;
    }

    const callback = twilioStatusCallbackUrl();
    if (callback) body.set('StatusCallback', callback);

    console.log(`[Twilio SMS] Sending message to ${formattedTo} ${senderDescription}`);

    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');

    try {
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });

        const result = await response.json().catch(() => ({} as any)) as { sid?: string };
        if (!response.ok) {
            console.error('[Twilio SMS] ❌ Error sending message:', result);
            await logOutboundMessage({
                provider: 'twilio', channel: 'sms', to, body: text,
                reservationId, errorMessage: `Twilio SMS API error: ${response.status} - ${JSON.stringify(result)}`,
            });
            throw new Error(`Twilio SMS API error: ${response.status} - ${JSON.stringify(result)}`);
        }
        console.log(`[Twilio SMS] ✅ Message sent to ${to} (sid=${result.sid})`);
        await logOutboundMessage({
            provider: 'twilio', channel: 'sms', to, body: text,
            sid: result.sid, reservationId,
        });
        return { sid: result.sid, channel: 'sms' };
    } catch (err: any) {
        if (err?.message && !err.message.startsWith('Twilio SMS API error')) {
            await logOutboundMessage({
                provider: 'twilio', channel: 'sms', to, body: text,
                reservationId, errorMessage: err.message,
            });
        }
        throw err;
    }
}

// Booking-confirmation dispatcher. WhatsApp is preferred (cheaper, richer,
// higher open rate) BUT only when the caller supplies an approved template:
// Meta rejects freeform business-initiated messages outside the 24h window
// with errCode 63016 async — Twilio still returns 200, so the sync fallback
// wouldn't fire and the customer would silently get nothing. When no template
// is provided we go straight to SMS. Delivery-time failures for template
// sends are still handled by the StatusCallback path. When `reservationId`
// is passed we persist the Twilio SID so the StatusCallback can update it.
async function sendBookingConfirmation(
    to: string,
    text: string,
    reservationId?: number | null,
    opts?: { whatsappTemplate?: WhatsAppTemplateOpts }
): Promise<OutboundConfirmationResult> {
    const template = opts?.whatsappTemplate;
    const tryWhatsApp = !!template && isTwilioWhatsAppConfigured();
    let result: OutboundConfirmationResult;
    try {
        result = tryWhatsApp
            ? await sendWhatsAppText(to, text, reservationId, template)
            : await sendTwilioSms(to, text, reservationId);
    } catch (err: any) {
        if (tryWhatsApp && isTwilioSmsConfigured()) {
            console.warn('[confirmation] WA send failed, falling back to SMS:', err?.message || err);
            result = await sendTwilioSms(to, text, reservationId);
        } else {
            throw err;
        }
    }
    if (reservationId != null) {
        recordConfirmationSent(reservationId, result).catch(err =>
            console.warn('[confirmation] recordConfirmationSent failed:', err?.message || err)
        );
    }
    return result;
}

// Persist the outbound confirmation on the reservation and broadcast the
// update so the delivery icon shows up on live dashboards. Called after a
// successful Twilio/WhatsApp send. Silently no-ops for providers that don't
// return a SID (Vonage) — without a SID we can't correlate the status callback.
async function recordConfirmationSent(
    reservationId: number,
    result: OutboundConfirmationResult
): Promise<void> {
    const initialStatus = result.sid ? 'queued' : 'sent';
    const updated = await queryWithRetry(
        `UPDATE reservations
         SET confirmation_status = $1,
             confirmation_channel = $2,
             confirmation_provider_sid = $3,
             confirmation_sent_at = CURRENT_TIMESTAMP,
             confirmation_delivered_at = NULL,
             confirmation_error = NULL
         WHERE id = $4
         RETURNING *`,
        [initialStatus, result.channel, result.sid ?? null, reservationId]
    );
    if (updated.rows[0] && socketService) {
        try { socketService.broadcastReservationUpdated(updated.rows[0]); }
        catch (err) { console.warn('[confirmation] broadcast failed:', err); }
    }
}

// Meta WhatsApp Business Cloud API — uses approved templates, so customers
// don't need to opt-in like in the Vonage sandbox. Active when the three
// META_WHATSAPP_* env vars are set; otherwise we fall back to Vonage.
function isMetaWhatsAppConfigured(): boolean {
    return !!(process.env.META_WHATSAPP_ACCESS_TOKEN
        && process.env.META_WHATSAPP_PHONE_NUMBER_ID);
}

interface MetaTemplateMessage {
    templateName: string;
    languageCode: string;
    bodyParams: string[];
}

async function sendMetaWhatsAppTemplate(to: string, template: MetaTemplateMessage): Promise<void> {
    const ACCESS_TOKEN = process.env.META_WHATSAPP_ACCESS_TOKEN;
    const PHONE_NUMBER_ID = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
    const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';

    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
        console.error('[Meta] Missing META_WHATSAPP_ACCESS_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID');
        return;
    }

    // Meta wants digits only, no leading +.
    const digitsTo = to.replace(/^\+/, '').replace(/\D/g, '');

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const body = {
        messaging_product: 'whatsapp',
        to: digitsTo,
        type: 'template',
        template: {
            name: template.templateName,
            language: { code: template.languageCode },
            components: template.bodyParams.length > 0
                ? [{
                    type: 'body',
                    parameters: template.bodyParams.map(text => ({ type: 'text', text })),
                }]
                : [],
        },
    };

    console.log(`[Meta] Sending template "${template.templateName}" to ${digitsTo}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify(body),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error('[Meta] ❌ Send failed', response.status, result);
        throw new Error(`Meta API error: ${response.status} - ${JSON.stringify(result)}`);
    }
    console.log(`[Meta] ✅ Template sent to ${digitsTo}`, result);
}


// ============================================
// OPENING HOURS & SPECIAL CLOSURES
// ============================================
// Single source of truth for the bookable slot grid. Read by the voice
// agent (utils/slots.ts) and — later — by the public Google booking page.
// Writes are gated by settings:full; reads only require an authenticated
// session so the booking form on the dashboard can render the grid.

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateHHMM(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || !HHMM_RE.test(v)) return undefined as any;
    return v;
}

// ============================================
// REMINDERS CRUD (Impostazioni → Promemoria)
// ============================================
// Roles allowed to edit: settings:full. Everyone sees the list because
// the scheduler runs server-side regardless; write access is what's gated.

const REMINDER_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const REMINDER_KINDS = new Set(['ONE_OFF', 'RECURRING']);
const REMINDER_FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY']);
const REMINDER_WEEKDAY_CODES_SET = new Set(WEEKDAY_CODES);
const REMINDER_VALID_ROLES = new Set(['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN']);

function normalizeReminderPayload(body: any): { ok: true; data: Omit<ReminderRow, 'id' | 'last_run_at'> } | { ok: false; error: string } {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) return { ok: false, error: 'Titolo richiesto (max 200 caratteri)' };
    const description = typeof body?.description === 'string' ? body.description.trim() : null;
    const kind = String(body?.kind || '').toUpperCase();
    if (!REMINDER_KINDS.has(kind)) return { ok: false, error: 'Tipo non valido (ONE_OFF o RECURRING)' };
    const schedule_time = String(body?.schedule_time || '').trim();
    if (!REMINDER_HHMM_RE.test(schedule_time)) return { ok: false, error: 'Orario non valido (HH:MM)' };

    let frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | null = null;
    let schedule_date: string | null = null;
    let weekdays: string[] | null = null;
    let month_day: number | null = null;

    if (kind === 'ONE_OFF') {
        const d = typeof body?.schedule_date === 'string' ? body.schedule_date.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'Data richiesta per promemoria temporaneo (YYYY-MM-DD)' };
        schedule_date = d;
    } else {
        const f = String(body?.frequency || '').toUpperCase();
        if (!REMINDER_FREQUENCIES.has(f)) return { ok: false, error: 'Frequenza non valida per promemoria ricorrente' };
        frequency = f as 'DAILY' | 'WEEKLY' | 'MONTHLY';
        if (frequency === 'WEEKLY') {
            const raw = Array.isArray(body?.weekdays) ? body.weekdays : [];
            const norm = Array.from(new Set(raw.map((x: any) => String(x).toUpperCase()))).filter(x => REMINDER_WEEKDAY_CODES_SET.has(x as string)) as string[];
            if (norm.length === 0) return { ok: false, error: 'Seleziona almeno un giorno della settimana' };
            weekdays = norm;
        }
        if (frequency === 'MONTHLY') {
            const n = parseInt(String(body?.month_day ?? ''), 10);
            if (!Number.isFinite(n) || n < 1 || n > 28) return { ok: false, error: 'Giorno del mese non valido (1-28)' };
            month_day = n;
        }
    }

    const rawRoles = Array.isArray(body?.target_roles) ? body.target_roles : [];
    const target_roles = Array.from(new Set(rawRoles.map((x: any) => String(x).toUpperCase()))).filter(x => REMINDER_VALID_ROLES.has(x as string)) as string[];
    if (target_roles.length === 0) return { ok: false, error: 'Seleziona almeno un destinatario' };

    const active = body?.active === undefined ? true : !!body.active;

    return {
        ok: true,
        data: {
            title, description, kind: kind as 'ONE_OFF' | 'RECURRING',
            frequency, schedule_time, schedule_date, weekdays, month_day,
            target_roles, active,
            system_key: null, // system_key is never editable via the API
        },
    };
}

app.get('/reminders', authenticate, async (_req, res) => {
    try {
        const r = await queryWithRetry(
            `SELECT id, title, description, kind, frequency, schedule_time,
                    to_char(schedule_date, 'YYYY-MM-DD') AS schedule_date,
                    weekdays, month_day, target_roles, active, system_key,
                    last_run_at, created_at, updated_at
             FROM reminders
             ORDER BY active DESC, created_at DESC`
        );
        res.json({ reminders: r.rows });
    } catch (err: any) {
        console.error('GET /reminders error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/reminders', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const parsed = normalizeReminderPayload(req.body || {});
        if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
        const d = parsed.data;
        const inserted = await queryWithRetry(
            `INSERT INTO reminders
                (title, description, kind, frequency, schedule_time,
                 schedule_date, weekdays, month_day, target_roles, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, title, description, kind, frequency, schedule_time,
                       to_char(schedule_date, 'YYYY-MM-DD') AS schedule_date,
                       weekdays, month_day, target_roles, active, system_key,
                       last_run_at, created_at, updated_at`,
            [d.title, d.description, d.kind, d.frequency, d.schedule_time,
             d.schedule_date, d.weekdays, d.month_day, d.target_roles, d.active]
        );
        res.status(201).json(inserted.rows[0]);
    } catch (err: any) {
        console.error('POST /reminders error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/reminders/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
        const parsed = normalizeReminderPayload(req.body || {});
        if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
        const d = parsed.data;
        // Preserve system_key across edits (never accepted from client, but
        // an existing row may still be a system reminder like the Pane).
        const updated = await queryWithRetry(
            `UPDATE reminders
             SET title = $1, description = $2, kind = $3, frequency = $4,
                 schedule_time = $5, schedule_date = $6, weekdays = $7,
                 month_day = $8, target_roles = $9, active = $10,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $11
             RETURNING id, title, description, kind, frequency, schedule_time,
                       to_char(schedule_date, 'YYYY-MM-DD') AS schedule_date,
                       weekdays, month_day, target_roles, active, system_key,
                       last_run_at, created_at, updated_at`,
            [d.title, d.description, d.kind, d.frequency, d.schedule_time,
             d.schedule_date, d.weekdays, d.month_day, d.target_roles, d.active, id]
        );
        if (updated.rows.length === 0) return res.status(404).json({ error: 'Reminder not found' });
        res.json(updated.rows[0]);
    } catch (err: any) {
        console.error('PUT /reminders/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/reminders/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
        const r = await queryWithRetry('DELETE FROM reminders WHERE id = $1 RETURNING id', [id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Reminder not found' });
        res.json({ ok: true });
    } catch (err: any) {
        console.error('DELETE /reminders/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/opening-hours', authenticate, async (_req, res) => {
    try {
        const rows = await getAllOpeningHours();
        res.json(rows);
    } catch (error) {
        console.error('Error fetching opening_hours:', error);
        res.status(500).json({ error: 'Failed to fetch opening hours' });
    }
});

app.put('/opening-hours/:weekday', authenticate, requirePermission('settings:full'), async (req, res) => {
    const weekday = parseInt(req.params.weekday, 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        return res.status(400).json({ error: 'invalid_weekday', message: 'weekday must be 0-6 (0=Sun)' });
    }
    const {
        lunch_open, lunch_close, dinner_open, dinner_close, slot_minutes,
        disabled_lunch_slots, disabled_dinner_slots,
    } = req.body ?? {};

    const lo = validateHHMM(lunch_open);
    const lc = validateHHMM(lunch_close);
    const dorn = validateHHMM(dinner_open);
    const dc = validateHHMM(dinner_close);
    if (lo === undefined || lc === undefined || dorn === undefined || dc === undefined) {
        return res.status(400).json({ error: 'invalid_time', message: 'Times must be HH:MM or null' });
    }
    if ((lo && !lc) || (!lo && lc)) {
        return res.status(400).json({ error: 'invalid_range', message: 'lunch_open and lunch_close must be both set or both null' });
    }
    if ((dorn && !dc) || (!dorn && dc)) {
        return res.status(400).json({ error: 'invalid_range', message: 'dinner_open and dinner_close must be both set or both null' });
    }
    const step = Number(slot_minutes);
    if (!Number.isInteger(step) || step < 5 || step > 240) {
        return res.status(400).json({ error: 'invalid_slot_minutes', message: 'slot_minutes must be 5-240' });
    }

    // Optional per-slot blacklist arrays. `undefined` = leave as-is; explicit
    // array = full replace. Any invalid entry rejects the whole request.
    const parseDisabled = (input: unknown): string[] | undefined | null => {
        if (input === undefined) return undefined;
        if (!Array.isArray(input)) return null;
        const out = new Set<string>();
        for (const raw of input) {
            const v = validateHHMM(raw);
            if (!v) return null;
            out.add(v);
        }
        return Array.from(out);
    };
    const disabledLunch = parseDisabled(disabled_lunch_slots);
    const disabledDinner = parseDisabled(disabled_dinner_slots);
    if (disabledLunch === null || disabledDinner === null) {
        return res.status(400).json({ error: 'invalid_disabled_slots', message: 'disabled slot arrays must contain HH:MM strings' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const upd = await client.query(
            `UPDATE opening_hours
             SET lunch_open = $2::time, lunch_close = $3::time,
                 dinner_open = $4::time, dinner_close = $5::time,
                 slot_minutes = $6
             WHERE weekday = $1`,
            [weekday, lo, lc, dorn, dc, step]
        );
        if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'not_found' });
        }
        if (disabledLunch !== undefined) {
            await client.query(
                `DELETE FROM opening_hours_disabled_slots WHERE weekday = $1 AND shift = 'LUNCH'`,
                [weekday]
            );
            if (disabledLunch.length > 0) {
                await client.query(
                    `INSERT INTO opening_hours_disabled_slots (weekday, shift, slot_time)
                     SELECT $1, 'LUNCH', unnest($2::text[])::time`,
                    [weekday, disabledLunch]
                );
            }
        }
        if (disabledDinner !== undefined) {
            await client.query(
                `DELETE FROM opening_hours_disabled_slots WHERE weekday = $1 AND shift = 'DINNER'`,
                [weekday]
            );
            if (disabledDinner.length > 0) {
                await client.query(
                    `INSERT INTO opening_hours_disabled_slots (weekday, shift, slot_time)
                     SELECT $1, 'DINNER', unnest($2::text[])::time`,
                    [weekday, disabledDinner]
                );
            }
        }
        await client.query('COMMIT');
        const fresh = await getOpeningHours(weekday);
        res.json(fresh);
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error('Error updating opening_hours:', error);
        res.status(500).json({ error: 'Failed to update opening hours' });
    } finally {
        client.release();
    }
});

app.get('/closures', authenticate, async (req, res) => {
    try {
        const from = typeof req.query.from === 'string' ? req.query.from : undefined;
        const rows = await listClosures(from);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching closures:', error);
        res.status(500).json({ error: 'Failed to fetch closures' });
    }
});

app.post('/closures', authenticate, requirePermission('settings:full'), async (req, res) => {
    const { date, shift, reason } = req.body ?? {};
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
    }
    if (shift !== null && shift !== undefined && shift !== Shift.LUNCH && shift !== Shift.DINNER) {
        return res.status(400).json({ error: 'invalid_shift', message: 'shift must be LUNCH, DINNER or null (whole day)' });
    }
    const reasonText = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null;

    try {
        const result = await queryWithRetry(
            `INSERT INTO special_closures (date, shift, reason)
             VALUES ($1::date, $2, $3)
             ON CONFLICT (date, shift) DO UPDATE SET reason = EXCLUDED.reason
             RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, shift, reason`,
            [date, shift ?? null, reasonText]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating closure:', error);
        res.status(500).json({ error: 'Failed to create closure' });
    }
});

app.delete('/closures/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
    }
    try {
        const result = await queryWithRetry('DELETE FROM special_closures WHERE id = $1', [id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'not_found' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting closure:', error);
        res.status(500).json({ error: 'Failed to delete closure' });
    }
});

// ============================================
// HACCP (controlli giornalieri)
// ============================================
// 5 resources mirror the operator's paper sheets. For per-day-per-label
// resources (temperatures / oil / cleaning) POST upserts on the unique
// (date, label) key so the daily form can fire-and-forget. For ad-hoc
// resources (receipts / production) POST creates new rows each time.

const HACCP_OIL_ACTIONS = ['SOSTITUITO', 'FILTRATO', 'UTILIZZABILE'] as const;
type HaccpOilAction = (typeof HACCP_OIL_ACTIONS)[number];

const isValidDate = (s: unknown): s is string =>
    typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const parseNumericOrNull = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
};

// ---- TEMPERATURE READINGS ---------------------------------------------------
app.get('/haccp/temperatures', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        const result = await queryWithRetry(`
            SELECT id,
                   TO_CHAR(date, 'YYYY-MM-DD') as date,
                   location,
                   temperature::float8 as temperature,
                   target_max::float8 as "targetMax",
                   note,
                   recorded_by_user_id as "recordedByUserId",
                   recorded_by_user_name as "recordedByUserName",
                   recorded_at as "recordedAt"
            FROM haccp_temperature_readings
            WHERE date = $1
            ORDER BY location ASC
        `, [date]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Upsert by (date, location). The daily form posts the same row repeatedly as
// the operator types; ON CONFLICT keeps the row in place.
app.post('/haccp/temperatures', authenticate, async (req, res) => {
    try {
        const { date, location, temperature, targetMax, note } = req.body;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        if (!location || typeof location !== 'string' || !location.trim()) {
            return res.status(400).json({ error: 'location is required' });
        }
        const temp = parseNumericOrNull(temperature);
        if (temp === null) return res.status(400).json({ error: 'temperature is required' });
        const target = parseNumericOrNull(targetMax);
        const recorderName = req.user?.email || null;
        const result = await queryWithRetry(`
            INSERT INTO haccp_temperature_readings
                (date, location, temperature, target_max, note, recorded_by_user_id, recorded_by_user_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (date, location) DO UPDATE SET
                temperature = EXCLUDED.temperature,
                target_max = EXCLUDED.target_max,
                note = EXCLUDED.note,
                recorded_by_user_id = EXCLUDED.recorded_by_user_id,
                recorded_by_user_name = EXCLUDED.recorded_by_user_name,
                recorded_at = CURRENT_TIMESTAMP
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      location,
                      temperature::float8 as temperature,
                      target_max::float8 as "targetMax",
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, [date, location.trim(), temp, target, note?.trim() || null, req.user?.userId || null, recorderName]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/haccp/temperatures/:id', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('DELETE FROM haccp_temperature_readings WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- OIL CHECKS -------------------------------------------------------------
app.get('/haccp/oil', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        const result = await queryWithRetry(`
            SELECT id,
                   TO_CHAR(date, 'YYYY-MM-DD') as date,
                   fryer_label as "fryerLabel",
                   action,
                   note,
                   recorded_by_user_id as "recordedByUserId",
                   recorded_by_user_name as "recordedByUserName",
                   recorded_at as "recordedAt"
            FROM haccp_oil_checks
            WHERE date = $1
            ORDER BY fryer_label ASC
        `, [date]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/haccp/oil', authenticate, async (req, res) => {
    try {
        const { date, fryerLabel, action, note } = req.body;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        if (!fryerLabel || typeof fryerLabel !== 'string' || !fryerLabel.trim()) {
            return res.status(400).json({ error: 'fryerLabel is required' });
        }
        if (!HACCP_OIL_ACTIONS.includes(action as HaccpOilAction)) {
            return res.status(400).json({ error: `action must be one of ${HACCP_OIL_ACTIONS.join(', ')}` });
        }
        const recorderName = req.user?.email || null;
        const result = await queryWithRetry(`
            INSERT INTO haccp_oil_checks
                (date, fryer_label, action, note, recorded_by_user_id, recorded_by_user_name)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (date, fryer_label) DO UPDATE SET
                action = EXCLUDED.action,
                note = EXCLUDED.note,
                recorded_by_user_id = EXCLUDED.recorded_by_user_id,
                recorded_by_user_name = EXCLUDED.recorded_by_user_name,
                recorded_at = CURRENT_TIMESTAMP
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      fryer_label as "fryerLabel",
                      action,
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, [date, fryerLabel.trim(), action, note?.trim() || null, req.user?.userId || null, recorderName]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/haccp/oil/:id', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('DELETE FROM haccp_oil_checks WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- CLEANING CHECKS --------------------------------------------------------
app.get('/haccp/cleaning', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        const result = await queryWithRetry(`
            SELECT id,
                   TO_CHAR(date, 'YYYY-MM-DD') as date,
                   point,
                   done,
                   note,
                   recorded_by_user_id as "recordedByUserId",
                   recorded_by_user_name as "recordedByUserName",
                   recorded_at as "recordedAt"
            FROM haccp_cleaning_checks
            WHERE date = $1
            ORDER BY point ASC
        `, [date]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/haccp/cleaning', authenticate, async (req, res) => {
    try {
        const { date, point, done, note } = req.body;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        if (!point || typeof point !== 'string' || !point.trim()) {
            return res.status(400).json({ error: 'point is required' });
        }
        const recorderName = req.user?.email || null;
        const result = await queryWithRetry(`
            INSERT INTO haccp_cleaning_checks
                (date, point, done, note, recorded_by_user_id, recorded_by_user_name)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (date, point) DO UPDATE SET
                done = EXCLUDED.done,
                note = EXCLUDED.note,
                recorded_by_user_id = EXCLUDED.recorded_by_user_id,
                recorded_by_user_name = EXCLUDED.recorded_by_user_name,
                recorded_at = CURRENT_TIMESTAMP
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      point,
                      done,
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, [date, point.trim(), !!done, note?.trim() || null, req.user?.userId || null, recorderName]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/haccp/cleaning/:id', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('DELETE FROM haccp_cleaning_checks WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- GOODS RECEIPTS ---------------------------------------------------------
app.get('/haccp/receipts', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        const result = await queryWithRetry(`
            SELECT id,
                   TO_CHAR(date, 'YYYY-MM-DD') as date,
                   product,
                   lot_number as "lotNumber",
                   temperature::float8 as temperature,
                   accepted,
                   note,
                   recorded_by_user_id as "recordedByUserId",
                   recorded_by_user_name as "recordedByUserName",
                   recorded_at as "recordedAt"
            FROM haccp_goods_receipts
            WHERE date = $1
            ORDER BY recorded_at ASC
        `, [date]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/haccp/receipts', authenticate, async (req, res) => {
    try {
        const { date, product, lotNumber, temperature, accepted, note } = req.body;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        if (!product || typeof product !== 'string' || !product.trim()) {
            return res.status(400).json({ error: 'product is required' });
        }
        const temp = parseNumericOrNull(temperature);
        const recorderName = req.user?.email || null;
        const result = await queryWithRetry(`
            INSERT INTO haccp_goods_receipts
                (date, product, lot_number, temperature, accepted, note, recorded_by_user_id, recorded_by_user_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      product,
                      lot_number as "lotNumber",
                      temperature::float8 as temperature,
                      accepted,
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, [date, product.trim(), lotNumber?.trim() || null, temp, accepted !== false, note?.trim() || null, req.user?.userId || null, recorderName]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/haccp/receipts/:id', authenticate, async (req, res) => {
    try {
        const { product, lotNumber, temperature, accepted, note } = req.body;
        const sets: string[] = [];
        const params: any[] = [];
        let p = 1;
        if (product !== undefined) { sets.push(`product = $${p++}`); params.push(String(product).trim()); }
        if (lotNumber !== undefined) { sets.push(`lot_number = $${p++}`); params.push(lotNumber?.trim() || null); }
        if (temperature !== undefined) { sets.push(`temperature = $${p++}`); params.push(parseNumericOrNull(temperature)); }
        if (accepted !== undefined) { sets.push(`accepted = $${p++}`); params.push(accepted !== false); }
        if (note !== undefined) { sets.push(`note = $${p++}`); params.push(note?.trim() || null); }
        if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
        params.push(req.params.id);
        const result = await queryWithRetry(`
            UPDATE haccp_goods_receipts SET ${sets.join(', ')} WHERE id = $${p}
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      product,
                      lot_number as "lotNumber",
                      temperature::float8 as temperature,
                      accepted,
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/haccp/receipts/:id', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('DELETE FROM haccp_goods_receipts WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- PRODUCTION LOGS --------------------------------------------------------
app.get('/haccp/production', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        const result = await queryWithRetry(`
            SELECT id,
                   TO_CHAR(date, 'YYYY-MM-DD') as date,
                   product,
                   blast_temp_range as "blastTempRange",
                   blast_duration as "blastDuration",
                   internal_lot as "internalLot",
                   note,
                   recorded_by_user_id as "recordedByUserId",
                   recorded_by_user_name as "recordedByUserName",
                   recorded_at as "recordedAt"
            FROM haccp_production_logs
            WHERE date = $1
            ORDER BY recorded_at ASC
        `, [date]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/haccp/production', authenticate, async (req, res) => {
    try {
        const { date, product, blastTempRange, blastDuration, internalLot, note } = req.body;
        if (!isValidDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
        if (!product || typeof product !== 'string' || !product.trim()) {
            return res.status(400).json({ error: 'product is required' });
        }
        const recorderName = req.user?.email || null;
        const result = await queryWithRetry(`
            INSERT INTO haccp_production_logs
                (date, product, blast_temp_range, blast_duration, internal_lot, note, recorded_by_user_id, recorded_by_user_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      product,
                      blast_temp_range as "blastTempRange",
                      blast_duration as "blastDuration",
                      internal_lot as "internalLot",
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, [date, product.trim(), blastTempRange?.trim() || null, blastDuration?.trim() || null, internalLot?.trim() || null, note?.trim() || null, req.user?.userId || null, recorderName]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/haccp/production/:id', authenticate, async (req, res) => {
    try {
        const { product, blastTempRange, blastDuration, internalLot, note } = req.body;
        const sets: string[] = [];
        const params: any[] = [];
        let p = 1;
        if (product !== undefined) { sets.push(`product = $${p++}`); params.push(String(product).trim()); }
        if (blastTempRange !== undefined) { sets.push(`blast_temp_range = $${p++}`); params.push(blastTempRange?.trim() || null); }
        if (blastDuration !== undefined) { sets.push(`blast_duration = $${p++}`); params.push(blastDuration?.trim() || null); }
        if (internalLot !== undefined) { sets.push(`internal_lot = $${p++}`); params.push(internalLot?.trim() || null); }
        if (note !== undefined) { sets.push(`note = $${p++}`); params.push(note?.trim() || null); }
        if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
        params.push(req.params.id);
        const result = await queryWithRetry(`
            UPDATE haccp_production_logs SET ${sets.join(', ')} WHERE id = $${p}
            RETURNING id,
                      TO_CHAR(date, 'YYYY-MM-DD') as date,
                      product,
                      blast_temp_range as "blastTempRange",
                      blast_duration as "blastDuration",
                      internal_lot as "internalLot",
                      note,
                      recorded_by_user_id as "recordedByUserId",
                      recorded_by_user_name as "recordedByUserName",
                      recorded_at as "recordedAt"
        `, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/haccp/production/:id', authenticate, async (req, res) => {
    try {
        const result = await queryWithRetry('DELETE FROM haccp_production_logs WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// VOICE CALLS (ElevenLabs conversations)
// ============================================
// Browse the voice_calls table populated by the post-call webhook, plus a
// manual sync that pulls recent conversations from the ElevenLabs API for
// rows the webhook missed (timeouts, redeploys). Audio is streamed through
// the server so the ElevenLabs API key never reaches the browser.

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || '';
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

const VOICE_CALLS_ROLES: UserRole[] = [UserRole.OWNER, UserRole.GENERAL_MANAGER, UserRole.MANAGER];

const voiceCallsAuthorize = authorize(...VOICE_CALLS_ROLES);

// List with optional filters. Default newest-first, capped to 200 rows.
app.get('/voice-calls', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const { from, to, q, linked, follow_up, phantom } = req.query as Record<string, string | undefined>;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
        const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

        const where: string[] = [];
        const params: any[] = [];

        if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
            params.push(from);
            where.push(`vc.created_at >= $${params.length}::date`);
        }
        if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
            params.push(to);
            where.push(`vc.created_at < ($${params.length}::date + INTERVAL '1 day')`);
        }
        if (q && q.trim()) {
            // Search across phone, summary, transcript, notes, and the linked
            // customer name so users can type "Mario" and find calls even when
            // the caller only appears in the customer registry, not the raw
            // ElevenLabs payload.
            params.push(`%${q.trim()}%`);
            const idx = params.length;
            where.push(
                `(vc.phone ILIKE $${idx}
                  OR vc.summary ILIKE $${idx}
                  OR vc.transcript ILIKE $${idx}
                  OR vc.notes ILIKE $${idx}
                  OR r.customer_name ILIKE $${idx}
                  OR EXISTS (
                      SELECT 1 FROM customers c2
                      WHERE c2.phone IS NOT NULL
                        AND vc.phone IS NOT NULL
                        AND length(regexp_replace(c2.phone, '\\D', '', 'g')) >= 8
                        AND right(regexp_replace(c2.phone, '\\D', '', 'g'), 10)
                          = right(regexp_replace(vc.phone, '\\D', '', 'g'), 10)
                        AND c2.name ILIKE $${idx}
                  ))`
            );
        }
        if (linked === 'true') where.push('vc.reservation_id IS NOT NULL');
        else if (linked === 'false') where.push('vc.reservation_id IS NULL');
        // Follow-up filter only makes sense on unlinked calls (calls with a
        // reservation don't need to be contacted back). We don't force
        // reservation_id IS NULL here so the UI can combine filters freely.
        if (follow_up === 'contacted') where.push("vc.follow_up_status = 'CONTACTED'");
        else if (follow_up === 'pending') where.push("(vc.follow_up_status IS NULL OR vc.follow_up_status = 'PENDING')");
        // "Da recuperare" filter — calls where the agent verbally confirmed
        // but never invoked the create-reservation tool. Excludes calls
        // already marked as recovered so the chip only surfaces open cases.
        if (phantom === 'true') where.push('vc.phantom_confirmation = TRUE AND vc.phantom_recovered = FALSE');

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        params.push(limit);
        params.push(offset);
        // Match customers on the last 10 digits of the phone. `customers.phone`
        // is stored in mixed formats (E.164, national, bare digits) so we can't
        // rely on equality — right(10) covers Italian mobile/landline reliably.
        // LATERAL + LIMIT 1 avoids row explosion if two rows share a number.
        const result = await queryWithRetry(
            `SELECT vc.id,
                    vc.conversation_id,
                    vc.phone,
                    vc.duration_seconds,
                    vc.summary,
                    vc.reservation_id,
                    vc.created_at,
                    vc.follow_up_status,
                    vc.notes,
                    vc.follow_up_updated_at,
                    vc.phantom_confirmation,
                    vc.phantom_recovered,
                    vc.large_group_handoff,
                    u.full_name AS follow_up_updated_by_name,
                    r.customer_name AS reservation_customer_name,
                    r.reservation_time AS reservation_time,
                    r.guests AS reservation_guests,
                    r.reservation_status AS reservation_status,
                    cust.customer_id,
                    cust.customer_name
             FROM voice_calls vc
             LEFT JOIN reservations r ON r.id = vc.reservation_id
             LEFT JOIN users u ON u.id = vc.follow_up_updated_by
             LEFT JOIN LATERAL (
                 SELECT c.id AS customer_id, c.name AS customer_name
                 FROM customers c
                 WHERE vc.phone IS NOT NULL
                   AND c.phone IS NOT NULL
                   AND length(regexp_replace(c.phone, '\\D', '', 'g')) >= 8
                   AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10)
                     = right(regexp_replace(vc.phone, '\\D', '', 'g'), 10)
                 LIMIT 1
             ) cust ON true
             ${whereSql}
             ORDER BY vc.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        const countResult = await queryWithRetry(
            `SELECT COUNT(*)::int AS total
             FROM voice_calls vc
             LEFT JOIN reservations r ON r.id = vc.reservation_id
             ${whereSql}`,
            params.slice(0, params.length - 2)
        );

        res.json({
            items: result.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit,
            offset,
        });
    } catch (err) {
        console.error('GET /voice-calls error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Count of calls that need a follow-up: no reservation was created and the
// call is recent enough to still be actionable (last 7 days). Surfaces as a
// badge on the sidebar phone icon. Must be declared before `/voice-calls/:id`
// so Express doesn't route "pending-count" into the :id handler.
app.get('/voice-calls/pending-count', authenticate, voiceCallsAuthorize, async (_req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT COUNT(*)::int AS count
             FROM voice_calls
             WHERE reservation_id IS NULL
               AND (follow_up_status IS NULL OR follow_up_status = 'PENDING')
               AND created_at >= NOW() - INTERVAL '7 days'`
        );
        res.json({ count: result.rows[0]?.count ?? 0 });
    } catch (err) {
        console.error('GET /voice-calls/pending-count error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Bulk: flip every call still awaiting follow-up (no linked reservation,
// status NULL/PENDING) to CONTACTED in one shot. Powers the "segna tutte
// come ricontattate" button in Conversazioni — returns how many rows
// changed so the UI can report it. Declared before the `:id` routes.
app.post('/voice-calls/mark-all-contacted', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const result = await queryWithRetry(
            `UPDATE voice_calls
             SET follow_up_status = 'CONTACTED',
                 follow_up_updated_by = $1,
                 follow_up_updated_at = NOW()
             WHERE reservation_id IS NULL
               AND (follow_up_status IS NULL OR follow_up_status = 'PENDING')
             RETURNING id`,
            [req.user?.userId ?? null]
        );
        res.json({ updated: result.rows.length });
    } catch (err) {
        console.error('POST /voice-calls/mark-all-contacted error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update follow-up state for a call: mark as contacted / pending, and store
// free-text notes for whoever picks it up next. Fields are patched
// individually — omitted fields stay as-is.
app.patch('/voice-calls/:id/follow-up', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const { status, notes } = req.body ?? {};
        const sets: string[] = [];
        const params: any[] = [];

        if (status !== undefined) {
            if (status !== 'PENDING' && status !== 'CONTACTED') {
                return res.status(400).json({ error: 'Invalid status' });
            }
            params.push(status);
            sets.push(`follow_up_status = $${params.length}`);
        }
        if (notes !== undefined) {
            if (notes !== null && typeof notes !== 'string') {
                return res.status(400).json({ error: 'Invalid notes' });
            }
            params.push(notes === null || notes.trim() === '' ? null : notes);
            sets.push(`notes = $${params.length}`);
        }
        if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

        params.push(req.user?.userId ?? null);
        sets.push(`follow_up_updated_by = $${params.length}`);
        sets.push(`follow_up_updated_at = NOW()`);

        params.push(id);
        const result = await queryWithRetry(
            `UPDATE voice_calls SET ${sets.join(', ')} WHERE id = $${params.length}
             RETURNING id, follow_up_status, notes, follow_up_updated_at`,
            params
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('PATCH /voice-calls/:id/follow-up error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Link a voice call to a reservation created from it (e.g. after a manual
// call-back). Also flips the follow-up state to CONTACTED so the call drops
// out of the pending queue.
app.patch('/voice-calls/:id/link', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const reservationIdRaw = req.body?.reservation_id;
        const reservationId = typeof reservationIdRaw === 'number'
            ? reservationIdRaw
            : parseInt(reservationIdRaw, 10);
        if (!Number.isFinite(reservationId)) return res.status(400).json({ error: 'Invalid reservation_id' });

        // Also clears the phantom-recovery banner: if this call was flagged
        // as a phantom confirmation, linking a real reservation is exactly
        // the recovery we were asking staff to perform.
        const result = await queryWithRetry(
            `UPDATE voice_calls
             SET reservation_id = $1,
                 follow_up_status = 'CONTACTED',
                 follow_up_updated_at = NOW(),
                 follow_up_updated_by = $2,
                 phantom_recovered = CASE WHEN phantom_confirmation THEN TRUE ELSE phantom_recovered END
             WHERE id = $3
             RETURNING id, reservation_id, follow_up_status, follow_up_updated_at, phantom_recovered`,
            [reservationId, req.user?.userId ?? null, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('PATCH /voice-calls/:id/link error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manual recovery: staff has verified the phantom confirmation (called back
// the customer, decided to leave it as cancelled, etc.) without necessarily
// linking a new reservation. Just flips phantom_recovered so the banner
// disappears from the detail modal.
app.patch('/voice-calls/:id/recover', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const result = await queryWithRetry(
            `UPDATE voice_calls
             SET phantom_recovered = TRUE
             WHERE id = $1
             RETURNING id, phantom_confirmation, phantom_recovered`,
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('PATCH /voice-calls/:id/recover error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Detail with full transcript.
app.get('/voice-calls/:id', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const result = await queryWithRetry(
            `SELECT vc.id,
                    vc.conversation_id,
                    vc.phone,
                    vc.duration_seconds,
                    vc.transcript,
                    vc.summary,
                    vc.reservation_id,
                    vc.created_at,
                    vc.follow_up_status,
                    vc.notes,
                    vc.follow_up_updated_at,
                    vc.phantom_confirmation,
                    vc.phantom_recovered,
                    vc.large_group_handoff,
                    u.full_name AS follow_up_updated_by_name,
                    r.customer_name AS reservation_customer_name,
                    r.reservation_time AS reservation_time,
                    r.guests AS reservation_guests,
                    r.reservation_status AS reservation_status,
                    cust.customer_id,
                    cust.customer_name
             FROM voice_calls vc
             LEFT JOIN reservations r ON r.id = vc.reservation_id
             LEFT JOIN users u ON u.id = vc.follow_up_updated_by
             LEFT JOIN LATERAL (
                 SELECT c.id AS customer_id, c.name AS customer_name
                 FROM customers c
                 WHERE vc.phone IS NOT NULL
                   AND c.phone IS NOT NULL
                   AND length(regexp_replace(c.phone, '\\D', '', 'g')) >= 8
                   AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10)
                     = right(regexp_replace(vc.phone, '\\D', '', 'g'), 10)
                 LIMIT 1
             ) cust ON true
             WHERE vc.id = $1`,
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /voice-calls/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Stream the call recording from ElevenLabs. The browser hits this endpoint
// so the API key stays on the server. Audio is gated by the same RBAC as the
// transcript so a leaked URL can't be hot-linked from outside the app.
app.get('/voice-calls/:id/audio', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        if (!ELEVENLABS_API_KEY) {
            return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
        }

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const row = await queryWithRetry(
            'SELECT conversation_id FROM voice_calls WHERE id = $1',
            [id]
        );
        if (row.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const conversationId = row.rows[0].conversation_id;

        const upstream = await fetch(
            `${ELEVENLABS_API_BASE}/convai/conversations/${encodeURIComponent(conversationId)}/audio`,
            { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
        );

        if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => '');
            console.warn('[ElevenLabs] audio fetch failed', upstream.status, text.slice(0, 200));
            return res.status(upstream.status === 404 ? 404 : 502).json({
                error: upstream.status === 404 ? 'Audio not available' : 'Upstream audio fetch failed',
            });
        }

        const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'private, max-age=300');

        const { Readable } = await import('stream');
        Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (err) {
        console.error('GET /voice-calls/:id/audio error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
});

// Outbound SMS/WhatsApp history for a given call. We match on the last 10
// digits of the recipient phone against the call's phone so operator can see
// every message ever sent to that customer regardless of reservation linkage.
app.get('/voice-calls/:id/messages', authenticate, voiceCallsAuthorize, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const callRow = await queryWithRetry(
            'SELECT phone FROM voice_calls WHERE id = $1',
            [id]
        );
        if (callRow.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const phone: string | null = callRow.rows[0].phone;
        if (!phone) return res.json({ items: [] });

        const digits = String(phone).replace(/\D/g, '');
        if (digits.length < 8) return res.json({ items: [] });
        const suffix = digits.slice(-10);

        const result = await queryWithRetry(
            `SELECT id, provider, channel, to_phone, body, status, provider_sid,
                    reservation_id, sent_at, delivered_at, failed_at,
                    error_code, error_message
             FROM outbound_messages
             WHERE right(to_phone_digits, 10) = $1
             ORDER BY sent_at DESC
             LIMIT 50`,
            [suffix]
        );
        res.json({ items: result.rows });
    } catch (err) {
        console.error('GET /voice-calls/:id/messages error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manual sync: pulls the agent's recent conversations from ElevenLabs and
// upserts any conversation_id we're missing (post-call webhook timeouts /
// redeploys lose calls otherwise). For each new conversation we fetch the
// detail to get transcript + summary + phone + duration; existing rows are
// left untouched so manual edits aren't clobbered.
app.post('/voice-calls/sync', authenticate, voiceCallsAuthorize, async (_req, res) => {
    try {
        if (!ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
        if (!ELEVENLABS_AGENT_ID) return res.status(503).json({ error: 'ELEVENLABS_AGENT_ID not configured' });

        const listUrl = `${ELEVENLABS_API_BASE}/convai/conversations?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}&page_size=30`;
        const listRes = await fetch(listUrl, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
        if (!listRes.ok) {
            const text = await listRes.text().catch(() => '');
            console.warn('[ElevenLabs] sync list failed', listRes.status, text.slice(0, 200));
            return res.status(502).json({ error: 'Upstream list failed' });
        }
        const listJson = await listRes.json() as any;
        const conversations: any[] = Array.isArray(listJson?.conversations) ? listJson.conversations : [];

        const existing = await queryWithRetry(
            `SELECT conversation_id, phone FROM voice_calls WHERE conversation_id = ANY($1::text[])`,
            [conversations.map(c => c.conversation_id).filter(Boolean)]
        );
        const savedWithPhone = new Set<string>(existing.rows.filter(r => r.phone).map(r => r.conversation_id));
        const savedWithoutPhone = new Set<string>(existing.rows.filter(r => !r.phone).map(r => r.conversation_id));

        let imported = 0;
        let backfilled = 0;
        let skipped = 0;
        let failed = 0;

        for (const conv of conversations) {
            const conversationId: string | undefined = conv.conversation_id;
            if (!conversationId) { failed++; continue; }
            if (savedWithPhone.has(conversationId)) { skipped++; continue; }

            try {
                const detailRes = await fetch(
                    `${ELEVENLABS_API_BASE}/convai/conversations/${encodeURIComponent(conversationId)}`,
                    { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
                );
                if (!detailRes.ok) { failed++; continue; }
                const detail = await detailRes.json() as any;

                const rawTranscript = detail?.transcript;
                let transcript: string | undefined;
                if (Array.isArray(rawTranscript)) {
                    transcript = rawTranscript
                        .map((t: any) => {
                            const who = t.role || t.speaker || 'unknown';
                            const text = t.message ?? t.text ?? t.content ?? '';
                            return `${who}: ${text}`;
                        })
                        .join('\n');
                } else if (typeof rawTranscript === 'string') {
                    transcript = rawTranscript;
                }

                const summary: string | undefined =
                    (typeof detail?.analysis?.transcript_summary === 'string' ? detail.analysis.transcript_summary : undefined) ??
                    (typeof detail?.summary === 'string' ? detail.summary : undefined);

                const duration = Number(
                    detail?.metadata?.call_duration_secs ??
                    detail?.metadata?.call_duration_seconds ??
                    detail?.call_duration_secs
                );

                const phoneRaw: string | undefined =
                    detail?.metadata?.phone_call?.external_number ||
                    detail?.metadata?.phone_number ||
                    detail?.metadata?.phone;

                if (savedWithoutPhone.has(conversationId)) {
                    // Backfill only the phone — leave transcript/summary/duration
                    // untouched to preserve any staff edits or fields already set
                    // by the post-call webhook.
                    if (!phoneRaw) { skipped++; continue; }
                    await recordVoiceCall({
                        conversation_id: conversationId,
                        phone: normalizeItalianPhone(phoneRaw),
                    });
                    backfilled++;
                } else {
                    await recordVoiceCall({
                        conversation_id: conversationId,
                        phone: phoneRaw ? normalizeItalianPhone(phoneRaw) : undefined,
                        duration_seconds: Number.isFinite(duration) ? Math.trunc(duration) : undefined,
                        transcript,
                        summary,
                    });
                    imported++;
                }
            } catch (err) {
                console.warn('[ElevenLabs] sync detail failed for', conversationId, err);
                failed++;
            }
        }

        res.json({ imported, backfilled, skipped, failed, total_fetched: conversations.length });
    } catch (err) {
        console.error('POST /voice-calls/sync error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// FEATURE FLAGS (app_settings)
// ============================================
// Boolean toggles managed from the Settings page. Used to pause the public
// booking form and the voice agent without redeploying. Reads hit the DB
// directly — the endpoints they gate are low-volume (a handful per minute
// at most), so caching isn't worth the complexity.

type FeatureFlagKey = 'public_bookings_enabled' | 'voice_agent_enabled' | 'voice_bookings_suspended' | 'pay_at_table_enabled' | 'table_orders_enabled';
const FEATURE_FLAG_KEYS: FeatureFlagKey[] = ['public_bookings_enabled', 'voice_agent_enabled', 'voice_bookings_suspended', 'pay_at_table_enabled', 'table_orders_enabled'];

async function getFeatureFlag(key: FeatureFlagKey, fallback: boolean): Promise<boolean> {
    try {
        const result = await queryWithRetry('SELECT value FROM app_settings WHERE key = $1', [key]);
        if (result.rowCount === 0) return fallback;
        return Boolean(result.rows[0].value);
    } catch (err) {
        console.error(`[feature-flag] failed to read ${key}, falling back to ${fallback}:`, err);
        return fallback;
    }
}

const FEATURE_FLAG_DEFAULTS: Record<FeatureFlagKey, boolean> = {
    public_bookings_enabled: false,
    voice_agent_enabled: true,
    voice_bookings_suspended: false,
    // Off by default: the pay-at-table + split-bill flow depends on Revolut
    // being configured and the QR link being physically distributed at the
    // table. Owner opts in from Settings once ready.
    pay_at_table_enabled: false,
    // Off by default: il modulo comande resta spento finché non c'è una UI
    // che lo usi (PR 3). Gli endpoint esistono ma rispondono 403.
    table_orders_enabled: false,
};

app.get('/settings/features', authenticate, async (_req, res) => {
    try {
        const result = await queryWithRetry(
            'SELECT key, value FROM app_settings WHERE key = ANY($1)',
            [FEATURE_FLAG_KEYS]
        );
        const flags: Record<string, boolean> = { ...FEATURE_FLAG_DEFAULTS };
        for (const row of result.rows) {
            flags[row.key] = Boolean(row.value);
        }
        res.json(flags);
    } catch (err) {
        console.error('Error fetching feature flags:', err);
        res.status(500).json({ error: 'Failed to fetch feature flags' });
    }
});

// Channel-specific settings — numeric or free-text. Booleans stay in
// /settings/features so existing FeatureFlags typing isn't polluted. Add new
// fields by extending the key/default map and the PUT validator below.
const VOICE_LARGE_GROUP_KEY = 'voice_large_group_threshold';
const VOICE_LARGE_GROUP_DEFAULT = 8;
const VOICE_SUSPENSION_CALLBACK_KEY = 'voice_bookings_suspension_callback_time';
const VOICE_SUSPENSION_CALLBACK_DEFAULT = '19:00';

async function getVoiceLargeGroupThreshold(): Promise<number> {
    try {
        const result = await queryWithRetry(
            'SELECT int_value FROM app_settings WHERE key = $1',
            [VOICE_LARGE_GROUP_KEY]
        );
        const raw = result.rows[0]?.int_value;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
        return VOICE_LARGE_GROUP_DEFAULT;
    } catch (err) {
        console.error(`[channel-settings] failed to read ${VOICE_LARGE_GROUP_KEY}, falling back to ${VOICE_LARGE_GROUP_DEFAULT}:`, err);
        return VOICE_LARGE_GROUP_DEFAULT;
    }
}

async function getVoiceSuspensionCallbackTime(): Promise<string> {
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE key = $1',
            [VOICE_SUSPENSION_CALLBACK_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (typeof raw === 'string' && HHMM_RE.test(raw)) return raw;
        return VOICE_SUSPENSION_CALLBACK_DEFAULT;
    } catch (err) {
        console.error(`[channel-settings] failed to read ${VOICE_SUSPENSION_CALLBACK_KEY}, falling back to ${VOICE_SUSPENSION_CALLBACK_DEFAULT}:`, err);
        return VOICE_SUSPENSION_CALLBACK_DEFAULT;
    }
}

const VOICE_SUSPENSION_SCHEDULE_KEY = 'voice_bookings_suspension_schedule';
const PUBLIC_BOOKINGS_BLOCKS_KEY = 'public_bookings_blocks';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type ScheduledSuspension = { date: string; start_time: string; end_time: string; callback_time?: string };
// Web-booking block: a specific date, optionally scoped to a single shift.
// `shift = 'ALL'` blocks the whole day. Keeps the operator's mental model
// aligned with how they think about the service (turno, non timestamp).
type PublicBookingBlock = { date: string; shift: 'LUNCH' | 'DINNER' | 'ALL' };
const PUBLIC_BLOCK_SHIFTS = new Set(['LUNCH', 'DINNER', 'ALL']);

function isValidPublicBookingBlock(e: any): e is PublicBookingBlock {
    if (!e || typeof e !== 'object') return false;
    if (typeof e.date !== 'string' || !ISO_DATE_RE.test(e.date)) return false;
    if (typeof e.shift !== 'string' || !PUBLIC_BLOCK_SHIFTS.has(e.shift)) return false;
    return true;
}

async function getPublicBookingBlocks(): Promise<PublicBookingBlock[]> {
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE key = $1',
            [PUBLIC_BOOKINGS_BLOCKS_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (typeof raw !== 'string' || !raw.trim()) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidPublicBookingBlock);
    } catch (err) {
        console.error(`[channel-settings] failed to read ${PUBLIC_BOOKINGS_BLOCKS_KEY}:`, err);
        return [];
    }
}

// Purge blocks whose date is already in the past so the settings screen
// doesn't accumulate stale rows over time. Runs opportunistically at read
// time — cheap since the array is small.
function pruneExpiredBlocks<T extends { date: string }>(blocks: T[]): T[] {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
    return blocks.filter(b => b.date >= today);
}

// Truthy when a booking for {date, shift} is refused by the operator via
// Settings → Prenotazioni web. A day-wide block (`shift = 'ALL'`) matches
// any shift on that date.
function isPublicBookingBlocked(date: string, shift: 'LUNCH' | 'DINNER', blocks: PublicBookingBlock[]): boolean {
    for (const b of blocks) {
        if (b.date !== date) continue;
        if (b.shift === 'ALL' || b.shift === shift) return true;
    }
    return false;
}

// Voice-booking block on the *requested* date: unlike the scheduled
// suspensions (which silence Sofia while the window is running), this blocks
// the target date the caller asks for — e.g. a fixed-menu holiday the staff
// wants to handle personally. Sofia stays on the phone and takes any other
// date; for a blocked one she invites the caller to ring back in the hours
// the operator wrote in `callback_hours`.
const VOICE_DATE_BLOCKS_KEY = 'voice_bookings_date_blocks';
type VoiceDateBlock = { date: string; shift: 'LUNCH' | 'DINNER' | 'ALL'; callback_hours?: string };

function isValidVoiceDateBlock(e: any): e is VoiceDateBlock {
    if (!e || typeof e !== 'object') return false;
    if (typeof e.date !== 'string' || !ISO_DATE_RE.test(e.date)) return false;
    if (typeof e.shift !== 'string' || !PUBLIC_BLOCK_SHIFTS.has(e.shift)) return false;
    if (e.callback_hours !== undefined && typeof e.callback_hours !== 'string') return false;
    return true;
}

async function getVoiceDateBlocks(): Promise<VoiceDateBlock[]> {
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE key = $1',
            [VOICE_DATE_BLOCKS_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (typeof raw !== 'string' || !raw.trim()) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidVoiceDateBlock);
    } catch (err) {
        console.error(`[channel-settings] failed to read ${VOICE_DATE_BLOCKS_KEY}:`, err);
        return [];
    }
}

function findVoiceDateBlock(date: string, shift: 'LUNCH' | 'DINNER', blocks: VoiceDateBlock[]): VoiceDateBlock | null {
    for (const b of blocks) {
        if (b.date !== date) continue;
        if (b.shift === 'ALL' || b.shift === shift) return b;
    }
    return null;
}

// What Sofia reads to the caller when the requested date is blocked. The
// date readback keeps weekday+day coherent (same reason as check-availability);
// callback_hours is operator-written free text ("dalle 9:00 alle 12:00").
function buildVoiceDateBlockMessage(date: string, shift: 'LUNCH' | 'DINNER', block: VoiceDateBlock): string {
    const shiftLabel = block.shift === 'ALL' ? '' : (shift === 'LUNCH' ? ' a pranzo' : ' a cena');
    const when = block.callback_hours?.trim() || 'negli orari di apertura del ristorante';
    return `Per ${formatItalianDateReadback(date)}${shiftLabel} le prenotazioni vengono gestite personalmente dal nostro staff, quindi non posso registrarla io. La invitiamo a richiamare ${when} per parlare con un operatore. Grazie!`;
}

function isValidScheduleEntry(e: any): e is ScheduledSuspension {
    if (!e || typeof e !== 'object') return false;
    if (typeof e.date !== 'string' || !ISO_DATE_RE.test(e.date)) return false;
    if (typeof e.start_time !== 'string' || !HHMM_RE.test(e.start_time)) return false;
    if (typeof e.end_time !== 'string' || !HHMM_RE.test(e.end_time)) return false;
    if (e.start_time >= e.end_time) return false;
    if (e.callback_time !== undefined && (typeof e.callback_time !== 'string' || !HHMM_RE.test(e.callback_time))) return false;
    return true;
}

async function getVoiceSuspensionSchedule(): Promise<ScheduledSuspension[]> {
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE key = $1',
            [VOICE_SUSPENSION_SCHEDULE_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (typeof raw !== 'string' || !raw.trim()) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidScheduleEntry);
    } catch (err) {
        console.error(`[channel-settings] failed to read ${VOICE_SUSPENSION_SCHEDULE_KEY}:`, err);
        return [];
    }
}

// Rome-anchored "YYYY-MM-DD" and "HH:MM" for the current instant. Used to
// decide whether a scheduled entry covers now. String comparison works
// because ISO date + zero-padded time are lexicographically ordered.
function getRomeNowParts(now: Date = new Date()): { date: string; time: string } {
    const d = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
    const t = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
    return { date: d, time: t };
}

function pickActiveScheduleEntry(entries: ScheduledSuspension[], now: Date = new Date()): ScheduledSuspension | null {
    const { date, time } = getRomeNowParts(now);
    for (const e of entries) {
        if (e.date === date && time >= e.start_time && time < e.end_time) return e;
    }
    return null;
}

// Single source of truth for "is Sofia in suspension mode right now, and if
// so which callback time should she announce?". Combines the manual toggle
// (uses the default callback) with the scheduled entries (each entry can
// carry its own callback_time; falls back to end_time when absent). Manual
// toggle wins if both hit.
async function computeVoiceSuspensionState(): Promise<{ suspended: boolean; callbackTime: string }> {
    if (await getFeatureFlag('voice_bookings_suspended', false)) {
        const callbackTime = await getVoiceSuspensionCallbackTime();
        return { suspended: true, callbackTime };
    }
    const schedule = await getVoiceSuspensionSchedule();
    const active = pickActiveScheduleEntry(schedule);
    if (active) return { suspended: true, callbackTime: active.callback_time || active.end_time };
    return { suspended: false, callbackTime: '' };
}

app.get('/settings/channels', authenticate, async (_req, res) => {
    try {
        const [voiceThreshold, suspensionCallback, suspensionSchedule, publicBlocksRaw, voiceDateBlocksRaw, roomCaps] = await Promise.all([
            getVoiceLargeGroupThreshold(),
            getVoiceSuspensionCallbackTime(),
            getVoiceSuspensionSchedule(),
            getPublicBookingBlocks(),
            getVoiceDateBlocks(),
            getRoomOccupancyCaps(),
        ]);
        // Filter past blocks at read time; UI never has to worry about them.
        const publicBlocks = pruneExpiredBlocks(publicBlocksRaw);
        const voiceDateBlocks = pruneExpiredBlocks(voiceDateBlocksRaw);
        res.json({
            voice_large_group_threshold: voiceThreshold,
            voice_bookings_suspension_callback_time: suspensionCallback,
            voice_bookings_suspension_schedule: suspensionSchedule,
            public_bookings_blocks: publicBlocks,
            voice_bookings_date_blocks: voiceDateBlocks,
            room_occupancy_caps: roomCaps,
        });
    } catch (err) {
        console.error('Error fetching channel settings:', err);
        res.status(500).json({ error: 'Failed to fetch channel settings' });
    }
});

app.put('/settings/channels', authenticate, requirePermission('settings:full'), async (req, res) => {
    const body = req.body ?? {};
    const updates: Array<{ key: string; column: 'int_value' | 'text_value'; value: number | string }> = [];

    if (body.voice_large_group_threshold !== undefined) {
        const n = Number(body.voice_large_group_threshold);
        if (!Number.isInteger(n) || n < 1 || n > 50) {
            return res.status(400).json({
                error: 'invalid_value',
                message: 'voice_large_group_threshold must be an integer between 1 and 50',
            });
        }
        updates.push({ key: VOICE_LARGE_GROUP_KEY, column: 'int_value', value: n });
    }

    if (body.voice_bookings_suspension_callback_time !== undefined) {
        const raw = String(body.voice_bookings_suspension_callback_time).trim();
        if (!HHMM_RE.test(raw)) {
            return res.status(400).json({
                error: 'invalid_value',
                message: 'voice_bookings_suspension_callback_time must be HH:MM (00-23:00-59)',
            });
        }
        updates.push({ key: VOICE_SUSPENSION_CALLBACK_KEY, column: 'text_value', value: raw });
    }

    if (body.public_bookings_blocks !== undefined) {
        if (!Array.isArray(body.public_bookings_blocks)) {
            return res.status(400).json({
                error: 'invalid_value',
                message: 'public_bookings_blocks must be an array',
            });
        }
        const normalizedBlocks: PublicBookingBlock[] = [];
        const seen = new Set<string>();
        for (const entry of body.public_bookings_blocks) {
            if (!entry || typeof entry !== 'object') {
                return res.status(400).json({ error: 'invalid_value', message: 'Each block entry must be an object' });
            }
            const date = String(entry.date ?? '').trim();
            const shift = String(entry.shift ?? '').trim().toUpperCase();
            if (!ISO_DATE_RE.test(date)) {
                return res.status(400).json({ error: 'invalid_value', message: `Block date must be YYYY-MM-DD (got "${date}")` });
            }
            if (!PUBLIC_BLOCK_SHIFTS.has(shift)) {
                return res.status(400).json({ error: 'invalid_value', message: `Block shift must be LUNCH, DINNER or ALL (got "${shift}")` });
            }
            // Dedupe on (date, shift). A day-wide ALL block subsumes LUNCH/
            // DINNER entries on the same date — drop the redundant ones.
            const key = `${date}|${shift}`;
            if (seen.has(key)) continue;
            seen.add(key);
            normalizedBlocks.push({ date, shift: shift as PublicBookingBlock['shift'] });
        }
        // Second pass: if an ALL entry exists for a date, remove any LUNCH/
        // DINNER entries for the same date.
        const daysWithAll = new Set(normalizedBlocks.filter(b => b.shift === 'ALL').map(b => b.date));
        const deduped = normalizedBlocks.filter(b => !(daysWithAll.has(b.date) && b.shift !== 'ALL'));
        // Chronological order for stable UI display.
        deduped.sort((a, b) => (a.date === b.date ? a.shift.localeCompare(b.shift) : a.date.localeCompare(b.date)));
        updates.push({ key: PUBLIC_BOOKINGS_BLOCKS_KEY, column: 'text_value', value: JSON.stringify(deduped) });
    }

    if (body.voice_bookings_date_blocks !== undefined) {
        if (!Array.isArray(body.voice_bookings_date_blocks)) {
            return res.status(400).json({
                error: 'invalid_value',
                message: 'voice_bookings_date_blocks must be an array',
            });
        }
        const normalizedVoiceBlocks: VoiceDateBlock[] = [];
        const seenVoice = new Set<string>();
        for (const entry of body.voice_bookings_date_blocks) {
            if (!entry || typeof entry !== 'object') {
                return res.status(400).json({ error: 'invalid_value', message: 'Each voice block entry must be an object' });
            }
            const date = String(entry.date ?? '').trim();
            const shift = String(entry.shift ?? '').trim().toUpperCase();
            const callbackHours = entry.callback_hours === undefined || entry.callback_hours === null
                ? ''
                : String(entry.callback_hours).trim();
            if (!ISO_DATE_RE.test(date)) {
                return res.status(400).json({ error: 'invalid_value', message: `Voice block date must be YYYY-MM-DD (got "${date}")` });
            }
            if (!PUBLIC_BLOCK_SHIFTS.has(shift)) {
                return res.status(400).json({ error: 'invalid_value', message: `Voice block shift must be LUNCH, DINNER or ALL (got "${shift}")` });
            }
            if (callbackHours.length > 120) {
                return res.status(400).json({ error: 'invalid_value', message: 'Voice block callback_hours must be at most 120 characters' });
            }
            // Same dedupe rules as the web blocks: (date, shift) unique, and a
            // day-wide ALL entry subsumes the per-shift ones on that date.
            const key = `${date}|${shift}`;
            if (seenVoice.has(key)) continue;
            seenVoice.add(key);
            const normalizedEntry: VoiceDateBlock = { date, shift: shift as VoiceDateBlock['shift'] };
            if (callbackHours) normalizedEntry.callback_hours = callbackHours;
            normalizedVoiceBlocks.push(normalizedEntry);
        }
        const voiceDaysWithAll = new Set(normalizedVoiceBlocks.filter(b => b.shift === 'ALL').map(b => b.date));
        const voiceDeduped = normalizedVoiceBlocks.filter(b => !(voiceDaysWithAll.has(b.date) && b.shift !== 'ALL'));
        voiceDeduped.sort((a, b) => (a.date === b.date ? a.shift.localeCompare(b.shift) : a.date.localeCompare(b.date)));
        updates.push({ key: VOICE_DATE_BLOCKS_KEY, column: 'text_value', value: JSON.stringify(voiceDeduped) });
    }

    if (body.room_occupancy_caps !== undefined) {
        if (!Array.isArray(body.room_occupancy_caps)) {
            return res.status(400).json({
                error: 'invalid_value',
                message: 'room_occupancy_caps must be an array',
            });
        }
        const normalizedCaps: RoomOccupancyCap[] = [];
        const seenRooms = new Set<number>();
        for (const entry of body.room_occupancy_caps) {
            if (!entry || typeof entry !== 'object') {
                return res.status(400).json({ error: 'invalid_value', message: 'Each room cap entry must be an object' });
            }
            const roomId = Number(entry.room_id);
            const percent = Number(entry.percent);
            const basis = String(entry.basis ?? 'TABLES').trim().toUpperCase();
            if (!Number.isInteger(roomId) || roomId <= 0) {
                return res.status(400).json({ error: 'invalid_value', message: `Cap room_id must be a positive integer (got "${entry.room_id}")` });
            }
            if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
                return res.status(400).json({ error: 'invalid_value', message: `Cap percent must be an integer between 1 and 100 (got "${entry.percent}")` });
            }
            if (basis !== 'TABLES' && basis !== 'SEATS') {
                return res.status(400).json({ error: 'invalid_value', message: `Cap basis must be TABLES or SEATS (got "${entry.basis}")` });
            }
            // Last write wins on duplicates so the UI never has to dedupe.
            if (seenRooms.has(roomId)) {
                const idx = normalizedCaps.findIndex(c => c.room_id === roomId);
                normalizedCaps[idx] = { room_id: roomId, percent, basis };
                continue;
            }
            seenRooms.add(roomId);
            normalizedCaps.push({ room_id: roomId, percent, basis });
        }
        // Reject caps pointing at rooms that no longer exist: a stale entry
        // would silently never apply and the operator would think it does.
        if (normalizedCaps.length > 0) {
            try {
                const known = await queryWithRetry('SELECT id FROM rooms WHERE id = ANY($1::int[])', [normalizedCaps.map(c => c.room_id)]);
                const knownIds = new Set<number>(known.rows.map((r: any) => Number(r.id)));
                const unknown = normalizedCaps.filter(c => !knownIds.has(c.room_id)).map(c => c.room_id);
                if (unknown.length > 0) {
                    return res.status(400).json({ error: 'invalid_value', message: `Sale inesistenti: ${unknown.join(', ')}` });
                }
            } catch (err) {
                console.error('Error validating room occupancy caps:', err);
                return res.status(500).json({ error: 'Failed to validate room occupancy caps' });
            }
        }
        normalizedCaps.sort((a, b) => a.room_id - b.room_id);
        updates.push({ key: ROOM_OCCUPANCY_CAPS_KEY, column: 'text_value', value: JSON.stringify(normalizedCaps) });
    }

    if (body.voice_bookings_suspension_schedule !== undefined) {
        if (!Array.isArray(body.voice_bookings_suspension_schedule)) {
            return res.status(400).json({
                error: 'invalid_value',
                message: 'voice_bookings_suspension_schedule must be an array',
            });
        }
        const normalized: ScheduledSuspension[] = [];
        for (const entry of body.voice_bookings_suspension_schedule) {
            if (!entry || typeof entry !== 'object') {
                return res.status(400).json({ error: 'invalid_value', message: 'Each schedule entry must be an object' });
            }
            const date = String(entry.date ?? '').trim();
            const start = String(entry.start_time ?? '').trim();
            const end = String(entry.end_time ?? '').trim();
            const callbackRaw = entry.callback_time === undefined || entry.callback_time === null
                ? ''
                : String(entry.callback_time).trim();
            if (!ISO_DATE_RE.test(date)) {
                return res.status(400).json({ error: 'invalid_value', message: `Schedule entry date must be YYYY-MM-DD (got "${date}")` });
            }
            if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
                return res.status(400).json({ error: 'invalid_value', message: 'Schedule entry start_time and end_time must be HH:MM' });
            }
            if (start >= end) {
                return res.status(400).json({ error: 'invalid_value', message: `Schedule entry start_time must be before end_time (${date} ${start}-${end})` });
            }
            if (callbackRaw && !HHMM_RE.test(callbackRaw)) {
                return res.status(400).json({ error: 'invalid_value', message: `Schedule entry callback_time must be HH:MM (got "${callbackRaw}")` });
            }
            const normalizedEntry: ScheduledSuspension = { date, start_time: start, end_time: end };
            if (callbackRaw) normalizedEntry.callback_time = callbackRaw;
            normalized.push(normalizedEntry);
        }
        // Sort chronologically so downstream reads/UI get a stable order.
        normalized.sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)));
        updates.push({ key: VOICE_SUSPENSION_SCHEDULE_KEY, column: 'text_value', value: JSON.stringify(normalized) });
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'no_updates', message: 'No channel settings supplied' });
    }

    try {
        for (const u of updates) {
            const sql = `INSERT INTO app_settings (key, ${u.column}, updated_at)
                         VALUES ($1, $2, CURRENT_TIMESTAMP)
                         ON CONFLICT (key) DO UPDATE
                           SET ${u.column} = EXCLUDED.${u.column}, updated_at = CURRENT_TIMESTAMP`;
            await queryWithRetry(sql, [u.key, u.value]);
        }
        const [voiceThreshold, suspensionCallback, suspensionSchedule, publicBlocksRaw, voiceDateBlocksRaw, roomCaps] = await Promise.all([
            getVoiceLargeGroupThreshold(),
            getVoiceSuspensionCallbackTime(),
            getVoiceSuspensionSchedule(),
            getPublicBookingBlocks(),
            getVoiceDateBlocks(),
            getRoomOccupancyCaps(),
        ]);
        const publicBlocks = pruneExpiredBlocks(publicBlocksRaw);
        const voiceDateBlocks = pruneExpiredBlocks(voiceDateBlocksRaw);
        res.json({
            voice_large_group_threshold: voiceThreshold,
            voice_bookings_suspension_callback_time: suspensionCallback,
            voice_bookings_suspension_schedule: suspensionSchedule,
            public_bookings_blocks: publicBlocks,
            voice_bookings_date_blocks: voiceDateBlocks,
            room_occupancy_caps: roomCaps,
        });
    } catch (err) {
        console.error('Error updating channel settings:', err);
        res.status(500).json({ error: 'Failed to update channel settings' });
    }
});

// Live occupancy per room, used by Settings → Canali di prenotazione to show
// the operator how full each sala is right now against its configured cap.
// Read-only: no side effects, safe for any authenticated user to poll.
app.get('/settings/rooms-occupancy', authenticate, async (req, res) => {
    const dateParam = typeof req.query.date === 'string' ? req.query.date : '';
    const date = ISO_DATE_RE.test(dateParam)
        ? dateParam
        : new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
    try {
        const [lunch, dinner] = await Promise.all([
            computeRoomOccupancy(date, Shift.LUNCH),
            computeRoomOccupancy(date, Shift.DINNER),
        ]);
        // One row per room carrying both shifts: the settings card renders a
        // single line per sala, so joining here keeps the UI dumb.
        const dinnerById = new Map(dinner.map(r => [r.room_id, r]));
        const rooms = lunch.map(r => ({
            room_id: r.room_id,
            room_name: r.room_name,
            is_closed: r.is_closed,
            capacity_tables: r.capacity_tables,
            capacity_seats: r.capacity_seats,
            lunch: {
                used_tables: r.used_tables,
                used_seats: r.used_seats,
                percent_tables: r.percent_tables,
                percent_seats: r.percent_seats,
                at_cap: r.at_cap,
                closed_for_shift: r.closed_for_shift,
            },
            dinner: (() => {
                const d = dinnerById.get(r.room_id);
                return {
                    used_tables: d?.used_tables ?? 0,
                    used_seats: d?.used_seats ?? 0,
                    percent_tables: d?.percent_tables ?? 0,
                    percent_seats: d?.percent_seats ?? 0,
                    at_cap: d?.at_cap ?? false,
                    closed_for_shift: d?.closed_for_shift ?? false,
                };
            })(),
        }));
        res.json({ date, rooms });
    } catch (err) {
        console.error('Error fetching room occupancy:', err);
        res.status(500).json({ error: 'Failed to fetch room occupancy' });
    }
});

// ---------------------------------------------------------------------------
// LEGAL SETTINGS (app_settings → key 'legal_config', stored as a JSON blob)
// Per-tenant identity + configuration used to generate the app's legal
// documents (privacy policy, voice notice, cookie policy + banner, terms).
// Multi-tenant/SaaS ready: everything is data, no hard-coded restaurant info.
// ---------------------------------------------------------------------------
const LEGAL_CONFIG_KEY = 'legal_config';
// Operating mode for the legal layer:
//   'simple'   → only the strict legal minimum (no marketing / non-essential).
//   'advanced' → full: marketing consents, audience, analytics cookies, terms.
const LEGAL_MODES = ['simple', 'advanced'] as const;
type LegalMode = typeof LEGAL_MODES[number];
const LEGAL_MODE_DEFAULT: LegalMode = 'advanced';
// Whitelisted string fields. Unknown keys are ignored on write.
const LEGAL_STRING_FIELDS = [
    'legal_mode',          // 'simple' | 'advanced'
    'company_name',        // Ragione sociale
    'company_address',     // Sede legale
    'vat_number',          // Partita IVA
    'fiscal_code',         // Codice fiscale (facoltativo)
    'privacy_email',       // E-mail per richieste privacy
    'privacy_phone',       // Telefono
    'dpo_name',            // Nome DPO (facoltativo)
    'dpo_contact',         // Contatto DPO (facoltativo)
    'website_url',         // Sito / canale di prenotazione online
    'app_name',            // Nome applicazione mostrato (default RistoManager)
    'voice_business_name', // Nome pronunciato nell'avviso vocale
    'data_processors',     // Elenco responsabili/fornitori (testo multiriga)
    'retention_customer',  // Conservazione dati cliente (es. "24 mesi")
    'retention_calls',     // Conservazione registrazioni chiamate (es. "6 mesi")
    'retention_marketing', // Conservazione dati marketing (es. "fino a revoca")
    'extra_eu_note',       // Nota trasferimenti extra-UE
    'governing_law',       // Legge applicabile / foro competente
    'last_updated',        // Data ultimo aggiornamento (ISO, gestita lato client)
] as const;
// Whitelisted boolean fields.
const LEGAL_BOOL_FIELDS = [
    'uses_analytics_cookies', // Il sito usa cookie analitici/di terze parti
    'records_calls',          // Le chiamate sono registrate
    'ask_health_consent',     // Chiedi il consenso allergie/dati sanitari in prenotazione
] as const;

function emptyLegalConfig(): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (const k of LEGAL_STRING_FIELDS) out[k] = '';
    for (const k of LEGAL_BOOL_FIELDS) out[k] = false;
    out.legal_mode = LEGAL_MODE_DEFAULT;
    // Default ON: preserves the previous always-on allergy-consent behaviour
    // for tenants without a stored value.
    out.ask_health_consent = true;
    return out;
}

function normalizeLegalMode(v: unknown): LegalMode {
    return (typeof v === 'string' && (LEGAL_MODES as readonly string[]).includes(v)) ? (v as LegalMode) : LEGAL_MODE_DEFAULT;
}

async function getLegalConfig(): Promise<Record<string, string | boolean>> {
    const base = emptyLegalConfig();
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE key = $1',
            [LEGAL_CONFIG_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                for (const k of LEGAL_STRING_FIELDS) {
                    if (typeof parsed[k] === 'string') base[k] = parsed[k];
                }
                for (const k of LEGAL_BOOL_FIELDS) {
                    if (typeof parsed[k] === 'boolean') base[k] = parsed[k];
                }
            }
        }
    } catch (err) {
        console.error('[legal-settings] failed to read legal_config:', err);
    }
    base.legal_mode = normalizeLegalMode(base.legal_mode);
    return base;
}

app.get('/settings/legal', authenticate, async (_req, res) => {
    try {
        res.json(await getLegalConfig());
    } catch (err) {
        console.error('GET /settings/legal error:', err);
        res.status(500).json({ error: 'Failed to fetch legal settings' });
    }
});

app.put('/settings/legal', authenticate, requirePermission('settings:full'), async (req, res) => {
    // Whole handler wrapped so a throw in getLegalConfig()/DB never escapes to
    // Express's default (HTML, non-JSON) error page — which surfaces on the
    // client as an opaque "Request failed". The real cause is echoed in `detail`.
    try {
        const body = req.body ?? {};
        if (typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'invalid_value', message: 'Body must be an object' });
        }
        const current = await getLegalConfig();
        const next: Record<string, string | boolean> = { ...current };
        for (const k of LEGAL_STRING_FIELDS) {
            if (k in body) {
                if (typeof body[k] !== 'string') {
                    return res.status(400).json({ error: 'invalid_value', message: `${k} must be a string` });
                }
                // Cap length defensively; legal blurbs can be long but not unbounded.
                next[k] = String(body[k]).slice(0, 5000);
            }
        }
        for (const k of LEGAL_BOOL_FIELDS) {
            if (k in body) {
                if (typeof body[k] !== 'boolean') {
                    return res.status(400).json({ error: 'invalid_value', message: `${k} must be a boolean` });
                }
                next[k] = body[k];
            }
        }
        // legal_mode must be one of the known modes; anything else falls back safely.
        next.legal_mode = normalizeLegalMode(next.legal_mode);
        await queryWithRetry(
            `INSERT INTO app_settings (key, text_value, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE
               SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
            [LEGAL_CONFIG_KEY, JSON.stringify(next)]
        );
        res.json(next);
    } catch (err: any) {
        console.error('PUT /settings/legal error:', err);
        res.status(500).json({ error: 'Failed to update legal settings', detail: err?.message });
    }
});

app.put('/settings/features', authenticate, requirePermission('settings:full'), async (req, res) => {
    const body = req.body ?? {};
    const updates: Array<{ key: FeatureFlagKey; value: boolean }> = [];
    for (const key of FEATURE_FLAG_KEYS) {
        if (key in body) {
            if (typeof body[key] !== 'boolean') {
                return res.status(400).json({ error: 'invalid_value', message: `${key} must be boolean` });
            }
            updates.push({ key, value: body[key] });
        }
    }
    if (updates.length === 0) {
        return res.status(400).json({ error: 'no_updates', message: 'No flag updates supplied' });
    }
    try {
        for (const { key, value } of updates) {
            await queryWithRetry(
                `INSERT INTO app_settings (key, value, updated_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE
                   SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                [key, value]
            );
        }
        const result = await queryWithRetry(
            'SELECT key, value FROM app_settings WHERE key = ANY($1)',
            [FEATURE_FLAG_KEYS]
        );
        const flags: Record<string, boolean> = { ...FEATURE_FLAG_DEFAULTS };
        for (const row of result.rows) {
            flags[row.key] = Boolean(row.value);
        }
        // Le voci di menu legate ai flag (Comande/Cucina/Passe) si aggiornano
        // in tempo reale su tutti i dispositivi connessi, incluso chi ha
        // premuto l'interruttore.
        try { socketService?.broadcastToAll('features:updated', flags); } catch (_) {}
        res.json(flags);
    } catch (err) {
        console.error('Error updating feature flags:', err);
        res.status(500).json({ error: 'Failed to update feature flags' });
    }
});

// ============================================
// INTEGRATION SETTINGS (Revolut)
// ============================================
// GET returns a masked snapshot (last 4 chars of secrets + booleans) so the
// UI can render the current state without leaking credentials. PUT accepts
// partial updates: any field left out is preserved. Sending an empty string
// clears that field back to the env-var fallback.
app.get('/settings/integrations/revolut', authenticate, requirePermission('settings:full'), async (_req, res) => {
    try {
        const status = await getRevolutConfigStatus();

        // integration_settings may not exist yet on a brand-new deploy where
        // the schema-init CTE that creates it hasn't finished running. Treat
        // any error here as "no metadata" so the card renders anyway with the
        // env-fallback status.
        let updatedAt: string | null = null;
        let updatedByEmail: string | null = null;
        try {
            const meta = await queryWithRetry(
                `SELECT updated_at, updated_by_user_id FROM integration_settings WHERE provider = 'revolut'`
            );
            const row = meta.rows[0];
            if (row) {
                updatedAt = row.updated_at ?? null;
                if (row.updated_by_user_id) {
                    const u = await queryWithRetry(`SELECT email FROM users WHERE id = $1`, [row.updated_by_user_id]);
                    updatedByEmail = u.rows[0]?.email ?? null;
                }
            }
        } catch (metaErr: any) {
            console.warn('[Revolut] integration_settings metadata unavailable:', metaErr?.message || metaErr);
        }

        res.json({
            ...status,
            updated_at: updatedAt,
            updated_by: updatedByEmail,
        });
    } catch (err: any) {
        console.error('GET /settings/integrations/revolut error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/settings/integrations/revolut', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const body = req.body ?? {};
        const updates: Record<string, string | null> = {};

        if (body.environment !== undefined) {
            if (body.environment !== 'sandbox' && body.environment !== 'production') {
                return res.status(400).json({ error: 'invalid_environment' });
            }
            updates.environment = body.environment;
        }
        // Empty string is a legit signal to CLEAR the DB value (fall back to
        // env). Undefined means "leave alone". null is treated the same as
        // empty string.
        const nullableString = (v: unknown): string | null | undefined => {
            if (v === undefined) return undefined;
            if (v === null) return null;
            if (typeof v !== 'string') return undefined;
            const trimmed = v.trim();
            return trimmed === '' ? null : trimmed;
        };
        const apiKey = nullableString(body.api_key);
        if (apiKey !== undefined) updates.api_key = apiKey;
        const webhookSecret = nullableString(body.webhook_secret);
        if (webhookSecret !== undefined) updates.webhook_secret = webhookSecret;
        const apiVersion = nullableString(body.api_version);
        if (apiVersion !== undefined) updates.api_version = apiVersion;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'no_updates' });
        }

        // Build an UPSERT: on first save the row doesn't exist yet so we need
        // to insert with the provided fields (defaulting environment to
        // 'sandbox') and, on conflict, update only the columns we were asked
        // to change.
        const providedCols = Object.keys(updates);
        const providedVals = providedCols.map(c => updates[c]);
        const userId = req.user?.userId ?? null;

        // Insert: fill known columns; for columns not provided, insert NULL
        // (environment defaults to 'sandbox' via the table default).
        const insertCols = ['provider', ...providedCols, 'updated_by_user_id', 'updated_at'];
        const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
        const insertValues = ['revolut', ...providedVals, userId, new Date()];

        const updateSet = [
            ...providedCols.map((c, i) => `${c} = $${i + 2}`),
            `updated_by_user_id = $${providedCols.length + 2}`,
            `updated_at = CURRENT_TIMESTAMP`,
        ].join(', ');

        await queryWithRetry(
            `INSERT INTO integration_settings (${insertCols.join(', ')})
             VALUES (${insertPlaceholders})
             ON CONFLICT (provider) DO UPDATE SET ${updateSet}`,
            insertValues
        );

        invalidateRevolutConfigCache();

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.SETTINGS,
                undefined,
                `Integrazione Revolut aggiornata (${updates.environment || 'campi credenziali'})`
            );
        }

        const status = await getRevolutConfigStatus();
        res.json({ ...status, updated_at: new Date().toISOString(), updated_by: req.user?.email ?? null });
    } catch (err: any) {
        console.error('PUT /settings/integrations/revolut error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// ============================================
// INTEGRATION SETTINGS (SumUp)
// ============================================
// Same contract as the Revolut endpoints above — GET returns a masked
// snapshot, PUT takes partial updates and treats an empty string as "clear
// back to the env fallback" — with one addition: SumUp credentials are stored
// per environment (production uses api_key + sumup_merchant_code, sandbox
// uses its own pair), because SumUp serves both from the same host and tells
// them apart by the key. `environment` picks which pair is live, so an
// operator can keep sandbox credentials around and flip back to test.
app.get('/settings/integrations/sumup', authenticate, requirePermission('settings:full'), async (_req, res) => {
    try {
        const status = await getSumUpConfigStatus();
        const activeProvider = await getActivePaymentProvider();

        // Same defensive read as the Revolut card: on a brand-new deploy the
        // schema-init may not have created the table yet, and the card should
        // still render off the env fallbacks.
        let updatedAt: string | null = null;
        let updatedByEmail: string | null = null;
        try {
            const meta = await queryWithRetry(
                `SELECT updated_at, updated_by_user_id FROM integration_settings WHERE provider = 'sumup'`
            );
            const row = meta.rows[0];
            if (row) {
                updatedAt = row.updated_at ?? null;
                if (row.updated_by_user_id) {
                    const u = await queryWithRetry(`SELECT email FROM users WHERE id = $1`, [row.updated_by_user_id]);
                    updatedByEmail = u.rows[0]?.email ?? null;
                }
            }
        } catch (metaErr: any) {
            console.warn('[SumUp] integration_settings metadata unavailable:', metaErr?.message || metaErr);
        }

        res.json({
            ...status,
            active_provider: activeProvider,
            is_active_provider: activeProvider === 'sumup',
            // The URL SumUp calls back on. Shown read-only in the card so the
            // operator can sanity-check it against CRM_APP_BASE_URL; the
            // token itself is never rendered.
            callback_url: status.has_callback_secret ? `${publicBaseUrl()}/webhook/sumup/•••` : null,
            updated_at: updatedAt,
            updated_by: updatedByEmail,
        });
    } catch (err: any) {
        console.error('GET /settings/integrations/sumup error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/settings/integrations/sumup', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const body = req.body ?? {};
        const updates: Record<string, string | null> = {};

        if (body.environment !== undefined) {
            if (body.environment !== 'sandbox' && body.environment !== 'production') {
                return res.status(400).json({ error: 'invalid_environment' });
            }
            updates.environment = body.environment;
        }

        // Empty string clears the DB value (falling back to env); undefined
        // means "leave alone"; null behaves like empty string.
        const nullableString = (v: unknown): string | null | undefined => {
            if (v === undefined) return undefined;
            if (v === null) return null;
            if (typeof v !== 'string') return undefined;
            const trimmed = v.trim();
            return trimmed === '' ? null : trimmed;
        };

        const fieldMap: Array<[string, string]> = [
            ['api_key', 'api_key'],                                   // production secret key
            ['merchant_code', 'sumup_merchant_code'],                 // production merchant code
            ['sandbox_api_key', 'sumup_sandbox_api_key'],
            ['sandbox_merchant_code', 'sumup_sandbox_merchant_code'],
            ['callback_secret', 'webhook_secret'],
        ];
        for (const [bodyKey, column] of fieldMap) {
            const value = nullableString(body[bodyKey]);
            if (value !== undefined) updates[column] = value;
        }

        // Switching the active gateway is part of the same card, but it lives
        // in app_settings rather than on this row — handle it separately so a
        // provider-only save doesn't trip the "no updates" guard.
        let providerChange: PaymentProvider | null = null;
        if (body.set_active !== undefined) {
            if (typeof body.set_active !== 'boolean') {
                return res.status(400).json({ error: 'invalid_set_active' });
            }
            providerChange = body.set_active ? 'sumup' : 'revolut';
        }

        if (Object.keys(updates).length === 0 && providerChange === null) {
            return res.status(400).json({ error: 'no_updates' });
        }

        // The callback token is ours to mint — SumUp doesn't hand one out —
        // so generate it the first time credentials are saved rather than
        // asking the operator to invent a secret. Without it we can't
        // register a return_url and payments would only settle on reconcile.
        if (Object.keys(updates).length > 0 && updates.webhook_secret === undefined) {
            const existing = await getSumUpConfigStatus();
            if (!existing.has_callback_secret) {
                updates.webhook_secret = crypto.randomBytes(24).toString('hex');
            }
        }

        if (Object.keys(updates).length > 0) {
            // UPSERT so the first save works before the row exists; on
            // conflict only the columns we were asked to change are touched.
            const providedCols = Object.keys(updates);
            const providedVals = providedCols.map(c => updates[c]);
            const userId = req.user?.userId ?? null;

            const insertCols = ['provider', ...providedCols, 'updated_by_user_id', 'updated_at'];
            const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
            const insertValues = ['sumup', ...providedVals, userId, new Date()];

            const updateSet = [
                ...providedCols.map((c, i) => `${c} = $${i + 2}`),
                `updated_by_user_id = $${providedCols.length + 2}`,
                `updated_at = CURRENT_TIMESTAMP`,
            ].join(', ');

            await queryWithRetry(
                `INSERT INTO integration_settings (${insertCols.join(', ')})
                 VALUES (${insertPlaceholders})
                 ON CONFLICT (provider) DO UPDATE SET ${updateSet}`,
                insertValues
            );
            invalidateSumUpConfigCache();
        }

        if (providerChange) {
            // Refuse to route live payments at a gateway that can't take
            // them — the failure would otherwise only show up on the guest's
            // checkout link.
            if (!(await isProviderConfigured(providerChange))) {
                return res.status(400).json({
                    error: `${providerLabel(providerChange)} non è configurato: completa le credenziali prima di attivarlo`,
                });
            }
            await setActivePaymentProvider(providerChange);
        }

        if (req.user) {
            const what = providerChange
                ? `provider attivo: ${providerLabel(providerChange)}`
                : (updates.environment || 'campi credenziali');
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.SETTINGS,
                undefined,
                `Integrazione SumUp aggiornata (${what})`
            );
        }

        const status = await getSumUpConfigStatus();
        const activeProvider = await getActivePaymentProvider();
        res.json({
            ...status,
            active_provider: activeProvider,
            is_active_provider: activeProvider === 'sumup',
            callback_url: status.has_callback_secret ? `${publicBaseUrl()}/webhook/sumup/•••` : null,
            updated_at: new Date().toISOString(),
            updated_by: req.user?.email ?? null,
        });
    } catch (err: any) {
        console.error('PUT /settings/integrations/sumup error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Which gateway new payments are created with. Split out from the two
// integration cards so either of them (and any future provider) can read and
// flip it without knowing about the other.
// GET is auth-only, not settings:full: the reservation modal labels its
// deposit box with the gateway that will actually take the money ("Richiedi
// acconto (SumUp)"), and that box is used by staff who can't see Settings.
// Nothing here is secret — just which gateway is live and whether it's ready.
// PUT stays admin-only.
app.get('/settings/payments/provider', authenticate, async (_req, res) => {
    try {
        const active = await getActivePaymentProvider();
        const configured: Record<string, boolean> = {};
        for (const provider of PAYMENT_PROVIDERS) {
            configured[provider] = await isProviderConfigured(provider);
        }
        res.json({
            provider: active,
            label: providerLabel(active),
            providers: PAYMENT_PROVIDERS,
            configured,
        });
    } catch (err: any) {
        console.error('GET /settings/payments/provider error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/settings/payments/provider', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const provider = req.body?.provider;
        if (!isPaymentProvider(provider)) {
            return res.status(400).json({ error: 'invalid_provider' });
        }
        if (!(await isProviderConfigured(provider))) {
            return res.status(400).json({
                error: `${providerLabel(provider)} non è configurato: completa le credenziali prima di attivarlo`,
            });
        }
        await setActivePaymentProvider(provider);

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.SETTINGS,
                undefined,
                `Provider pagamenti attivo: ${providerLabel(provider)}`
            );
        }
        res.json({ provider });
    } catch (err: any) {
        console.error('PUT /settings/payments/provider error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// ============================================
// INTEGRATION SETTINGS (SMTP / email)
// ============================================
// Same shape as the Revolut endpoints above: GET returns a masked snapshot,
// PUT accepts partial updates (empty string = clear back to env fallback).
app.get('/settings/integrations/smtp', authenticate, requirePermission('settings:full'), async (_req, res) => {
    try {
        const status = await getSmtpConfigStatus();
        let updatedAt: string | null = null;
        let updatedByEmail: string | null = null;
        try {
            const meta = await queryWithRetry(
                `SELECT updated_at, updated_by_user_id FROM integration_settings WHERE provider = 'smtp'`
            );
            const row = meta.rows[0];
            if (row) {
                updatedAt = row.updated_at ?? null;
                if (row.updated_by_user_id) {
                    const u = await queryWithRetry(`SELECT email FROM users WHERE id = $1`, [row.updated_by_user_id]);
                    updatedByEmail = u.rows[0]?.email ?? null;
                }
            }
        } catch (metaErr: any) {
            console.warn('[SMTP] integration_settings metadata unavailable:', metaErr?.message || metaErr);
        }
        res.json({ ...status, updated_at: updatedAt, updated_by: updatedByEmail });
    } catch (err: any) {
        console.error('GET /settings/integrations/smtp error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/settings/integrations/smtp', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const body = req.body ?? {};
        const updates: Record<string, string | number | boolean | null> = {};

        const nullableString = (v: unknown): string | null | undefined => {
            if (v === undefined) return undefined;
            if (v === null) return null;
            if (typeof v !== 'string') return undefined;
            const trimmed = v.trim();
            return trimmed === '' ? null : trimmed;
        };

        if (body.provider !== undefined) {
            if (body.provider !== 'smtp' && body.provider !== 'resend') {
                return res.status(400).json({ error: 'invalid_provider' });
            }
            updates.email_provider = body.provider;
        }
        // Resend API key. Empty string / null clears back to env fallback.
        if (body.resend_api_key !== undefined) {
            if (body.resend_api_key === null || (typeof body.resend_api_key === 'string' && body.resend_api_key.trim() === '')) {
                updates.resend_api_key = null;
            } else if (typeof body.resend_api_key === 'string') {
                updates.resend_api_key = body.resend_api_key.trim();
            }
        }
        // Resend inbound webhook signing secret (whsec_...). Same clear-on-empty semantics.
        if (body.resend_inbound_secret !== undefined) {
            if (body.resend_inbound_secret === null || (typeof body.resend_inbound_secret === 'string' && body.resend_inbound_secret.trim() === '')) {
                updates.resend_inbound_secret = null;
            } else if (typeof body.resend_inbound_secret === 'string') {
                updates.resend_inbound_secret = body.resend_inbound_secret.trim();
            }
        }
        const replyTo = nullableString(body.reply_to);
        if (replyTo !== undefined) updates.smtp_reply_to = replyTo;

        const host = nullableString(body.host);
        if (host !== undefined) updates.smtp_host = host;
        const user = nullableString(body.user);
        if (user !== undefined) updates.smtp_user = user;
        // Password is not trimmed on the DB side — but null/empty means clear.
        if (body.password !== undefined) {
            if (body.password === null || (typeof body.password === 'string' && body.password === '')) {
                updates.smtp_password = null;
            } else if (typeof body.password === 'string') {
                updates.smtp_password = body.password;
            }
        }
        const fromEmail = nullableString(body.from_email);
        if (fromEmail !== undefined) updates.smtp_from_email = fromEmail;
        const fromName = nullableString(body.from_name);
        if (fromName !== undefined) updates.smtp_from_name = fromName;
        if (body.port !== undefined) {
            if (body.port === null || body.port === '') {
                updates.smtp_port = null;
            } else {
                const n = Number(body.port);
                if (!Number.isInteger(n) || n < 1 || n > 65535) {
                    return res.status(400).json({ error: 'invalid_port' });
                }
                updates.smtp_port = n;
            }
        }
        if (body.secure !== undefined) {
            if (typeof body.secure !== 'boolean') {
                return res.status(400).json({ error: 'invalid_secure' });
            }
            updates.smtp_secure = body.secure;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'no_updates' });
        }

        const providedCols = Object.keys(updates);
        const providedVals = providedCols.map(c => updates[c]);
        const userId = req.user?.userId ?? null;

        const insertCols = ['provider', ...providedCols, 'updated_by_user_id', 'updated_at'];
        const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
        const insertValues = ['smtp', ...providedVals, userId, new Date()];
        const updateSet = [
            ...providedCols.map((c, i) => `${c} = $${i + 2}`),
            `updated_by_user_id = $${providedCols.length + 2}`,
            `updated_at = CURRENT_TIMESTAMP`,
        ].join(', ');

        await queryWithRetry(
            `INSERT INTO integration_settings (${insertCols.join(', ')})
             VALUES (${insertPlaceholders})
             ON CONFLICT (provider) DO UPDATE SET ${updateSet}`,
            insertValues
        );

        invalidateSmtpConfigCache();

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.SETTINGS,
                undefined,
                `Configurazione SMTP aggiornata`
            );
        }

        const status = await getSmtpConfigStatus();
        res.json({ ...status, updated_at: new Date().toISOString(), updated_by: req.user?.email ?? null });
    } catch (err: any) {
        console.error('PUT /settings/integrations/smtp error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Sends a test email to the given recipient (or to smtp_user if omitted) using
// the currently saved SMTP config. Verifies the transport first so a bad host
// or bad password fails fast with a clear message.
app.post('/settings/integrations/smtp/test', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const to = String(req.body?.to ?? '').trim();
        if (!to || !/@/.test(to)) {
            return res.status(400).json({ error: 'Indirizzo destinatario mancante o non valido' });
        }
        const verify = await verifySmtpConnection();
        if (!verify.ok) {
            console.warn('[SMTP] verify failed before test send:', verify.error);
            return res.status(400).json({ error: verify.error || 'Verifica SMTP fallita' });
        }
        try {
            const info = await sendMail({
                to,
                subject: 'Test SMTP RistoManager',
                text: 'Questo è un messaggio di test dal tuo CRM RistoManager. Se lo hai ricevuto, la configurazione SMTP funziona correttamente.',
            });
            console.log('[SMTP] test email sent:', { to, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected });
            res.json({ success: true });
        } catch (sendErr: any) {
            console.error('[SMTP] test sendMail failed:', {
                message: sendErr?.message,
                code: sendErr?.code,
                command: sendErr?.command,
                response: sendErr?.response,
                responseCode: sendErr?.responseCode,
            });
            res.status(500).json({ error: sendErr?.message || 'Invio email di test fallito' });
        }
    } catch (err: any) {
        console.error('POST /settings/integrations/smtp/test error:', err);
        res.status(500).json({ error: err?.message || 'Test SMTP fallito' });
    }
});

// ============================================
// INTEGRATION SETTINGS (IMAP inbound polling)
// ============================================
// Config lives on the same integration_settings row as SMTP (provider='smtp')
// but under imap_* columns. Toggling `enabled` restarts the long-lived
// IMAP+IDLE listener so config changes take effect without a redeploy.
app.get('/settings/integrations/imap', authenticate, requirePermission('settings:full'), async (_req, res) => {
    try {
        const status = await getImapConfigStatus();
        let updatedAt: string | null = null;
        let updatedByEmail: string | null = null;
        try {
            const meta = await queryWithRetry(
                `SELECT updated_at, updated_by_user_id FROM integration_settings WHERE provider = 'smtp'`
            );
            const row = meta.rows[0];
            if (row) {
                updatedAt = row.updated_at ?? null;
                if (row.updated_by_user_id) {
                    const u = await queryWithRetry(`SELECT email FROM users WHERE id = $1`, [row.updated_by_user_id]);
                    updatedByEmail = u.rows[0]?.email ?? null;
                }
            }
        } catch (metaErr: any) {
            console.warn('[IMAP] integration_settings metadata unavailable:', metaErr?.message || metaErr);
        }
        res.json({ ...status, updated_at: updatedAt, updated_by: updatedByEmail });
    } catch (err: any) {
        console.error('GET /settings/integrations/imap error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/settings/integrations/imap', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const body = req.body ?? {};
        const updates: Record<string, string | number | boolean | null> = {};

        const nullableString = (v: unknown): string | null | undefined => {
            if (v === undefined) return undefined;
            if (v === null) return null;
            if (typeof v !== 'string') return undefined;
            const trimmed = v.trim();
            return trimmed === '' ? null : trimmed;
        };

        const host = nullableString(body.host);
        if (host !== undefined) updates.imap_host = host;
        const user = nullableString(body.user);
        if (user !== undefined) updates.imap_user = user;
        if (body.password !== undefined) {
            if (body.password === null || (typeof body.password === 'string' && body.password === '')) {
                updates.imap_password = null;
            } else if (typeof body.password === 'string') {
                updates.imap_password = body.password;
            }
        }
        if (body.port !== undefined) {
            if (body.port === null || body.port === '') {
                updates.imap_port = null;
            } else {
                const n = Number(body.port);
                if (!Number.isInteger(n) || n < 1 || n > 65535) {
                    return res.status(400).json({ error: 'invalid_port' });
                }
                updates.imap_port = n;
            }
        }
        if (body.secure !== undefined) {
            if (typeof body.secure !== 'boolean') {
                return res.status(400).json({ error: 'invalid_secure' });
            }
            updates.imap_secure = body.secure;
        }
        if (body.enabled !== undefined) {
            if (typeof body.enabled !== 'boolean') {
                return res.status(400).json({ error: 'invalid_enabled' });
            }
            updates.imap_enabled = body.enabled;
        }
        // Manual reset of the watermark — useful when the operator wants to
        // reingest the inbox after a bad match run.
        if (body.reset_last_seen_uid === true) {
            updates.imap_last_seen_uid = null;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'no_updates' });
        }

        const providedCols = Object.keys(updates);
        const providedVals = providedCols.map(c => updates[c]);
        const userId = req.user?.userId ?? null;

        const insertCols = ['provider', ...providedCols, 'updated_by_user_id', 'updated_at'];
        const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
        const insertValues = ['smtp', ...providedVals, userId, new Date()];
        const updateSet = [
            ...providedCols.map((c, i) => `${c} = $${i + 2}`),
            `updated_by_user_id = $${providedCols.length + 2}`,
            `updated_at = CURRENT_TIMESTAMP`,
        ].join(', ');

        await queryWithRetry(
            `INSERT INTO integration_settings (${insertCols.join(', ')})
             VALUES (${insertPlaceholders})
             ON CONFLICT (provider) DO UPDATE SET ${updateSet}`,
            insertValues
        );

        invalidateImapConfigCache();

        // Restart the listener so credentials / enabled toggle take effect
        // right away. Fire-and-forget: HTTP response should not block on the
        // IMAP handshake, which can be slow.
        restartImapInboundService().catch((err) => {
            console.error('[IMAP] restart after update failed:', err?.message || err);
        });

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.SETTINGS,
                undefined,
                `Configurazione IMAP aggiornata`
            );
        }

        const status = await getImapConfigStatus();
        res.json({ ...status, updated_at: new Date().toISOString(), updated_by: req.user?.email ?? null });
    } catch (err: any) {
        console.error('PUT /settings/integrations/imap error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.post('/settings/integrations/imap/test', authenticate, requirePermission('settings:full'), async (_req, res) => {
    try {
        const verify = await verifyImapConnection();
        if (!verify.ok) {
            console.warn('[IMAP] verify failed:', verify.error);
            return res.status(400).json({ error: verify.error || 'Verifica IMAP fallita' });
        }
        res.json({ success: true });
    } catch (err: any) {
        console.error('POST /settings/integrations/imap/test error:', err);
        res.status(500).json({ error: err?.message || 'Test IMAP fallito' });
    }
});

// ============================================
// AUTO-DEPOSIT POLICY (public web bookings)
// ============================================
// Stored on the Revolut integration row (historically the only gateway);
// exposed here as a dedicated endpoint so the Settings UI can surface the
// feature under "Opzioni prenotazioni" rather than buried in an integration
// card. The policy is provider-independent — the deposit link is created with
// whichever gateway is active — so readiness is reported for that one, under
// the original `revolut_configured` key so existing clients keep working.
// GET is auth-only so any operator can read the current policy; PUT requires
// settings:full because the setting affects customer-facing charges.
app.get('/settings/auto-deposit', authenticate, async (_req, res) => {
    try {
        const activeProvider = await getActivePaymentProvider();
        const paymentConfigured = await isProviderConfigured(activeProvider);
        const row = await queryWithRetry(
            `SELECT auto_deposit_enabled, auto_deposit_min_guests
               FROM integration_settings WHERE provider = 'revolut'`
        );
        const r = row.rows[0];
        res.json({
            enabled: Boolean(r?.auto_deposit_enabled),
            min_guests: Number.isInteger(Number(r?.auto_deposit_min_guests))
                ? Number(r.auto_deposit_min_guests)
                : 9,
            revolut_configured: paymentConfigured,
            payment_configured: paymentConfigured,
            active_provider: activeProvider,
            active_provider_label: providerLabel(activeProvider),
        });
    } catch (err: any) {
        console.error('GET /settings/auto-deposit error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.put('/settings/auto-deposit', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const body = req.body ?? {};
        const updates: Array<{ col: string; val: boolean | number }> = [];
        if (body.enabled !== undefined) {
            if (typeof body.enabled !== 'boolean') {
                return res.status(400).json({ error: 'invalid_enabled' });
            }
            updates.push({ col: 'auto_deposit_enabled', val: body.enabled });
        }
        if (body.min_guests !== undefined) {
            const n = Number(body.min_guests);
            if (!Number.isInteger(n) || n < 1 || n > 100) {
                return res.status(400).json({ error: 'invalid_min_guests' });
            }
            updates.push({ col: 'auto_deposit_min_guests', val: n });
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'no_updates' });
        }

        // UPSERT so the first save works even when the Revolut row doesn't
        // exist yet (e.g. auto-deposit configured before credentials).
        const cols = ['provider', ...updates.map(u => u.col), 'updated_by_user_id', 'updated_at'];
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const values: any[] = ['revolut', ...updates.map(u => u.val), req.user?.userId ?? null, new Date()];
        const updateSet = [
            ...updates.map((u, i) => `${u.col} = $${i + 2}`),
            `updated_by_user_id = $${updates.length + 2}`,
            `updated_at = CURRENT_TIMESTAMP`,
        ].join(', ');
        await queryWithRetry(
            `INSERT INTO integration_settings (${cols.join(', ')})
             VALUES (${placeholders})
             ON CONFLICT (provider) DO UPDATE SET ${updateSet}`,
            values
        );

        if (req.user) {
            LogService.logActivity(
                req.user.userId,
                req.user.email,
                req.user.email,
                ActivityAction.UPDATE,
                ResourceType.SETTINGS,
                undefined,
                `Caparra automatica aggiornata`
            );
        }

        const activeProvider = await getActivePaymentProvider();
        const paymentConfigured = await isProviderConfigured(activeProvider);
        const after = await queryWithRetry(
            `SELECT auto_deposit_enabled, auto_deposit_min_guests
               FROM integration_settings WHERE provider = 'revolut'`
        );
        const r = after.rows[0] || {};
        res.json({
            enabled: Boolean(r.auto_deposit_enabled),
            min_guests: Number.isInteger(Number(r.auto_deposit_min_guests))
                ? Number(r.auto_deposit_min_guests)
                : 9,
            revolut_configured: paymentConfigured,
            payment_configured: paymentConfigured,
            active_provider: activeProvider,
            active_provider_label: providerLabel(activeProvider),
        });
    } catch (err: any) {
        console.error('PUT /settings/auto-deposit error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// ============================================
// RESERVATION NOTE PRESETS (quick-notes chips)
// ============================================
// GET is authenticated but not permission-gated — every operator that can
// see the reservation modal needs to render the chip list. PUT is admin-only
// (settings:full) and replaces the full list in one shot so we don't have to
// track per-item CRUD/ordering.
app.get('/settings/reservation-notes', authenticate, async (_req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT id, label, icon FROM reservation_note_presets ORDER BY sort_order ASC, id ASC`
        );
        res.json(result.rows.map((r: any) => ({ id: r.id, label: r.label, icon: r.icon || null })));
    } catch (err) {
        console.error('Error fetching reservation note presets:', err);
        res.status(500).json({ error: 'Failed to fetch reservation note presets' });
    }
});

// Same pattern as reservation-notes but without an icon column. Kept as two
// separate endpoints (rather than a generic /settings/presets/:kind) so the
// permission surface and payload shape stay explicit — allergens have their
// own semantics (uniform amber pill on the card) and shouldn't accidentally
// grow icon support just because the notes endpoint does.
app.get('/settings/reservation-allergens', authenticate, async (_req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT id, label FROM reservation_allergen_presets ORDER BY sort_order ASC, id ASC`
        );
        res.json(result.rows.map((r: any) => ({ id: r.id, label: r.label })));
    } catch (err) {
        console.error('Error fetching reservation allergen presets:', err);
        res.status(500).json({ error: 'Failed to fetch reservation allergen presets' });
    }
});

app.put('/settings/reservation-allergens', authenticate, requirePermission('settings:full'), async (req, res) => {
    const body = req.body ?? {};
    const rawLabels = Array.isArray(body.labels) ? body.labels : null;
    if (!rawLabels) {
        return res.status(400).json({ error: 'invalid_body', message: 'labels must be an array of strings' });
    }
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawLabels) {
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (trimmed.length > 80) {
            return res.status(400).json({ error: 'label_too_long', message: `Intolleranza "${trimmed.slice(0, 20)}…" supera 80 caratteri` });
        }
        const dedupKey = trimmed.toLowerCase();
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        cleaned.push(trimmed);
    }
    if (cleaned.length > 30) {
        return res.status(400).json({ error: 'too_many_labels', message: 'Massimo 30 intolleranze.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM reservation_allergen_presets');
        for (let i = 0; i < cleaned.length; i++) {
            await client.query(
                `INSERT INTO reservation_allergen_presets (label, sort_order) VALUES ($1, $2)`,
                [cleaned[i], (i + 1) * 10]
            );
        }
        await client.query('COMMIT');
        const result = await queryWithRetry(
            `SELECT id, label FROM reservation_allergen_presets ORDER BY sort_order ASC, id ASC`
        );
        res.json(result.rows.map((r: any) => ({ id: r.id, label: r.label })));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error updating reservation allergen presets:', err);
        res.status(500).json({ error: 'Failed to update reservation allergen presets' });
    } finally {
        client.release();
    }
});

app.put('/settings/reservation-notes', authenticate, requirePermission('settings:full'), async (req, res) => {
    const body = req.body ?? {};
    // Accept either the legacy shape { labels: string[] } or the richer
    // { items: { label, icon? }[] }. The legacy branch keeps older clients
    // working while frontends roll out the icon picker.
    const rawItems: Array<{ label: any; icon?: any }> | null = Array.isArray(body.items)
        ? body.items
        : Array.isArray(body.labels)
            ? body.labels.map((l: any) => ({ label: l }))
            : null;
    if (!rawItems) {
        return res.status(400).json({ error: 'invalid_body', message: 'items or labels required' });
    }
    const cleaned: Array<{ label: string; icon: string | null }> = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
        if (!raw || typeof raw.label !== 'string') continue;
        const trimmed = raw.label.trim();
        if (!trimmed) continue;
        if (trimmed.length > 80) {
            return res.status(400).json({ error: 'label_too_long', message: `Nota "${trimmed.slice(0, 20)}…" supera 80 caratteri` });
        }
        const dedupKey = trimmed.toLowerCase();
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        // Icon is free-form (validated on the client against the whitelist);
        // we just clamp length and reject non-strings.
        let icon: string | null = null;
        if (typeof raw.icon === 'string' && raw.icon.trim()) {
            const t = raw.icon.trim();
            if (t.length > 40) {
                return res.status(400).json({ error: 'icon_too_long', message: 'Icona non valida' });
            }
            icon = t;
        }
        cleaned.push({ label: trimmed, icon });
    }
    if (cleaned.length > 30) {
        return res.status(400).json({ error: 'too_many_labels', message: 'Massimo 30 note.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM reservation_note_presets');
        for (let i = 0; i < cleaned.length; i++) {
            await client.query(
                `INSERT INTO reservation_note_presets (label, sort_order, icon) VALUES ($1, $2, $3)`,
                [cleaned[i].label, (i + 1) * 10, cleaned[i].icon]
            );
        }
        await client.query('COMMIT');
        const result = await queryWithRetry(
            `SELECT id, label, icon FROM reservation_note_presets ORDER BY sort_order ASC, id ASC`
        );
        res.json(result.rows.map((r: any) => ({ id: r.id, label: r.label, icon: r.icon || null })));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error updating reservation note presets:', err);
        res.status(500).json({ error: 'Failed to update reservation note presets' });
    } finally {
        client.release();
    }
});

// ============================================
// PUBLIC BOOKING (Google Business link)
// ============================================
// Unauthenticated endpoints powering the /prenota mobile page. Two safeguards
// against abuse:
//   - express-rate-limit caps each IP to 5 reservation POSTs per minute
//   - a hidden honeypot field (`website`) — bots fill every field, humans don't
// Submissions always land as source=GOOGLE + reservation_status=PENDING so staff
// review them before they become confirmed bookings.

const publicBookingLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Troppe richieste, riprova tra qualche minuto.' },
});

app.get('/public/availability', async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'invalid_date', message: 'date deve essere YYYY-MM-DD' });
    }

    try {
        const [lunchSlotsRaw, dinnerSlotsRaw, blocks] = await Promise.all([
            getAvailableSlots(date, Shift.LUNCH),
            getAvailableSlots(date, Shift.DINNER),
            getPublicBookingBlocks(),
        ]);
        // Empty a shift's slot list if the operator has blocked it — the
        // public form treats "no slots" as "not bookable", so nothing else
        // needs to know about blocks.
        const lunchSlots = isPublicBookingBlocked(date, Shift.LUNCH as any, blocks) ? [] : lunchSlotsRaw;
        const dinnerSlots = isPublicBookingBlocked(date, Shift.DINNER as any, blocks) ? [] : dinnerSlotsRaw;

        // Drop past slots when the requested date is today (Europe/Rome).
        const now = new Date();
        const todayIso = now.toISOString().slice(0, 10);
        const isToday = date === todayIso;
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const filterFuture = (slots: string[]) => {
            if (!isToday) return slots;
            return slots.filter(s => {
                const [h, m] = s.split(':').map(Number);
                return h * 60 + m > currentMinutes;
            });
        };

        res.json({
            date,
            lunch:  { slots: filterFuture(lunchSlots) },
            dinner: { slots: filterFuture(dinnerSlots) },
        });
    } catch (err: any) {
        console.error('GET /public/availability error:', err);
        res.status(500).json({ error: 'Failed to load availability' });
    }
});

app.get('/public/rooms', async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const shift = typeof req.query.shift === 'string' ? req.query.shift : '';
    const guests = Number(req.query.guests);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'invalid_date', message: 'date deve essere YYYY-MM-DD' });
    }
    if (shift !== Shift.LUNCH && shift !== Shift.DINNER) {
        return res.status(400).json({ error: 'invalid_shift', message: 'shift deve essere LUNCH o DINNER' });
    }
    if (!Number.isFinite(guests) || guests < 1 || guests > 20) {
        return res.status(400).json({ error: 'invalid_guests', message: 'guests deve essere 1-20' });
    }

    try {
        // Stessa definizione di "tavolo assegnabile" usata dall'assegnazione
        // automatica: una sala compare solo se ha davvero qualcosa da dare.
        const rooms = await listBookableRooms(date, shift as Shift, guests);
        res.json({ rooms });
    } catch (err: any) {
        console.error('GET /public/rooms error:', err);
        res.status(500).json({ error: 'Failed to load rooms' });
    }
});

// Surfaces the restaurant's reachable phone number (the Vonage DID bound to
// the ElevenLabs SIP trunk) and the public-bookings feature flag to the
// /prenota page. Lets us swap the DID at porting time via VONAGE_VOICE_NUMBER
// and pause/resume web bookings from Settings, no HTML edit needed.
app.get('/public/contact', async (_req, res) => {
    const bookingsEnabled = await getFeatureFlag('public_bookings_enabled', false);
    const raw = (process.env.VONAGE_VOICE_NUMBER || '').replace(/[^\d+]/g, '');
    let voice: { phone: string; display: string } | null = null;
    if (raw) {
        const e164 = raw.startsWith('+') ? raw : `+${raw}`;
        const rest = e164.slice(3);
        let display = e164;
        if (e164.startsWith('+39') && rest.length >= 9) {
            display = `+39 ${rest.slice(0, 3)} ${rest.slice(3)}`;
        } else if (e164.startsWith('+44') && rest.length >= 10) {
            display = `+44 ${rest.slice(0, 4)} ${rest.slice(4)}`;
        }
        voice = { phone: e164, display };
    }
    res.json({ voice, bookingsEnabled });
});

// Maintenance message used by both the public form and the API safety net.
const PUBLIC_BOOKINGS_DISABLED_MESSAGE = 'Le prenotazioni web non sono disponibili al momento.';
const VOICE_AGENT_DISABLED_MESSAGE = 'Le prenotazioni telefoniche non sono disponibili al momento.';
// Tool-side safety net when voice_bookings_suspended is on: if Sofia calls a
// booking tool anyway, we refuse and hand back a message the agent can read
// aloud verbatim. The callback time is looked up at call time so the message
// stays in sync with the /settings/channels config without a redeploy.
const buildVoiceSuspensionMessage = (callbackTime: string) =>
    `Le prenotazioni sono momentaneamente sospese. Richiami dopo le ${callbackTime} per verificare eventuali tavoli disponibili.`;

app.post('/public/reservations', publicBookingLimiter, async (req, res) => {
    if (!(await getFeatureFlag('public_bookings_enabled', false))) {
        return res.status(503).json({ error: 'bookings_disabled', message: PUBLIC_BOOKINGS_DISABLED_MESSAGE });
    }
    try {
        const body = req.body ?? {};

        // Honeypot — if the hidden field is populated we silently accept and drop.
        if (typeof body.website === 'string' && body.website.trim().length > 0) {
            console.warn('[public-booking] honeypot triggered', { ip: req.ip });
            return res.status(201).json({ ok: true });
        }

        const customer_name = typeof body.customer_name === 'string' ? normalizeCustomerName(body.customer_name.trim()) : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const date = typeof body.date === 'string' ? body.date : '';
        const time = typeof body.time === 'string' ? body.time : '';
        const shift = body.shift;
        const guestsNum = Number(body.guests);
        const notesRaw = typeof body.notes === 'string' ? body.notes.trim() : '';
        const roomIdRaw = body.room_id;
        const requestedRoomId = (roomIdRaw === null || roomIdRaw === undefined || roomIdRaw === '')
            ? null
            : Number(roomIdRaw);

        if (!customer_name || customer_name.length < 2 || customer_name.length > 80) {
            return res.status(400).json({ error: 'invalid_name', message: 'Nome non valido' });
        }
        if (!phone && !email) {
            return res.status(400).json({ error: 'missing_contact', message: 'Inserisci almeno un contatto: telefono o email' });
        }
        if (phone && !/^\+?[0-9 ]{6,20}$/.test(phone)) {
            return res.status(400).json({ error: 'invalid_phone', message: 'Numero di telefono non valido' });
        }
        if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
            return res.status(400).json({ error: 'invalid_email', message: 'Indirizzo email non valido' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'invalid_date', message: 'Data non valida' });
        }
        if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
            return res.status(400).json({ error: 'invalid_time', message: 'Orario non valido' });
        }
        if (shift !== Shift.LUNCH && shift !== Shift.DINNER) {
            return res.status(400).json({ error: 'invalid_shift', message: 'Turno non valido' });
        }
        if (!Number.isFinite(guestsNum) || guestsNum < 1 || guestsNum > 20) {
            return res.status(400).json({ error: 'invalid_guests', message: 'Numero ospiti non valido' });
        }

        // Operator-defined blocks for (date, shift) — takes precedence over
        // the availability grid so we refuse even if a slot happens to be
        // free. Prevents a race between the /public/availability call and
        // this create when the operator adds the block in between.
        const blocks = await getPublicBookingBlocks();
        if (isPublicBookingBlocked(date, shift as any, blocks)) {
            const isFullDay = blocks.some(b => b.date === date && b.shift === 'ALL');
            const scope = isFullDay ? 'per questa data' : (shift === Shift.LUNCH ? 'per il pranzo di questa data' : 'per la cena di questa data');
            return res.status(503).json({
                error: 'date_blocked',
                message: `Le prenotazioni web sono chiuse ${scope}. La preghiamo di chiamarci al telefono.`,
            });
        }

        // Confirm the requested slot is on the current grid for that date+shift.
        const validSlots = await getAvailableSlots(date, shift as Shift);
        if (!validSlots.includes(time)) {
            return res.status(409).json({ error: 'slot_unavailable', message: 'Lo slot scelto non è più disponibile' });
        }

        // Resolve the requested room name (if any) so the staff sees the
        // preference in the notes column without needing extra joins. Reject
        // rooms closed globally OR overridden as closed for this (date, shift).
        let requestedRoomName: string | null = null;
        if (requestedRoomId && Number.isFinite(requestedRoomId)) {
            const roomRes = await queryWithRetry(
                `SELECT name FROM rooms
                 WHERE id = $1
                   AND is_closed = false
                   AND id NOT IN (
                       SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3
                   )`,
                [requestedRoomId, date, shift]
            );
            if (roomRes.rows[0]) {
                requestedRoomName = roomRes.rows[0].name;
            } else {
                return res.status(409).json({ error: 'room_unavailable', message: 'La sala scelta non è disponibile per il turno selezionato' });
            }
        }

        // Normalize phone to E.164 if it starts with a leading 3 (IT mobile) and no +.
        // Nullable — email-only bookings skip normalization entirely.
        const phoneE164 = phone
            ? (phone.startsWith('+')
                ? phone.replace(/\s/g, '')
                : phone.replace(/\D/g, '').replace(/^3/, '+393').slice(0, 13))
            : null;
        const emailNormalized = email ? email.toLowerCase() : null;

        const reservation_time = `${date}T${time}:00`;
        const userNote = notesRaw ? notesRaw.slice(0, 500) : '';
        const noteParts = ['[Web]'];
        if (requestedRoomName) noteParts.push(`Sala richiesta: ${requestedRoomName}.`);
        noteParts.push(userNote || 'Richiesta prenotazione dal sito');
        const notes = noteParts.join(' ');

        // A guest who lists an allergy/intolerance on the public form is
        // volunteering their own health data — that submission IS the consent
        // (art. 9.2.a). Record it so the CRM shows the booking as consented
        // without staff having to tick a box the customer already implied.
        const hasHealthData = /(Allergie|Intolleranze):/i.test(notes);
        const consentHealth = hasHealthData ? true : null;
        const consentUpdatedAt = hasHealthData ? new Date().toISOString() : null;

        // Caparra automatica: letta PRIMA dell'inserimento perché decide anche
        // se la prenotazione può essere confermata subito. Finché la caparra
        // non è pagata il tavolo non è garantito, quindi in quel caso la
        // richiesta resta PENDING e la conferma arriva col pagamento.
        let autoDepositEnabled = false;
        let autoDepositMinGuests = 9;
        try {
            const cfgRow = await queryWithRetry(
                `SELECT auto_deposit_enabled, auto_deposit_min_guests
                   FROM integration_settings WHERE provider = 'revolut'`
            );
            if (cfgRow.rows[0]) {
                autoDepositEnabled = Boolean(cfgRow.rows[0].auto_deposit_enabled);
                const n = Number(cfgRow.rows[0].auto_deposit_min_guests);
                if (Number.isInteger(n) && n >= 1) autoDepositMinGuests = n;
            }
        } catch (err) {
            console.warn('[public-booking] auto-deposit config lookup failed:', (err as any)?.message || err);
        }
        const depositRequired = autoDepositEnabled
            && guestsNum >= autoDepositMinGuests
            && (await isPaymentConfigured());

        // Conferma automatica: se la sala è ancora sotto il proprio limite di
        // occupazione assegniamo il tavolo e confermiamo subito; se il limite
        // è già stato superato (o non c'è un tavolo libero) la richiesta resta
        // PENDING e la conferma lo staff, come prima. Con una sala richiesta
        // cerchiamo solo lì — dirottare il cliente in un'altra sala senza
        // dirglielo sarebbe peggio di farlo confermare a mano.
        let autoTable: Awaited<ReturnType<typeof pickSelfServiceTable>> = null;
        if (!depositRequired) {
            try {
                autoTable = await pickSelfServiceTable(date, shift as Shift, Math.trunc(guestsNum), {
                    roomId: requestedRoomId && Number.isFinite(requestedRoomId) ? Math.trunc(requestedRoomId) : null,
                });
            } catch (err) {
                // Un errore qui non deve far perdere la prenotazione: si
                // degrada al flusso manuale di sempre.
                console.error('[public-booking] auto-assign lookup failed:', (err as any)?.message || err);
            }
        }
        const autoConfirmed = autoTable !== null;

        const result = await queryWithRetry(
            `INSERT INTO reservations (
                customer_name, reservation_time, shift, guests, children,
                table_id, notes, email, phone, payment_status, arrival_status,
                reservation_status, source, requires_review,
                consent_data_health, consent_updated_at
            )
            VALUES ($1, $2, $3, $4, 0, $10, $5, $6, $7, 'PENDING', 'WAITING', $11, 'GOOGLE', $12, $8, $9)
            RETURNING *`,
            [customer_name, reservation_time, shift, Math.trunc(guestsNum), notes, emailNormalized, phoneE164,
             consentHealth, consentUpdatedAt,
             autoTable?.id ?? null,
             autoConfirmed ? 'CONFIRMED' : 'PENDING',
             !autoConfirmed]
        );
        const created = result.rows[0];

        // Guardia anti-doppia-assegnazione: pick e INSERT non sono atomici,
        // quindi due richieste simultanee possono scegliere lo stesso tavolo.
        // Se succede molliamo il tavolo e torniamo al flusso manuale: meglio
        // una conferma in meno che due clienti sullo stesso tavolo.
        if (autoConfirmed && autoTable) {
            const clash = await findTableConflicts(date, shift as string, [autoTable.id], {
                excludeReservationId: created.id,
            });
            if (clash.length > 0) {
                console.warn('[public-booking] auto-assign race, reverting to manual review', {
                    reservation_id: created.id, table_id: autoTable.id,
                });
                const reverted = await queryWithRetry(
                    `UPDATE reservations
                     SET table_id = NULL, reservation_status = 'PENDING', requires_review = true
                     WHERE id = $1 RETURNING *`,
                    [created.id]
                );
                Object.assign(created, reverted.rows[0]);
                autoTable = null;
            }
        }
        // Da qui in poi conta lo stato effettivamente salvato.
        const confirmedNow = created.reservation_status === 'CONFIRMED';

        // Auto-save the booker into the rubrica so the contact appears even if
        // staff never edit this booking from the internal app. Skipped for
        // email-only bookings — upsertCustomerFromReservation early-returns
        // without a phone.
        await upsertCustomerFromReservation(customer_name, phoneE164, emailNormalized, null);

        // Notify staff dashboards in real time.
        if (socketService) {
            try { socketService.broadcastReservationCreated(created); }
            catch (err) { console.warn('[public-booking] socket broadcast failed:', err); }
        }
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                category: 'reservation',
                title: confirmedNow ? 'Prenotazione web confermata' : 'Nuova richiesta prenotazione',
                body: `${toTitleCase(customer_name)} · ${guestsNum} ospiti · ${date} ${time}`,
                url: `/?view=RESERVATIONS&reservationId=${created.id}`,
                tag: `pending-${created.id}`,
            }
        ).catch(err => console.error('Push (public booking) failed:', err));

        // Fire-and-forget acknowledgement to the customer: "confermata" quando
        // il tavolo è stato assegnato in automatico, "richiesta ricevuta"
        // quando tocca allo staff.
        // Channel priority: Twilio SMS (while Meta verification is pending) →
        // Meta WhatsApp template → generic WhatsApp text fallback.
        const [yyyy, mm, dd] = date.split('-');
        const dateLabel = `${dd}/${mm}/${yyyy}`;
        const guestsLabel = `${guestsNum} ${guestsNum === 1 ? 'persona' : 'persone'}`;
        // Sala, mai il tavolo: il numero di tavolo è un dato operativo, lo
        // staff lo sposta di continuo e comunicarlo al cliente crea solo
        // aspettative da smentire all'arrivo.
        const ackRoomName = autoTable?.room_name ?? requestedRoomName;

        // Large web bookings require a €10/person deposit before the table
        // is guaranteed. The enabled toggle and guest threshold live on the
        // Revolut integration row (Settings → Integrazioni → Revolut) — the
        // policy is shared, the charge itself goes through whichever gateway
        // is active. We create the order synchronously so we can include the
        // checkout link in the ack. On any gateway failure we silently
        // degrade to the plain "richiesta ricevuta" flow — staff will then
        // confirm manually.
        let depositCheckoutUrl: string | null = null;
        let depositAmountCents = 0;
        if (depositRequired) {
            depositAmountCents = guestsNum * 1000; // €10 per person, in cents
            const orderDescription = `Caparra prenotazione #${created.id} - ${guestsLabel} ${dateLabel} ${time}`;
            try {
                const order = await createPaymentOrder({
                    amount: depositAmountCents,
                    currency: 'EUR',
                    description: orderDescription,
                    reference: `reservation:${created.id}`,
                });
                const insertedPayment = await queryWithRetry(
                    `INSERT INTO payment_requests
                        (reservation_id, amount_cents, currency, description, status, provider,
                         provider_order_id, checkout_url, metadata)
                     VALUES ($1, $2, 'EUR', $3, $4, $5, $6, $7, $8)
                     RETURNING *`,
                    [
                        created.id,
                        depositAmountCents,
                        orderDescription,
                        order.status,
                        order.provider,
                        order.id,
                        order.checkoutUrl,
                        JSON.stringify({ ...order.metadata, source: 'public_booking_auto_deposit' }),
                    ]
                );
                depositCheckoutUrl = order.checkoutUrl;
                try { socketService?.broadcastToAll('paymentRequest:created', insertedPayment.rows[0]); }
                catch (err) { console.warn('[public-booking] payment socket broadcast failed:', err); }
            } catch (err: any) {
                console.error('[public-booking] deposit link creation failed:', err?.message || err);
                depositAmountCents = 0;
            }
        }

        const ackText = depositCheckoutUrl
            ? buildDepositRequestMessage(
                toTitleCase(customer_name),
                guestsLabel,
                dateLabel,
                time,
                depositAmountCents,
                depositCheckoutUrl
              )
            : confirmedNow
                ? buildConfirmationMessage(customer_name, created.reservation_time, guestsNum, ackRoomName)
                : `Ciao ${toTitleCase(customer_name)}, abbiamo ricevuto la tua richiesta di prenotazione per ${guestsLabel} il ${dateLabel} alle ${time}. Ti ricontatteremo a breve per confermarla. Grazie!`;

        // Pick the right WA template for the branch. When either env var is
        // unset, or the deposit token can't be parsed, waTemplate stays
        // undefined and sendBookingConfirmation falls back to plain SMS.
        let waTemplate: WhatsAppTemplateOpts | undefined;
        if (depositCheckoutUrl) {
            waTemplate = buildBookingDepositRequestTemplate(
                toTitleCase(customer_name),
                guestsLabel,
                dateLabel,
                time,
                depositAmountCents,
                depositCheckoutUrl
            );
        } else if (confirmedNow) {
            waTemplate = buildBookingConfirmedTemplate(customer_name, created.reservation_time, guestsNum);
        } else {
            const bookingReceivedSid = process.env.TWILIO_WA_CONTENT_SID_BOOKING_RECEIVED;
            if (bookingReceivedSid) {
                waTemplate = {
                    contentSid: bookingReceivedSid,
                    contentVariables: {
                        '1': toTitleCase(customer_name),
                        '2': guestsLabel,
                        '3': dateLabel,
                        '4': time,
                    },
                };
            }
        }

        // SMS/WhatsApp ack — only if the guest gave us a phone number.
        if (phoneE164) {
            sendBookingConfirmation(phoneE164, ackText, created.id, { whatsappTemplate: waTemplate }).catch(err =>
                console.error('[public-booking] confirmation send failed:', err?.message || err)
            );
        }

        // Email ack — fire-and-forget. Requires an email on the booking and a
        // configured provider (SMTP or Resend). Failures are logged into
        // outbound_messages just like the manual /confirm-email endpoint so
        // staff can see them in the reservation card timeline.
        if (emailNormalized) {
            (async () => {
                try {
                    if (!(await isSmtpConfigured())) return;
                    const emailStatus = await getSmtpConfigStatus().catch(() => null);
                    const emailProvider: 'smtp' | 'resend' = emailStatus?.provider === 'resend' ? 'resend' : 'smtp';
                    const { subject, text, html } = confirmedNow
                        ? buildBookingConfirmationEmail({
                            customerName: toTitleCase(customer_name),
                            reservationTime: created.reservation_time,
                            guests: guestsNum,
                            roomName: ackRoomName,
                          })
                        : buildBookingRequestEmail({
                            customerName: toTitleCase(customer_name),
                            reservationTime: reservation_time,
                            guests: guestsNum,
                            roomName: requestedRoomName,
                            notes: userNote,
                          });
                    try {
                        const sent = await sendMail({ to: emailNormalized, subject, text, html });
                        await logOutboundEmail({
                            provider: emailProvider,
                            to: emailNormalized,
                            subject,
                            body: text,
                            messageId: sent.messageId || null,
                            reservationId: created.id,
                        });
                    } catch (sendErr: any) {
                        await logOutboundEmail({
                            provider: emailProvider,
                            to: emailNormalized,
                            subject,
                            body: text,
                            reservationId: created.id,
                            errorMessage: sendErr?.message || String(sendErr),
                        });
                        throw sendErr;
                    }
                } catch (err: any) {
                    console.error('[public-booking] email ack failed:', err?.message || err);
                }
            })();
        }

        // `confirmed` pilota il testo della schermata finale del form. `room`
        // è il nome della sala (mai il tavolo: vedi ackRoomName).
        res.status(201).json({ ok: true, id: created.id, confirmed: confirmedNow, room: ackRoomName || null });
    } catch (err: any) {
        console.error('POST /public/reservations error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

app.get('/prenota', (_req, res) => {
    // Force browsers to fetch a fresh copy on every visit. `no-cache` was
    // theoretically enough (requires revalidation) but in practice Safari
    // and iOS webviews still served stale HTML after a deploy — customer
    // sees a form/label that no longer exists on the backend. `no-store`
    // forbids caching entirely and closes the loophole.
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(path.join(process.cwd(), 'public', 'prenota.html'));
});

// Public privacy notice (informativa) linked from the /prenota form. Built from
// the legal settings so the restaurant edits it in one place (Impostazioni →
// Legale) without touching HTML. Covers the personal data — and the special
// category health data (allergies) — collected by the booking form.
app.get(['/privacy', '/informativa-privacy'], async (_req, res) => {
    try {
        const c = await getLegalConfig();
        const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
        const ph = (v: unknown, fallback: string): string => {
            const s = String(v ?? '').trim();
            return s ? esc(s) : `<span style="color:#a8a29e">[${esc(fallback)}]</span>`;
        };
        const adv = c.legal_mode !== 'simple';
        const company = ph(c.company_name, 'Ragione sociale');
        const dpo = String(c.dpo_name ?? '').trim()
            ? `<p><strong>Responsabile della protezione dei dati (DPO):</strong> ${esc(c.dpo_name)}${String(c.dpo_contact ?? '').trim() ? ` — ${esc(c.dpo_contact)}` : ''}</p>`
            : '';
        const processors = String(c.data_processors ?? '').trim()
            ? String(c.data_processors).trim().split('\n').map(l => `<li>${esc(l.trim())}</li>`).join('')
            : '<li style="color:#a8a29e">[Fornitori: hosting, assistente vocale, messaggistica, provider e-mail…]</li>';
        const extraEu = String(c.extra_eu_note ?? '').trim()
            ? esc(c.extra_eu_note)
            : 'Alcuni fornitori possono trattare i dati fuori dallo Spazio Economico Europeo (anche negli USA), sulla base di garanzie adeguate ex artt. 44 ss. GDPR (Data Privacy Framework UE-USA o Clausole Contrattuali Standard).';
        const html = `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Informativa sulla privacy — ${company}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#fbf9f4; color:#292524; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.65; }
  .wrap { max-width:720px; margin:0 auto; padding:40px 22px 80px; }
  h1 { font-family:Georgia,"Times New Roman",serif; font-size:26px; font-weight:600; margin:0 0 6px; }
  .sub { color:#78716c; font-size:13px; margin:0 0 28px; }
  h2 { font-size:15px; font-weight:700; margin:28px 0 8px; color:#78350f; }
  p, li { font-size:14.5px; }
  ul { padding-left:20px; margin:8px 0; }
  a { color:#92400e; }
  .card { background:#fff; border:1px solid #e7e5e4; border-radius:16px; padding:20px 22px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  .back { display:inline-block; margin-bottom:20px; font-size:14px; color:#92400e; text-decoration:none; }
  footer { margin-top:32px; font-size:12px; color:#a8a29e; }
</style></head><body><div class="wrap">
  <a class="back" href="/prenota">← Torna alla prenotazione</a>
  <div class="card">
    <h1>Informativa sul trattamento dei dati personali</h1>
    <p class="sub">Clienti e prenotazioni · resa ai sensi degli artt. 13-14 del Reg. (UE) 2016/679 (GDPR)</p>

    <h2>1. Titolare del trattamento</h2>
    <p>${company}${String(c.company_address ?? '').trim() ? ` — ${esc(c.company_address)}` : ''}${String(c.vat_number ?? '').trim() ? ` — P.IVA ${esc(c.vat_number)}` : ''}.<br>
    Contatti privacy: ${ph(c.privacy_email, 'e-mail privacy')}${String(c.privacy_phone ?? '').trim() ? ` — ${esc(c.privacy_phone)}` : ''}.</p>
    ${dpo}

    <h2>2. Categorie di dati trattati</h2>
    <ul>
      <li>Dati identificativi e di contatto: nome, telefono, e-mail.</li>
      <li>Dati della prenotazione: data, orario, numero di ospiti, sala, note.</li>
      <li><strong>Dati relativi alla salute</strong> (categoria particolare, art. 9 GDPR): <strong>allergie e intolleranze</strong>, conferiti volontariamente per la sicurezza alimentare.</li>
    </ul>

    <h2>3. Finalità e base giuridica</h2>
    <ul>
      <li>Gestione della prenotazione e del servizio — esecuzione del contratto (art. 6.1.b).</li>
      <li>Trattamento di allergie/intolleranze — consenso esplicito, prestato conferendo volontariamente il dato (art. 9.2.a).</li>
      <li>Conferme e promemoria di prenotazione — esecuzione del contratto (art. 6.1.b).</li>
      ${adv ? '<li>Eventuali comunicazioni commerciali — solo previo consenso, revocabile (art. 6.1.a).</li>' : ''}
      <li>Adempimenti di legge (fiscali/contabili) — obbligo legale (art. 6.1.c).</li>
    </ul>

    <h2>4. Natura del conferimento</h2>
    <p>Il conferimento dei dati di contatto è necessario per gestire la prenotazione. I dati su allergie/intolleranze sono facoltativi: il rifiuto non pregiudica la prenotazione ma può limitare la gestione della sicurezza alimentare.</p>

    <h2>5. Destinatari</h2>
    <p>I dati possono essere trattati, per conto del Titolare e sulla base di accordi ex art. 28 GDPR, da fornitori di servizi:</p>
    <ul>${processors}</ul>
    <p>I dati non sono diffusi; possono essere comunicati ad autorità competenti ove previsto dalla legge.</p>

    <h2>6. Trasferimenti extra-UE</h2>
    <p>${extraEu}</p>

    <h2>7. Conservazione</h2>
    <p>Dati cliente e storico prenotazioni: ${ph(c.retention_customer, 'es. 24 mesi dall’ultima interazione')}. Dati con obbligo fiscale: 10 anni.</p>

    <h2>8. Diritti dell'interessato</h2>
    <p>Puoi esercitare i diritti ex artt. 15-22 GDPR (accesso, rettifica, cancellazione, limitazione, portabilità, opposizione) e revocare il consenso in ogni momento scrivendo a ${ph(c.privacy_email, 'e-mail privacy')}. Hai inoltre diritto di reclamo al <a href="https://www.garanteprivacy.it" target="_blank" rel="noopener">Garante per la protezione dei dati personali</a>.</p>
  </div>
  <footer>${company} · Informativa privacy</footer>
</div></body></html>`;
        res.set('Cache-Control', 'no-store');
        res.type('html').send(html);
    } catch (err) {
        console.error('GET /privacy error:', err);
        res.status(500).type('html').send('<p>Informativa temporaneamente non disponibile.</p>');
    }
});

// Restaurant logo used by the /prenota landing page and the customer emails.
// Served explicitly rather than via express.static to avoid exposing the whole
// public/ folder. Two variants: default (dark artwork on transparent) and
// -dark.png (white artwork) — the email templates swap between them via
// prefers-color-scheme so the mark stays visible in both light and dark
// inboxes.
app.get('/prenota/logo.png', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(process.cwd(), 'public', 'logo-vf.png'));
});
app.get('/prenota/logo-dark.png', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(process.cwd(), 'public', 'logo-vf-dark.png'));
});

// WhatsApp diagnostic — sends a real message via the active provider and
// returns the raw response so we can see exactly what's happening.
// "auto" prefers Twilio → Meta → Vonage (same priority as the dispatcher).
// Owner-only.
app.post('/debug/whatsapp-test', authenticate, requirePermission('settings:full'), async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const text = typeof req.body?.text === 'string' && req.body.text.trim()
        ? req.body.text.trim()
        : 'Test diagnostico WhatsApp.';
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : 'auto';

    if (!to) return res.status(400).json({ error: 'missing_to', message: 'Body must include "to"' });

    const useTwilio = provider === 'twilio' || (provider === 'auto' && isTwilioWhatsAppConfigured());
    const useMeta = !useTwilio && (provider === 'meta' || (provider === 'auto' && isMetaWhatsAppConfigured()));

    if (useTwilio) {
        const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
        const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
        const FROM = process.env.TWILIO_WHATSAPP_FROM;

        if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM) {
            return res.status(500).json({
                error: 'missing_twilio_config',
                present: {
                    TWILIO_ACCOUNT_SID: !!ACCOUNT_SID,
                    TWILIO_AUTH_TOKEN: !!AUTH_TOKEN,
                    TWILIO_WHATSAPP_FROM: !!FROM,
                },
            });
        }

        const formattedTo = `whatsapp:${normalizeItalianPhone(String(to))}`;
        const formattedFrom = FROM.startsWith('whatsapp:') ? FROM : `whatsapp:${FROM.startsWith('+') ? FROM : `+${FROM}`}`;
        const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
        const body = new URLSearchParams({ From: formattedFrom, To: formattedTo, Body: text });

        try {
            const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
            const rawBody = await response.text();
            let parsedBody: any;
            try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
            return res.json({
                ok: response.ok,
                provider: 'twilio',
                request: { from: formattedFrom, to: formattedTo, text, accountSid: ACCOUNT_SID },
                twilio: { status: response.status, body: parsedBody },
            });
        } catch (err: any) {
            return res.status(500).json({ error: 'fetch_failed', message: err?.message ?? String(err) });
        }
    }

    if (useMeta) {
        const ACCESS_TOKEN = process.env.META_WHATSAPP_ACCESS_TOKEN;
        const PHONE_NUMBER_ID = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
        const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';
        const templateName = req.body?.templateName || process.env.META_WHATSAPP_TEMPLATE_NAME || 'booking_received';
        const templateLang = req.body?.templateLang || process.env.META_WHATSAPP_TEMPLATE_LANG || 'it';
        const bodyParams: string[] = Array.isArray(req.body?.bodyParams) ? req.body.bodyParams : [];

        if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
            return res.status(500).json({
                error: 'missing_meta_config',
                present: {
                    META_WHATSAPP_ACCESS_TOKEN: !!ACCESS_TOKEN,
                    META_WHATSAPP_PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
                },
            });
        }

        const digitsTo = to.replace(/^\+/, '').replace(/\D/g, '');
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
        const reqBody = {
            messaging_product: 'whatsapp',
            to: digitsTo,
            type: 'template',
            template: {
                name: templateName,
                language: { code: templateLang },
                components: bodyParams.length > 0
                    ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
                    : [],
            },
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ACCESS_TOKEN}` },
                body: JSON.stringify(reqBody),
            });
            const rawBody = await response.text();
            let parsedBody: any;
            try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
            return res.json({
                ok: response.ok,
                provider: 'meta',
                request: { to: digitsTo, phoneNumberId: PHONE_NUMBER_ID, template: templateName, language: templateLang, bodyParams },
                meta: { status: response.status, body: parsedBody },
            });
        } catch (err: any) {
            return res.status(500).json({ error: 'fetch_failed', message: err?.message ?? String(err) });
        }
    }

    // Vonage path
    const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
    const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
    const VONAGE_WHATSAPP_NUMBER = process.env.VONAGE_WHATSAPP_NUMBER;

    if (!VONAGE_API_KEY || !VONAGE_API_SECRET || !VONAGE_WHATSAPP_NUMBER) {
        return res.status(500).json({
            error: 'missing_vonage_config',
            present: {
                VONAGE_API_KEY: !!VONAGE_API_KEY,
                VONAGE_API_SECRET: !!VONAGE_API_SECRET,
                VONAGE_WHATSAPP_NUMBER: !!VONAGE_WHATSAPP_NUMBER,
            },
        });
    }

    const formattedTo = to.startsWith('+') ? to : `+${to}`;
    const formattedFrom = VONAGE_WHATSAPP_NUMBER.startsWith('+') ? VONAGE_WHATSAPP_NUMBER : `+${VONAGE_WHATSAPP_NUMBER}`;
    const auth = Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString('base64');

    try {
        const response = await fetch('https://messages-sandbox.nexmo.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
            body: JSON.stringify({
                from: formattedFrom,
                to: formattedTo,
                message_type: 'text',
                text,
                channel: 'whatsapp',
            }),
        });
        const rawBody = await response.text();
        let parsedBody: any;
        try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
        res.json({
            ok: response.ok,
            provider: 'vonage',
            request: { from: formattedFrom, to: formattedTo, text, apiKey: VONAGE_API_KEY },
            vonage: { status: response.status, body: parsedBody },
        });
    } catch (err: any) {
        res.status(500).json({ error: 'fetch_failed', message: err?.message ?? String(err) });
    }
});

// ============================================
// GESTIONALE DI SALA — COMANDE (PR 2)
// ============================================
// La comanda dice cosa si sta preparando, il conto (`table_bills`) quanto si
// deve. Due domini separati: il ponte fra i due arriva nella PR 6, qui i
// totali sono solo calcolati e restituiti, nessun conto viene toccato.
//
// Piano completo: docs/gestionale-sala-plan.md

// Il servizio corrente: data + turno. La data di servizio NON è la data
// solare — una cena che finisce all'una di notte appartiene ancora al giorno
// prima, e una comanda aperta a mezzanotte e mezza non deve saltare al giorno
// dopo mentre il tavolo è ancora seduto.
//
// Il giorno di servizio comincia alle 05:00 Europe/Rome; il turno cambia alle
// 17:00, come il resto del CRM.
const SERVICE_DAY_START_HOUR = 5;
const DINNER_START_HOUR = 17;

interface CurrentService { service_date: string; shift: 'LUNCH' | 'DINNER' }

function resolveService(at: Date = new Date()): CurrentService {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const hour = Number(get('hour'));
    let date = `${get('year')}-${get('month')}-${get('day')}`;

    if (hour < SERVICE_DAY_START_HOUR) {
        // Notte fonda: siamo ancora nella cena di ieri.
        const d = new Date(`${date}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        date = d.toISOString().slice(0, 10);
        return { service_date: date, shift: 'DINNER' };
    }
    return { service_date: date, shift: hour < DINNER_START_HOUR ? 'LUNCH' : 'DINNER' };
}

// Le viste di servizio accettano un override esplicito (utile per guardare un
// turno passato); senza parametri rispondono sempre sul servizio in corso.
function serviceFromQuery(query: any): CurrentService {
    const d = typeof query?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : null;
    const sh = query?.shift === 'LUNCH' || query?.shift === 'DINNER' ? query.shift : null;
    const now = resolveService();
    return { service_date: d ?? now.service_date, shift: sh ?? now.shift };
}

type CourseFireModeValue = 'AUTO_ALL' | 'AUTO_FIRST' | 'MANUAL';

// Come vengono lanciate le uscite. Default prudente ad AUTO_ALL: finché la
// vista passe non esiste (PR 5) nessuno può lanciare a mano, e un default
// diverso lascerebbe le uscite ferme in QUEUED senza che nessuno se ne accorga.
async function getCourseFireMode(): Promise<CourseFireModeValue> {
    try {
        const r = await queryWithRetry(`SELECT text_value FROM app_settings WHERE key = 'course_fire_mode'`);
        const v = r.rows[0]?.text_value;
        if (v === 'AUTO_FIRST' || v === 'MANUAL' || v === 'AUTO_ALL') return v;
        return 'AUTO_ALL';
    } catch (err) {
        console.error('[orders] lettura course_fire_mode fallita, uso AUTO_ALL:', err);
        return 'AUTO_ALL';
    }
}

const ordersEnabledGuard = async (res: any): Promise<boolean> => {
    if (await getFeatureFlag('table_orders_enabled', false)) return true;
    res.status(403).json({
        error: 'feature_disabled',
        message: 'Il modulo comande è disattivato. Attivalo da Impostazioni.',
    });
    return false;
};

// Totale riga = (prezzo unitario + Σ varianti) * quantità. Il client non lo
// calcola mai: il palmare è un tablet in mano a chiunque passi in sala.
const lineTotalCents = (row: any): number => {
    const mods: any[] = Array.isArray(row.modifiers) ? row.modifiers : [];
    const delta = mods.reduce((sum, m) => sum + Number(m?.price_delta_cents || 0), 0);
    return (Number(row.unit_price_cents) + delta) * Number(row.qty);
};

// Sconto applicato all'imponibile. Percentuale o importo, mai sotto zero:
// un conto negativo non esiste, e uno sconto battuto male non deve
// trasformarsi in un credito verso il cliente.
const applyDiscount = (subtotalCents: number, type: string | null, value: any): number => {
    if (!type || value == null) return subtotalCents;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return subtotalCents;
    const cut = type === 'PERCENT'
        ? Math.round((subtotalCents * Math.min(v, 100)) / 100)
        : Math.round(v * 100);
    return Math.max(0, subtotalCents - cut);
};

// Stato dell'uscita derivato dalle righe, mai materializzato: due fonti di
// verità divergono al primo storno a metà preparazione.
const deriveCourseStatus = (items: any[]): string => {
    const live = items.filter(i => i.status !== 'VOIDED');
    if (live.length === 0) return 'PENDING';
    if (live.every(i => i.status === 'SERVED')) return 'SERVED';
    if (live.every(i => i.status === 'READY' || i.status === 'SERVED')) return 'READY';
    if (live.some(i => i.fired_at)) return 'FIRED';
    if (live.some(i => i.queued_at)) return 'QUEUED';
    return 'PENDING';
};

// Vista completa della comanda: righe, uscite e totali già sommati.
async function loadOrderView(orderId: number): Promise<any | null> {
    const o = await queryWithRetry(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    if (o.rows.length === 0) return null;
    const it = await queryWithRetry(
        `SELECT * FROM order_items WHERE order_id = $1 ORDER BY course_no, id`,
        [orderId]
    );
    const items = it.rows.map(r => ({ ...r, line_total_cents: lineTotalCents(r) }));

    const byCourse = new Map<number, any[]>();
    for (const i of items) {
        if (!byCourse.has(i.course_no)) byCourse.set(i.course_no, []);
        byCourse.get(i.course_no)!.push(i);
    }
    const courses = [...byCourse.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([course_no, list]) => ({
            course_no,
            status: deriveCourseStatus(list),
            items: list,
            total_cents: list.filter(i => i.status !== 'VOIDED')
                             .reduce((s, i) => s + i.line_total_cents, 0),
        }));

    const subtotal_cents = items.filter(i => i.status !== 'VOIDED')
                                .reduce((s, i) => s + i.line_total_cents, 0);
    const voided_cents = items.filter(i => i.status === 'VOIDED')
                              .reduce((s, i) => s + i.line_total_cents, 0);
    const order = o.rows[0];
    const total_cents = applyDiscount(subtotal_cents, order.discount_type, order.discount_value);

    return {
        order, items, courses,
        subtotal_cents,
        discount_cents: subtotal_cents - total_cents,
        total_cents,
        voided_cents,
    };
}

// Lancio di un'uscita: QUEUED → SENT con lo scaglionamento per partita.
// station_start_at = adesso + (prep massimo dell'uscita − prep della riga),
// così la griglia parte subito e i primi partono dopo, e arrivano insieme.
// Le righe senza prep_minutes valgono 0 e partono subito — comportamento
// identico a un KDS non scaglionato, che è ciò che serve finché il campo non
// è popolato.
async function fireCourseInTx(client: any, orderId: number, courseNo: number): Promise<any[]> {
    const upd = await client.query(
        `WITH prep AS (
             SELECT oi.id, COALESCE(d.prep_minutes, 0) AS p
             FROM order_items oi
             LEFT JOIN dishes d ON d.id = oi.dish_id
             WHERE oi.order_id = $1 AND oi.course_no = $2 AND oi.status = 'QUEUED'
         ), mx AS (
             SELECT COALESCE(MAX(p), 0) AS m FROM prep
         )
         UPDATE order_items oi
         SET status = 'SENT',
             fired_at = CURRENT_TIMESTAMP,
             station_start_at = CURRENT_TIMESTAMP
                 + make_interval(mins => (SELECT m FROM mx) - prep.p)
         FROM prep, mx
         WHERE oi.id = prep.id
         RETURNING oi.*`,
        [orderId, courseNo]
    );
    if (upd.rows.length > 0) {
        await enqueueCoursePrintsInTx(client, orderId, courseNo, upd.rows);
    }
    return upd.rows;
}

// Al lancio, oltre ai monitor KDS, la carta: le righe di ogni partita escono
// dalla termica del suo centro (stations.printer). Stessa transazione del
// lancio — o l'uscita parte con le sue stampe accodate, o non parte affatto.
// Partite senza stampante (printer NULL) restano solo a schermo. Best-effort
// NON è questo: un errore qui annulla il lancio, ed è voluto — un'uscita
// lanciata di cui la cucina non sa niente è il caso peggiore.
async function enqueueCoursePrintsInTx(client: any, orderId: number, courseNo: number, firedRows: any[]): Promise<void> {
    const ctx = await client.query(
        `SELECT o.covers, t.name AS table_name
         FROM orders o LEFT JOIN tables t ON t.id = o.table_id
         WHERE o.id = $1`,
        [orderId]
    );
    const tableName = ctx.rows[0]?.table_name ?? null;
    const covers = ctx.rows[0]?.covers ?? null;

    const stationIds = [...new Set(firedRows.map(r => r.station_id).filter((s: any) => s != null))];
    if (stationIds.length === 0) return;
    const st = await client.query(
        `SELECT id, name, printer FROM stations WHERE id = ANY($1::int[]) AND printer IS NOT NULL`,
        [stationIds]
    );

    for (const station of st.rows) {
        const items = firedRows
            .filter(r => r.station_id === station.id)
            .map(r => ({
                qty: Number(r.qty),
                name: r.name_snapshot,
                modifiers: (Array.isArray(r.modifiers) ? r.modifiers : []).map((m: any) => m?.name).filter(Boolean),
                note: r.note ?? null,
            }));
        if (items.length === 0) continue;
        await client.query(
            `INSERT INTO print_jobs (kind, payload, printer)
             VALUES ('COMANDA', $1, $2)`,
            [JSON.stringify({
                order_id: orderId,
                course_no: courseNo,
                table_name: tableName,
                covers,
                station_name: station.name,
                items,
            }), station.printer]
        );
    }
}

// Apre una comanda. Idempotente rispetto all'header Idempotency-Key: il
// palmare in sala perde il WiFi a metà richiesta e ritenta, e senza chiave il
// tavolo si ritroverebbe due comande.
//
// Se il tavolo ha già una comanda aperta la restituisce invece di fallire:
// due camerieri sullo stesso tavolo devono scrivere sulla stessa comanda.
app.post('/orders', authenticate, requirePermission('orders:take'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;

        const idemKey = typeof req.headers['idempotency-key'] === 'string'
            ? (req.headers['idempotency-key'] as string).slice(0, 80)
            : null;
        if (idemKey) {
            const prev = await queryWithRetry(`SELECT id FROM orders WHERE idempotency_key = $1`, [idemKey]);
            if (prev.rows.length > 0) {
                return res.json({ ...(await loadOrderView(prev.rows[0].id)), replayed: true });
            }
        }

        let reservationId = req.body?.reservation_id != null ? Number(req.body.reservation_id) : null;
        let tableId = req.body?.table_id != null ? Number(req.body.table_id) : null;
        if (reservationId != null && !Number.isFinite(reservationId)) {
            return res.status(400).json({ error: 'reservation_id non valido' });
        }
        if (tableId != null && !Number.isFinite(tableId)) {
            return res.status(400).json({ error: 'table_id non valido' });
        }
        if (reservationId == null && tableId == null) {
            return res.status(400).json({ error: 'Serve reservation_id oppure table_id' });
        }

        // Dalla prenotazione ereditiamo tavolo e coperti, così il cameriere
        // non li ridigita (e non li sbaglia).
        let covers = req.body?.covers != null ? Number(req.body.covers) : NaN;
        if (reservationId != null) {
            const r = await queryWithRetry(
                `SELECT id, table_id, guests FROM reservations WHERE id = $1`, [reservationId]
            );
            if (r.rows.length === 0) return res.status(404).json({ error: 'Prenotazione non trovata' });
            if (tableId == null) tableId = r.rows[0].table_id ?? null;
            if (!Number.isFinite(covers)) covers = Number(r.rows[0].guests);
        }
        if (!Number.isFinite(covers) || covers <= 0) covers = 1;

        let priceListId = req.body?.price_list_id != null ? Number(req.body.price_list_id) : null;
        if (priceListId == null) {
            const pl = await queryWithRetry(`SELECT id FROM menu_price_lists WHERE is_default LIMIT 1`);
            priceListId = pl.rows[0]?.id ?? null;
        }

        // Il servizio si stampa all'apertura e non si tocca più: una comanda
        // iniziata a pranzo resta del pranzo anche se si chiude alle 17:30.
        const service = resolveService();
        const orderType = req.body?.order_type === 'TAKEAWAY' ? 'TAKEAWAY' : 'DINE_IN';
        const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : null;

        let created: any;
        try {
            const ins = await queryWithRetry(
                `INSERT INTO orders
                    (reservation_id, table_id, order_type, price_list_id, covers, notes,
                     opened_by_user_id, idempotency_key, service_date, shift)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [reservationId, tableId, orderType, priceListId, Math.round(covers), notes,
                 req.user?.userId ?? null, idemKey, service.service_date, service.shift]
            );
            created = ins.rows[0];
        } catch (err: any) {
            // 23505 = violazione di unicità. Sui due indici parziali significa
            // "comanda già aperta qui": la restituiamo invece di far fallire il
            // cameriere, che è il comportamento utile in sala.
            if (err?.code === '23505') {
                const existing = await queryWithRetry(
                    `SELECT id FROM orders
                     WHERE status = 'OPEN'
                       AND ((table_id = $1 AND $1 IS NOT NULL
                             AND service_date = $3 AND shift = $4)
                         OR (reservation_id = $2 AND $2 IS NOT NULL))
                     LIMIT 1`,
                    [tableId, reservationId, service.service_date, service.shift]
                );
                if (existing.rows.length > 0) {
                    return res.json({ ...(await loadOrderView(existing.rows[0].id)), reused: true });
                }
            }
            throw err;
        }

        try { socketService?.broadcastToAll('order:created', created); } catch (_) {}

        LogService.logActivity(
            req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
            ActivityAction.CREATE, ResourceType.ORDER, created.id,
            `Comanda tavolo ${tableId ?? '—'}`,
            { reservation_id: reservationId, table_id: tableId, covers: created.covers }
        ).catch(() => {});

        res.status(201).json(await loadOrderView(created.id));
    } catch (err: any) {
        console.error('POST /orders error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Catalogo di supporto al palmare: listini, partite e varianti in una sola
// chiamata. Il palmare lo carica all'apertura e non lo riscarica per ogni
// piatto — in sala la latenza si nota.
//
// Sta sotto /menu e non sotto /orders per non collidere con /orders/:id.
app.get('/menu/catalogue', authenticate, requirePermission('orders:view'), async (_req, res) => {
    try {
        const [lists, stations, groups, mods, links] = await Promise.all([
            queryWithRetry(`SELECT id, name, is_default, is_active, sort_order FROM menu_price_lists WHERE is_active ORDER BY sort_order, id`),
            queryWithRetry(`SELECT id, name, color, sort_order, is_active FROM stations WHERE is_active ORDER BY sort_order, id`),
            queryWithRetry(`SELECT id, name, min_select, max_select, sort_order FROM modifier_groups ORDER BY sort_order, id`),
            queryWithRetry(`SELECT id, group_id, name, price_delta_cents, is_active, sort_order FROM modifiers WHERE is_active ORDER BY sort_order, id`),
            queryWithRetry(`SELECT dish_id, group_id FROM dish_modifier_groups`),
        ]);
        res.json({
            price_lists: lists.rows,
            stations: stations.rows,
            modifier_groups: groups.rows.map((g: any) => ({
                ...g,
                modifiers: mods.rows.filter((m: any) => m.group_id === g.id),
            })),
            dish_modifier_groups: links.rows,
        });
    } catch (err: any) {
        console.error('GET /menu/catalogue error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.get('/orders/:id', authenticate, requirePermission('orders:view'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const view = await loadOrderView(id);
        if (!view) return res.status(404).json({ error: 'Comanda non trovata' });
        res.json(view);
    } catch (err: any) {
        console.error('GET /orders/:id error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Comanda aperta su un tavolo — l'ingresso naturale del palmare: il cameriere
// tocca il tavolo sulla mappa, non conosce l'id della comanda.
app.get('/tables/:id/order', authenticate, requirePermission('orders:view'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const tableId = parseInt(req.params.id, 10);
        if (!Number.isFinite(tableId)) return res.status(400).json({ error: 'id non valido' });
        // Solo il servizio in corso: una comanda dimenticata a pranzo non deve
        // riaprirsi da sola quando il tavolo si risiede a cena.
        const service = serviceFromQuery(req.query);
        const r = await queryWithRetry(
            `SELECT id FROM orders
             WHERE table_id = $1 AND status = 'OPEN'
               AND service_date = $2 AND shift = $3
             LIMIT 1`,
            [tableId, service.service_date, service.shift]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Nessuna comanda aperta su questo tavolo' });
        res.json(await loadOrderView(r.rows[0].id));
    } catch (err: any) {
        console.error('GET /tables/:id/order error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Aggiunge righe in DRAFT. Batch, perché il cameriere compone il carrello
// offline e lo manda in una volta sola.
//
// Prezzo e varianti vengono risolti QUI e congelati sulla riga: rinominare un
// piatto o ritoccare il listino domani non deve muovere le comande di stasera.
app.post('/orders/:id/items', authenticate, requirePermission('orders:take'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!(await ordersEnabledGuard(res))) { client.release(); return; }

        const orderId = parseInt(req.params.id, 10);
        if (!Number.isFinite(orderId)) { client.release(); return res.status(400).json({ error: 'id non valido' }); }

        const incoming = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!incoming || incoming.length === 0) {
            client.release();
            return res.status(400).json({ error: 'items deve essere un array non vuoto' });
        }
        if (incoming.length > 100) {
            client.release();
            return res.status(400).json({ error: 'Massimo 100 righe per richiesta' });
        }

        const batchKey = typeof req.headers['idempotency-key'] === 'string'
            ? (req.headers['idempotency-key'] as string).slice(0, 60)
            : null;

        await client.query('BEGIN');

        const ord = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
        if (ord.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(404).json({ error: 'Comanda non trovata' });
        }
        if (ord.rows[0].status !== 'OPEN') {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'La comanda non è aperta', status: ord.rows[0].status });
        }
        const priceListId: number | null = ord.rows[0].price_list_id;

        for (let i = 0; i < incoming.length; i++) {
            const raw = incoming[i];
            const dishId = Number(raw?.dish_id);
            if (!Number.isFinite(dishId)) {
                await client.query('ROLLBACK'); client.release();
                return res.status(400).json({ error: `items[${i}].dish_id mancante o non valido` });
            }
            const qty = raw?.qty != null ? Math.round(Number(raw.qty)) : 1;
            if (!Number.isFinite(qty) || qty <= 0) {
                await client.query('ROLLBACK'); client.release();
                return res.status(400).json({ error: `items[${i}].qty deve essere > 0` });
            }
            const courseNo = raw?.course_no != null ? Math.round(Number(raw.course_no)) : 1;
            if (!Number.isFinite(courseNo) || courseNo <= 0) {
                await client.query('ROLLBACK'); client.release();
                return res.status(400).json({ error: `items[${i}].course_no deve essere > 0` });
            }
            const seatNo = raw?.seat_no != null ? Math.round(Number(raw.seat_no)) : null;

            const dish = await client.query(
                `SELECT id, name, price, station_id FROM dishes WHERE id = $1`, [dishId]
            );
            if (dish.rows.length === 0) {
                await client.query('ROLLBACK'); client.release();
                return res.status(404).json({ error: `Piatto ${dishId} non trovato` });
            }

            // Prezzo dal listino della comanda; se manca la riga di listino si
            // ricade sul prezzo di anagrafica, così un piatto nuovo non blocca
            // il servizio mentre qualcuno sistema i listini.
            let unitPrice: number | null = null;
            if (priceListId != null) {
                const p = await client.query(
                    `SELECT price_cents FROM dish_prices WHERE dish_id = $1 AND price_list_id = $2`,
                    [dishId, priceListId]
                );
                if (p.rows.length > 0) unitPrice = Number(p.rows[0].price_cents);
            }
            if (unitPrice == null) unitPrice = Math.max(0, Math.round(Number(dish.rows[0].price) * 100));

            // Varianti: accettiamo solo quelle collegate al piatto, altrimenti
            // un client sbagliato potrebbe attaccare "al sangue" a un tiramisù.
            const modifierIds: number[] = Array.isArray(raw?.modifier_ids)
                ? raw.modifier_ids.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
                : [];
            let modifiers: any[] | null = null;
            if (modifierIds.length > 0) {
                const mres = await client.query(
                    `SELECT m.id, m.name, m.price_delta_cents
                     FROM modifiers m
                     JOIN dish_modifier_groups dmg ON dmg.group_id = m.group_id
                     WHERE m.id = ANY($1::int[]) AND dmg.dish_id = $2 AND m.is_active`,
                    [modifierIds, dishId]
                );
                if (mres.rows.length !== modifierIds.length) {
                    await client.query('ROLLBACK'); client.release();
                    return res.status(400).json({
                        error: `items[${i}]: una o più varianti non sono valide per questo piatto`,
                        richieste: modifierIds,
                        ammesse: mres.rows.map((r: any) => r.id),
                    });
                }
                modifiers = mres.rows.map((r: any) => ({
                    id: r.id, name: r.name, price_delta_cents: Number(r.price_delta_cents),
                }));
            }

            // La partita viene copiata sulla riga, non risolta via join a
            // runtime: riassegnare un piatto a un'altra partita non deve
            // spostare ciò che è già in preparazione.
            const stationId = raw?.station_id != null ? Number(raw.station_id) : dish.rows[0].station_id;

            const itemKey = typeof raw?.idempotency_key === 'string'
                ? raw.idempotency_key.slice(0, 80)
                : (batchKey ? `${batchKey}:${i}` : null);

            await client.query(
                `INSERT INTO order_items
                    (order_id, dish_id, name_snapshot, unit_price_cents, modifiers, qty,
                     course_no, seat_no, station_id, note, created_by_user_id, idempotency_key)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (idempotency_key) DO NOTHING`,
                [orderId, dishId, dish.rows[0].name, unitPrice,
                 modifiers ? JSON.stringify(modifiers) : null, qty, courseNo, seatNo,
                 Number.isFinite(stationId) ? stationId : null,
                 typeof raw?.note === 'string' ? raw.note.slice(0, 300) : null,
                 req.user?.userId ?? null, itemKey]
            );
        }

        await client.query('COMMIT');
        client.release();

        await syncSystemLines(orderId);
        const view = await loadOrderView(orderId);
        // Se la comanda è già agganciata a un conto, il totale lo segue.
        const sync = await resyncBillForOrder(orderId);
        try { socketService?.broadcastToAll('order:updated', view.order); } catch (_) {}
        res.status(201).json({ ...view, ...(sync?.warning ? { bill_warning: sync.warning } : {}) });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('POST /orders/:id/items error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Modifica una riga. Solo in DRAFT: dopo l'invio la cucina l'ha vista e
// l'unica strada onesta è lo storno, che lascia traccia.
app.patch('/orders/items/:id', authenticate, requirePermission('orders:take'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });

        const cur = await queryWithRetry(`SELECT * FROM order_items WHERE id = $1`, [id]);
        if (cur.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
        if (cur.rows[0].status !== 'DRAFT') {
            return res.status(409).json({
                error: 'Riga già inviata: si può solo stornare',
                status: cur.rows[0].status,
            });
        }

        const sets: string[] = [];
        const vals: any[] = [];
        const push = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

        if (req.body?.qty != null) {
            const q = Math.round(Number(req.body.qty));
            if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'qty deve essere > 0' });
            push('qty', q);
        }
        if (req.body?.course_no != null) {
            const c = Math.round(Number(req.body.course_no));
            if (!Number.isFinite(c) || c <= 0) return res.status(400).json({ error: 'course_no deve essere > 0' });
            push('course_no', c);
        }
        if (req.body?.seat_no !== undefined) {
            const s = req.body.seat_no == null ? null : Math.round(Number(req.body.seat_no));
            if (s != null && (!Number.isFinite(s) || s <= 0)) return res.status(400).json({ error: 'seat_no deve essere > 0' });
            push('seat_no', s);
        }
        if (req.body?.note !== undefined) {
            push('note', typeof req.body.note === 'string' ? req.body.note.slice(0, 300) : null);
        }
        if (req.body?.station_id !== undefined) {
            const st = req.body.station_id == null ? null : Number(req.body.station_id);
            if (st != null && !Number.isFinite(st)) return res.status(400).json({ error: 'station_id non valido' });
            push('station_id', st);
        }
        if (sets.length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

        vals.push(id);
        const upd = await queryWithRetry(
            `UPDATE order_items SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING order_id`,
            vals
        );

        await syncSystemLines(upd.rows[0].order_id);
        const view = await loadOrderView(upd.rows[0].order_id);
        const sync = await resyncBillForOrder(upd.rows[0].order_id);
        try { socketService?.broadcastToAll('order:updated', view.order); } catch (_) {}
        res.json({ ...view, ...(sync?.warning ? { bill_warning: sync.warning } : {}) });
    } catch (err: any) {
        console.error('PATCH /orders/items/:id error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

app.delete('/orders/items/:id', authenticate, requirePermission('orders:take'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });

        const cur = await queryWithRetry(`SELECT order_id, status FROM order_items WHERE id = $1`, [id]);
        if (cur.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
        if (cur.rows[0].status !== 'DRAFT') {
            return res.status(409).json({
                error: 'Riga già inviata: si può solo stornare',
                status: cur.rows[0].status,
            });
        }
        await queryWithRetry(`DELETE FROM order_items WHERE id = $1`, [id]);

        await syncSystemLines(cur.rows[0].order_id);
        const view = await loadOrderView(cur.rows[0].order_id);
        const sync = await resyncBillForOrder(cur.rows[0].order_id);
        try { socketService?.broadcastToAll('order:updated', view.order); } catch (_) {}
        res.json({ ...view, ...(sync?.warning ? { bill_warning: sync.warning } : {}) });
    } catch (err: any) {
        console.error('DELETE /orders/items/:id error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Invio: la sala propone (DRAFT → QUEUED), poi il lancio avviene secondo
// `course_fire_mode`. La prima uscita non ha niente da coordinare — il tavolo
// si è appena seduto — quindi in AUTO_FIRST parte da sola; dalla seconda in poi
// decide il passe, che è l'unico a vedere la sala.
app.post('/orders/:id/send', authenticate, requirePermission('orders:take'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!(await ordersEnabledGuard(res))) { client.release(); return; }

        const orderId = parseInt(req.params.id, 10);
        if (!Number.isFinite(orderId)) { client.release(); return res.status(400).json({ error: 'id non valido' }); }

        const onlyCourse = req.body?.course_no != null ? Math.round(Number(req.body.course_no)) : null;
        if (onlyCourse != null && (!Number.isFinite(onlyCourse) || onlyCourse <= 0)) {
            client.release();
            return res.status(400).json({ error: 'course_no deve essere > 0' });
        }

        const mode = await getCourseFireMode();
        await client.query('BEGIN');

        const ord = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
        if (ord.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(404).json({ error: 'Comanda non trovata' });
        }
        if (ord.rows[0].status !== 'OPEN') {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'La comanda non è aperta', status: ord.rows[0].status });
        }

        const queued = await client.query(
            `UPDATE order_items
             SET status = 'QUEUED', queued_at = CURRENT_TIMESTAMP
             WHERE order_id = $1 AND status = 'DRAFT'
               AND ($2::int IS NULL OR course_no = $2)
             RETURNING id, course_no`,
            [orderId, onlyCourse]
        );
        if (queued.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'Nessuna riga in bozza da inviare' });
        }

        const proposedCourses = [...new Set(queued.rows.map((r: any) => r.course_no))].sort((a, b) => a - b);
        const toFire = mode === 'AUTO_ALL' ? proposedCourses
                     : mode === 'AUTO_FIRST' ? proposedCourses.filter(c => c === 1)
                     : [];
        const fired: number[] = [];
        for (const c of toFire) {
            const rows = await fireCourseInTx(client, orderId, c);
            if (rows.length > 0) fired.push(c);
        }

        await client.query('COMMIT');
        client.release();

        const view = await loadOrderView(orderId);
        const stillQueued = proposedCourses.filter(c => !fired.includes(c));
        try {
            // Il passe riceve ciò che attende di essere lanciato, i monitor di
            // partita solo ciò che è stato lanciato davvero.
            for (const c of stillQueued) {
                socketService?.broadcastToAll('course:queued', {
                    order_id: orderId, course_no: c, table_id: view.order.table_id,
                    items: view.items.filter((i: any) => i.course_no === c && i.status === 'QUEUED'),
                });
            }
            for (const c of fired) {
                const firedItems = view.items.filter((i: any) => i.course_no === c && i.status === 'SENT');
                socketService?.broadcastToAll('course:fired', {
                    order_id: orderId, course_no: c, table_id: view.order.table_id, items: firedItems,
                });
                // Ogni monitor riceve solo le righe della propria partita.
                for (const st of new Set(firedItems.map((i: any) => i.station_id))) {
                    socketService?.broadcastToStation(st as number | null, 'kds:fired', {
                        order_id: orderId, course_no: c, table_id: view.order.table_id,
                        items: firedItems.filter((i: any) => i.station_id === st),
                    });
                }
            }
            socketService?.broadcastToAll('order:updated', view.order);
        } catch (_) {}

        res.json({ ...view, fire_mode: mode, fired_courses: fired, queued_courses: stillQueued });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('POST /orders/:id/send error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Richiama un'uscita proposta ma non ancora lanciata: torna in DRAFT e il
// cameriere la corregge. In cucina non l'ha vista nessuno, quindi non serve
// uno storno e non resta traccia.
app.post('/orders/:id/courses/:n/recall', authenticate, requirePermission('orders:take'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const orderId = parseInt(req.params.id, 10);
        const courseNo = parseInt(req.params.n, 10);
        if (!Number.isFinite(orderId) || !Number.isFinite(courseNo)) {
            return res.status(400).json({ error: 'Parametri non validi' });
        }

        const upd = await queryWithRetry(
            `UPDATE order_items
             SET status = 'DRAFT', queued_at = NULL
             WHERE order_id = $1 AND course_no = $2 AND status = 'QUEUED' AND fired_at IS NULL
             RETURNING id`,
            [orderId, courseNo]
        );
        if (upd.rows.length === 0) {
            return res.status(409).json({
                error: 'Nessuna riga richiamabile: l\'uscita non è in attesa oppure è già stata lanciata',
            });
        }

        const view = await loadOrderView(orderId);
        try {
            socketService?.broadcastToAll('course:recalled', { order_id: orderId, course_no: courseNo });
            socketService?.broadcastToAll('order:updated', view.order);
        } catch (_) {}
        res.json(view);
    } catch (err: any) {
        console.error('POST /orders/:id/courses/:n/recall error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Monitor di partita (PR 4) ----------------------------------------------
// Ogni schermo di cucina vede solo la propria coda. La riga porta con sé il
// tavolo, l'uscita e gli allergeni della prenotazione: il cuoco non deve
// cercare niente altrove.

// Righe lavorabili di una partita. `station_id` assente = coda generica
// (piatti senza partita assegnata), che è il fallback del passe.
app.get('/kds/queue', authenticate, requirePermission('orders:kds'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;

        const raw = req.query.station_id;
        const stationId = raw != null && raw !== '' ? Number(raw) : null;
        if (raw != null && raw !== '' && !Number.isFinite(stationId)) {
            return res.status(400).json({ error: 'station_id non valido' });
        }

        // Il monitor vede solo il servizio in corso: le righe rimaste appese a
        // un turno precedente sono un problema di chi chiude i conti, non del
        // cuoco che sta lavorando adesso.
        const service = serviceFromQuery(req.query);
        const rows = await queryWithRetry(
            `SELECT oi.id, oi.order_id, oi.course_no, oi.name_snapshot, oi.qty,
                    oi.modifiers, oi.note, oi.status, oi.station_id,
                    oi.fired_at, oi.station_start_at, oi.started_at, oi.ready_at,
                    o.table_id, t.name AS table_name,
                    r.customer_name, r.notes AS reservation_notes,
                    c.dietary_notes AS customer_dietary_notes
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             LEFT JOIN tables t ON t.id = o.table_id
             LEFT JOIN reservations r ON r.id = o.reservation_id
             -- Gli allergeni stanno in anagrafica cliente, agganciata per
             -- telefono normalizzato: stessa lateral join delle prenotazioni.
             LEFT JOIN LATERAL (
                 SELECT cc.dietary_notes
                 FROM customers cc
                 WHERE r.phone IS NOT NULL AND cc.phone IS NOT NULL
                   AND regexp_replace(r.phone, '\\D', '', 'g') = regexp_replace(cc.phone, '\\D', '', 'g')
                 ORDER BY cc.id ASC
                 LIMIT 1
             ) c ON true
             WHERE oi.status IN ('SENT','PREPARING','READY')
               AND o.service_date = $2 AND o.shift = $3
               AND ($1::int IS NULL OR oi.station_id = $1)
               AND ($1::int IS NOT NULL OR oi.station_id IS NULL)
             ORDER BY oi.station_start_at NULLS FIRST, oi.id`,
            [stationId, service.service_date, service.shift]
        );

        // Lo stato dell'uscita serve al monitor per sapere se sta facendo
        // aspettare le altre partite: si calcola su TUTTE le righe
        // dell'uscita, non solo su quelle di questa partita.
        const keys = [...new Set(rows.rows.map((r: any) => `${r.order_id}:${r.course_no}`))];
        let siblings: any[] = [];
        if (keys.length > 0) {
            const sib = await queryWithRetry(
                `SELECT order_id, course_no, status, ready_at, station_id
                 FROM order_items
                 WHERE status <> 'VOIDED'
                   AND (order_id, course_no) IN (
                       SELECT (split_part(k, ':', 1))::int, (split_part(k, ':', 2))::int
                       FROM unnest($1::text[]) AS k
                   )`,
                [keys]
            );
            siblings = sib.rows;
        }

        const courses = keys.map(k => {
            const [orderId, courseNo] = k.split(':').map(Number);
            const mine = siblings.filter(s => s.order_id === orderId && s.course_no === courseNo);
            const pending = mine.filter(s => s.status !== 'READY' && s.status !== 'SERVED');
            return {
                order_id: orderId,
                course_no: courseNo,
                total_items: mine.length,
                ready_items: mine.length - pending.length,
                // Partite che l'uscita sta ancora aspettando: serve a dire al
                // cuoco se è lui a far aspettare gli altri, o il contrario.
                waiting_station_ids: [...new Set(pending.map(s => s.station_id))],
            };
        });

        res.json({ station_id: stationId, ...service, items: rows.rows, courses });
    } catch (err: any) {
        console.error('GET /kds/queue error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Avanzamento della riga da parte del cuoco. Solo in avanti: tornare indietro
// richiede uno storno esplicito, che ha un percorso suo (PR 7).
app.post('/kds/items/:id/status', authenticate, requirePermission('orders:kds'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });

        const next = req.body?.status;
        if (next !== 'PREPARING' && next !== 'READY') {
            return res.status(400).json({ error: "status deve essere PREPARING o READY" });
        }
        // PREPARING solo da SENT, READY da SENT o PREPARING: il cuoco che
        // segna pronto senza passare da "in preparazione" è normale sui
        // piatti veloci e non va ostacolato.
        const allowedFrom = next === 'PREPARING' ? ['SENT'] : ['SENT', 'PREPARING'];

        const upd = await queryWithRetry(
            // $2 va castato esplicitamente: senza, Postgres deve dedurne il
            // tipo sia dalla colonna status sia dal confronto con 'READY' e
            // rifiuta la query ("inconsistent types deduced for parameter").
            `UPDATE order_items
             SET status = $2::varchar,
                 started_at = CASE WHEN started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
                 ready_at   = CASE WHEN $2::text = 'READY' THEN CURRENT_TIMESTAMP ELSE ready_at END
             WHERE id = $1 AND status = ANY($3::varchar[])
             RETURNING *`,
            [id, next, allowedFrom]
        );
        if (upd.rows.length === 0) {
            const cur = await queryWithRetry(`SELECT status FROM order_items WHERE id = $1`, [id]);
            if (cur.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
            return res.status(409).json({
                error: `Transizione non ammessa da ${cur.rows[0].status} a ${next}`,
                status: cur.rows[0].status,
            });
        }
        const item = upd.rows[0];

        // L'uscita è pronta solo quando lo sono TUTTE le sue righe, anche
        // quelle delle altre partite: è il segnale che fa chiamare la sala.
        const course = await queryWithRetry(
            `SELECT status, ready_at, station_id FROM order_items
             WHERE order_id = $1 AND course_no = $2 AND status <> 'VOIDED'`,
            [item.order_id, item.course_no]
        );
        const live = course.rows;
        const pending = live.filter((r: any) => r.status !== 'READY' && r.status !== 'SERVED');
        const courseReady = live.length > 0 && pending.length === 0;

        try {
            socketService?.broadcastToStation(item.station_id, 'kds:item', item);
            socketService?.broadcastToAll('orderItem:status', {
                id: item.id, status: item.status, station_id: item.station_id,
                order_id: item.order_id, course_no: item.course_no, ts: new Date().toISOString(),
            });
            if (courseReady) {
                const readyTimes = live.map((r: any) => new Date(r.ready_at).getTime()).filter(Number.isFinite);
                // Delta di sincronia: quanto tempo è passato fra la prima
                // riga pronta e l'ultima. È la metrica che dice se la cucina
                // è coordinata, e finisce nelle statistiche della PR 8.
                const syncDelta = readyTimes.length > 1
                    ? Math.round((Math.max(...readyTimes) - Math.min(...readyTimes)) / 1000)
                    : 0;
                socketService?.broadcastToAll('course:ready', {
                    order_id: item.order_id, course_no: item.course_no, sync_delta_s: syncDelta,
                });
            }
        } catch (_) {}

        res.json({
            item,
            course_ready: courseReady,
            waiting_station_ids: [...new Set(pending.map((r: any) => r.station_id))],
        });
    } catch (err: any) {
        console.error('POST /kds/items/:id/status error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Passe / chef d'expédition (PR 5) ---------------------------------------
// L'unico punto in cui qualcuno vede l'uscita intera. Con tre partite senza
// questa vista lavorano alla cieca l'una rispetto all'altra e la
// sincronizzazione torna a essere un fatto di urla.

// Soglia oltre la quale una riga pronta che aspetta le altre partite viene
// segnalata: il piatto sta morendo sotto la lampada.
const KDS_LAMP_ALERT_SECONDS = 4 * 60;
// Soglia oltre la quale un'uscita proposta e mai lanciata diventa un allarme.
// È il rischio strutturale del modello proponi/lancia: una proposta che
// nessuno lancia è un tavolo che non mangia, e nessun altro se ne accorge.
const PASSE_QUEUED_ALERT_SECONDS = 5 * 60;

// Tutte le uscite vive, con lo stato di ogni partita. Il passe si iscrive a
// tutte le partite: è l'unico a vedere l'insieme.
app.get('/kds/expediter', authenticate, requirePermission('orders:expedite'), async (_req: any, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;

        const service = serviceFromQuery(_req.query);
        const rows = await queryWithRetry(
            `SELECT oi.id, oi.order_id, oi.course_no, oi.name_snapshot, oi.qty,
                    oi.status, oi.station_id, oi.queued_at, oi.fired_at,
                    oi.station_start_at, oi.ready_at,
                    o.table_id, t.name AS table_name, r.customer_name
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             LEFT JOIN tables t ON t.id = o.table_id
             LEFT JOIN reservations r ON r.id = o.reservation_id
             WHERE o.status = 'OPEN'
               AND o.service_date = $1 AND o.shift = $2
               AND oi.status IN ('QUEUED','SENT','PREPARING','READY')
             ORDER BY oi.course_no, oi.id`,
            [service.service_date, service.shift]
        );

        const nowMs = Date.now();
        const byCourse = new Map<string, any>();
        for (const it of rows.rows) {
            const key = `${it.order_id}:${it.course_no}`;
            if (!byCourse.has(key)) {
                byCourse.set(key, {
                    order_id: it.order_id,
                    course_no: it.course_no,
                    table_id: it.table_id,
                    table_name: it.table_name,
                    customer_name: it.customer_name,
                    items: [],
                });
            }
            byCourse.get(key).items.push(it);
        }

        const courses = [...byCourse.values()].map(c => {
            const items: any[] = c.items;
            const queuedOnly = items.every(i => i.status === 'QUEUED');
            const allReady = items.every(i => i.status === 'READY');
            const status = queuedOnly ? 'QUEUED' : allReady ? 'READY' : 'FIRED';

            // Una riga per partita coinvolta: sono i pallini del monitor.
            const stations = [...new Set(items.map(i => i.station_id))].map(sid => {
                const mine = items.filter(i => i.station_id === sid);
                return {
                    station_id: sid,
                    ready: mine.every(i => i.status === 'READY'),
                    items: mine.length,
                };
            });

            const waiting = stations.filter(s => !s.ready).map(s => s.station_id);
            const readyTimes = items.filter(i => i.ready_at)
                                    .map(i => new Date(i.ready_at).getTime());

            // Quanto sta aspettando il piatto già pronto mentre gli altri
            // finiscono: se supera la soglia, qualcosa si sta rovinando.
            const lampWaitS = !allReady && readyTimes.length > 0
                ? Math.floor((nowMs - Math.min(...readyTimes)) / 1000)
                : 0;

            const queuedAt = items.map(i => i.queued_at).filter(Boolean).sort()[0] ?? null;
            const firedAt = items.map(i => i.fired_at).filter(Boolean).sort()[0] ?? null;
            const ageS = Math.floor((nowMs - new Date(queuedAt ?? firedAt ?? nowMs).getTime()) / 1000);

            return {
                ...c,
                status,
                stations,
                waiting_station_ids: waiting,
                queued_at: queuedAt,
                fired_at: firedAt,
                age_seconds: Math.max(0, ageS),
                // Proposta che nessuno lancia da troppo tempo.
                stale_queued: status === 'QUEUED' && ageS >= PASSE_QUEUED_ALERT_SECONDS,
                // Una partita ha finito e le altre no, da troppo tempo.
                lagging: lampWaitS >= KDS_LAMP_ALERT_SECONDS,
                lamp_wait_seconds: lampWaitS,
                sync_delta_seconds: readyTimes.length > 1
                    ? Math.round((Math.max(...readyTimes) - Math.min(...readyTimes)) / 1000)
                    : 0,
            };
        });

        const stations = await queryWithRetry(
            `SELECT id, name, color, sort_order FROM stations WHERE is_active ORDER BY sort_order, id`
        );

        res.json({
            ...service,
            stations: stations.rows,
            // In corso prima, poi le proposte in attesa: sono le due domande
            // diverse che si fa il passe — cosa sta uscendo, cosa far partire.
            courses: courses.sort((a, b) => {
                if (a.status === 'QUEUED' && b.status !== 'QUEUED') return 1;
                if (b.status === 'QUEUED' && a.status !== 'QUEUED') return -1;
                // Dentro ogni blocco: prima ciò che è più urgente.
                if (a.lagging !== b.lagging) return a.lagging ? -1 : 1;
                return b.age_seconds - a.age_seconds;
            }),
        });
    } catch (err: any) {
        console.error('GET /kds/expediter error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Lancia un'uscita proposta: QUEUED → SENT, con il calcolo dello
// station_start_at per ogni partita. La sala propone, il passe decide quando.
app.post('/orders/:id/courses/:n/fire', authenticate, requirePermission('orders:expedite'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!(await ordersEnabledGuard(res))) { client.release(); return; }

        const orderId = parseInt(req.params.id, 10);
        const courseNo = parseInt(req.params.n, 10);
        if (!Number.isFinite(orderId) || !Number.isFinite(courseNo)) {
            client.release();
            return res.status(400).json({ error: 'Parametri non validi' });
        }

        await client.query('BEGIN');
        const fired = await fireCourseInTx(client, orderId, courseNo);
        if (fired.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: "L'uscita non è in attesa di lancio" });
        }
        await client.query('COMMIT');
        client.release();

        const view = await loadOrderView(orderId);
        try {
            socketService?.broadcastToAll('course:fired', {
                order_id: orderId, course_no: courseNo,
                table_id: view.order.table_id, items: fired,
            });
            for (const st of new Set(fired.map((i: any) => i.station_id))) {
                socketService?.broadcastToStation(st as number | null, 'kds:fired', {
                    order_id: orderId, course_no: courseNo, table_id: view.order.table_id,
                    items: fired.filter((i: any) => i.station_id === st),
                });
            }
        } catch (_) {}

        res.json({ order_id: orderId, course_no: courseNo, items: fired });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('POST /orders/:id/courses/:n/fire error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Ri-lancio: ricalcola gli station_start_at da adesso. Serve la sera che una
// partita accumula venti minuti di ritardo e il calcolo teorico diventa
// fantascienza — senza, l'unica alternativa è che le altre partite ignorino
// il monitor, e da lì il sistema è morto.
app.post('/orders/:id/courses/:n/refire', authenticate, requirePermission('orders:expedite'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!(await ordersEnabledGuard(res))) { client.release(); return; }

        const orderId = parseInt(req.params.id, 10);
        const courseNo = parseInt(req.params.n, 10);
        if (!Number.isFinite(orderId) || !Number.isFinite(courseNo)) {
            client.release();
            return res.status(400).json({ error: 'Parametri non validi' });
        }

        await client.query('BEGIN');
        // Solo le righe non ancora iniziate: quello che il cuoco ha già in
        // mano non si tocca, altrimenti gli si sposta il lavoro sotto i piedi.
        const upd = await client.query(
            `WITH prep AS (
                 SELECT oi.id, COALESCE(d.prep_minutes, 0) AS p
                 FROM order_items oi
                 LEFT JOIN dishes d ON d.id = oi.dish_id
                 WHERE oi.order_id = $1 AND oi.course_no = $2 AND oi.status = 'SENT'
             ), mx AS (
                 SELECT COALESCE(MAX(p), 0) AS m FROM prep
             )
             UPDATE order_items oi
             SET fired_at = CURRENT_TIMESTAMP,
                 station_start_at = CURRENT_TIMESTAMP
                     + make_interval(mins => (SELECT m FROM mx) - prep.p)
             FROM prep, mx
             WHERE oi.id = prep.id
             RETURNING oi.*`,
            [orderId, courseNo]
        );
        if (upd.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'Nessuna riga da ri-lanciare (già in preparazione o pronta)' });
        }
        await client.query('COMMIT');
        client.release();

        try {
            for (const st of new Set(upd.rows.map((i: any) => i.station_id))) {
                socketService?.broadcastToStation(st as number | null, 'kds:fired', {
                    order_id: orderId, course_no: courseNo,
                    items: upd.rows.filter((i: any) => i.station_id === st),
                });
            }
        } catch (_) {}

        res.json({ order_id: orderId, course_no: courseNo, items: upd.rows });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('POST /orders/:id/courses/:n/refire error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Chiama la sala: l'uscita è pronta, qualcuno la venga a prendere. Notifica
// push ai camerieri invece dell'urlo dalla cucina.
app.post('/orders/:id/courses/:n/call', authenticate, requirePermission('orders:expedite'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const orderId = parseInt(req.params.id, 10);
        const courseNo = parseInt(req.params.n, 10);
        if (!Number.isFinite(orderId) || !Number.isFinite(courseNo)) {
            return res.status(400).json({ error: 'Parametri non validi' });
        }

        const info = await queryWithRetry(
            `SELECT t.name AS table_name
             FROM orders o LEFT JOIN tables t ON t.id = o.table_id
             WHERE o.id = $1`,
            [orderId]
        );
        if (info.rows.length === 0) return res.status(404).json({ error: 'Comanda non trovata' });
        const tableName = info.rows[0].table_name ?? '—';

        try {
            socketService?.broadcastToAll('course:called', {
                order_id: orderId, course_no: courseNo, table_name: tableName,
            });
        } catch (_) {}
        // La push è best-effort: se fallisce il monitor mostra comunque
        // l'uscita pronta, non si perde niente.
        pushSendToRoles(
            ['WAITER', 'MANAGER', 'GENERAL_MANAGER', 'OWNER'],
            {
                category: 'service',
                title: `Tavolo ${tableName} — servizio`,
                body: `${courseNo}ª uscita pronta al passe`,
                url: `/?view=COMANDE`,
                tag: `course-${orderId}-${courseNo}`,
            }
        ).catch(err => console.warn('[passe] push non inviata:', err?.message ?? err));

        res.json({ ok: true, table_name: tableName });
    } catch (err: any) {
        console.error('POST /orders/:id/courses/:n/call error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Ponte comanda → conto (PR 6) -------------------------------------------
// `table_bills.total_cents` smette di essere un numero digitato dal cameriere
// e diventa la somma delle righe non stornate. È la parte delicata del piano,
// perché tocca il pay-at-table già in produzione.

class BillSyncError extends Error {
    constructor(message: string, readonly detail: Record<string, any>) {
        super(message);
    }
}

// Snapshot delle righe per `table_bills.items`: è il campo che la pagina
// pubblica userà per mostrare il dettaglio invece del solo totale, e che
// sblocca lo split per riga (PR 8).
async function billItemsSnapshot(client: any, billId: number): Promise<any[]> {
    const rows = await client.query(
        `SELECT oi.id, oi.name_snapshot, oi.qty, oi.unit_price_cents, oi.modifiers,
                oi.course_no, d.category
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN dishes d ON d.id = oi.dish_id
         WHERE o.table_bill_id = $1 AND oi.status <> 'VOIDED'
         ORDER BY oi.course_no, oi.id`,
        [billId]
    );
    return rows.rows.map((r: any) => {
        const mods: any[] = Array.isArray(r.modifiers) ? r.modifiers : [];
        const delta = mods.reduce((s, m) => s + Number(m?.price_delta_cents || 0), 0);
        return {
            order_item_id: r.id,
            name: mods.length > 0 ? `${r.name_snapshot} (${mods.map(m => m.name).join(', ')})` : r.name_snapshot,
            qty: Number(r.qty),
            unit_price_cents: Number(r.unit_price_cents) + delta,
            category: r.category ?? null,
            course_no: r.course_no,
        };
    });
}

// Riallinea il conto alle righe. Da chiamare dentro una transazione che ha
// già il lock sul bill.
//
// Il conflitto vero: il totale può SCENDERE (uno storno) sotto quanto gli
// ospiti hanno già impegnato. Il trigger esistente protegge dal caso opposto
// (split che sfondano il totale) ma non da questo.
async function syncBillTotalInTx(client: any, billId: number): Promise<any> {
    const billRs = await client.query(
        `SELECT id, total_cents, status FROM table_bills WHERE id = $1 FOR UPDATE`,
        [billId]
    );
    if (billRs.rowCount === 0) throw new BillSyncError('Conto non trovato', { bill_id: billId });
    const bill = billRs.rows[0];
    if (!['OPEN', 'LOCKED', 'SETTLED', 'SETTLED_PARTIAL'].includes(bill.status)) {
        throw new BillSyncError('Il conto non è più modificabile', { status: bill.status });
    }

    // Una riga per comanda: lo sconto è per comanda, quindi va applicato
    // prima di sommare, non sul totale aggregato.
    const totalRs = await client.query(
        `SELECT o.id, o.discount_type, o.discount_value,
                COALESCE(SUM(
                    (oi.unit_price_cents + COALESCE((
                        SELECT SUM((m->>'price_delta_cents')::int)
                        FROM jsonb_array_elements(COALESCE(oi.modifiers, '[]'::jsonb)) m
                    ), 0)) * oi.qty
                ) FILTER (WHERE oi.status <> 'VOIDED'), 0)::int AS subtotal
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE o.table_bill_id = $1
         GROUP BY o.id, o.discount_type, o.discount_value`,
        [billId]
    );
    const newTotal: number = totalRs.rows.reduce(
        (sum: number, r: any) => sum + applyDiscount(Number(r.subtotal), r.discount_type, r.discount_value),
        0
    );

    const splitsRs = await client.query(
        `SELECT id, amount_cents, status, claimed_at
         FROM table_bill_splits
         WHERE table_bill_id = $1 AND status IN ('CLAIMED','PAID')
         ORDER BY claimed_at DESC`,
        [billId]
    );
    const paid = splitsRs.rows.filter((s: any) => s.status === 'PAID')
                              .reduce((n: number, s: any) => n + s.amount_cents, 0);
    const claimed = splitsRs.rows.filter((s: any) => s.status === 'CLAIMED')
                                 .reduce((n: number, s: any) => n + s.amount_cents, 0);

    // Sotto il già pagato non si scende: la strada corretta è il rimborso
    // Revolut, che esiste già ed è tracciato.
    if (newTotal < paid) {
        throw new BillSyncError(
            'Il nuovo totale è inferiore a quanto già incassato: serve un rimborso',
            { new_total_cents: newTotal, paid_cents: paid, bill_id: billId }
        );
    }

    // Fra il pagato e l'impegnato: rilasciamo i claim non pagati più recenti
    // finché il totale rientra. Gli ospiti vedono il residuo aggiornarsi.
    const released: number[] = [];
    if (newTotal < paid + claimed) {
        let excess = paid + claimed - newTotal;
        for (const s of splitsRs.rows.filter((r: any) => r.status === 'CLAIMED')) {
            if (excess <= 0) break;
            await client.query(
                `UPDATE table_bill_splits
                 SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status = 'CLAIMED'`,
                [s.id]
            );
            released.push(s.id);
            excess -= s.amount_cents;
        }
    }

    // total_cents ha un CHECK > 0: una comanda svuotata non può azzerare il
    // conto. Teniamo il minimo tecnico di 1 centesimo e lasciamo che sia il
    // cameriere ad annullare il conto, che è la decisione giusta comunque.
    const items = await billItemsSnapshot(client, billId);
    const upd = await client.query(
        `UPDATE table_bills
         SET total_cents = GREATEST($2, 1), items = $3::jsonb
         WHERE id = $1
         RETURNING id, reservation_id, table_id, total_cents, covers, currency,
                   items, status, share_token, opened_at, closed_at,
                   opened_by_user_id, closed_by_user_id, external_ref,
                   cash_settled_cents, tip_cents, notes`,
        [billId, newTotal, JSON.stringify(items)]
    );
    return { bill: upd.rows[0], released_split_ids: released, computed_total_cents: newTotal };
}

// Riallineamento fuori transazione, usato dopo ogni mutazione di riga. Non
// deve mai far fallire l'operazione sulla comanda: se il conto non si può
// aggiornare lo segnaliamo, ma la riga resta com'è.
async function resyncBillForOrder(orderId: number): Promise<{ warning?: string } | null> {
    const o = await queryWithRetry(`SELECT table_bill_id FROM orders WHERE id = $1`, [orderId]);
    const billId = o.rows[0]?.table_bill_id;
    if (!billId) return null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await syncBillTotalInTx(client, billId);
        await client.query('COMMIT');
        try { socketService?.broadcastToAll('bill:updated', result.bill); } catch (_) {}
        return null;
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        if (err instanceof BillSyncError) {
            console.warn(`[bill-sync] conto ${billId} non riallineato:`, err.message, err.detail);
            return { warning: err.message };
        }
        console.error('[bill-sync] errore:', err);
        return { warning: 'Conto non riallineato' };
    } finally {
        client.release();
    }
}

// Coperti modificabili dopo l'apertura: per un walk-in il numero iniziale è
// una stima dai posti del tavolo, e alimenta lo split equo del conto.
app.patch('/orders/:id', authenticate, requirePermission('orders:take'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });

        const sets: string[] = [];
        const vals: any[] = [];
        const push = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

        if (req.body?.covers != null) {
            const c = Math.round(Number(req.body.covers));
            if (!Number.isFinite(c) || c <= 0) return res.status(400).json({ error: 'covers deve essere > 0' });
            push('covers', c);
        }
        if (req.body?.notes !== undefined) {
            push('notes', typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : null);
        }
        if (sets.length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

        vals.push(id);
        const upd = await queryWithRetry(
            `UPDATE orders SET ${sets.join(', ')} WHERE id = $${vals.length} AND status = 'OPEN' RETURNING *`,
            vals
        );
        if (upd.rows.length === 0) return res.status(404).json({ error: 'Comanda non trovata o non aperta' });

        // Cambiare i coperti cambia la riga "Coperto".
        if (req.body?.covers != null) {
            await syncSystemLines(id);
            await resyncBillForOrder(id);
        }
        // I coperti viaggiano anche sul conto: è il divisore dello split equo.
        if (upd.rows[0].table_bill_id && req.body?.covers != null) {
            await queryWithRetry(
                `UPDATE table_bills SET covers = $2 WHERE id = $1`,
                [upd.rows[0].table_bill_id, upd.rows[0].covers]
            );
        }

        const view = await loadOrderView(id);
        try { socketService?.broadcastToAll('order:updated', view.order); } catch (_) {}
        res.json(view);
    } catch (err: any) {
        console.error('PATCH /orders/:id error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Chiude la comanda e apre (o aggiorna) il conto al tavolo, già valorizzato.
// È il punto in cui il gestionale di sala consegna il lavoro al pay-at-table
// esistente: da qui in poi valgono le regole del conto, non quelle della
// comanda.
app.post('/orders/:id/close', authenticate, requirePermission('orders:take'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!(await ordersEnabledGuard(res))) { client.release(); return; }
        const orderId = parseInt(req.params.id, 10);
        if (!Number.isFinite(orderId)) { client.release(); return res.status(400).json({ error: 'id non valido' }); }

        await client.query('BEGIN');
        const ordRs = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
        if (ordRs.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(404).json({ error: 'Comanda non trovata' });
        }
        const order = ordRs.rows[0];
        if (order.status !== 'OPEN') {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'La comanda non è aperta', status: order.status });
        }

        // Righe mai lanciate: chiudere la comanda lasciandole in bozza
        // significherebbe farle sparire senza che nessuno le abbia mai viste.
        const pending = await client.query(
            `SELECT COUNT(*)::int AS n FROM order_items
             WHERE order_id = $1 AND status IN ('DRAFT','QUEUED')`,
            [orderId]
        );
        if (pending.rows[0].n > 0 && !req.body?.discard_pending) {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({
                error: 'Ci sono righe non ancora inviate in cucina',
                pending_items: pending.rows[0].n,
                hint: 'Invia o elimina le righe in bozza, oppure richiama con discard_pending: true',
            });
        }
        if (pending.rows[0].n > 0) {
            await client.query(
                `DELETE FROM order_items WHERE order_id = $1 AND status IN ('DRAFT','QUEUED')`,
                [orderId]
            );
        }

        // Quanto c'è davvero da pagare. Va calcolato PRIMA di creare il conto:
        // una comanda annullata in blocco, o chiusa dopo aver scartato le
        // bozze, non deve generare un conto da un centesimo con tanto di QR
        // pagabile — che è quello che succedeva col minimo tecnico imposto
        // dal CHECK su total_cents.
        const billableRs = await client.query(
            `SELECT COALESCE(SUM(
                        (oi.unit_price_cents + COALESCE((
                            SELECT SUM((m->>'price_delta_cents')::int)
                            FROM jsonb_array_elements(COALESCE(oi.modifiers, '[]'::jsonb)) m
                        ), 0)) * oi.qty
                    ), 0)::int AS total
             FROM order_items oi
             WHERE oi.order_id = $1 AND oi.status <> 'VOIDED'`,
            [orderId]
        );
        const billableCents: number = billableRs.rows[0].total;

        if (billableCents === 0 && !order.table_bill_id) {
            await client.query(
                `UPDATE orders
                 SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closed_by_user_id = $2
                 WHERE id = $1`,
                [orderId, req.user?.userId ?? null]
            );
            await client.query('COMMIT');
            client.release();
            try { socketService?.broadcastToAll('order:updated', { ...order, status: 'CLOSED' }); } catch (_) {}
            return res.json({
                order_id: orderId,
                bill: null,
                released_split_ids: [],
                message: 'Comanda chiusa senza conto: nessuna riga da pagare.',
            });
        }

        let billId: number | null = order.table_bill_id;
        if (!billId) {
            // Un conto attivo può esistere già (aperto a mano dal pay-at-table
            // prima che il modulo comande fosse acceso): lo riusiamo invece di
            // crearne un secondo, che l'indice unico rifiuterebbe comunque.
            const existing = await client.query(
                `SELECT id FROM table_bills
                 WHERE status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL')
                   AND ((reservation_id = $1 AND $1 IS NOT NULL)
                     OR (table_id = $2 AND $2 IS NOT NULL AND reservation_id IS NULL))
                 ORDER BY opened_at DESC LIMIT 1`,
                [order.reservation_id, order.table_id]
            );
            if (existing.rows.length > 0) {
                billId = existing.rows[0].id;
            } else {
                const shareToken = crypto.randomBytes(24).toString('base64url');
                const ins = await client.query(
                    `INSERT INTO table_bills
                        (reservation_id, table_id, total_cents, covers, share_token, opened_by_user_id)
                     VALUES ($1, $2, 1, $3, $4, $5)
                     RETURNING id`,
                    [order.reservation_id, order.table_id, order.covers, shareToken, req.user?.userId ?? null]
                );
                billId = ins.rows[0].id;
            }
            await client.query(`UPDATE orders SET table_bill_id = $2 WHERE id = $1`, [orderId, billId]);
        }

        let synced;
        try {
            synced = await syncBillTotalInTx(client, billId!);
        } catch (err: any) {
            await client.query('ROLLBACK'); client.release();
            if (err instanceof BillSyncError) {
                return res.status(409).json({ error: err.message, ...err.detail });
            }
            throw err;
        }

        await client.query(
            `UPDATE orders
             SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closed_by_user_id = $2
             WHERE id = $1`,
            [orderId, req.user?.userId ?? null]
        );
        await client.query('COMMIT');
        client.release();

        try {
            socketService?.broadcastToAll('bill:updated', synced.bill);
            socketService?.broadcastToAll('order:updated', { ...order, status: 'CLOSED', table_bill_id: billId });
        } catch (_) {}

        LogService.logActivity(
            req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
            ActivityAction.UPDATE, ResourceType.ORDER, orderId,
            `Comanda chiusa · tavolo ${order.table_id ?? '—'}`,
            { bill_id: billId, total_cents: synced.bill.total_cents, discarded_pending: pending.rows[0].n }
        ).catch(() => {});

        res.json({
            order_id: orderId,
            bill: synced.bill,
            released_split_ids: synced.released_split_ids,
        });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('POST /orders/:id/close error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Conto su un tavolo senza prenotazione. Gemello di POST /reservations/:id/bill
// per i walk-in, che finora non avevano percorso: `table_bills.reservation_id`
// era già nullable, mancava solo l'ingresso.
app.post('/tables/:id/bill', authenticate, requirePermission('payments:full'), async (req, res) => {
    try {
        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.status(403).json({
                error: 'feature_disabled',
                message: 'Il conto al tavolo è disattivato. Attivalo da Impostazioni → Conto al tavolo.',
            });
        }
        const tableId = parseInt(req.params.id, 10);
        if (!Number.isFinite(tableId)) return res.status(400).json({ error: 'id non valido' });

        const tbl = await queryWithRetry(`SELECT id, seats FROM tables WHERE id = $1`, [tableId]);
        if (tbl.rows.length === 0) return res.status(404).json({ error: 'Tavolo non trovato' });

        const totalCents = Number(req.body?.total_cents);
        if (!Number.isFinite(totalCents) || totalCents <= 0) {
            return res.status(400).json({ error: 'total_cents deve essere un intero positivo' });
        }
        const requested = req.body?.covers != null ? Number(req.body.covers) : NaN;
        const covers = Number.isFinite(requested) && requested > 0
            ? Math.round(requested)
            : Math.max(1, Number(tbl.rows[0].seats) || 1);

        const shareToken = crypto.randomBytes(24).toString('base64url');
        let inserted;
        try {
            inserted = await queryWithRetry(
                `INSERT INTO table_bills
                    (reservation_id, table_id, total_cents, covers, share_token, opened_by_user_id)
                 VALUES (NULL, $1, $2, $3, $4, $5)
                 RETURNING id, reservation_id, table_id, total_cents, covers, currency,
                           items, status, share_token, opened_at, closed_at,
                           opened_by_user_id, closed_by_user_id, external_ref,
                           cash_settled_cents, tip_cents, notes`,
                [tableId, Math.round(totalCents), covers, shareToken, req.user?.userId ?? null]
            );
        } catch (err: any) {
            // L'indice unico ha fatto il suo lavoro: c'è già un conto attivo.
            if (err?.code === '23505') {
                const existing = await queryWithRetry(
                    `SELECT id, status FROM table_bills
                     WHERE table_id = $1 AND reservation_id IS NULL
                       AND status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL')
                     LIMIT 1`,
                    [tableId]
                );
                return res.status(409).json({
                    error: 'Il tavolo ha già un conto attivo',
                    existing_bill_id: existing.rows[0]?.id,
                    existing_bill_status: existing.rows[0]?.status,
                });
            }
            throw err;
        }

        const bill = inserted.rows[0];
        try { socketService?.broadcastToAll('bill:opened', bill); } catch (_) {}
        res.status(201).json({ bill, splits: [], paid_cents: 0, claimed_cents: 0, residual_cents: bill.total_cents });
    } catch (err: any) {
        console.error('POST /tables/:id/bill error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Storni, sconti, coperti e trasferimenti (PR 7) --------------------------

// Coperto e servizio come righe, non come campi del conto: si scontano con lo
// stesso codice degli altri importi e compaiono nel dettaglio che l'ospite
// vede dal QR. Ricalcolate a ogni mutazione — il servizio è una percentuale
// dell'imponibile, quindi si muove con le righe.
async function syncSystemLinesInTx(client: any, orderId: number): Promise<void> {
    const cfg = await client.query(
        `SELECT key, int_value FROM app_settings
         WHERE key IN ('cover_charge_cents','service_charge_percent')`
    );
    const map = Object.fromEntries(cfg.rows.map((r: any) => [r.key, Number(r.int_value ?? 0)]));
    const coverCents = Math.max(0, map.cover_charge_cents ?? 0);
    const servicePct = Math.max(0, map.service_charge_percent ?? 0);

    const ord = await client.query(`SELECT covers FROM orders WHERE id = $1`, [orderId]);
    if (ord.rows.length === 0) return;
    const covers = Number(ord.rows[0].covers);

    // Sempre ricreate da zero: inseguire le variazioni con UPDATE mirati
    // lascerebbe righe orfane appena cambia il numero di coperti.
    await client.query(
        `DELETE FROM order_items WHERE order_id = $1 AND line_kind IN ('COVER','SERVICE')`,
        [orderId]
    );

    if (coverCents > 0 && covers > 0) {
        await client.query(
            `INSERT INTO order_items
                (order_id, name_snapshot, unit_price_cents, qty, course_no, status, line_kind)
             VALUES ($1, 'Coperto', $2, $3, 1, 'SERVED', 'COVER')`,
            [orderId, coverCents, covers]
        );
    }

    if (servicePct > 0) {
        // Il servizio si calcola sull'imponibile dei piatti, non sul coperto:
        // addebitare il servizio sul servizio è il classico errore che il
        // cliente nota e contesta.
        const sub = await client.query(
            `SELECT COALESCE(SUM(
                        (oi.unit_price_cents + COALESCE((
                            SELECT SUM((m->>'price_delta_cents')::int)
                            FROM jsonb_array_elements(COALESCE(oi.modifiers, '[]'::jsonb)) m
                        ), 0)) * oi.qty
                    ), 0)::int AS total
             FROM order_items oi
             WHERE oi.order_id = $1 AND oi.status <> 'VOIDED' AND oi.line_kind = 'DISH'`,
            [orderId]
        );
        const amount = Math.round((Number(sub.rows[0].total) * servicePct) / 100);
        if (amount > 0) {
            await client.query(
                `INSERT INTO order_items
                    (order_id, name_snapshot, unit_price_cents, qty, course_no, status, line_kind)
                 VALUES ($1, $2, $3, 1, 1, 'SERVED', 'SERVICE')`,
                [orderId, `Servizio ${servicePct}%`, amount]
            );
        }
    }
}

async function syncSystemLines(orderId: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await syncSystemLinesInTx(client, orderId);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.warn('[order] righe di sistema non aggiornate:', (err as any)?.message ?? err);
    } finally {
        client.release();
    }
}

// Storno di una riga già inviata. Da SENT in poi non si cancella: si storna,
// con motivazione, e resta a bilancio come scarto.
app.post('/orders/items/:id/void', authenticate, requirePermission('orders:void'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });

        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (reason.length < 3) {
            return res.status(400).json({ error: 'Serve una motivazione (almeno 3 caratteri)' });
        }

        const upd = await queryWithRetry(
            `UPDATE order_items
             SET status = 'VOIDED', voided_at = CURRENT_TIMESTAMP,
                 voided_by_user_id = $2, void_reason = $3
             WHERE id = $1 AND status <> 'VOIDED'
             RETURNING *`,
            [id, req.user?.userId ?? null, reason.slice(0, 300)]
        );
        if (upd.rows.length === 0) {
            const cur = await queryWithRetry(`SELECT status FROM order_items WHERE id = $1`, [id]);
            if (cur.rows.length === 0) return res.status(404).json({ error: 'Riga non trovata' });
            return res.status(409).json({ error: 'Riga già stornata' });
        }
        const item = upd.rows[0];

        await syncSystemLines(item.order_id);
        const view = await loadOrderView(item.order_id);
        const sync = await resyncBillForOrder(item.order_id);

        try {
            // La cucina deve vedere sparire la riga dal monitor: continuare a
            // cucinare un piatto stornato è spreco puro.
            socketService?.broadcastToStation(item.station_id, 'orderItem:voided', {
                id: item.id, order_id: item.order_id, reason: item.void_reason,
            });
            socketService?.broadcastToAll('orderItem:voided', {
                id: item.id, order_id: item.order_id, station_id: item.station_id, reason: item.void_reason,
            });
            socketService?.broadcastToAll('order:updated', view.order);
        } catch (_) {}

        LogService.logActivity(
            req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
            ActivityAction.UPDATE, ResourceType.ORDER, item.order_id,
            `Storno · ${item.qty}× ${item.name_snapshot}`,
            {
                order_item_id: item.id,
                amount_cents: lineTotalCents(item),
                previous_status: item.status,
                reason: item.void_reason,
            }
        ).catch(() => {});

        res.json({ ...view, ...(sync?.warning ? { bill_warning: sync.warning } : {}) });
    } catch (err: any) {
        console.error('POST /orders/items/:id/void error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Sconto sulla comanda, con motivazione obbligatoria e traccia di chi l'ha
// concesso. Passa da `orders:void`, non da `orders:take`: regalare soldi non
// è la stessa cosa che prendere una comanda.
app.post('/orders/:id/discount', authenticate, requirePermission('orders:void'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });

        const clear = req.body?.discount_type == null;
        let type: string | null = null;
        let value: number | null = null;
        let reason: string | null = null;

        if (!clear) {
            type = req.body.discount_type;
            if (type !== 'PERCENT' && type !== 'AMOUNT') {
                return res.status(400).json({ error: "discount_type deve essere PERCENT o AMOUNT" });
            }
            value = Number(req.body.discount_value);
            if (!Number.isFinite(value) || value <= 0) {
                return res.status(400).json({ error: 'discount_value deve essere > 0' });
            }
            if (type === 'PERCENT' && value > 100) {
                return res.status(400).json({ error: 'Uno sconto percentuale non può superare il 100%' });
            }
            const raw = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
            if (raw.length < 3) {
                return res.status(400).json({ error: 'Serve una motivazione (almeno 3 caratteri)' });
            }
            reason = raw.slice(0, 300);
        }

        const upd = await queryWithRetry(
            `UPDATE orders
             SET discount_type = $2, discount_value = $3, discount_reason = $4,
                 discount_by_user_id = $5
             WHERE id = $1 AND status = 'OPEN'
             RETURNING *`,
            [id, type, value, reason, clear ? null : (req.user?.userId ?? null)]
        );
        if (upd.rows.length === 0) return res.status(404).json({ error: 'Comanda non trovata o non aperta' });

        const view = await loadOrderView(id);
        const sync = await resyncBillForOrder(id);
        try { socketService?.broadcastToAll('order:updated', view.order); } catch (_) {}

        LogService.logActivity(
            req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
            ActivityAction.UPDATE, ResourceType.ORDER, id,
            clear ? 'Sconto rimosso' : `Sconto ${type === 'PERCENT' ? `${value}%` : `${value} €`}`,
            { discount_type: type, discount_value: value, reason, total_after_cents: view.total_cents }
        ).catch(() => {});

        res.json({ ...view, ...(sync?.warning ? { bill_warning: sync.warning } : {}) });
    } catch (err: any) {
        console.error('POST /orders/:id/discount error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// Sposta la comanda su un altro tavolo, portandosi dietro il conto. Se ci
// sono già quote pagate il trasferimento è permesso ma loggato: i soldi
// restano attaccati al conto, non al tavolo.
app.post('/orders/:id/transfer', authenticate, requirePermission('orders:take'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!(await ordersEnabledGuard(res))) { client.release(); return; }
        const id = parseInt(req.params.id, 10);
        const targetId = Number(req.body?.table_id);
        if (!Number.isFinite(id) || !Number.isFinite(targetId)) {
            client.release();
            return res.status(400).json({ error: 'Parametri non validi' });
        }

        await client.query('BEGIN');
        const ord = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id]);
        if (ord.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(404).json({ error: 'Comanda non trovata' });
        }
        const order = ord.rows[0];
        if (order.status !== 'OPEN') {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'La comanda non è aperta', status: order.status });
        }
        if (order.table_id === targetId) {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({ error: 'La comanda è già su questo tavolo' });
        }

        const tbl = await client.query(`SELECT id, name FROM tables WHERE id = $1`, [targetId]);
        if (tbl.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(404).json({ error: 'Tavolo di destinazione non trovato' });
        }
        const busy = await client.query(
            `SELECT id FROM orders WHERE table_id = $1 AND status = 'OPEN' AND id <> $2 LIMIT 1`,
            [targetId, id]
        );
        if (busy.rows.length > 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(409).json({
                error: 'Il tavolo di destinazione ha già una comanda aperta',
                existing_order_id: busy.rows[0].id,
            });
        }

        // Il legame con la prenotazione si spezza: la prenotazione resta sul
        // vecchio tavolo, la comanda no. Tenerlo darebbe un conto agganciato
        // a una prenotazione che sta altrove.
        await client.query(
            `UPDATE orders SET table_id = $2, reservation_id = NULL WHERE id = $1`,
            [id, targetId]
        );
        let paidCents = 0;
        if (order.table_bill_id) {
            const paid = await client.query(
                `SELECT COALESCE(SUM(amount_cents),0)::int AS n FROM table_bill_splits
                 WHERE table_bill_id = $1 AND status = 'PAID'`,
                [order.table_bill_id]
            );
            paidCents = paid.rows[0].n;
            await client.query(
                `UPDATE table_bills SET table_id = $2, reservation_id = NULL WHERE id = $1`,
                [order.table_bill_id, targetId]
            );
        }
        await client.query('COMMIT');
        client.release();

        const view = await loadOrderView(id);
        try { socketService?.broadcastToAll('order:updated', view.order); } catch (_) {}

        LogService.logActivity(
            req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
            ActivityAction.UPDATE, ResourceType.ORDER, id,
            `Trasferimento al tavolo ${tbl.rows[0].name}`,
            { from_table_id: order.table_id, to_table_id: targetId, paid_cents: paidCents }
        ).catch(() => {});

        res.json({ ...view, paid_cents_moved: paidCents });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('POST /orders/:id/transfer error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Statistiche di cucina (PR 8) -------------------------------------------
// Il delta di sincronia è la metrica che dice se la cucina è coordinata:
// quanto tempo passa fra la prima riga pronta di un'uscita e l'ultima. Dice
// dov'è il collo di bottiglia con un numero, invece che con le impressioni
// del sabato sera.
app.get('/reports/kitchen', authenticate, requirePermission('orders:expedite'), async (req, res) => {
    try {
        if (!(await ordersEnabledGuard(res))) return;

        const from = typeof req.query.from === 'string' ? req.query.from : null;
        const to = typeof req.query.to === 'string' ? req.query.to : null;

        // Tempo di preparazione reale per partita: da quando la riga doveva
        // iniziare a quando è stata dichiarata pronta. Mediana oltre alla
        // media, perché una sola comanda dimenticata sposta la media e non la
        // mediana.
        const perStation = await queryWithRetry(
            `SELECT s.id AS station_id, s.name AS station_name,
                    COUNT(*)::int AS righe,
                    ROUND(AVG(GREATEST(0, EXTRACT(epoch FROM (oi.ready_at - COALESCE(oi.station_start_at, oi.fired_at)))))/60.0, 1) AS media_min,
                    ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
                        ORDER BY GREATEST(0, EXTRACT(epoch FROM (oi.ready_at - COALESCE(oi.station_start_at, oi.fired_at))))
                    ))::numeric/60.0, 1) AS mediana_min,
                    COUNT(*) FILTER (WHERE oi.status = 'VOIDED')::int AS stornate
             FROM order_items oi
             LEFT JOIN stations s ON s.id = oi.station_id
             WHERE oi.ready_at IS NOT NULL AND oi.line_kind = 'DISH'
               AND ($1::date IS NULL OR oi.fired_at >= $1::date)
               AND ($2::date IS NULL OR oi.fired_at < ($2::date + INTERVAL '1 day'))
             GROUP BY s.id, s.name
             ORDER BY s.sort_order NULLS LAST, s.id`,
            [from, to]
        );

        // Delta di sincronia per uscita completata.
        const sync = await queryWithRetry(
            `WITH uscite AS (
                 SELECT oi.order_id, oi.course_no,
                        MAX(oi.ready_at) - MIN(oi.ready_at) AS delta,
                        COUNT(DISTINCT oi.station_id)::int AS partite
                 FROM order_items oi
                 WHERE oi.status IN ('READY','SERVED') AND oi.line_kind = 'DISH'
                   AND oi.ready_at IS NOT NULL
                   AND ($1::date IS NULL OR oi.fired_at >= $1::date)
                   AND ($2::date IS NULL OR oi.fired_at < ($2::date + INTERVAL '1 day'))
                 GROUP BY oi.order_id, oi.course_no
                 HAVING COUNT(*) > 1
             )
             SELECT COUNT(*)::int AS uscite,
                    COUNT(*) FILTER (WHERE partite > 1)::int AS uscite_multipartita,
                    ROUND(AVG(EXTRACT(epoch FROM delta))/60.0, 1) AS delta_medio_min,
                    ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM delta)))::numeric/60.0, 1) AS delta_mediano_min,
                    ROUND(MAX(EXTRACT(epoch FROM delta))/60.0, 1) AS delta_massimo_min
             FROM uscite`,
            [from, to]
        );

        // Attesa al passe: quanto restano ferme le proposte prima del lancio.
        // È il costo del modello proponi/lancia, ed è giusto poterlo misurare.
        const passe = await queryWithRetry(
            // GREATEST(0, …): un'attesa negativa non esiste. In esercizio
            // fired_at segue sempre queued_at, ma un report non deve poter
            // mostrare un numero senza senso se i dati si disallineano.
            `SELECT COUNT(*)::int AS uscite,
                    ROUND(AVG(GREATEST(0, EXTRACT(epoch FROM (fired_at - queued_at))))/60.0, 1) AS attesa_media_min,
                    ROUND(MAX(GREATEST(0, EXTRACT(epoch FROM (fired_at - queued_at))))/60.0, 1) AS attesa_massima_min
             FROM (
                 SELECT MIN(queued_at) AS queued_at, MIN(fired_at) AS fired_at
                 FROM order_items
                 WHERE queued_at IS NOT NULL AND fired_at IS NOT NULL AND line_kind = 'DISH'
                   AND ($1::date IS NULL OR fired_at >= $1::date)
                   AND ($2::date IS NULL OR fired_at < ($2::date + INTERVAL '1 day'))
                 GROUP BY order_id, course_no
             ) q`,
            [from, to]
        );

        // Scarto: cosa è stato stornato e perché. La motivazione è
        // obbligatoria dalla PR 7, quindi qui c'è sempre qualcosa da leggere.
        const scarti = await queryWithRetry(
            `SELECT oi.void_reason AS motivo, COUNT(*)::int AS righe,
                    SUM((oi.unit_price_cents + COALESCE((
                        SELECT SUM((m->>'price_delta_cents')::int)
                        FROM jsonb_array_elements(COALESCE(oi.modifiers, '[]'::jsonb)) m
                    ), 0)) * oi.qty)::int AS valore_cents
             FROM order_items oi
             WHERE oi.status = 'VOIDED' AND oi.line_kind = 'DISH'
               AND ($1::date IS NULL OR oi.voided_at >= $1::date)
               AND ($2::date IS NULL OR oi.voided_at < ($2::date + INTERVAL '1 day'))
             GROUP BY oi.void_reason
             ORDER BY valore_cents DESC NULLS LAST
             LIMIT 10`,
            [from, to]
        );

        res.json({
            from, to,
            partite: perStation.rows,
            sincronia: sync.rows[0],
            passe: passe.rows[0],
            scarti: scarti.rows,
        });
    } catch (err: any) {
        console.error('GET /reports/kitchen error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Conti aperti (PR 9) ----------------------------------------------------
// L'interfaccia del conto è sempre vissuta dentro il dettaglio prenotazione,
// quindi un conto walk-in — creato correttamente dal modulo comande — non era
// raggiungibile da nessuna schermata: niente QR, niente chiusura. Questo
// endpoint elenca i conti attivi per tavolo, con o senza prenotazione.
app.get('/bills/open', authenticate, requirePermission('payments:view'), async (_req, res) => {
    try {
        if (!(await getFeatureFlag('pay_at_table_enabled', false))) {
            return res.json({ bills: [] });
        }

        const service = resolveService();
        const rows = await queryWithRetry(
            `SELECT b.id, b.reservation_id, b.table_id, b.total_cents, b.covers,
                    b.currency, b.items, b.status, b.share_token, b.opened_at,
                    b.cash_settled_cents, b.tip_cents,
                    t.name AS table_name,
                    r.customer_name,
                    -- Il servizio del conto arriva dalla comanda; per un conto
                    -- aperto a mano (senza comanda) si deduce dall'orario con
                    -- la stessa regola del giorno di servizio.
                    COALESCE(
                        (SELECT o.service_date FROM orders o WHERE o.table_bill_id = b.id ORDER BY o.id LIMIT 1),
                        CASE WHEN EXTRACT(hour FROM (b.opened_at AT TIME ZONE 'Europe/Rome')) < 5
                             THEN ((b.opened_at AT TIME ZONE 'Europe/Rome') - INTERVAL '1 day')::date
                             ELSE (b.opened_at AT TIME ZONE 'Europe/Rome')::date END
                    ) AS service_date,
                    COALESCE(
                        (SELECT o.shift FROM orders o WHERE o.table_bill_id = b.id ORDER BY o.id LIMIT 1),
                        CASE WHEN EXTRACT(hour FROM (b.opened_at AT TIME ZONE 'Europe/Rome')) BETWEEN 5 AND 16
                             THEN 'LUNCH' ELSE 'DINNER' END
                    ) AS shift,
                    COALESCE(SUM(s.amount_cents) FILTER (WHERE s.status = 'PAID'), 0)::int AS paid_cents,
                    COALESCE(SUM(s.amount_cents) FILTER (WHERE s.status = 'CLAIMED'), 0)::int AS claimed_cents,
                    COUNT(s.id) FILTER (WHERE s.status = 'PAID')::int AS paid_splits,
                    (SELECT COUNT(*) FROM orders o WHERE o.table_bill_id = b.id AND o.status = 'OPEN')::int AS open_orders
             FROM table_bills b
             LEFT JOIN tables t ON t.id = b.table_id
             LEFT JOIN reservations r ON r.id = b.reservation_id
             LEFT JOIN table_bill_splits s ON s.table_bill_id = b.id
             WHERE b.status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL')
             GROUP BY b.id, t.name, r.customer_name
             ORDER BY b.opened_at DESC`
        );

        // Comande rimaste aperte in servizi precedenti: non compaiono più in
        // sala né in cucina, quindi devono comparire qui — altrimenti un
        // tavolo mai chiuso sparisce senza che nessuno se ne accorga.
        const stale = await queryWithRetry(
            `SELECT o.id, o.table_id, t.name AS table_name, o.service_date, o.shift,
                    o.covers, o.opened_at,
                    COALESCE(SUM(
                        (oi.unit_price_cents + COALESCE((
                            SELECT SUM((m->>'price_delta_cents')::int)
                            FROM jsonb_array_elements(COALESCE(oi.modifiers, '[]'::jsonb)) m
                        ), 0)) * oi.qty
                    ) FILTER (WHERE oi.status <> 'VOIDED'), 0)::int AS total_cents
             FROM orders o
             LEFT JOIN tables t ON t.id = o.table_id
             LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.status = 'OPEN'
               AND (o.service_date, o.shift) IS DISTINCT FROM ($1::date, $2::varchar)
             GROUP BY o.id, t.name
             ORDER BY o.service_date DESC, o.opened_at DESC`,
            [service.service_date, service.shift]
        );

        res.json({
            service,
            bills: rows.rows.map((b: any) => ({
                ...b,
                service_date: b.service_date instanceof Date
                    ? b.service_date.toISOString().slice(0, 10)
                    : b.service_date,
                is_current_service:
                    String(b.service_date instanceof Date
                        ? b.service_date.toISOString().slice(0, 10)
                        : b.service_date) === service.service_date
                    && b.shift === service.shift,
                residual_cents: Math.max(0, b.total_cents - b.paid_cents - b.claimed_cents),
            })),
            stale_orders: stale.rows.map((o: any) => ({
                ...o,
                service_date: o.service_date instanceof Date
                    ? o.service_date.toISOString().slice(0, 10)
                    : o.service_date,
            })),
        });
    } catch (err: any) {
        console.error('GET /bills/open error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// --- Stampa preconti (Ditron PRP-300 via agente locale) ---------------------
// Il backend può stare in cloud, la termica sta in sala: in mezzo c'è una
// coda a DB. Il palmare accoda (POST /print-jobs), l'agente sulla LAN del
// ristorante ritira e conferma (endpoint /print-agent/*, autenticati con un
// token condiviso via env — l'agente è un processo, non un utente).
// Heartbeat dell'agente: l'ultimo poll visto, tenuto in memoria (una sola
// istanza backend). Impostazioni lo mostra come online/offline, così un
// Raspberry spento si scopre PRIMA del servizio, non alla prima comanda persa.
let printAgentLastSeen: number | null = null;

const printAgentAuth = (req: any, res: any, next: any) => {
    const expected = process.env.PRINT_AGENT_TOKEN;
    if (!expected) {
        return res.status(503).json({ error: 'print_agent_not_configured' });
    }
    if (req.headers['x-print-agent-token'] !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    printAgentLastSeen = Date.now();
    next();
};

app.post('/print-jobs', authenticate, requirePermission('orders:take'), async (req, res) => {
    try {
        const billId = Number(req.body?.bill_id);
        if (!Number.isFinite(billId)) return res.status(400).json({ error: 'bill_id non valido' });

        const b = await queryWithRetry(
            `SELECT b.*, t.name AS table_name FROM table_bills b
             LEFT JOIN tables t ON t.id = b.table_id
             WHERE b.id = $1`,
            [billId]
        );
        if (b.rows.length === 0) return res.status(404).json({ error: 'Conto non trovato' });
        const bill = b.rows[0];

        // L'origin per l'URL nel QR arriva dal client: è l'unico che sa da che
        // host è servita la SPA (in LAN è un IP, in prod il dominio). Il path
        // però lo componiamo noi dal token a DB — del body ci fidiamo solo
        // dell'origine, mai di un URL intero.
        const rawOrigin = typeof req.body?.origin === 'string' ? req.body.origin : '';
        const origin = /^https?:\/\/[a-z0-9.\-:\[\]]+$/i.test(rawOrigin) ? rawOrigin : null;
        const shareUrl = bill.share_token && origin ? `${origin}/pay/${bill.share_token}` : null;

        const items = (Array.isArray(bill.items) ? bill.items : []).map((i: any) => ({
            name: String(i.name ?? ''),
            qty: Number(i.qty ?? 1),
            total_cents: Number(i.unit_price_cents ?? 0) * Number(i.qty ?? 1),
        }));

        const printer = /^[a-z0-9_-]{1,30}$/i.test(String(req.body?.printer ?? ''))
            ? String(req.body.printer) : 'preconti';
        const ins = await queryWithRetry(
            `INSERT INTO print_jobs (kind, payload, printer, created_by_user_id)
             VALUES ('PRECONTO', $1, $3, $2) RETURNING id`,
            [JSON.stringify({
                bill_id: bill.id,
                table_name: bill.table_name ?? null,
                covers: bill.covers,
                total_cents: bill.total_cents,
                items,
                share_url: shareUrl,
            }), req.user?.userId ?? null, printer]
        );
        res.status(201).json({ id: ins.rows[0].id, status: 'PENDING' });
    } catch (err: any) {
        console.error('POST /print-jobs error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

// La mappa nome→indirizzo per l'agente, dal registro a DB. L'agente la
// scarica a ogni poll: aggiungere una termica da Impostazioni diventa
// effettivo in un paio di secondi, senza toccare l'agente.
app.get('/print-agent/config', printAgentAuth, async (_req, res) => {
    try {
        const rows = await queryWithRetry(
            `SELECT name, host, port FROM printers
             WHERE kind = 'THERMAL' AND is_active ORDER BY name`
        );
        res.json({ printers: rows.rows });
    } catch (err: any) {
        console.error('GET /print-agent/config error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/print-agent/jobs', printAgentAuth, async (_req, res) => {
    try {
        const rows = await queryWithRetry(
            `SELECT id, kind, payload, printer, attempts FROM print_jobs
             WHERE status = 'PENDING' ORDER BY id LIMIT 10`
        );
        res.json({ jobs: rows.rows });
    } catch (err: any) {
        console.error('GET /print-agent/jobs error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/print-agent/jobs/:id/ack', printAgentAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        if (req.body?.ok) {
            await queryWithRetry(
                `UPDATE print_jobs SET status = 'PRINTED', printed_at = CURRENT_TIMESTAMP, error = NULL
                 WHERE id = $1`, [id]
            );
        } else {
            // Dopo troppi tentativi il job si arena come FAILED invece di
            // bloccare per sempre la testa della coda (es. payload malformato).
            await queryWithRetry(
                `UPDATE print_jobs
                 SET attempts = attempts + 1,
                     error = $2,
                     status = CASE WHEN attempts + 1 >= 20 THEN 'FAILED' ELSE 'PENDING' END
                 WHERE id = $1`,
                [id, String(req.body?.error ?? 'errore sconosciuto').slice(0, 500)]
            );
        }
        res.json({ ok: true });
    } catch (err: any) {
        console.error('POST /print-agent/jobs/:id/ack error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Impostazioni → Sala & Cucina -------------------------------------------
// Configurazione operativa del modulo comande: fire mode, partite (con la
// scelta schermo/stampante) e registro stampanti. Letture per chiunque entri
// in Impostazioni, scritture solo per chi ha settings:full.

const PRINTER_NAME_RE = /^[a-z0-9_-]{1,30}$/;
const FIRE_MODES = ['AUTO_ALL', 'AUTO_FIRST', 'MANUAL'];

app.get('/sala/config', authenticate, async (_req, res) => {
    try {
        const [fireMode, stations, printers, jobs] = await Promise.all([
            getCourseFireMode(),
            queryWithRetry(`SELECT id, name, color, sort_order, is_active, printer FROM stations ORDER BY sort_order, id`),
            queryWithRetry(`SELECT id, name, host, port, kind, is_active, notes FROM printers ORDER BY kind, name`),
            queryWithRetry(`SELECT status, COUNT(*)::int AS n FROM print_jobs WHERE status IN ('PENDING','FAILED') GROUP BY status`),
        ]);
        const jobCount = (s: string) => jobs.rows.find((r: any) => r.status === s)?.n ?? 0;
        res.json({
            fire_mode: fireMode,
            stations: stations.rows,
            printers: printers.rows,
            agent: {
                online: printAgentLastSeen != null && Date.now() - printAgentLastSeen < 30_000,
                last_seen_seconds: printAgentLastSeen != null ? Math.round((Date.now() - printAgentLastSeen) / 1000) : null,
            },
            pending_jobs: jobCount('PENDING'),
            failed_jobs: jobCount('FAILED'),
        });
    } catch (err: any) {
        console.error('GET /sala/config error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/sala/fire-mode', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const mode = String(req.body?.mode ?? '');
        if (!FIRE_MODES.includes(mode)) return res.status(400).json({ error: 'Fire mode non valido' });
        await queryWithRetry(
            `INSERT INTO app_settings (key, text_value) VALUES ('course_fire_mode', $1)
             ON CONFLICT (key) DO UPDATE SET text_value = $1, updated_at = CURRENT_TIMESTAMP`,
            [mode]
        );
        res.json({ fire_mode: mode });
    } catch (err: any) {
        console.error('PUT /sala/fire-mode error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Partite: niente DELETE — una partita con storico di comande si disattiva,
// non si cancella (le statistiche di cucina la referenziano per sempre).
app.post('/sala/stations', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const name = String(req.body?.name ?? '').trim();
        if (!name || name.length > 50) return res.status(400).json({ error: 'Nome non valido' });
        const printer = req.body?.printer != null ? String(req.body.printer) : null;
        if (printer !== null && !PRINTER_NAME_RE.test(printer)) return res.status(400).json({ error: 'Stampante non valida' });
        const ins = await queryWithRetry(
            `INSERT INTO stations (name, color, sort_order, printer)
             VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM stations), $3)
             RETURNING id, name, color, sort_order, is_active, printer`,
            [name, req.body?.color ?? null, printer]
        );
        res.status(201).json(ins.rows[0]);
    } catch (err: any) {
        if (err?.code === '23505') return res.status(409).json({ error: 'Esiste già una partita con questo nome' });
        console.error('POST /sala/stations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/sala/stations/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const name = req.body?.name != null ? String(req.body.name).trim() : null;
        if (name !== null && (!name || name.length > 50)) return res.status(400).json({ error: 'Nome non valido' });
        // printer: assente = non toccare; null esplicito = solo schermo.
        const touchPrinter = 'printer' in (req.body ?? {});
        const printer = touchPrinter && req.body.printer != null ? String(req.body.printer) : null;
        if (touchPrinter && printer !== null && !PRINTER_NAME_RE.test(printer)) {
            return res.status(400).json({ error: 'Stampante non valida' });
        }
        const upd = await queryWithRetry(
            `UPDATE stations SET
                name = COALESCE($2, name),
                color = COALESCE($3, color),
                is_active = COALESCE($4, is_active),
                printer = CASE WHEN $5 THEN $6 ELSE printer END
             WHERE id = $1
             RETURNING id, name, color, sort_order, is_active, printer`,
            [id, name, req.body?.color ?? null,
             typeof req.body?.is_active === 'boolean' ? req.body.is_active : null,
             touchPrinter, printer]
        );
        if (upd.rows.length === 0) return res.status(404).json({ error: 'Partita non trovata' });
        res.json(upd.rows[0]);
    } catch (err: any) {
        if (err?.code === '23505') return res.status(409).json({ error: 'Esiste già una partita con questo nome' });
        console.error('PUT /sala/stations/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/sala/printers', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const name = String(req.body?.name ?? '').trim().toLowerCase();
        const host = String(req.body?.host ?? '').trim();
        const port = req.body?.port != null ? Number(req.body.port) : 9100;
        const kind = req.body?.kind === 'FISCAL' ? 'FISCAL' : 'THERMAL';
        if (!PRINTER_NAME_RE.test(name)) return res.status(400).json({ error: 'Nome non valido: minuscole, numeri, - e _' });
        if (!/^[a-z0-9.\-]+$/i.test(host)) return res.status(400).json({ error: 'Indirizzo non valido' });
        if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Porta non valida' });
        const ins = await queryWithRetry(
            `INSERT INTO printers (name, host, port, kind, notes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, host, port, kind, is_active, notes`,
            [name, host, port, kind, req.body?.notes ? String(req.body.notes).slice(0, 300) : null]
        );
        res.status(201).json(ins.rows[0]);
    } catch (err: any) {
        if (err?.code === '23505') return res.status(409).json({ error: 'Esiste già una stampante con questo nome' });
        console.error('POST /sala/printers error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/sala/printers/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const host = req.body?.host != null ? String(req.body.host).trim() : null;
        if (host !== null && !/^[a-z0-9.\-]+$/i.test(host)) return res.status(400).json({ error: 'Indirizzo non valido' });
        const port = req.body?.port != null ? Number(req.body.port) : null;
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return res.status(400).json({ error: 'Porta non valida' });
        const upd = await queryWithRetry(
            `UPDATE printers SET
                host = COALESCE($2, host),
                port = COALESCE($3, port),
                is_active = COALESCE($4, is_active),
                notes = COALESCE($5, notes)
             WHERE id = $1
             RETURNING id, name, host, port, kind, is_active, notes`,
            [id, host, port,
             typeof req.body?.is_active === 'boolean' ? req.body.is_active : null,
             req.body?.notes != null ? String(req.body.notes).slice(0, 300) : null]
        );
        if (upd.rows.length === 0) return res.status(404).json({ error: 'Stampante non trovata' });
        res.json(upd.rows[0]);
    } catch (err: any) {
        console.error('PUT /sala/printers/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/sala/printers/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const p = await queryWithRetry(`SELECT name FROM printers WHERE id = $1`, [id]);
        if (p.rows.length === 0) return res.status(404).json({ error: 'Stampante non trovata' });
        // Una stampante referenziata da una partita non si elimina: la partita
        // resterebbe a puntare un nome fantasma e i job si accoderebbero nel vuoto.
        const used = await queryWithRetry(`SELECT name FROM stations WHERE printer = $1 LIMIT 1`, [p.rows[0].name]);
        if (used.rows.length > 0) {
            return res.status(409).json({
                error: `Usata dalla partita "${used.rows[0].name}": togli prima l'assegnazione.`,
            });
        }
        await queryWithRetry(`DELETE FROM printers WHERE id = $1`, [id]);
        res.json({ ok: true });
    } catch (err: any) {
        console.error('DELETE /sala/printers/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Pagina di prova sulla termica scelta: chiude il giro "l'ho configurata
// bene?" senza aspettare la prima comanda vera.
app.post('/sala/printers/:id/test', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const p = await queryWithRetry(`SELECT name, host, port, kind, is_active FROM printers WHERE id = $1`, [id]);
        if (p.rows.length === 0) return res.status(404).json({ error: 'Stampante non trovata' });
        if (p.rows[0].kind !== 'THERMAL') return res.status(400).json({ error: 'La stampante fiscale non accetta stampe di prova (Fase 2)' });
        if (!p.rows[0].is_active) return res.status(400).json({ error: 'Stampante disattivata' });
        const ins = await queryWithRetry(
            `INSERT INTO print_jobs (kind, payload, printer, created_by_user_id)
             VALUES ('TEST', $1, $2, $3) RETURNING id`,
            [JSON.stringify({ printer_name: p.rows[0].name, host: p.rows[0].host, port: p.rows[0].port }),
             p.rows[0].name, req.user?.userId ?? null]
        );
        res.status(201).json({ id: ins.rows[0].id, status: 'PENDING' });
    } catch (err: any) {
        console.error('POST /sala/printers/:id/test error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Profili di configurazione Sala & Cucina --------------------------------
// Uno snapshot con nome (fire mode + partite + stampanti) che si attiva in
// blocco. L'attivazione fa UPSERT per nome — non cancella ciò che c'è in più:
// un profilo è una base da applicare, non una sincronizzazione distruttiva.
// "Scollega" rimuove solo il marcatore: la configurazione corrente resta.

const salaSnapshot = async (): Promise<any> => {
    const [fireMode, stations, printers] = await Promise.all([
        getCourseFireMode(),
        queryWithRetry(`SELECT name, color, printer, is_active FROM stations ORDER BY sort_order, id`),
        queryWithRetry(`SELECT name, host, port, kind, is_active, notes FROM printers ORDER BY id`),
    ]);
    return { fire_mode: fireMode, stations: stations.rows, printers: printers.rows };
};

const getActiveSalaProfile = async (): Promise<string | null> => {
    const r = await queryWithRetry(`SELECT text_value FROM app_settings WHERE key = 'sala_active_profile'`);
    return r.rows[0]?.text_value ?? null;
};

app.get('/sala/profiles', authenticate, async (_req, res) => {
    try {
        const [rows, active] = await Promise.all([
            queryWithRetry(`SELECT id, name, updated_at FROM sala_profiles ORDER BY name`),
            getActiveSalaProfile(),
        ]);
        res.json({ profiles: rows.rows, active_profile: active });
    } catch (err: any) {
        console.error('GET /sala/profiles error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/sala/profiles', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const name = String(req.body?.name ?? '').trim();
        if (!name || name.length > 60) return res.status(400).json({ error: 'Nome non valido' });
        const ins = await queryWithRetry(
            `INSERT INTO sala_profiles (name, payload) VALUES ($1, $2) RETURNING id, name, updated_at`,
            [name, JSON.stringify(await salaSnapshot())]
        );
        res.status(201).json(ins.rows[0]);
    } catch (err: any) {
        if (err?.code === '23505') return res.status(409).json({ error: 'Esiste già un profilo con questo nome' });
        console.error('POST /sala/profiles error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// "Aggiorna": sovrascrive lo snapshot del profilo con il setup corrente.
app.put('/sala/profiles/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const upd = await queryWithRetry(
            `UPDATE sala_profiles SET payload = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING id, name, updated_at`,
            [id, JSON.stringify(await salaSnapshot())]
        );
        if (upd.rows.length === 0) return res.status(404).json({ error: 'Profilo non trovato' });
        res.json(upd.rows[0]);
    } catch (err: any) {
        console.error('PUT /sala/profiles/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/sala/profiles/:id/activate', authenticate, requirePermission('settings:full'), async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) { client.release(); return res.status(400).json({ error: 'id non valido' }); }
        const p = await queryWithRetry(`SELECT name, payload FROM sala_profiles WHERE id = $1`, [id]);
        if (p.rows.length === 0) { client.release(); return res.status(404).json({ error: 'Profilo non trovato' }); }
        const { name, payload } = p.rows[0];

        await client.query('BEGIN');
        if (payload?.fire_mode && ['AUTO_ALL', 'AUTO_FIRST', 'MANUAL'].includes(payload.fire_mode)) {
            await client.query(
                `INSERT INTO app_settings (key, text_value) VALUES ('course_fire_mode', $1)
                 ON CONFLICT (key) DO UPDATE SET text_value = $1, updated_at = CURRENT_TIMESTAMP`,
                [payload.fire_mode]
            );
        }
        for (const pr of Array.isArray(payload?.printers) ? payload.printers : []) {
            if (!PRINTER_NAME_RE.test(String(pr?.name ?? ''))) continue;
            await client.query(
                `INSERT INTO printers (name, host, port, kind, is_active, notes)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (name) DO UPDATE SET
                    host = EXCLUDED.host, port = EXCLUDED.port, kind = EXCLUDED.kind,
                    is_active = EXCLUDED.is_active, notes = EXCLUDED.notes`,
                [pr.name, String(pr.host ?? ''), Number(pr.port) || 9100,
                 pr.kind === 'FISCAL' ? 'FISCAL' : 'THERMAL', pr.is_active !== false,
                 pr.notes ?? null]
            );
        }
        for (const st of Array.isArray(payload?.stations) ? payload.stations : []) {
            const stName = String(st?.name ?? '').trim();
            if (!stName) continue;
            await client.query(
                `INSERT INTO stations (name, color, sort_order, printer, is_active)
                 VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM stations), $3, $4)
                 ON CONFLICT (lower(name)) DO UPDATE SET
                    color = EXCLUDED.color, printer = EXCLUDED.printer, is_active = EXCLUDED.is_active`,
                [stName, st.color ?? null,
                 st.printer != null && PRINTER_NAME_RE.test(String(st.printer)) ? st.printer : null,
                 st.is_active !== false]
            );
        }
        await client.query(
            `INSERT INTO app_settings (key, text_value) VALUES ('sala_active_profile', $1)
             ON CONFLICT (key) DO UPDATE SET text_value = $1, updated_at = CURRENT_TIMESTAMP`,
            [name]
        );
        await client.query('COMMIT');
        res.json({ ok: true, active_profile: name });
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /sala/profiles/:id/activate error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    } finally {
        client.release();
    }
});

app.post('/sala/profiles/detach', authenticate, requirePermission('settings:full'), async (_req, res) => {
    try {
        await queryWithRetry(`DELETE FROM app_settings WHERE key = 'sala_active_profile'`);
        res.json({ ok: true });
    } catch (err: any) {
        console.error('POST /sala/profiles/detach error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/sala/profiles/:id', authenticate, requirePermission('settings:full'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'id non valido' });
        const del = await queryWithRetry(`DELETE FROM sala_profiles WHERE id = $1 RETURNING name`, [id]);
        if (del.rows.length === 0) return res.status(404).json({ error: 'Profilo non trovato' });
        await queryWithRetry(
            `DELETE FROM app_settings WHERE key = 'sala_active_profile' AND text_value = $1`,
            [del.rows[0].name]
        );
        res.json({ ok: true });
    } catch (err: any) {
        console.error('DELETE /sala/profiles/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const startServer = async () => {
    try {
        // Start HTTP server
        const portNumber = Number(port);
        console.log(`Starting server on port ${portNumber}...`);

        httpServer.listen(portNumber, '0.0.0.0', () => {
            console.log(`✅ Server listening on port ${portNumber}`);

            // Initialize Socket.IO
            try {
                socketService = new SocketService(httpServer);
                console.log('✅ Socket.IO initialized');
            } catch (socketError) {
                console.error('Socket.IO initialization failed:', socketError);
            }

            // Initialize database schema in background, then backfill banquet reminders
            createSchema()
                .then(async () => {
                    console.log('✅ Database schema initialized');
                    try {
                        await RolePermissionService.warmUp();
                        console.log('✅ Role permission cache warmed up');
                    } catch (permErr) {
                        console.warn('Permission cache warm-up skipped:', permErr);
                    }
                    try {
                        const today = new Date().toISOString().substring(0, 10);
                        const upcoming = await queryWithRetry(
                            "SELECT id, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date FROM banquet_menus WHERE event_date >= $1",
                            [today]
                        );
                        for (const row of upcoming.rows) {
                            await addBanquetToReminders(row.id, row.event_date);
                        }
                        if (upcoming.rows.length > 0) {
                            console.log(`✅ Backfilled kitchen reminder todos for ${upcoming.rows.length} upcoming banquet(s)`);
                        }
                    } catch (backfillErr) {
                        console.error('Banquet reminder backfill failed:', backfillErr);
                    }
                    try {
                        startRemindersScheduler();
                        console.log('✅ Reminders scheduler started (polls every 5 min, Europe/Rome)');
                    } catch (schedErr) {
                        console.error('Bread reminder scheduler failed to start:', schedErr);
                    }
                    try {
                        startBillSplitReconcileScheduler();
                        console.log('✅ Bill split reconcile scheduler started (60s)');
                    } catch (schedErr) {
                        console.error('Bill split reconcile scheduler failed to start:', schedErr);
                    }
                    try {
                        startPaymentRequestReconcileScheduler();
                        console.log('✅ Payment reconcile scheduler started (2 min)');
                    } catch (schedErr) {
                        console.error('Payment reconcile scheduler failed to start:', schedErr);
                    }
                    try {
                        // Fire-and-forget: the IMAP handshake can take seconds
                        // and we don't want to block schema-init callbacks.
                        startImapInboundService(() => socketService).catch((imapErr) => {
                            console.error('IMAP inbound service startup error:', imapErr);
                        });
                    } catch (imapErr) {
                        console.error('IMAP inbound service failed to start:', imapErr);
                    }
                })
                .catch((dbError) => {
                    console.error('Database initialization failed:', dbError);
                    console.error('Server will continue running, but database operations may fail');
                });
        }).on('error', (error) => {
            console.error('❌ Failed to start server:', error);
            process.exit(1);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();