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
    verifyElevenLabsSignature,
    findAvailability,
    createVoiceReservation,
    cancelVoiceReservation,
    recordVoiceCall,
    formatItalianConfirmation,
    formatItalianCancellation,
    normalizeItalianPhone,
    parseFlexibleDate,
    parseFlexibleTime,
} from './services/elevenlabsService.js';
import { toTitleCase } from './utils/text.js';
import {
    getAvailableSlots,
    getAllOpeningHours,
    listClosures,
    formatSlotListItalian,
} from './utils/slots.js';

const app = express();
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

// Health check endpoint for Railway
app.get('/', (req, res) => {
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

// Tool 1 — check_availability
// Body shape (per ElevenLabs tools spec): { parameters: { date, shift, guests }, conversation_id?, agent_id? }
// We also accept flat top-level fields as a fallback.
app.post('/webhook/elevenlabs/check-availability', async (req, res) => {
    if (!authorizeElevenLabs(req, res)) return;

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const rawShift = String(p.shift ?? '').trim().toUpperCase();
    const guests = Number(p.guests);

    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn('[ElevenLabs] check-availability rejected: unparseable date', { received: p.date });
        return res.status(400).json({
            error: 'invalid_date',
            message: 'Formato data non riconosciuto. Esempi accettati: 2026-05-14, 14/05/2026, "14 maggio 2026".'
        });
    }
    if (rawShift !== Shift.LUNCH && rawShift !== Shift.DINNER) {
        return res.status(400).json({ error: 'invalid_shift', message: 'shift must be LUNCH or DINNER' });
    }
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
        return res.status(400).json({ error: 'invalid_guests', message: 'guests must be an integer 1-50' });
    }

    try {
        const result = await findAvailability({
            date: normalizedDate,
            shift: rawShift as Shift,
            guests: Math.trunc(guests)
        });
        console.log('[ElevenLabs] check-availability', { date: normalizedDate, raw_date: p.date, shift: rawShift, guests, result });
        res.json(result);
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

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const conversationId: string | undefined = req.body?.conversation_id || p.conversation_id;

    const customerName = String(p.customer_name ?? '').trim();
    const phoneRaw = String(p.phone ?? '').trim();
    const rawShift = String(p.shift ?? '').trim().toUpperCase();
    const guests = Number(p.guests);
    const childrenRaw = p.children;
    const notes = typeof p.notes === 'string' ? p.notes.trim() : undefined;

    if (!customerName) {
        return res.status(400).json({ error: 'invalid_customer_name', message: 'customer_name is required' });
    }
    if (!phoneRaw) {
        return res.status(400).json({ error: 'invalid_phone', message: 'phone is required' });
    }
    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn('[ElevenLabs] create-reservation rejected: unparseable date', { received: p.date });
        return res.status(400).json({
            error: 'invalid_date',
            message: 'Formato data non riconosciuto. Esempi accettati: 2026-05-14, 14/05/2026, "14 maggio 2026".'
        });
    }
    const normalizedTime = parseFlexibleTime(p.time);
    if (!normalizedTime) {
        console.warn('[ElevenLabs] create-reservation rejected: unparseable time', { received: p.time });
        return res.status(400).json({
            error: 'invalid_time',
            message: 'Formato orario non riconosciuto. Esempi accettati: 20:30, "20 e 30", "20 e mezza".'
        });
    }
    if (rawShift !== Shift.LUNCH && rawShift !== Shift.DINNER) {
        return res.status(400).json({ error: 'invalid_shift', message: 'shift must be LUNCH or DINNER' });
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
        return res.status(400).json({ error: 'invalid_slot', message });
    }
    if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
        return res.status(400).json({ error: 'invalid_guests', message: 'guests must be an integer 1-50' });
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
                url: '/?view=RESERVATIONS',
                tag: `reservation-${created.id}`,
            },
            { excludeUserId: null }
        ).catch(err => console.error('Push (voice reservation) failed:', err));

        const confirmationPhrase = formatItalianConfirmation(created);
        console.log('[ElevenLabs] create-reservation OK', {
            id: created.id, conversation_id: conversationId, customer: created.customer_name,
        });
        res.json({
            success: true,
            reservation_id: created.id,
            requires_review: created.requires_review,
            confirmation_phrase: confirmationPhrase,
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

    const p = (req.body?.parameters && typeof req.body.parameters === 'object')
        ? req.body.parameters
        : req.body || {};
    const conversationId: string | undefined = req.body?.conversation_id || p.conversation_id;

    const phoneRaw = String(p.phone ?? '').trim();
    if (!phoneRaw) {
        return res.status(400).json({ error: 'invalid_phone', message: 'phone is required' });
    }
    const normalizedDate = parseFlexibleDate(p.date);
    if (!normalizedDate) {
        console.warn('[ElevenLabs] cancel-reservation rejected: unparseable date', { received: p.date });
        return res.status(400).json({
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
            return res.status(400).json({
                error: 'invalid_time',
                message: 'Formato orario non riconosciuto. Esempi accettati: 20:30, "20 e 30", "20 e mezza".'
            });
        }
        normalizedTime = t;
    }

    try {
        console.log('[ElevenLabs] cancel-reservation start', {
            phone_raw: phoneRaw, normalized_date: normalizedDate,
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
                url: '/?view=RESERVATIONS',
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
    const phoneRaw: string | undefined =
        data.metadata?.phone || body.metadata?.phone || data.phone || body.phone || data.caller_id || body.caller_id;

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
            `SELECT r.id, r.customer_name, r.phone, r.reservation_time, r.guests
             FROM voice_calls vc
             JOIN reservations r ON r.id = vc.reservation_id
             WHERE vc.conversation_id = $1`,
            [conversationId]
        );
        const row = linked.rows[0];
        if (row && row.phone) {
            const dt = new Date(row.reservation_time);
            const day = String(dt.getDate()).padStart(2, '0');
            const month = String(dt.getMonth() + 1).padStart(2, '0');
            const year = dt.getFullYear();
            const hours = String(dt.getHours()).padStart(2, '0');
            const minutes = String(dt.getMinutes()).padStart(2, '0');
            const persone = row.guests === 1 ? 'persona' : 'persone';
            const message = `Ciao ${row.customer_name.split(' ')[0]}, la tua prenotazione per ${row.guests} ${persone} è registrata per il ${day}/${month}/${year} alle ${hours}:${minutes}. A presto!`;
            sendVonageWhatsApp(row.phone, message).catch(err =>
                console.warn('[ElevenLabs] post-call WhatsApp send failed:', err?.message || err)
            );
        }
    } catch (err: any) {
        console.warn('[ElevenLabs] post-call recap lookup failed:', err?.message || err);
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

async function findTableConflicts(
    eventDate: string,
    shift: string | null | undefined,
    tableIds: number[],
    options?: { excludeBanquetId?: number; excludeReservationId?: number }
): Promise<TableConflict[]> {
    if (!eventDate || !shift || !Array.isArray(tableIds) || tableIds.length === 0) return [];

    const conflicts: TableConflict[] = [];

    const resParams: any[] = [tableIds, eventDate, shift];
    let resWhere = `r.table_id = ANY($1::int[])
                    AND DATE(r.reservation_time) = $2::date
                    AND r.shift = $3
                    AND COALESCE(r.arrival_status, 'WAITING') <> 'DEPARTED'
                    AND COALESCE(r.reservation_status, 'CONFIRMED') <> 'CANCELLED'`;
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
        const result = await queryWithRetry(`
            SELECT r.*, u.full_name AS created_by_user_name
            FROM reservations r
            LEFT JOIN users u ON r.created_by_user_id = u.id
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
        const { customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        if (await isTableInClosedRoom(table_id)) {
            return res.status(400).json({ error: 'La sala selezionata è chiusa. Scegli un tavolo in una sala aperta.' });
        }
        if (table_id != null && reservation_time && shift) {
            const eventDate = new Date(reservation_time).toISOString().substring(0, 10);
            const conflicts = await findTableConflicts(eventDate, shift, [Number(table_id)]);
            if (conflicts.length > 0) {
                return res.status(409).json({
                    error: buildConflictMessage(conflicts),
                    conflicts,
                });
            }
        }
        const result = await queryWithRetry(
            `WITH ins AS (
                INSERT INTO reservations (customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status, created_by_user_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING *
            )
            SELECT ins.*, u.full_name AS created_by_user_name
            FROM ins
            LEFT JOIN users u ON ins.created_by_user_id = u.id`,
            [
                customer_name,
                reservation_time,
                shift,
                guests,
                childrenCount,
                table_id ?? null,
                notes ?? null,
                email ?? null,
                phone ?? null,
                payment_status ?? 'PENDING',
                arrival_status ?? 'WAITING',
                reservation_status ?? 'CONFIRMED',
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
                url: '/?view=RESERVATIONS',
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
        const { customer_name, reservation_time, shift, guests, children, table_id, notes, email, phone, payment_status, arrival_status, reservation_status } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        if (await isTableInClosedRoom(table_id)) {
            return res.status(400).json({ error: 'La sala selezionata è chiusa. Scegli un tavolo in una sala aperta.' });
        }
        if (table_id != null && reservation_time && shift) {
            const eventDate = new Date(reservation_time).toISOString().substring(0, 10);
            const conflicts = await findTableConflicts(eventDate, shift, [Number(table_id)], { excludeReservationId: Number(id) });
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
                SELECT reservation_status AS prev_status FROM reservations WHERE id = $13
            ), upd AS (
                UPDATE reservations
                SET customer_name = $1, reservation_time = $2, shift = $3, guests = $4, children = $5, table_id = $6, notes = $7, email = $8, phone = $9, payment_status = $10, arrival_status = $11, reservation_status = $12
                WHERE id = $13
                RETURNING *
            )
            SELECT upd.*, u.full_name AS created_by_user_name, (SELECT prev_status FROM old) AS prev_status
            FROM upd
            LEFT JOIN users u ON upd.created_by_user_id = u.id`,
            [
                customer_name,
                reservation_time,
                shift,
                guests,
                childrenCount,
                table_id ?? null,
                notes ?? null,
                email ?? null,
                phone ?? null,
                payment_status ?? 'PENDING',
                arrival_status ?? 'WAITING',
                reservation_status ?? 'CONFIRMED',
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
                    url: '/?view=RESERVATIONS',
                    tag: `reservation-${updatedReservation.id}`,
                },
                { excludeUserId: req.user?.userId ?? null }
            ).catch(err => console.error('Push (cancellation) failed:', err));
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

// Send WhatsApp confirmation for reservation
app.post('/reservations/:id/confirm-whatsapp', authenticate, requirePermission('reservations:full'), async (req, res) => {
    try {
        const { id } = req.params;

        // Get reservation details
        const result = await queryWithRetry(
            'SELECT customer_name, reservation_time, guests, phone FROM reservations WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Reservation not found' });
        }

        const reservation = result.rows[0];

        if (!reservation.phone) {
            return res.status(400).json({ error: 'No phone number for this reservation' });
        }

        // Format date and time in Italian format
        const reservationDate = new Date(reservation.reservation_time);
        const day = String(reservationDate.getDate()).padStart(2, '0');
        const month = String(reservationDate.getMonth() + 1).padStart(2, '0');
        const year = reservationDate.getFullYear();
        const hours = String(reservationDate.getHours()).padStart(2, '0');
        const minutes = String(reservationDate.getMinutes()).padStart(2, '0');

        const formattedDate = `${day}/${month}/${year}`;
        const formattedTime = `${hours}:${minutes}`;

        // Send WhatsApp confirmation
        await sendVonageWhatsApp(
            reservation.phone,
            `La prenotazione per ${formattedDate} ${formattedTime} e' confermata. A presto!`
        );

        console.log(`[WhatsApp] ✅ Confirmation sent for reservation ${id} to ${reservation.phone}`);

        res.json({ success: true, message: 'Confirmation sent via WhatsApp' });
    } catch (err) {
        console.error('Error sending WhatsApp confirmation:', err);
        res.status(500).json({ error: 'Failed to send confirmation' });
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
app.get('/table-hidden', authenticate, async (req, res) => {
    try {
        const { date, shift } = req.query;
        if (!date || !shift) {
            return res.status(400).json({ error: 'date and shift query params are required' });
        }
        if (shift !== 'LUNCH' && shift !== 'DINNER') {
            return res.status(400).json({ error: 'shift must be LUNCH or DINNER' });
        }
        const result = await queryWithRetry(
            'SELECT id, date, shift, table_id FROM table_hidden_overrides WHERE date = $1 AND shift = $2',
            [date, shift]
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

    // Sum guests for tomorrow's reservations (banquet bookings already counted via reservation rows)
    const result = await queryWithRetry(
        `SELECT COALESCE(SUM(guests), 0)::int AS total FROM reservations
         WHERE DATE(reservation_time) = $1
         AND COALESCE(reservation_status, 'CONFIRMED') <> 'CANCELLED'`,
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
        const { name, phone, email, address, city, postal_code, notes } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        if (!phone || !String(phone).trim()) {
            return res.status(400).json({ error: 'phone is required' });
        }

        // Dedupe on the digit-only form of the phone — strips spaces, "+",
        // dashes, etc. so "+39 333 1234567" and "3331234567" match. Phone
        // is required, so it's a reliable identifier.
        const trimmedPhone = String(phone).trim();
        const phoneDigits = trimmedPhone.replace(/\D/g, '');
        if (phoneDigits) {
            const existing = await queryWithRetry(
                `SELECT id, name, phone, email, address, city, postal_code, notes, created_at, updated_at
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
            `INSERT INTO customers (name, phone, email, address, city, postal_code, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, name, phone, email, address, city, postal_code, notes, created_at, updated_at`,
            [
                normalizeCustomerName(String(name).trim()),
                trimmedPhone || null,
                email ? String(email).trim() : null,
                address ?? null,
                city ?? null,
                postal_code ?? null,
                notes ?? null,
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
        const { name, phone, email, address, city, postal_code, notes } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        if (!phone || !String(phone).trim()) {
            return res.status(400).json({ error: 'phone is required' });
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
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING id, name, phone, email, address, city, postal_code, notes, created_at, updated_at`,
            [
                normalizeCustomerName(String(name).trim()),
                phone ? String(phone).trim() : null,
                email ? String(email).trim() : null,
                address ?? null,
                city ?? null,
                postal_code ?? null,
                notes ?? null,
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
        const { name, description, price_per_person, dish_ids, courses, event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        const childrenPrice = children_price != null && children_price !== '' ? Number(children_price) : null;
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
            "INSERT INTO banquet_menus (name, description, price_per_person, dish_ids, courses, event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids",
            [name, description, price_per_person, flatDishIds, coursesJson, event_date, shift ?? null, deposit_amount ?? null, guests ?? null, childrenCount, childrenPrice, notes_courses ?? null, notes_service ?? null, notes_mise_en_place ?? null, customer_id ?? null, tableIdsArr.length > 0 ? tableIdsArr : null]
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
        const { name, description, price_per_person, dish_ids, courses, event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids } = req.body;
        const childrenCount = Math.max(0, Math.min(Number(children) || 0, Number(guests) || 0));
        const childrenPrice = children_price != null && children_price !== '' ? Number(children_price) : null;
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
            "UPDATE banquet_menus SET name = $1, description = $2, price_per_person = $3, dish_ids = $4, courses = $5::jsonb, event_date = $6, shift = $7, deposit_amount = $8, guests = $9, children = $10, children_price = $11, notes_courses = $12, notes_service = $13, notes_mise_en_place = $14, customer_id = $15, table_ids = $16 WHERE id = $17 RETURNING id, name, description, price_per_person, dish_ids, courses, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, shift, deposit_amount, guests, children, children_price, notes_courses, notes_service, notes_mise_en_place, customer_id, table_ids",
            [name, description, price_per_person, flatDishIds, coursesJson, event_date, shift ?? null, deposit_amount ?? null, guests ?? null, childrenCount, childrenPrice, notes_courses ?? null, notes_service ?? null, notes_mise_en_place ?? null, customer_id ?? null, tableIdsArr.length > 0 ? tableIdsArr : null, id]
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
                    b.guests, b.notes_courses, b.notes_service, b.notes_mise_en_place, b.customer_id,
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
                    b.guests, b.notes_courses, b.notes_service, b.notes_mise_en_place, b.customer_id,
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
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
            FROM shopping_items
        `;
        const params: string[] = [];

        if (date) {
            query += ' WHERE date = $1';
            params.push(date as string);
        }

        query += `
            ORDER BY
                CASE category
                    WHEN 'CUCINA' THEN 1
                    WHEN 'BAR' THEN 2
                    WHEN 'ALTRO' THEN 3
                END,
                created_at ASC
        `;

        const result = await queryWithRetry(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/shopping', authenticate, async (req, res) => {
    try {
        const { name, category, date } = req.body;

        console.log('🛒 POST /shopping - req.user:', req.user);

        if (!name || !date) {
            return res.status(400).json({ error: 'Name and date are required' });
        }

        const creatorEmail = req.user?.email || null;
        console.log('🛒 Creator email:', creatorEmail);

        const result = await queryWithRetry(`
            INSERT INTO shopping_items (name, category, date, created_by_user_id, created_by_user_name)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [name, category || 'ALTRO', date, req.user?.userId || null, creatorEmail]);

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
        const { name, category } = req.body;

        if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
            return res.status(400).json({ error: 'name must be a non-empty string' });
        }
        if (category !== undefined && !['CUCINA', 'BAR', 'ALTRO'].includes(category)) {
            return res.status(400).json({ error: 'category must be CUCINA, BAR, or ALTRO' });
        }
        if (name === undefined && category === undefined) {
            return res.status(400).json({ error: 'At least one of name or category is required' });
        }

        const result = await queryWithRetry(`
            UPDATE shopping_items
            SET name = COALESCE($1, name),
                category = COALESCE($2, category)
            WHERE id = $3
            RETURNING
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [name?.trim() ?? null, category ?? null, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

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

        const result = await queryWithRetry(`
            UPDATE shopping_items
            SET checked = NOT checked
            WHERE id = $1
            RETURNING
                id,
                name,
                category,
                checked,
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                created_at as "createdAt",
                created_by_user_id as "createdByUserId",
                created_by_user_name as "createdByUserName"
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

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

    if (!bookingData) {
        await sendVonageWhatsApp(phoneNumber,
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
        await sendVonageWhatsApp(phoneNumber,
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

        // Send immediate acknowledgment
        await sendVonageWhatsApp(phoneNumber,
            "Grazie per la richiesta di prenotazione, a breve ricevera la conferma della disponibilita del tavolo per la data e ora richiesta."
        );

        // Determine shift based on time
        const shift = determineShift(time);

        // Create reservation in database
        const result = await queryWithRetry(
            'INSERT INTO reservations (customer_name, reservation_time, shift, guests, phone, payment_status, arrival_status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [
                name,
                `${date}T${time}`,
                shift,
                guests,
                phoneNumber,
                PaymentStatus.PENDING,
                'WAITING'
            ]
        );

        const newReservation = result.rows[0];

        // Broadcast via Socket.IO
        if (socketService) {
            socketService.broadcastReservationCreated(newReservation);
        }

        console.log(`[WhatsApp] ✅ Reservation created successfully for ${name}. Waiting for manual confirmation.`);

    } catch (error) {
        console.error('[WhatsApp] Error creating reservation:', error);
        await sendVonageWhatsApp(phoneNumber,
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
               AND EXISTS (
                   SELECT 1 FROM tables t
                   WHERE t.room_id = r.id
                     AND t.seats >= $1
                     AND NOT EXISTS (
                         SELECT 1 FROM reservations res
                         WHERE res.table_id = t.id
                           AND DATE(res.reservation_time) = $2
                           AND res.shift = $3
                           AND COALESCE(res.reservation_status, 'CONFIRMED') <> 'CANCELLED'
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

app.post('/public/reservations', publicBookingLimiter, async (req, res) => {
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
        // preference in the notes column without needing extra joins.
        let requestedRoomName: string | null = null;
        if (requestedRoomId && Number.isFinite(requestedRoomId)) {
            const roomRes = await queryWithRetry(
                'SELECT name FROM rooms WHERE id = $1 AND is_closed = false',
                [requestedRoomId]
            );
            if (roomRes.rows[0]) requestedRoomName = roomRes.rows[0].name;
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
                url: '/?view=RESERVATIONS',
                tag: `pending-${created.id}`,
            }
        ).catch(err => console.error('Push (public booking) failed:', err));

        // Fire-and-forget WhatsApp acknowledgement to the customer. The booking
        // is PENDING — staff still need to confirm — so wording reflects that.
        const [yyyy, mm, dd] = date.split('-');
        const dateLabel = `${dd}/${mm}/${yyyy}`;
        sendVonageWhatsApp(
            phoneE164,
            `Ciao ${toTitleCase(customer_name)}, abbiamo ricevuto la tua richiesta di prenotazione per ${guestsNum} ${guestsNum === 1 ? 'persona' : 'persone'} il ${dateLabel} alle ${time}. Ti ricontatteremo a breve per confermarla. Grazie!`
        ).catch(err => console.error('[public-booking] WhatsApp ack failed:', err));

        res.status(201).json({ ok: true, id: created.id });
    } catch (err: any) {
        console.error('POST /public/reservations error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

app.get('/prenota', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'prenota.html'));
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