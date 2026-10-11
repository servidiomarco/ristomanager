// Il modulo asporto lato server: impostazioni, griglia dei ritiri, capienza,
// numero del giorno, righe dal menu, abbinamento dei piatti detti o scritti,
// e la creazione dell'ordine. Fino all'11/10/2026 tutto stava in server.ts e
// l'ordine si creava in tre copie (Sofia al telefono, la pagina /ordina, il
// banco): ora le tre strade e l'agente WhatsApp passano da createTakeawayOrder.

import { queryWithRetry, withTenant } from '../db.js';
import { Shift } from '../types.js';
import { getAvailableSlots } from '../utils/slots.js';
import { isEnglishGuest, normalizeLanguageCode } from '../utils/language.js';
import { getDatePartInTz, getTimePartInTz } from '../utils/reservationTime.js';
import { outboxEnqueueInTx } from './outboxService.js';

// ============================================
// Impostazioni, griglia, capienza, righe
// ============================================

export const TAKEAWAY_CAPACITY_KEY = 'takeaway_capacity_per_slot';
export const TAKEAWAY_CAPACITY_DEFAULT = 4;
export const TAKEAWAY_PREP_MINUTES_KEY = 'takeaway_prep_minutes';
export const TAKEAWAY_PREP_MINUTES_DEFAULT = 20;
// text_value = data ISO: lo «stop asporto» vale per UNA data (di solito
// stasera) e decade da solo — niente interruttore da ricordarsi di riaprire.
export const TAKEAWAY_STOP_DATE_KEY = 'takeaway_stop_date';
// text_value = 'global' | 'own'. Se la board segue la data dell'app, il
// giorno si cambia una volta sola dalla testata e vale per prenotazioni,
// sala e asporto insieme; 'own' tiene il giorno del banco per conto suo,
// com'era prima che il navigatore salisse in testata.
export const TAKEAWAY_DATE_MODE_KEY = 'takeaway_date_mode';
export const TAKEAWAY_DATE_MODE_DEFAULT: 'global' | 'own' = 'own';

export const TAKEAWAY_STATUSES = ['REQUESTED', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'PICKED_UP', 'NO_SHOW', 'CANCELLED'] as const;

export async function getTakeawaySettings(tenantId: number): Promise<{ capacityPerSlot: number; prepMinutes: number; stopDate: string | null; dateMode: 'global' | 'own' }> {
    try {
        const result = await queryWithRetry(
            'SELECT key, int_value, text_value FROM app_settings WHERE tenant_id = $1 AND key = ANY($2)',
            [tenantId, [TAKEAWAY_CAPACITY_KEY, TAKEAWAY_PREP_MINUTES_KEY, TAKEAWAY_STOP_DATE_KEY, TAKEAWAY_DATE_MODE_KEY]]
        );
        const byKey = new Map<string, any>(result.rows.map((r: any) => [r.key, r]));
        const intOr = (key: string, fallback: number) => {
            const n = Number(byKey.get(key)?.int_value);
            return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
        };
        const stopRaw = byKey.get(TAKEAWAY_STOP_DATE_KEY)?.text_value;
        const modeRaw = byKey.get(TAKEAWAY_DATE_MODE_KEY)?.text_value;
        return {
            capacityPerSlot: intOr(TAKEAWAY_CAPACITY_KEY, TAKEAWAY_CAPACITY_DEFAULT),
            prepMinutes: intOr(TAKEAWAY_PREP_MINUTES_KEY, TAKEAWAY_PREP_MINUTES_DEFAULT),
            stopDate: typeof stopRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stopRaw) ? stopRaw : null,
            dateMode: modeRaw === 'global' || modeRaw === 'own' ? modeRaw : TAKEAWAY_DATE_MODE_DEFAULT,
        };
    } catch (err) {
        console.error('[takeaway] lettura impostazioni fallita, uso i default:', (err as any)?.message || err);
        return { capacityPerSlot: TAKEAWAY_CAPACITY_DEFAULT, prepMinutes: TAKEAWAY_PREP_MINUTES_DEFAULT, stopDate: null, dateMode: TAKEAWAY_DATE_MODE_DEFAULT };
    }
}

// Uno slot di ritiro è valido se sta nella griglia di apertura di uno dei
// due turni; il turno dell'ordine deriva da qui, mai dal client.
export async function resolveTakeawayShift(tenantId: number, date: string, time: string): Promise<'LUNCH' | 'DINNER' | null> {
    const [lunch, dinner] = await Promise.all([
        getAvailableSlots(tenantId, date, Shift.LUNCH),
        getAvailableSlots(tenantId, date, Shift.DINNER),
    ]);
    if (lunch.includes(time)) return 'LUNCH';
    if (dinner.includes(time)) return 'DINNER';
    return null;
}

