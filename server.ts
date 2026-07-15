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
    createOrder as revolutCreateOrder,
    verifyWebhookSignature as verifyRevolutWebhook,
    getRevolutConfigStatus,
    invalidateRevolutConfigCache,
    type RevolutEnvironment,
} from './services/revolutService.js';
import {
    isSmtpConfigured,
    getSmtpConfigStatus,
    invalidateSmtpConfigCache,
    sendMail,
    verifySmtpConnection,
} from './services/smtpService.js';
import {
    verifyElevenLabsSignature,
    findAvailability,
    findCustomerByPhone,
    createVoiceReservation,
    cancelVoiceReservation,
    recordVoiceCall,
    formatItalianConfirmation,
    formatItalianCancellation,
    normalizeItalianPhone,
    parseFlexibleDate,
    parseFlexibleTime,
    formatItalianDateReadback,
    spellItalianPhoneDigits,
} from './services/elevenlabsService.js';
import { toTitleCase } from './utils/text.js';
import {
    getAvailableSlots,
    getAllOpeningHours,
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

        if (messageText) {
            await processWhatsAppBooking(from, messageText);
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

// Twilio WhatsApp inbound messages webhook
app.post('/webhook/twilio-whatsapp', twilioUrlEncoded, async (req, res) => {
    if (!validateTwilioSignature(req)) {
        console.warn('[Twilio] Inbound: invalid signature, rejecting');
        return res.status(403).send();
    }
    console.log('[Twilio] Incoming message:', req.body);
    // Acknowledge with empty TwiML so Twilio doesn't auto-reply on our behalf.
    res.set('Content-Type', 'text/xml').status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    try {
        const from = String(req.body?.From || '').replace(/^whatsapp:/, '');
        const body = String(req.body?.Body || '').trim();
        const numMedia = Number(req.body?.NumMedia || 0);
        if (numMedia > 0) {
            console.log('[Twilio] Inbound has media attachments — processing text only');
        }
        if (from && body) {
            await processWhatsAppBooking(from, body);
        } else {
            console.log('[Twilio] Inbound: missing From or empty Body, ignoring');
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
    } catch (err: any) {
        console.warn('[Twilio] status persist failed:', err?.message || err);
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

    const baseDynamicVars = {
        customer_first_name: '',
        customer_full_name: '',
        customer_id: '',
        caller_id_spelled: '',
        customer_known: 'false',
    };
    const fallbackResponse = {
        type: 'conversation_initiation_client_data',
        dynamic_variables: baseDynamicVars,
        conversation_config_override: {
            agent: { first_message: VOICE_FIRST_MESSAGE_FALLBACK },
        },
    };

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

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const conversationId: string | undefined = req.body?.conversation_id || p.conversation_id;

    const customerName = String(p.customer_name ?? '').trim();
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

        const reservationLabel = (() => {
            try {
                const dt = new Date(created.reservation_time);
                const time = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                const date = dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                return `${date} ${time}`;
            } catch {
                return created.reservation_time;
            }
        })();
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
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
            const dt = new Date(outcome.reservation.reservation_time);
            const hh = String(dt.getHours()).padStart(2, '0');
            const mm = String(dt.getMinutes()).padStart(2, '0');
            console.log('[ElevenLabs] cancel-reservation: already cancelled', {
                id: outcome.reservation.id, conversation_id: conversationId,
            });
            return res.json({
                success: false,
                status: 'already_cancelled',
                reservation_id: outcome.reservation.id,
                message: `La prenotazione di ${outcome.reservation.customer_name} delle ${hh}:${mm} risulta già annullata. C'è altro che posso fare?`
            });
        }

        if (outcome.status === 'ambiguous') {
            const list = outcome.candidates.map(c => {
                const t = new Date(c.reservation_time);
                const hh = String(t.getHours()).padStart(2, '0');
                const mm = String(t.getMinutes()).padStart(2, '0');
                return `${hh}:${mm} per ${c.guests}`;
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

        const reservationLabel = (() => {
            try {
                const dt = new Date(cancelled.reservation_time);
                const time = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                const date = dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                return `${date} ${time}`;
            } catch {
                return cancelled.reservation_time;
            }
        })();
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
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

    // Look up any reservation linked to this conversation (set during create_reservation).
    // If found and we have a phone, send the WhatsApp recap.
    try {
        const linked = await queryWithRetry(
            `SELECT r.id, r.customer_name, r.phone, r.reservation_time, r.guests,
                    t.name AS table_name, rm.name AS room_name
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
            sendBookingConfirmation(row.phone, message, row.id).catch(err =>
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
        const { customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, duration_minutes } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
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
                INSERT INTO reservations (customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, duration_minutes, created_by_user_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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

        // Broadcast to all connected clients except the one who created it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationCreated(newReservation, socketId);

        const reservationLabel = (() => {
            try {
                const dt = new Date(reservation_time);
                const time = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                const date = dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                return `${date} ${time}`;
            } catch {
                return reservation_time;
            }
        })();
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
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
        const { customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, duration_minutes } = req.body;
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
                SET customer_name = $1, reservation_time = $2, shift = $3, guests = $4, children = $5, table_id = $6, notes = $7, email = $8, phone = $9, payment_status = $10, arrival_status = $11, reservation_status = $12, duration_minutes = $13
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

        // Broadcast to all connected clients except the one who updated it
        const socketId = req.headers['x-socket-id'] as string;
        if (socketService) socketService.broadcastReservationUpdated(updatedReservation, socketId);

        // Notify managers when a booking transitions to CANCELLED (soft cancel).
        // Skip if it was already CANCELLED — avoids duplicate notifications on
        // saves that don't change the status.
        if (previousStatus !== 'CANCELLED' && reservation_status === 'CANCELLED' && updatedReservation) {
            const reservationLabel = (() => {
                try {
                    const dt = new Date(updatedReservation.reservation_time);
                    const time = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                    const date = dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                    return `${date} ${time}`;
                } catch {
                    return updatedReservation.reservation_time;
                }
            })();
            pushSendToRoles(
                ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
                {
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
            updatedReservation?.phone
        ) {
            const roomName = await resolveReservationRoomName(updatedReservation);
            sendBookingConfirmation(
                updatedReservation.phone,
                buildConfirmationMessage(
                    updatedReservation.customer_name,
                    updatedReservation.reservation_time,
                    updatedReservation.guests,
                    roomName
                ),
                updatedReservation.id
            ).catch(err => console.error('Auto-confirmation send failed:', err));
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
                updatedReservation.id
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
            outcome = await sendWhatsAppText(reservation.phone, message, reservation.id);
            recordConfirmationSent(reservation.id, outcome).catch(err =>
                console.warn('[confirmation] recordConfirmationSent failed:', err?.message || err)
            );
        } else {
            outcome = await sendBookingConfirmation(reservation.phone, message, reservation.id);
        }

        const label = outcome.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
        console.log(`[${label}] ✅ Confirmation sent for reservation ${id} to ${reservation.phone}`);
        res.json({ success: true, message: `Confirmation sent via ${label}`, channel: outcome.channel });
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
        const text = buildConfirmationMessage(
            reservation.customer_name,
            reservation.reservation_time,
            reservation.guests,
            roomName
        );
        const dt = new Date(reservation.reservation_time);
        const subject = `Conferma prenotazione - ${dt.toLocaleDateString('it-IT')} ${dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;

        const sent = await sendMail({
            to: String(reservation.email),
            subject,
            text,
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
        res.json({ success: true, message: 'Confirmation sent via Email', channel: 'email' });
    } catch (err: any) {
        console.error('Error sending email confirmation:', err);
        res.status(500).json({ error: err?.message || 'Failed to send email confirmation' });
    }
});

// Outbound SMS/WhatsApp history for a reservation. Matches messages either
// tagged with this reservation_id or sent to the same phone (last 10 digits),
// so historical messages sent before we started stamping reservation_id still
// surface for the customer.
app.get('/reservations/:id/messages', authenticate, requirePermission('reservations:view'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

        const resRow = await queryWithRetry(
            'SELECT phone FROM reservations WHERE id = $1',
            [id]
        );
        if (resRow.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const phone: string | null = resRow.rows[0].phone;
        const digits = phone ? String(phone).replace(/\D/g, '') : '';
        const suffix = digits.length >= 8 ? digits.slice(-10) : null;

        const conditions: string[] = ['reservation_id = $1'];
        const params: any[] = [id];
        if (suffix) {
            params.push(suffix);
            conditions.push(`right(to_phone_digits, 10) = $${params.length}`);
        }

        const result = await queryWithRetry(
            `SELECT id, provider, channel, to_phone, body, status, provider_sid,
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


// ============================================
// PAYMENT LINK REQUESTS (Revolut hosted checkout)
// ============================================

// Format an amount in minor units as an Italian euro string ("€ 15,00").
function formatEuroMinor(cents: number): string {
    return `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

// Compose the message we send to the customer with the Revolut checkout link.
// Kept intentionally short so it fits comfortably inside an SMS segment when
// WhatsApp isn't available.
function buildPaymentMessage(customerName: string, amountCents: number, url: string, description?: string | null): string {
    const amount = formatEuroMinor(amountCents);
    const desc = (description || '').trim();
    const intro = `Ciao ${customerName}, per completare la prenotazione al Vecchio Frantoio serve un anticipo di ${amount}.`;
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
    return `Ciao ${customerName}, per confermare la prenotazione per ${guestsLabel} il ${dateLabel} alle ${time} serve una caparra di ${amount} (€ 10 a persona).\nPaga in sicurezza qui: ${checkoutUrl}\n\nAppena riceviamo il pagamento ti confermeremo il tavolo. Grazie!`;
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
    const dt = reservationTime instanceof Date ? reservationTime : new Date(reservationTime);
    const day = String(dt.getDate()).padStart(2, '0');
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const year = dt.getFullYear();
    const hours = String(dt.getHours()).padStart(2, '0');
    const minutes = String(dt.getMinutes()).padStart(2, '0');
    const fullName = (customerName ?? '').trim();
    const greeting = fullName ? `Ciao ${fullName}` : 'Ciao';
    const guestsNum = Math.max(1, Math.trunc(Number(guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    const room = (roomName ?? '').trim();
    const roomPart = room ? ` in ${room}` : '';
    const amount = formatEuroMinor(amountCents);
    return `${greeting}, abbiamo ricevuto la caparra di ${amount}. La tua prenotazione per ${guestsNum} ${persone} il ${day}/${month}/${year} alle ${hours}:${minutes}${roomPart} e' confermata. A presto!`;
}

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
        if (!(await isRevolutConfigured())) {
            return res.status(503).json({ error: 'Revolut non è configurato (API key mancante)' });
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

        // Create the Revolut order first — if the API call fails we don't
        // want to persist a half-baked row. `merchant_order_ext_ref` is how
        // the webhook will correlate the event back to our reservation.
        const orderDescription = (typeof description === 'string' && description.trim())
            ? description.trim()
            : `Prenotazione #${reservation.id} - ${reservation.guests} persone`;
        const order = await revolutCreateOrder({
            amount: amountCents,
            currency: 'EUR',
            description: orderDescription,
            merchant_order_ext_ref: `reservation:${reservation.id}`,
        });

        const inserted = await queryWithRetry(
            `INSERT INTO payment_requests
                (reservation_id, amount_cents, currency, description, status, provider,
                 provider_order_id, checkout_url, created_by_user_id, metadata)
             VALUES ($1, $2, 'EUR', $3, $4, 'revolut', $5, $6, $7, $8)
             RETURNING *`,
            [
                reservation.id,
                amountCents,
                orderDescription,
                (order.state || 'PENDING').toUpperCase(),
                order.id,
                order.checkout_url,
                req.user?.userId ?? null,
                JSON.stringify({ revolut_token: order.token || null }),
            ]
        );
        const paymentRequest = inserted.rows[0];

        // Fire-and-forget delivery: same channel policy as booking
        // confirmations. Failures update delivery_error but don't fail the
        // API call — the operator can still copy the link from the UI.
        const message = buildPaymentMessage(reservation.customer_name, amountCents, order.checkout_url, orderDescription);
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

        res.status(201).json(paymentRequest);
    } catch (err: any) {
        console.error('POST /payments/requests error:', err);
        res.status(500).json({ error: 'Internal server error', detail: err?.message });
    }
});

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

        // Map Revolut event → our internal status. Everything else is logged
        // and acknowledged so Revolut stops retrying, but doesn't mutate the row.
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
                console.log('[Revolut] unhandled event:', event);
                return res.status(200).json({ ok: true, ignored: event });
        }

        // Atomic transition: lock the row, capture its pre-update state, then
        // update. `wasCompleted` lets us detect the FIRST ORDER_COMPLETED and
        // fire the customer confirmation exactly once — even if Revolut
        // retries the webhook concurrently.
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
                console.warn('[Revolut] webhook: no payment_request found for order_id', orderId);
                return res.status(200).json({ ok: true, ignored: 'unknown order' });
            }
            wasCompleted = before.rows[0].completed_at !== null;
            const updated = await client.query(
                `UPDATE payment_requests
                 SET status = $1,
                     completed_at = CASE WHEN $2 AND completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE completed_at END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3
                 RETURNING *`,
                [nextStatus, markCompleted, before.rows[0].id]
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
        catch (err) { console.warn('[Revolut] socket broadcast failed:', (err as any)?.message || err); }

        const isFirstCompletion = markCompleted && !wasCompleted;

        // Push notification to managers on the FIRST completed transition so
        // they can act in real time. Skip retries so they don't get spammed.
        if (isFirstCompletion) {
            const bodyLine = `${formatEuroMinor(row.amount_cents)} da prenotazione #${row.reservation_id ?? '?'}`;
            pushSendToRoles(['OWNER', 'GENERAL_MANAGER', 'MANAGER'], {
                title: 'Pagamento ricevuto',
                body: bodyLine,
                url: row.reservation_id ? `/?view=RESERVATIONS&reservationId=${row.reservation_id}` : `/?view=RESERVATIONS`,
                tag: `payment-${row.id}`,
            }, { excludeUserId: null }).catch(err => {
                console.warn('[Revolut] push send failed:', err?.message || err);
            });
        }

        // On the first ORDER_COMPLETED for a reservation-linked payment:
        // 1) auto-flip the reservation from PENDING → CONFIRMED (this happens
        //    for web bookings above the deposit threshold, which land as PENDING)
        // 2) notify the customer that the deposit was received and their table
        //    is now confirmed. Fire and forget — never fail the webhook.
        if (isFirstCompletion && row.reservation_id) {
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

                    // Only auto-confirm if the reservation is still PENDING.
                    // If staff already CONFIRMED it, DECLINED, or CANCELLED,
                    // we don't touch the status — but we still send a message
                    // if PENDING/CONFIRMED so the customer is not left in
                    // silence after paying.
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
                            catch (err) { console.warn('[Revolut] reservation broadcast failed:', err); }
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
                        await sendBookingConfirmation(reservation.phone, message, reservation.id);
                    }
                } catch (err: any) {
                    console.error('[Revolut] deposit confirmation flow failed:', err?.message || err);
                }
            })();
        }

        res.status(200).json({ ok: true });
    } catch (err: any) {
        console.error('POST /webhook/revolut error:', err);
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

const getItalianDateParts = (date: Date): { year: string; month: string; day: string; hour: string } => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: BREAD_TARGET_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
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

async function runDailyBreadReminder(): Promise<void> {
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

    if (existing.rows.length > 0) {
        const todo = existing.rows[0];
        // Don't overwrite a completed reminder — owner already acted on it
        if (todo.completed) return;
        const updated = await queryWithRetry(`
            UPDATE todos
            SET title = $1, description = $2
            WHERE id = $3
            RETURNING ${TODO_FULL_SELECT}
        `, [title, description, todo.id]);
        if (socketService && updated.rows[0]) socketService.broadcastToAll('todo:updated', updated.rows[0]);
    } else {
        const created = await queryWithRetry(`
            INSERT INTO todos (
                title, description, priority, category, due_date,
                assigned_to_team, auto_kind
            ) VALUES ($1, $2, 'HIGH', 'INVENTORY', $3, 'OWNER', $4)
            RETURNING ${TODO_FULL_SELECT}
        `, [title, description, tomorrowIso, BREAD_AUTO_KIND]);
        if (socketService && created.rows[0]) socketService.broadcastToAll('todo:created', created.rows[0]);
        if (created.rows[0]) {
            pushSendToRoles(
                ['OWNER'],
                {
                    title: 'Promemoria pane',
                    body: title,
                    url: '/?view=DASHBOARD',
                    tag: `bread-${tomorrowIso}`,
                }
            ).catch(err => console.error('Push (bread reminder) failed:', err));
        }
    }
    console.log(`🥖 Bread reminder for ${tomorrowIso}: ${kg}kg (${totalGuests} coperti)`);
}

let lastBreadRunIso: string | null = null;
const startBreadReminderScheduler = () => {
    const tick = async () => {
        try {
            const { year, month, day, hour } = getItalianDateParts(new Date());
            const todayItalian = `${year}-${month}-${day}`;
            const hourNum = parseInt(hour, 10);
            if (hourNum >= BREAD_TRIGGER_HOUR && lastBreadRunIso !== todayItalian) {
                await runDailyBreadReminder();
                lastBreadRunIso = todayItalian;
            }
        } catch (err) {
            console.error('Bread reminder scheduler error:', err);
        }
    };
    // First check immediately (in case server started past 20:00 Italian time today)
    tick();
    // Then poll every 5 minutes
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
        const cap = Math.min(Math.max(parseInt(limit || '500', 10) || 500, 1), 1000);
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

        const result = await queryWithRetry(
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
                normalizeCustomerName(String(name).trim()),
                phone ? String(phone).trim() : null,
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
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        const updated = result.rows[0];

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
        if (source.phone) {
            await client.query(
                `UPDATE reservations
                 SET phone = $1,
                     customer_name = $2
                 WHERE phone = $3`,
                [target.phone || source.phone, target.name, source.phone]
            );
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
// auto-fire on PENDING→CONFIRMED in PUT /reservations/:id, and the
// voice-agent post-call.
function buildConfirmationMessage(
    customerName: string | null | undefined,
    reservationTime: string | Date,
    guests: number | null | undefined,
    roomName?: string | null
): string {
    const dt = reservationTime instanceof Date ? reservationTime : new Date(reservationTime);
    const day = String(dt.getDate()).padStart(2, '0');
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const year = dt.getFullYear();
    const hours = String(dt.getHours()).padStart(2, '0');
    const minutes = String(dt.getMinutes()).padStart(2, '0');
    const fullName = (customerName ?? '').trim();
    const greeting = fullName ? `Ciao ${fullName}, la tua` : 'La';
    const guestsNum = Math.max(1, Math.trunc(Number(guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    const room = (roomName ?? '').trim();
    const roomPart = room ? ` in ${room}` : '';
    return `${greeting} prenotazione per ${guestsNum} ${persone} il ${day}/${month}/${year} alle ${hours}:${minutes}${roomPart} e' confermata. A presto!`;
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
    const dt = reservationTime instanceof Date ? reservationTime : new Date(reservationTime);
    const day = String(dt.getDate()).padStart(2, '0');
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const year = dt.getFullYear();
    const hours = String(dt.getHours()).padStart(2, '0');
    const minutes = String(dt.getMinutes()).padStart(2, '0');
    const fullName = (customerName ?? '').trim();
    const greeting = fullName ? `Ciao ${fullName}, purtroppo` : 'Purtroppo';
    const guestsNum = Math.max(1, Math.trunc(Number(guests) || 1));
    const persone = guestsNum === 1 ? 'persona' : 'persone';
    return `${greeting} non ci e' stato possibile confermare la tua richiesta di prenotazione per ${guestsNum} ${persone} il ${day}/${month}/${year} alle ${hours}:${minutes}. Chiamaci allo 0985 876578 per verificare un'altra data/orario. Grazie e a presto!`;
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

// Public URL used as StatusCallback for Twilio outbound messages so Twilio can
// notify us of delivery/failure. Falls back to VITE_API_URL, then null (no
// callback attached — messages still send, just no delivery tracking).
function twilioStatusCallbackUrl(): string | null {
    const base = process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.VITE_API_URL;
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/webhook/twilio-whatsapp-status`;
}

async function sendTwilioWhatsApp(to: string, text: string, reservationId?: number | null): Promise<OutboundConfirmationResult> {
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

    console.log(`[Twilio] Sending message to ${formattedTo} from ${formattedFrom}`);

    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    const body = new URLSearchParams({
        From: formattedFrom,
        To: formattedTo,
        Body: text,
    });
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
async function sendWhatsAppText(to: string, text: string, reservationId?: number | null): Promise<OutboundConfirmationResult> {
    if (isTwilioWhatsAppConfigured()) {
        return sendTwilioWhatsApp(to, text, reservationId);
    }
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

// Booking-confirmation dispatcher. WhatsApp is the primary channel (cheaper,
// richer, higher open rate); Twilio SMS acts as fallback when the WA send
// fails synchronously — e.g. recipient not on WhatsApp, Twilio WA sender not
// yet registered, template not approved. Delivery-time failures (Twilio
// queues the message but Meta drops it later) are handled by the
// StatusCallback path, not here. When `reservationId` is passed we persist
// the Twilio SID so the StatusCallback can update the delivery status.
async function sendBookingConfirmation(
    to: string,
    text: string,
    reservationId?: number | null
): Promise<OutboundConfirmationResult> {
    // Try WA first only when Twilio WA is properly configured. Vonage is a
    // deprecated sandbox that would generate noisy failed sends per booking,
    // so skip it entirely — if TWILIO_WHATSAPP_FROM is unset we go straight
    // to SMS.
    const tryWhatsApp = isTwilioWhatsAppConfigured();
    let result: OutboundConfirmationResult;
    try {
        result = tryWhatsApp
            ? await sendWhatsAppText(to, text, reservationId)
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
    const { lunch_open, lunch_close, dinner_open, dinner_close, slot_minutes } = req.body ?? {};

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

    try {
        const result = await queryWithRetry(
            `UPDATE opening_hours
             SET lunch_open = $2::time, lunch_close = $3::time,
                 dinner_open = $4::time, dinner_close = $5::time,
                 slot_minutes = $6
             WHERE weekday = $1
             RETURNING weekday,
                       to_char(lunch_open,  'HH24:MI') AS lunch_open,
                       to_char(lunch_close, 'HH24:MI') AS lunch_close,
                       to_char(dinner_open, 'HH24:MI') AS dinner_open,
                       to_char(dinner_close,'HH24:MI') AS dinner_close,
                       slot_minutes`,
            [weekday, lo, lc, dorn, dc, step]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'not_found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating opening_hours:', error);
        res.status(500).json({ error: 'Failed to update opening hours' });
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
        const { from, to, q, linked } = req.query as Record<string, string | undefined>;
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
            params.push(`%${q.trim()}%`);
            const idx = params.length;
            where.push(`(vc.phone ILIKE $${idx} OR vc.summary ILIKE $${idx} OR vc.transcript ILIKE $${idx})`);
        }
        if (linked === 'true') where.push('vc.reservation_id IS NOT NULL');
        else if (linked === 'false') where.push('vc.reservation_id IS NULL');

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
            `SELECT COUNT(*)::int AS total FROM voice_calls vc ${whereSql}`,
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

        const result = await queryWithRetry(
            `UPDATE voice_calls
             SET reservation_id = $1,
                 follow_up_status = 'CONTACTED',
                 follow_up_updated_at = NOW(),
                 follow_up_updated_by = $2
             WHERE id = $3
             RETURNING id, reservation_id, follow_up_status, follow_up_updated_at`,
            [reservationId, req.user?.userId ?? null, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('PATCH /voice-calls/:id/link error:', err);
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

type FeatureFlagKey = 'public_bookings_enabled' | 'voice_agent_enabled';
const FEATURE_FLAG_KEYS: FeatureFlagKey[] = ['public_bookings_enabled', 'voice_agent_enabled'];

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

app.get('/settings/features', authenticate, async (_req, res) => {
    try {
        const result = await queryWithRetry(
            'SELECT key, value FROM app_settings WHERE key = ANY($1)',
            [FEATURE_FLAG_KEYS]
        );
        const flags: Record<string, boolean> = {
            public_bookings_enabled: false,
            voice_agent_enabled: true,
        };
        for (const row of result.rows) {
            flags[row.key] = Boolean(row.value);
        }
        res.json(flags);
    } catch (err) {
        console.error('Error fetching feature flags:', err);
        res.status(500).json({ error: 'Failed to fetch feature flags' });
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
        const flags: Record<string, boolean> = {
            public_bookings_enabled: false,
            voice_agent_enabled: true,
        };
        for (const row of result.rows) {
            flags[row.key] = Boolean(row.value);
        }
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
            return res.status(400).json({ error: verify.error || 'Verifica SMTP fallita' });
        }
        await sendMail({
            to,
            subject: 'Test SMTP RistoManager',
            text: 'Questo è un messaggio di test dal tuo CRM RistoManager. Se lo hai ricevuto, la configurazione SMTP funziona correttamente.',
        });
        res.json({ success: true });
    } catch (err: any) {
        console.error('POST /settings/integrations/smtp/test error:', err);
        res.status(500).json({ error: err?.message || 'Test SMTP fallito' });
    }
});

// ============================================
// AUTO-DEPOSIT POLICY (public web bookings)
// ============================================
// Stored on the Revolut integration row (both concerns share credentials);
// exposed here as a dedicated endpoint so the Settings UI can surface the
// feature under "Opzioni prenotazioni" rather than buried in the Revolut card.
// GET is auth-only so any operator can read the current policy; PUT requires
// settings:full because the setting affects customer-facing charges.
app.get('/settings/auto-deposit', authenticate, async (_req, res) => {
    try {
        const revolutConfigured = await isRevolutConfigured();
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
            revolut_configured: revolutConfigured,
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

        const revolutConfigured = await isRevolutConfigured();
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
            revolut_configured: revolutConfigured,
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
        const [lunchSlots, dinnerSlots] = await Promise.all([
            getAvailableSlots(date, Shift.LUNCH),
            getAvailableSlots(date, Shift.DINNER),
        ]);

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
        const result = await queryWithRetry(
            `SELECT r.id, r.name
             FROM rooms r
             WHERE r.is_closed = false
               AND r.id NOT IN (
                   SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3
               )
               AND EXISTS (
                   SELECT 1 FROM tables t
                   WHERE t.room_id = r.id
                     AND t.seats >= $1
                     AND t.id NOT IN (
                         SELECT table_id FROM table_hidden_overrides WHERE date = $2 AND shift = $3
                     )
                     AND NOT EXISTS (
                         SELECT 1 FROM reservations res
                         WHERE res.table_id = t.id
                           AND DATE(res.reservation_time) = $2
                           AND res.shift = $3
                           AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
                     )
               )
             ORDER BY r.name ASC`,
            [Math.trunc(guests), date, shift]
        );
        res.json({ rooms: result.rows });
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

        const customer_name = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
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
        if (!phone || !/^\+?[0-9 ]{6,20}$/.test(phone)) {
            return res.status(400).json({ error: 'invalid_phone', message: 'Numero di telefono non valido' });
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
        const phoneE164 = phone.startsWith('+')
            ? phone.replace(/\s/g, '')
            : phone.replace(/\D/g, '').replace(/^3/, '+393').slice(0, 13);

        const reservation_time = `${date}T${time}:00`;
        const userNote = notesRaw ? notesRaw.slice(0, 500) : '';
        const noteParts = ['[Web]'];
        if (requestedRoomName) noteParts.push(`Sala richiesta: ${requestedRoomName}.`);
        noteParts.push(userNote || 'Richiesta prenotazione dal sito');
        const notes = noteParts.join(' ');

        const result = await queryWithRetry(
            `INSERT INTO reservations (
                customer_name, reservation_time, shift, guests, children,
                table_id, notes, email, phone, payment_status, arrival_status,
                reservation_status, source, requires_review
            )
            VALUES ($1, $2, $3, $4, 0, NULL, $5, NULL, $6, 'PENDING', 'WAITING', 'PENDING', 'GOOGLE', true)
            RETURNING *`,
            [customer_name, reservation_time, shift, Math.trunc(guestsNum), notes, phoneE164]
        );
        const created = result.rows[0];

        // Auto-save the booker into the rubrica so the contact appears even if
        // staff never edit this booking from the internal app.
        await upsertCustomerFromReservation(customer_name, phoneE164, null, null);

        // Notify staff dashboards in real time.
        if (socketService) {
            try { socketService.broadcastReservationCreated(created); }
            catch (err) { console.warn('[public-booking] socket broadcast failed:', err); }
        }
        pushSendToRoles(
            ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
            {
                title: 'Nuova richiesta prenotazione',
                body: `${toTitleCase(customer_name)} · ${guestsNum} ospiti · ${date} ${time}`,
                url: `/?view=RESERVATIONS&reservationId=${created.id}`,
                tag: `pending-${created.id}`,
            }
        ).catch(err => console.error('Push (public booking) failed:', err));

        // Fire-and-forget acknowledgement to the customer. The booking is
        // PENDING — staff still need to confirm — so wording reflects that.
        // Channel priority: Twilio SMS (while Meta verification is pending) →
        // Meta WhatsApp template → generic WhatsApp text fallback.
        const [yyyy, mm, dd] = date.split('-');
        const dateLabel = `${dd}/${mm}/${yyyy}`;
        const guestsLabel = `${guestsNum} ${guestsNum === 1 ? 'persona' : 'persone'}`;

        // Large web bookings require a €10/person deposit before the table
        // is guaranteed. The enabled toggle and guest threshold live on the
        // Revolut integration row (Settings → Integrazioni → Revolut). We
        // create the order synchronously so we can include the checkout link
        // in the ack. On any Revolut failure we silently degrade to the plain
        // "richiesta ricevuta" flow — staff will then confirm manually.
        let depositCheckoutUrl: string | null = null;
        let depositAmountCents = 0;
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
        if (autoDepositEnabled && guestsNum >= autoDepositMinGuests && (await isRevolutConfigured())) {
            depositAmountCents = guestsNum * 1000; // €10 per person, in cents
            const orderDescription = `Caparra prenotazione #${created.id} - ${guestsLabel} ${dateLabel} ${time}`;
            try {
                const order = await revolutCreateOrder({
                    amount: depositAmountCents,
                    currency: 'EUR',
                    description: orderDescription,
                    merchant_order_ext_ref: `reservation:${created.id}`,
                });
                const insertedPayment = await queryWithRetry(
                    `INSERT INTO payment_requests
                        (reservation_id, amount_cents, currency, description, status, provider,
                         provider_order_id, checkout_url, metadata)
                     VALUES ($1, $2, 'EUR', $3, $4, 'revolut', $5, $6, $7)
                     RETURNING *`,
                    [
                        created.id,
                        depositAmountCents,
                        orderDescription,
                        (order.state || 'PENDING').toUpperCase(),
                        order.id,
                        order.checkout_url,
                        JSON.stringify({ revolut_token: order.token || null, source: 'public_booking_auto_deposit' }),
                    ]
                );
                depositCheckoutUrl = order.checkout_url;
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
            : `Ciao ${toTitleCase(customer_name)}, abbiamo ricevuto la tua richiesta di prenotazione per ${guestsLabel} il ${dateLabel} alle ${time}. Ti ricontatteremo a breve per confermarla. Grazie!`;

        sendBookingConfirmation(phoneE164, ackText, created.id).catch(err =>
            console.error('[public-booking] confirmation send failed:', err?.message || err)
        );

        res.status(201).json({ ok: true, id: created.id });
    } catch (err: any) {
        console.error('POST /public/reservations error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

app.get('/prenota', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'prenota.html'));
});

// Restaurant logo used by the /prenota landing page. Served explicitly rather
// than via express.static to avoid exposing the whole public/ folder.
app.get('/prenota/logo.png', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(process.cwd(), 'public', 'logo-vf.png'));
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
                        startBreadReminderScheduler();
                        console.log('✅ Daily bread reminder scheduler started (20:00 Europe/Rome)');
                    } catch (schedErr) {
                        console.error('Bread reminder scheduler failed to start:', schedErr);
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