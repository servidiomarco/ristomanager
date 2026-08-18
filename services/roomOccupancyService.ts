import { queryWithRetry } from '../db.js';
import { Shift } from '../types.js';

// ============================================
// PER-ROOM OCCUPANCY CAPS
// ============================================
// L'operatore può riservare una quota di ogni sala ai canali "umani"
// (telefono diretto, walk-in, prenotazioni prese a mano dallo staff):
// quando l'occupazione di una sala raggiunge la percentuale configurata,
// l'agente vocale e il modulo /prenota smettono di proporla.
//
// Il cap NON limita in alcun modo le prenotazioni create dallo staff dal
// gestionale: è una regola che vale solo per i canali self-service.
//
// Il valore è persistito in app_settings.text_value come array JSON, stessa
// convenzione di public_bookings_blocks / voice_bookings_suspension_schedule.

export const ROOM_OCCUPANCY_CAPS_KEY = 'room_occupancy_caps';

// Su cosa si misura la percentuale:
//   TABLES → tavoli occupati / tavoli della sala
//   SEATS  → coperti prenotati / coperti della sala
export type OccupancyBasis = 'TABLES' | 'SEATS';

export interface RoomOccupancyCap {
    room_id: number;
    percent: number;        // 1..100 — a 100 il cap è di fatto disattivo
    basis: OccupancyBasis;
}

const OCCUPANCY_BASES = new Set<string>(['TABLES', 'SEATS']);

export function isValidRoomOccupancyCap(entry: any): entry is RoomOccupancyCap {
    if (!entry || typeof entry !== 'object') return false;
    if (!Number.isInteger(entry.room_id) || entry.room_id <= 0) return false;
    if (!Number.isInteger(entry.percent) || entry.percent < 1 || entry.percent > 100) return false;
    if (typeof entry.basis !== 'string' || !OCCUPANCY_BASES.has(entry.basis)) return false;
    return true;
}

export async function getRoomOccupancyCaps(tenantId: number): Promise<RoomOccupancyCap[]> {
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, ROOM_OCCUPANCY_CAPS_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (typeof raw !== 'string' || !raw.trim()) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidRoomOccupancyCap);
    } catch (err) {
        console.error(`[room-occupancy] failed to read ${ROOM_OCCUPANCY_CAPS_KEY}:`, err);
        return [];
    }
}

export interface RoomOccupancy {
    room_id: number;
    room_name: string;
    is_closed: boolean;          // sala chiusa in modo permanente
    closed_for_shift: boolean;   // chiusura puntuale su questo (data, turno)
    capacity_tables: number;
    capacity_seats: number;
    used_tables: number;
    used_seats: number;
    percent_tables: number;      // arrotondato, per la UI
    percent_seats: number;       // arrotondato, per la UI
    cap: RoomOccupancyCap | null;
    at_cap: boolean;             // true → canali self-service esclusi da questa sala
}

/**
 * Occupazione di ogni sala per un dato (data, turno).
 *
 * Un tavolo conta come occupato quando ha una prenotazione viva, è coinvolto
 * in un accorpamento del turno o è tenuto da un banchetto (in tutti i casi
 * non è più assegnabile). I coperti invece sommano gli ospiti delle
 * prenotazioni: un tavolo da 6 preso da 2 persone pesa 2 coperti ma 1 tavolo.
 *
 * Le richieste web ancora senza tavolo ("Sala richiesta: X." nelle note,
 * scritta da POST /public/reservations) pesano sulla sala richiesta come 1
 * tavolo + i suoi ospiti: altrimenti il canale web potrebbe riempire una
 * sala con decine di richieste PENDING senza mai toccare il cap.
 */