export async function countTakeawayInSlot(tenantId: number, date: string, time: string, excludeId?: number): Promise<number> {
    const result = await queryWithRetry(
        `SELECT COUNT(*)::int AS n FROM takeaway_orders
         WHERE tenant_id = $1 AND pickup_date = $2 AND pickup_time = $3
           AND status NOT IN ('CANCELLED', 'NO_SHOW') AND id <> COALESCE($4, -1)`,
        [tenantId, date, time, excludeId ?? null]
    );
    return result.rows[0]?.n ?? 0;
}

export async function loadTakeawayView(tenantId: number, orderId: number): Promise<any | null> {
    const [order, items] = await Promise.all([
        // bill_id in vista: la board mostra «conto in cassa» senza
        // interrogare /bills/open.
        queryWithRetry(
            `SELECT t.*, o.table_bill_id AS bill_id FROM takeaway_orders t
             LEFT JOIN orders o ON o.id = t.kitchen_order_id AND o.tenant_id = t.tenant_id
             WHERE t.id = $1 AND t.tenant_id = $2`,
            [orderId, tenantId]
        ),
        queryWithRetry(
            'SELECT id, takeaway_order_id, dish_id, name_snapshot, unit_price_cents, qty, note FROM takeaway_order_items WHERE takeaway_order_id = $1 AND tenant_id = $2 ORDER BY id',
            [orderId, tenantId]
        ),
    ]);
    if (order.rows.length === 0) return null;
    const rows = items.rows;
    const total = rows.reduce((sum: number, r: any) => sum + Number(r.unit_price_cents) * Number(r.qty), 0);
    return { ...order.rows[0], items: rows, total_cents: total };
}

