// Chiamate in corso e scheda del chiamante (docs/telefono-piano.md, Fase 1).
// Oggi l'unica chiamata che passa da Sympotia è quella di Sofia:
// il webhook di init la apre, il post-call la chiude. Lo staff vede chi sta
// chiamando mentre Sofia parla, invece di scoprirlo a chiamata finita.
//
// Le chiamate in corso stanno nella memoria del processo, non nel DB: durano
// un minuto, e un riavvio del server a metà chiamata le perde senza danno
// (il post-call le chiude comunque sui client che le mostrano). Railway gira
// con un'istanza sola; con più istanze servirebbe una tabella.

import { queryWithRetry } from '../db.js';
import { phoneLast10Variants } from '../utils/text.js';
import { findActiveReservationsByPhone } from './elevenlabsService.js';

export interface CallerCardCustomer {
    id: number;
    name: string;
    /** Il telefono com'è scritto in rubrica: la scheda Clienti si apre con
     *  questo, non col numero E.164 del chiamante. */
    phone: string | null;
    is_vip: boolean;
    is_blacklisted: boolean;
    dietary_notes: string | null;
    preferences_notes: string | null;
}

export interface CallerCardBooking {
    id: number;
    reservation_time: string;
    date: string;
    time: string;
    guests: number;
    children: number | null;
    reservation_status: string;
}

export interface CallerCard {
    /** E.164 del chiamante; '' per un numero nascosto. */
    phone: string;
    customer: CallerCardCustomer | null;
    /** Cene passate confermate con questo numero, in rubrica o no. */
    visits: number;
    last_visit: string | null;
    no_shows: number;
    upcoming: CallerCardBooking[];
}

export type LiveCallChannel = 'sofia';

export interface LiveCall {
    id: string;
    channel: LiveCallChannel;
    call_sid: string | null;
    phone: string;
    started_at: string;
    card: CallerCard;
}

const emptyCard = (phone: string): CallerCard => ({
    phone, customer: null, visits: 0, last_visit: null, no_shows: 0, upcoming: [],
});

export async function buildCallerCard(tenantId: number, phone: string): Promise<CallerCard> {
    const last10 = phoneLast10Variants(phone);
    if (last10.length === 0) return emptyCard(phone);

    // Stesse chiavi delle ultime 10 cifre di findCustomerByPhone e della
    // rubrica, così la scheda trova lo stesso cliente che Sofia saluta per nome.
    const [customerRes, statsRes, upcoming] = await Promise.all([
        queryWithRetry(
            `SELECT id, name, phone, is_vip, is_blacklisted, dietary_notes, preferences_notes
             FROM customers
             WHERE tenant_id = $2
               AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ANY($1::text[])
             ORDER BY id ASC
             LIMIT 1`,
            [last10, tenantId]
        ),
        queryWithRetry(
            `SELECT
                COUNT(*) FILTER (WHERE COALESCE(reservation_status, 'CONFIRMED') = 'CONFIRMED'
                                   AND reservation_time < now())::int AS visits,
                MAX(reservation_time) FILTER (WHERE COALESCE(reservation_status, 'CONFIRMED') = 'CONFIRMED'
                                                AND reservation_time < now()) AS last_visit,
                COUNT(*) FILTER (WHERE reservation_status = 'NO_SHOW')::int AS no_shows
             FROM reservations
             WHERE tenant_id = $2
               AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ANY($1::text[])`,
            [last10, tenantId]
        ),
        // Un anno e non i 30 giorni di Sofia: chi chiama per il banchetto di
        // giugno deve comparire con quella prenotazione.
        findActiveReservationsByPhone(tenantId, phone, { horizonDays: 365 }),
    ]);

    const c = customerRes.rows[0];
    const s = statsRes.rows[0] || {};
    return {
        phone,
        customer: c ? {
            id: c.id,
            name: (c.name || '').trim(),
            phone: c.phone ?? null,
            is_vip: c.is_vip === true,
            is_blacklisted: c.is_blacklisted === true,
            dietary_notes: (c.dietary_notes || '').trim() || null,
            preferences_notes: (c.preferences_notes || '').trim() || null,
        } : null,
        visits: Number(s.visits) || 0,
        last_visit: s.last_visit ? new Date(s.last_visit).toISOString() : null,
        no_shows: Number(s.no_shows) || 0,
        upcoming: upcoming.slice(0, 3).map(r => ({
            id: r.id,
            reservation_time: new Date(r.reservation_time).toISOString(),
            date: r.date,
            time: r.time,
            guests: r.guests,
            children: r.children ?? null,
            reservation_status: r.reservation_status,
        })),
    };
}

// Una chiamata senza post-call (webhook perso, conversazione abortita) non
// deve restare «in corso» per sempre sui client che si collegano dopo.
const LIVE_CALL_TTL_MS = 20 * 60 * 1000;

const liveByTenant = new Map<number, Map<string, { call: LiveCall; timer: ReturnType<typeof setTimeout> }>>();

export function addLiveCall(tenantId: number, call: LiveCall): void {
    let calls = liveByTenant.get(tenantId);
    if (!calls) { calls = new Map(); liveByTenant.set(tenantId, calls); }
    const previous = calls.get(call.id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => { calls!.delete(call.id); }, LIVE_CALL_TTL_MS);
    timer.unref?.();
    calls.set(call.id, { call, timer });
}

/** Chiude la chiamata per call_sid; senza sid (o se il sid non torna) la più
 *  vecchia dello stesso numero. Restituisce l'id chiuso, null se non c'era. */
export function removeLiveCall(tenantId: number, ref: { callSid?: string | null; phone?: string | null }): string | null {
    const calls = liveByTenant.get(tenantId);
    if (!calls) return null;
    let id: string | null = null;
    if (ref.callSid && calls.has(ref.callSid)) {
        id = ref.callSid;
    } else if (ref.phone) {
        const match = [...calls.values()]
            .filter(e => e.call.phone === ref.phone)
            .sort((a, b) => a.call.started_at.localeCompare(b.call.started_at))[0];
        id = match?.call.id ?? null;
    }
    if (!id) return null;
    const entry = calls.get(id);
    if (entry) clearTimeout(entry.timer);
    calls.delete(id);
    return id;
}

/** Una chiamata dello stesso numero aperta da poco: con Sympotia davanti al
 *  numero la apre il webhook voce, e il webhook di init di ElevenLabs, se
 *  arriva senza call_sid, non deve aprirne una seconda. */
export function findRecentLiveCall(tenantId: number, phone: string, withinMs: number): LiveCall | null {
    const calls = liveByTenant.get(tenantId);
    if (!calls || !phone) return null;
    const cutoff = Date.now() - withinMs;
    for (const { call } of calls.values()) {
        if (call.phone === phone && Date.parse(call.started_at) >= cutoff) return call;
    }
    return null;
}

export function listLiveCalls(tenantId: number): LiveCall[] {
    const calls = liveByTenant.get(tenantId);
    if (!calls) return [];
    return [...calls.values()]
        .map(e => e.call)
        .sort((a, b) => a.started_at.localeCompare(b.started_at));
}
