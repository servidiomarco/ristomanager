// Shared helpers for threading an incoming email back to a reservation.
// Used by both the Resend inbound webhook (server.ts) and the IMAP inbound
// service (imapInboundService.ts) so both paths share one match algorithm.

import { queryWithRetry } from '../db.js';

// The `From:` header is often `Name <addr@domain>` — extract the bare address.
export function parseFromAddress(from: string | null | undefined): string | null {
    if (!from) return null;
    const m = String(from).match(/<([^>]+)>/);
    return (m ? m[1] : String(from)).trim().toLowerCase();
}

// Pull a single header value in a case-insensitive way from a headers object
// (as returned by Resend's Received Email API). Values can be strings or arrays.
export function pickHeader(
    headers: Record<string, string | string[]> | null | undefined,
    name: string
): string | null {
    if (!headers) return null;
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== target) continue;
        if (Array.isArray(v)) {
            const first = v.find(x => typeof x === 'string' && x.trim().length > 0);
            return first ? String(first).trim() : null;
        }
        return typeof v === 'string' ? v.trim() : null;
    }
    return null;
}

// Split the References header (space-separated Message-IDs) into individual ids.
export function splitReferences(refs: string | null): string[] {
    if (!refs) return [];
    return refs
        .split(/\s+/)
        .map(s => s.trim())
        .filter(Boolean);
}

// Given the Message-IDs from a reply's In-Reply-To / References headers, find
// the reservation those Message-IDs belong to. Returns null when no match.
// tenantId obbligatorio: i canali inbound (Resend, IMAP) lo fissano al tenant
// pubblico. Senza filtro un Message-ID riusato aggancerebbe la risposta alla
// prenotazione di un altro ristorante.
export async function resolveReservationByMessageIds(tenantId: number, candidateIds: string[]): Promise<number | null> {
    const ids = candidateIds.filter(Boolean);
    if (ids.length === 0) return null;
    try {
        const r = await queryWithRetry(
            `SELECT reservation_id
             FROM outbound_messages
             WHERE message_id = ANY($1::text[]) AND reservation_id IS NOT NULL
               AND tenant_id = $2
             ORDER BY sent_at DESC
             LIMIT 1`,
            [ids, tenantId]
        );
        return r.rows[0]?.reservation_id ?? null;
    } catch (err: any) {
        console.warn('[email-threading] resolve-by-message-id failed:', err?.message || err);
        return null;
    }
}

// Fallback resolver: match sender's email against a recent reservation.
export async function resolveReservationByFromEmail(fromEmail: string | null): Promise<number | null> {
    if (!fromEmail) return null;
    try {
        const r = await queryWithRetry(
            `SELECT id
             FROM reservations
             WHERE lower(email) = lower($1)
             ORDER BY reservation_time DESC
             LIMIT 1`,
            [fromEmail]
        );
        return r.rows[0]?.id ?? null;
    } catch (err: any) {
        console.warn('[email-threading] resolve-by-from failed:', err?.message || err);
        return null;
    }
}
