// Movimenti di magazzino letti come li racconta chi li ha fatti.
//
// Ogni tocco su + e − è un movimento a sé (POST /inventory/movements con
// delta ±1): dieci tocchi per caricare dieci bottiglie sono dieci righe. Per
// chi legge lo storico è un carico solo, «+10», e così lo mostriamo: le righe
// consecutive dello stesso prodotto, nella stessa cella, della stessa persona
// e dello stesso genere si sommano finché fra una e l'altra passano al
// massimo MOVEMENT_GROUP_GAP_MS. Un + seguito da un − (il tocco sbagliato
// corretto subito) si compensa nella somma; se la somma fa zero non è
// successo niente, e la voce sparisce.
//
// Usato dal server (GET /inventory/movements e /latest) e dalla pagina, che
// dopo un tocco aggiorna l'ultima voce del prodotto senza rileggerla.

export const MOVEMENT_GROUP_GAP_MS = 10 * 60 * 1000;

export type MovementReason = 'CARICO' | 'SCARICO' | 'RETTIFICA' | 'TRASFERIMENTO';

export interface RawMovement {
    id: number;
    product_id: number;
    location_id: number;
    delta: number;
    reason: MovementReason;
    notes: string | null;
    user_id: number | null;
    user_name: string | null;
    created_at: string;
    /** Viene dal carico di una fattura fornitore (o dal suo annullamento). */
    from_invoice: boolean;
}

export interface MovementEntry {
    /** L'id del movimento più recente della voce. */
    id: number;
    product_id: number;
    location_id: number;
    delta: number;
    /** CARICO/SCARICO dal segno della somma; RETTIFICA quando si è scritto il
     *  numero contato; il resto com'è stato registrato. */
    reason: MovementReason;
    notes: string | null;
    user_id: number | null;
    user_name: string | null;
    /** Il movimento più recente della voce. */
    at: string;
    /** Il primo: diverso da `at` quando la voce somma più tocchi. */
    first_at: string;
    count: number;
    from_invoice: boolean;
}

// Il genere decide cosa si può sommare. I tocchi su + e − sono lo stesso
// gesto; un conteggio scritto a mano si somma solo ad altri conteggi (chi
// corregge 8 in 9 ha contato una volta sola). Le righe di fattura restano
// ciascuna una voce: portano il nome del documento nelle note.
const familyOf = (m: { reason: MovementReason; from_invoice: boolean }): string | null => {
    if (m.from_invoice) return null;
    if (m.reason === 'CARICO' || m.reason === 'SCARICO') return 'STEP';
    if (m.reason === 'RETTIFICA') return 'RETTIFICA';
    return null;
};

const sameAuthor = (a: { user_id: number | null; user_name: string | null }, b: { user_id: number | null; user_name: string | null }): boolean =>
    a.user_id != null || b.user_id != null ? a.user_id === b.user_id : a.user_name === b.user_name;

const time = (iso: string): number => new Date(iso).getTime();

// Toglie la polvere dei NUMERIC: 0.1 + 0.2 non deve leggersi 0,30000000000000004.
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const entryFrom = (m: RawMovement): MovementEntry => ({
    id: m.id,
    product_id: m.product_id,
    location_id: m.location_id,
    delta: m.delta,
    reason: m.reason,
    notes: m.notes,
    user_id: m.user_id,
    user_name: m.user_name,
    at: m.created_at,
    first_at: m.created_at,
    count: 1,
    from_invoice: m.from_invoice,
});

const settle = (e: MovementEntry): MovementEntry => {
    const delta = round3(e.delta);
    const reason = familyOf(e) === 'STEP' ? (delta > 0 ? 'CARICO' : 'SCARICO') : e.reason;
    return { ...e, delta, reason };
};

/** Vero se `older` (più vecchio) si somma alla voce `entry`. */
const joins = (entry: MovementEntry, older: RawMovement): boolean => {
    const family = familyOf(entry);
    return family != null
        && family === familyOf(older)
        && entry.product_id === older.product_id
        && entry.location_id === older.location_id
        && sameAuthor(entry, older)
        && time(entry.first_at) - time(older.created_at) <= MOVEMENT_GROUP_GAP_MS;
};

/**
 * Raggruppa movimenti già ordinati dal più recente al più vecchio. Le voci
 * escono nello stesso ordine (per il loro movimento più recente).
 *
 * Una voce resta aperta solo finché il prossimo movimento DELLO STESSO
 * prodotto le appartiene: se in mezzo un collega tocca lo stesso prodotto, la
 * voce si chiude e quella dopo ricomincia da capo.
 */
export const groupMovements = (rows: RawMovement[]): MovementEntry[] => {
    const entries: MovementEntry[] = [];
    const open = new Map<number, MovementEntry>();
    for (const m of rows) {
        const current = open.get(m.product_id);
        if (current && joins(current, m)) {
            current.delta += m.delta;
            current.first_at = m.created_at;
            current.count += 1;
            continue;
        }
        const entry = entryFrom(m);
        entries.push(entry);
        open.set(m.product_id, entry);
    }
    return entries.map(settle).filter(e => e.delta !== 0);
};

/**
 * La voce più recente di un prodotto dopo un movimento appena fatto. `latest`
 * è la voce che la pagina mostrava; ritorna null quando il nuovo tocco la
 * compensa a zero (allora l'ultima voce vera è una più vecchia, da rileggere).
 */
export const extendLatest = (latest: MovementEntry | null, m: RawMovement): MovementEntry | null => {
    if (!latest) return settle(entryFrom(m));
    // `joins` guarda indietro nel tempo; qui il movimento nuovo è il più
    // recente, quindi si chiede se la voce di prima si sarebbe unita a lui.
    const fresh = entryFrom(m);
    const back: RawMovement = {
        id: latest.id,
        product_id: latest.product_id,
        location_id: latest.location_id,
        delta: latest.delta,
        reason: latest.reason,
        notes: latest.notes,
        user_id: latest.user_id,
        user_name: latest.user_name,
        created_at: latest.at,
        from_invoice: latest.from_invoice,
    };
    if (!joins(fresh, back)) return settle(fresh);
    const merged = settle({
        ...fresh,
        delta: fresh.delta + latest.delta,
        first_at: latest.first_at,
        count: latest.count + 1,
    });
    return merged.delta === 0 ? null : merged;
};