export async function computeRoomOccupancy(tenantId: number, date: string, shift: Shift): Promise<RoomOccupancy[]> {
    const caps = await getRoomOccupancyCaps(tenantId);
    const capByRoom = new Map<number, RoomOccupancyCap>(caps.map(c => [c.room_id, c]));

    // $3 = tenant su ogni tabella coinvolta: senza, i tavoli e i banchetti
    // di un ristorante peserebbero sull'occupazione delle sale dell'altro.
    const result = await queryWithRetry(`
        WITH active AS (
            SELECT t.id, t.room_id, t.seats
            FROM tables t
            WHERE t.tenant_id = $3
              AND NOT EXISTS (
                SELECT 1 FROM table_hidden_overrides h
                WHERE h.table_id = t.id AND h.date = $1 AND h.shift = $2 AND h.tenant_id = $3
            )
        ),
        capacity AS (
            SELECT room_id,
                   COUNT(*)::int AS tables_total,
                   COALESCE(SUM(seats), 0)::int AS seats_total
            FROM active
            GROUP BY room_id
        ),
        occupied AS (
            SELECT a.room_id,
                   COUNT(*)::int AS tables_used,
                   -- Posti sottratti al servizio da un banchetto: il banchetto
                   -- non ha una prenotazione per tavolo da cui sommare gli
                   -- ospiti, quindi pesa per i posti che tiene fermi.
                   COALESCE(SUM(CASE WHEN EXISTS (
                       SELECT 1 FROM banquet_menus b
                       WHERE b.event_date = $1 AND b.shift = $2 AND b.tenant_id = $3 AND a.id = ANY(b.table_ids)
                   ) THEN a.seats ELSE 0 END), 0)::int AS banquet_seats
            FROM active a
            WHERE EXISTS (
                    SELECT 1 FROM reservations res
                    WHERE res.table_id = a.id
                      AND res.tenant_id = $3
                      AND DATE(res.reservation_time) = $1
                      AND res.shift = $2
                      AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
                  )
               OR EXISTS (
                    SELECT 1 FROM table_merges tm
                    WHERE tm.date = $1 AND tm.shift = $2 AND tm.tenant_id = $3
                      AND (tm.primary_id = a.id OR a.id = ANY(tm.merged_ids))
                  )
               OR EXISTS (
                    SELECT 1 FROM banquet_menus b
                    WHERE b.event_date = $1 AND b.shift = $2 AND b.tenant_id = $3 AND a.id = ANY(b.table_ids)
                  )
            GROUP BY a.room_id
        ),
        covers AS (
            SELECT a.room_id, COALESCE(SUM(res.guests), 0)::int AS seats_used
            FROM active a
            JOIN reservations res
              ON res.table_id = a.id
             AND res.tenant_id = $3
             AND DATE(res.reservation_time) = $1
             AND res.shift = $2
             AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
            GROUP BY a.room_id
        ),
        requested AS (
            -- Richieste web non ancora assegnate a un tavolo: la sala scelta
            -- dal cliente è ricostruita dalla nota. position() e non LIKE, così
            -- un nome sala con % o _ non diventa un wildcard.
            SELECT rm.id AS room_id,
                   COUNT(*)::int AS tables_requested,
                   COALESCE(SUM(res.guests), 0)::int AS seats_requested
            FROM rooms rm
            JOIN reservations res
              ON res.table_id IS NULL
             AND res.tenant_id = $3
             AND DATE(res.reservation_time) = $1
             AND res.shift = $2
             AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
             AND position('Sala richiesta: ' || rm.name || '.' in COALESCE(res.notes, '')) > 0
            WHERE rm.tenant_id = $3
            GROUP BY rm.id
        )
        SELECT rm.id                                AS room_id,
               rm.name                              AS room_name,
               COALESCE(rm.is_closed, false)        AS is_closed,
               COALESCE(c.tables_total, 0)          AS capacity_tables,
               COALESCE(c.seats_total, 0)           AS capacity_seats,
               COALESCE(o.tables_used, 0)
                 + COALESCE(q.tables_requested, 0)  AS used_tables,
               COALESCE(v.seats_used, 0)
                 + COALESCE(o.banquet_seats, 0)
                 + COALESCE(q.seats_requested, 0)   AS used_seats,
               EXISTS (
                   SELECT 1 FROM room_closed_overrides rc
                   WHERE rc.room_id = rm.id AND rc.date = $1 AND rc.shift = $2 AND rc.tenant_id = $3
               )                                    AS closed_for_shift
        FROM rooms rm
        LEFT JOIN capacity  c ON c.room_id = rm.id
        LEFT JOIN occupied  o ON o.room_id = rm.id
        LEFT JOIN covers    v ON v.room_id = rm.id
        LEFT JOIN requested q ON q.room_id = rm.id
        WHERE rm.tenant_id = $3
        ORDER BY rm.name ASC
    `, [date, shift, tenantId]);

    return result.rows.map((row: any) => {
        const capacityTables = Number(row.capacity_tables) || 0;
        const capacitySeats = Number(row.capacity_seats) || 0;
        const usedTables = Number(row.used_tables) || 0;
        const usedSeats = Number(row.used_seats) || 0;
        // Sala senza tavoli utilizzabili = 100%: non ha niente da offrire.
        // Il tetto a 100 serve perché le richieste web senza tavolo possono
        // spingere il conteggio oltre la capienza reale della sala.
        const rawTables = capacityTables > 0 ? Math.min(100, (usedTables / capacityTables) * 100) : 100;
        const rawSeats = capacitySeats > 0 ? Math.min(100, (usedSeats / capacitySeats) * 100) : 100;
        const cap = capByRoom.get(Number(row.room_id)) ?? null;
        const raw = cap?.basis === 'SEATS' ? rawSeats : rawTables;
        return {
            room_id: Number(row.room_id),
            room_name: String(row.room_name),
            is_closed: Boolean(row.is_closed),
            closed_for_shift: Boolean(row.closed_for_shift),
            capacity_tables: capacityTables,
            capacity_seats: capacitySeats,
            used_tables: usedTables,
            used_seats: usedSeats,
            percent_tables: Math.round(rawTables),
            percent_seats: Math.round(rawSeats),
            cap,
            // Confronto sul valore esatto, non su quello arrotondato: 69.6%
            // non deve bloccare una sala con cap al 70%.
            at_cap: cap ? raw >= cap.percent : false,
        };
    });
}

