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

export async function getRoomOccupancyCaps(): Promise<RoomOccupancyCap[]> {
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE key = $1',
            [ROOM_OCCUPANCY_CAPS_KEY]
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
 * Un tavolo conta come occupato quando ha una prenotazione viva oppure è
 * coinvolto in un accorpamento del turno (in entrambi i casi non è più
 * assegnabile). I coperti invece sommano gli ospiti delle prenotazioni: un
 * tavolo da 6 preso da 2 persone pesa 2 coperti ma 1 tavolo.
 *
 * Le richieste web ancora senza tavolo ("Sala richiesta: X." nelle note,
 * scritta da POST /public/reservations) pesano sulla sala richiesta come 1
 * tavolo + i suoi ospiti: altrimenti il canale web potrebbe riempire una
 * sala con decine di richieste PENDING senza mai toccare il cap.
 */
export async function computeRoomOccupancy(date: string, shift: Shift): Promise<RoomOccupancy[]> {
    const caps = await getRoomOccupancyCaps();
    const capByRoom = new Map<number, RoomOccupancyCap>(caps.map(c => [c.room_id, c]));

    const result = await queryWithRetry(`
        WITH active AS (
            SELECT t.id, t.room_id, t.seats
            FROM tables t
            WHERE NOT EXISTS (
                SELECT 1 FROM table_hidden_overrides h
                WHERE h.table_id = t.id AND h.date = $1 AND h.shift = $2
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
            SELECT a.room_id, COUNT(*)::int AS tables_used
            FROM active a
            WHERE EXISTS (
                    SELECT 1 FROM reservations res
                    WHERE res.table_id = a.id
                      AND DATE(res.reservation_time) = $1
                      AND res.shift = $2
                      AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
                  )
               OR EXISTS (
                    SELECT 1 FROM table_merges tm
                    WHERE tm.date = $1 AND tm.shift = $2
                      AND (tm.primary_id = a.id OR a.id = ANY(tm.merged_ids))
                  )
            GROUP BY a.room_id
        ),
        covers AS (
            SELECT a.room_id, COALESCE(SUM(res.guests), 0)::int AS seats_used
            FROM active a
            JOIN reservations res
              ON res.table_id = a.id
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
             AND DATE(res.reservation_time) = $1
             AND res.shift = $2
             AND COALESCE(res.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED')
             AND position('Sala richiesta: ' || rm.name || '.' in COALESCE(res.notes, '')) > 0
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
                 + COALESCE(q.seats_requested, 0)   AS used_seats,
               EXISTS (
                   SELECT 1 FROM room_closed_overrides rc
                   WHERE rc.room_id = rm.id AND rc.date = $1 AND rc.shift = $2
               )                                    AS closed_for_shift
        FROM rooms rm
        LEFT JOIN capacity  c ON c.room_id = rm.id
        LEFT JOIN occupied  o ON o.room_id = rm.id
        LEFT JOIN covers    v ON v.room_id = rm.id
        LEFT JOIN requested q ON q.room_id = rm.id
        ORDER BY rm.name ASC
    `, [date, shift]);

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
export async function getCappedRoomIds(date: string, shift: Shift): Promise<number[]> {
    try {
        const caps = await getRoomOccupancyCaps();
        // Nessun cap configurato: evita la query di occupazione sul percorso
        // caldo (ogni check-availability dell'agente vocale ci passa).
        if (caps.length === 0) return [];
        const occupancy = await computeRoomOccupancy(date, shift);
        return occupancy.filter(o => o.at_cap).map(o => o.room_id);
    } catch (err) {
        // Fail-open: un errore di lettura non deve far sparire la disponibilità.
        console.error('[room-occupancy] failed to compute capped rooms:', err);
        return [];
    }
}

/**
 * True quando ogni sala aperta e dotata di tavoli ha raggiunto il proprio cap.
 * Usata dal canale web per rifiutare anche le richieste senza preferenza di
 * sala: senza questo controllo basterebbe scegliere "Nessuna preferenza" per
 * aggirare i limiti.
 */
export async function areAllRoomsAtCap(date: string, shift: Shift): Promise<boolean> {
    try {
        const caps = await getRoomOccupancyCaps();
        if (caps.length === 0) return false;
        const occupancy = await computeRoomOccupancy(date, shift);
        const bookable = occupancy.filter(o => !o.is_closed && !o.closed_for_shift && o.capacity_tables > 0);
        if (bookable.length === 0) return false;
        return bookable.every(o => o.at_cap);
    } catch (err) {
        console.error('[room-occupancy] failed to evaluate global cap state:', err);
        return false;
    }
}