// Numero d'ordine del giorno («#12»): progressivo per (tenant, data di
// ritiro), assegnato DENTRO la transazione di creazione e persistito — mai
// derivato a video, così un annullamento non rinumera gli ordini già
// comunicati ai clienti. L'advisory lock transazionale serializza le
// assegnazioni concorrenti dello stesso giorno (due ordini web nello stesso
// istante leggerebbero lo stesso MAX+1); l'indice unico parziale della
// migration resta la rete di sicurezza. Il lock muore col COMMIT/ROLLBACK.
export async function allocateTakeawayDailyNumber(client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }, tenantId: number, pickupDate: string): Promise<number> {
    await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('takeaway_daily:' || $1 || ':' || $2, 0))`,
        [String(tenantId), pickupDate]
    );
    const r = await client.query(
        `SELECT COALESCE(MAX(daily_number), 0) + 1 AS n FROM takeaway_orders WHERE tenant_id = $1 AND pickup_date = $2`,
        [tenantId, pickupDate]
    );
    return Number(r.rows[0].n);
}

// Valida le righe e congela nome/prezzo dal menu. Prezzo base del piatto:
// il listino dedicato all'asporto arriva con la scelta menu-asporto, non qui.
export async function buildTakeawayItems(tenantId: number, raw: unknown): Promise<{ error?: string; items?: { dish_id: number; name: string; cents: number; qty: number; note: string | null }[] }> {
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'Serve almeno una riga' };
    if (raw.length > 50) return { error: 'Troppe righe (max 50)' };
    const parsed: { dish_id: number; qty: number; note: string | null }[] = [];
    for (const r of raw) {
        const dishId = Math.trunc(Number((r as any)?.dish_id));
        const qty = Math.trunc(Number((r as any)?.qty ?? 1));
        if (!Number.isFinite(dishId) || dishId <= 0) return { error: 'dish_id mancante o non valido' };
        if (!Number.isFinite(qty) || qty < 1 || qty > 99) return { error: 'Quantità non valida (1-99)' };
        const note = typeof (r as any)?.note === 'string' ? (r as any).note.trim().slice(0, 300) : '';
        parsed.push({ dish_id: dishId, qty, note: note || null });
    }
    const dishIds = [...new Set(parsed.map(p => p.dish_id))];
    const dishes = await queryWithRetry(
        'SELECT id, name, price FROM dishes WHERE id = ANY($1::int[]) AND tenant_id = $2',
        [dishIds, tenantId]
    );
    const byId = new Map<number, any>(dishes.rows.map((d: any) => [Number(d.id), d]));
    const items = [];
    for (const p of parsed) {
        const dish = byId.get(p.dish_id);
        if (!dish) return { error: `Piatto ${p.dish_id} inesistente` };
        items.push({
            dish_id: p.dish_id,
            name: String(dish.name),
            cents: Math.max(0, Math.round(Number(dish.price) * 100)),
            qty: p.qty,
            note: p.note,
        });
    }
    return { items };
}

// Le route di scrittura ricontrollano slot, stop e capienza; `force: true`
// scavalca stop e capienza (MAI la validità dello slot): chi prende
// l'ordine al banco può decidere che uno in più ci sta, la pagina pubblica
// delle fasi successive no.
export async function validateTakeawaySlot(
    tenantId: number, date: string, time: string,
    opts: { force: boolean; excludeId?: number }
): Promise<{ error?: { status: number; body: any }; shift?: 'LUNCH' | 'DINNER' }> {
    const shift = await resolveTakeawayShift(tenantId, date, time);
    if (!shift) return { error: { status: 400, body: { error: 'invalid_slot', message: 'Orario fuori dalla griglia di apertura' } } };
    const settings = await getTakeawaySettings(tenantId);
    if (!opts.force) {
        if (settings.stopDate === date) {
            return { error: { status: 409, body: { error: 'takeaway_stopped', message: 'Asporto fermo per questa data' } } };
        }
        const booked = await countTakeawayInSlot(tenantId, date, time, opts.excludeId);
        if (booked >= settings.capacityPerSlot) {
            return { error: { status: 409, body: { error: 'slot_full', message: 'Slot al completo', booked, capacity: settings.capacityPerSlot } } };
        }
    }
    return { shift };
}


// ============================================
// Il catalogo e l'abbinamento dei piatti
// ============================================
// Nato per Sofia («due amatriciane»), vale uguale per l'agente WhatsApp che
// legge «2 amatriciana e una tagliata».

// Normalizzazione per il match dei piatti dettati: minuscole, niente
// accenti, solo lettere e cifre. «Spaghetti all'Amatriciana» ≈ «spaghetti
// amatriciana».
export const normalizeDishText = (s: string): string =>
    String(s ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

export async function loadVoiceCatalogue(tenantId: number): Promise<{ id: number; name: string; norm: string; tokens: Set<string> }[]> {
    const rs = await queryWithRetry(
        `SELECT d.id, d.name
         FROM dishes d
         WHERE d.tenant_id = $1 AND d.is_active AND d.crm_enabled
           AND COALESCE(d.sold_by_weight, false) = false
           AND EXISTS (SELECT 1 FROM dish_menus dm JOIN menus m ON m.id = dm.menu_id
                       WHERE dm.dish_id = d.id AND m.system_key = 'ALLA_CARTA')`,
        [tenantId]
    );
    return rs.rows.map((d: any) => {
        const norm = normalizeDishText(d.name);
        return { id: Number(d.id), name: String(d.name), norm, tokens: new Set(norm.split(' ')) };
    });
}

// Dal nome dettato al piatto del menu. Esatto → contenimento → tokens
// tutti presenti; più candidati alla pari = ambiguo, si chiede al cliente
// invece di tirare a indovinare la cena di qualcuno.
export function matchVoiceDish(catalogue: { id: number; name: string; norm: string; tokens: Set<string> }[], spoken: string):
    { dish: { id: number; name: string } } | { ambiguous: string[] } | { suggestions: string[] } {
    const norm = normalizeDishText(spoken);
    if (!norm) return { suggestions: [] };
    const exact = catalogue.filter(d => d.norm === norm);
    if (exact.length === 1) return { dish: exact[0] };
    if (exact.length > 1) return { ambiguous: exact.map(d => d.name) };
    const contains = catalogue.filter(d => d.norm.includes(norm) || norm.includes(d.norm));
    if (contains.length === 1) return { dish: contains[0] };
    if (contains.length > 1) return { ambiguous: contains.slice(0, 3).map(d => d.name) };
    const spokenTokens = norm.split(' ').filter(t => t.length > 2);
    if (spokenTokens.length > 0) {
        const tokenMatch = catalogue.filter(d => spokenTokens.every(t => d.tokens.has(t)));
        if (tokenMatch.length === 1) return { dish: tokenMatch[0] };
        if (tokenMatch.length > 1) return { ambiguous: tokenMatch.slice(0, 3).map(d => d.name) };
    }
    // Niente match: i più vicini per token condivisi, per il «forse intendevi».
    const scored = catalogue
        .map(d => ({ d, score: spokenTokens.filter(t => d.tokens.has(t)).length }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.d.name);
    return { suggestions: scored };
}

export const takeawayDateReadback = (iso: string, language?: string | null): string =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(
        isEnglishGuest(normalizeLanguageCode(language)) ? 'en-GB' : 'it-IT',
        { weekday: 'long', day: 'numeric', month: 'long' });


// ============================================
// Orari ordinabili
// ============================================

// Minuti da un orario 'HH:MM'; -1 su forma imprevista (slot scartato).
export const slotMinutes = (time: string): number => {
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

// Per OGGI uno slot è ordinabile solo se la cucina fa in tempo: ritiro ≥
// adesso + minuti di preparazione. La griglia di domani passa intera.
export function filterOrderableSlots(slots: string[], date: string, prepMinutes: number, tz: string = 'Europe/Rome'): string[] {
    if (date !== getDatePartInTz(new Date(), tz)) return slots;
    const now = getTimePartInTz(new Date(), tz);
    const cutoff = slotMinutes(now) + prepMinutes;
    return slots.filter(s => slotMinutes(s) >= cutoff);
}


// ============================================
// La creazione dell'ordine
// ============================================

export type TakeawayChannel = 'STAFF' | 'WEB' | 'VOICE' | 'WHATSAPP';

export interface NewTakeawayOrder {
    name: string;
    phone: string | null;
    date: string;
    time: string;
    shift: 'LUNCH' | 'DINNER';
    channel: TakeawayChannel;
    notes: string | null;
    items: { dish_id: number; name: string; cents: number; qty: number; note: string | null }[];
    /** Chi l'ha preso al banco. */
    createdByUserId?: number | null;
    /** L'envelope del log di replica (attore, command id). */
    outbox: { commandId?: string | null; actor: Record<string, any> | null };
}

/**
 * L'ordine nasce confermato, col suo numero del giorno, e le righe insieme
 * nella stessa transazione, con l'evento per il nodo di sala. Le tre strade
 * di prima (voce, web, banco) facevano la stessa cosa in tre copie; i
 * controlli (slot, capienza, righe) restano di chi chiama, perché ognuno
 * risponde a modo suo.
 */
export async function createTakeawayOrder(tenantId: number, o: NewTakeawayOrder): Promise<number> {
    return withTenant(tenantId, async client => {
        const dailyNumber = await allocateTakeawayDailyNumber(client, tenantId, o.date);
        const ins = await client.query(
            `INSERT INTO takeaway_orders (tenant_id, customer_name, customer_phone, pickup_date, pickup_time, shift, status, channel, notes, created_by_user_id, daily_number)
             VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', $7, $8, $9, $10) RETURNING id`,
            [tenantId, o.name, o.phone, o.date, o.time, o.shift, o.channel, o.notes, o.createdByUserId ?? null, dailyNumber]
        );
        const id = Number(ins.rows[0].id);
        await outboxEnqueueInTx(client, tenantId, 'takeaway:created', `takeaway:${id}`,
            { takeaway_order_id: id }, o.outbox);
        for (const item of o.items) {
            await client.query(
                `INSERT INTO takeaway_order_items (tenant_id, takeaway_order_id, dish_id, name_snapshot, unit_price_cents, qty, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [tenantId, id, item.dish_id, item.name, item.cents, item.qty, item.note]
            );
        }
        return id;
    });
}

/** Gli orari di ritiro ancora liberi di un giorno, per turno: la griglia,
 *  meno quelli che la cucina non fa in tempo a preparare e quelli pieni.
 *  Null se l'asporto è fermo per quella data. */
export async function freeTakeawaySlots(tenantId: number, date: string, tz: string): Promise<{ lunch: string[]; dinner: string[] } | null> {
    const [lunch, dinner, settings, counts] = await Promise.all([
        getAvailableSlots(tenantId, date, Shift.LUNCH),
        getAvailableSlots(tenantId, date, Shift.DINNER),
        getTakeawaySettings(tenantId),
        queryWithRetry(
            `SELECT pickup_time, COUNT(*)::int AS n FROM takeaway_orders
             WHERE tenant_id = $1 AND pickup_date = $2 AND status NOT IN ('CANCELLED', 'NO_SHOW')
             GROUP BY pickup_time`,
            [tenantId, date]
        ),
    ]);
    if (settings.stopDate === date) return null;
    const booked = new Map<string, number>(counts.rows.map((r: any) => [r.pickup_time, r.n]));
    const free = (times: string[]) => filterOrderableSlots(times, date, settings.prepMinutes, tz)
        .filter(t => (booked.get(t) ?? 0) < settings.capacityPerSlot);
    return { lunch: free(lunch), dinner: free(dinner) };
}