/**
 * Sale da escludere dai canali self-service per questo (data, turno).
 * Restituisce sempre un array (mai null) così può essere passato dritto a
 * un `= ANY($n::int[])` senza guardie extra.
 */
export async function getCappedRoomIds(tenantId: number, date: string, shift: Shift): Promise<number[]> {
    try {
        const caps = await getRoomOccupancyCaps(tenantId);
        // Nessun cap configurato: evita la query di occupazione sul percorso
        // caldo (ogni check-availability dell'agente vocale ci passa).
        if (caps.length === 0) return [];
        const occupancy = await computeRoomOccupancy(tenantId, date, shift);
        return occupancy.filter(o => o.at_cap).map(o => o.room_id);
    } catch (err) {
        // Fail-open: un errore di lettura non deve far sparire la disponibilità.
        console.error('[room-occupancy] failed to compute capped rooms:', err);
        return [];
    }
}

export interface SelfServiceTablePick {
    id: number;
    name: string;
    room_id: number;
    room_name: string;
    location: 'INDOOR' | 'OUTDOOR' | null;
}

/**
 * Cosa rende un tavolo davvero assegnabile per un (data, turno): non nascosto,
 * senza prenotazioni vive, non accorpato e non tenuto da un banchetto.
 *
 * Vive qui in un pezzo solo perché la usano sia chi elenca le sale prenotabili
 * sia chi sceglie il tavolo. Quando erano due query separate divergevano: la
 * lista sale ignorava accorpamenti e banchetti e proponeva online sale in
 * realtà piene.
 *
 * `alias` è l'alias del tavolo nella query chiamante; `dateParam`/`shiftParam`/
 * `tenantParam` sono le posizioni dei placeholder di data, turno e tenant.
 */
function assignableTableSql(alias: string, dateParam: number, shiftParam: number, tenantParam: number, excludeReservationParam?: number): string {
    const d = `$${dateParam}`;
    const s = `$${shiftParam}`;
    const tn = `$${tenantParam}`;
    // Chi MODIFICA una prenotazione deve poter tenere il proprio tavolo: senza
    // l'esclusione, la prenotazione stessa lo farebbe risultare occupato.
    const excl = excludeReservationParam ? `AND res.id <> $${excludeReservationParam}` : '';
    return `
              ${alias}.id NOT IN (
                  SELECT table_id FROM table_hidden_overrides WHERE date = ${d} AND shift = ${s} AND tenant_id = ${tn}
              )
              AND NOT EXISTS (
                  SELECT 1 FROM reservations res
                  WHERE res.table_id = ${alias}.id
                    AND res.tenant_id = ${tn}
                    AND DATE(res.reservation_time) = ${d}
                    AND res.shift = ${s}
                    ${excl}
                    AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM table_merges tm
                  WHERE tm.date = ${d} AND tm.shift = ${s} AND tm.tenant_id = ${tn}
                    AND (tm.primary_id = ${alias}.id OR ${alias}.id = ANY(tm.merged_ids))
              )
              AND NOT EXISTS (
                  SELECT 1 FROM banquet_menus b
                  WHERE b.event_date = ${d} AND b.shift = ${s} AND b.tenant_id = ${tn} AND ${alias}.id = ANY(b.table_ids)
              )`;
}

/**
 * Sale che il modulo /prenota può proporre: aperte per quel turno e con almeno
 * un tavolo davvero assegnabile per quel numero di ospiti.
 *
 * Le sale oltre il limite di occupazione restano nell'elenco — sono ancora
 * prenotabili, cambia solo che la richiesta la conferma lo staff invece del
 * sistema (vedi POST /public/reservations). Una sala piena, invece, sparisce:
 * non ha niente da dare a nessuno dei due.
 */
export async function listBookableRooms(
    tenantId: number,
    date: string,
    shift: Shift,
    guests: number
): Promise<Array<{ id: number; name: string }>> {
    const result = await queryWithRetry(`
        SELECT r.id, r.name
        FROM rooms r
        WHERE r.tenant_id = $4
          AND r.is_closed = false
          AND r.id NOT IN (
              SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3 AND tenant_id = $4
          )
          AND EXISTS (
              SELECT 1 FROM tables t
              WHERE t.room_id = r.id
                AND t.tenant_id = $4
                AND t.seats >= $1
                AND ${assignableTableSql('t', 2, 3, 4)}
          )
        ORDER BY r.name ASC
    `, [Math.trunc(guests), date, shift, tenantId]);
    return result.rows;
}

/**
 * Il tavolo libero più piccolo che regge `guests`, saltando le sale che hanno
 * già raggiunto il proprio limite di occupazione. È il punto di assegnazione
 * condiviso dai due canali self-service: l'agente vocale (che filtra per
 * dentro/fuori) e il modulo /prenota (che filtra per sala richiesta).
 *
 * Esclude tavoli nascosti per il turno, sale chiuse, tavoli con una
 * prenotazione viva, tavoli accorpati e tavoli tenuti da un banchetto.
 * Restituisce null quando non c'è niente: il chiamante salva comunque la
 * prenotazione senza tavolo e la lascia allo staff.
 */
export async function pickSelfServiceTable(
    tenantId: number,
    date: string,
    shift: Shift,
    guests: number,
    opts: { roomId?: number | null; location?: 'INDOOR' | 'OUTDOOR' | null } = {}
): Promise<SelfServiceTablePick | null> {
    const params: any[] = [guests, date, shift, tenantId];
    let extraFilters = '';
    if (opts.location) {
        params.push(opts.location);
        extraFilters += ` AND r.location = $${params.length}`;
    }
    if (opts.roomId) {
        params.push(Math.trunc(opts.roomId));
        extraFilters += ` AND r.id = $${params.length}`;
    }
    params.push(await getCappedRoomIds(tenantId, date, shift));
    extraFilters += ` AND NOT (r.id = ANY($${params.length}::int[]))`;

    const result = await queryWithRetry(`
        SELECT t.id, t.name, r.id AS room_id, r.name AS room_name, r.location
        FROM tables t
        JOIN rooms r ON t.room_id = r.id AND r.tenant_id = t.tenant_id
        WHERE t.tenant_id = $4
          AND r.is_closed = false
          ${extraFilters}
          AND r.id NOT IN (
              SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3 AND tenant_id = $4
          )
          AND t.seats >= $1
          AND ${assignableTableSql('t', 2, 3, 4)}
        ORDER BY t.seats ASC, t.id ASC
        LIMIT 1
    `, params);
    return result.rows[0] ?? null;
}

/**
 * Il tavolo già assegnato a una prenotazione regge anche il nuovo servizio?
 * Stessa definizione di "assegnabile" di pickSelfServiceTable (sala aperta,
 * capienza, niente doppie prenotazioni/accorpamenti/banchetti), più
 * l'esclusione della prenotazione che si sta modificando. Usata dalle
 * modifiche via agente vocale per non strappare un tavolo piazzato a mano
 * dall'operatore quando basta tenerlo. Il tetto di occupazione self-service
 * qui NON conta: il tavolo è già suo, tenerlo non aggiunge coperti alla sala.
 */
export async function isTableStillAssignable(
    tenantId: number,
    tableId: number,
    date: string,
    shift: Shift,
    guests: number,
    excludeReservationId: number
): Promise<boolean> {
    const result = await queryWithRetry(`
        SELECT 1
        FROM tables t
        JOIN rooms r ON t.room_id = r.id AND r.tenant_id = t.tenant_id
        WHERE t.id = $4
          AND t.tenant_id = $6
          AND r.is_closed = false
          AND r.id NOT IN (
              SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3 AND tenant_id = $6
          )
          AND t.seats >= $1
          AND ${assignableTableSql('t', 2, 3, 6, 5)}
        LIMIT 1
    `, [Math.trunc(guests), date, shift, Math.trunc(tableId), Math.trunc(excludeReservationId), tenantId]);
    return (result.rowCount ?? 0) > 0;
}

