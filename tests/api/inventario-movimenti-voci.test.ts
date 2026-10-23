import { describe, it, expect } from 'vitest';
// Il sorgente, non dist: il raggruppamento non ha dipendenze (vedi event-registry).
import { MOVEMENT_GROUP_GAP_MS, extendLatest, groupMovements, type RawMovement } from '../../utils/inventoryMovements';

// Storico del magazzino: i tocchi di fila su + e − sono UNA voce. Le righe
// arrivano come le legge il server, dalla più recente.

const T0 = Date.parse('2026-10-23T16:00:00Z');
let nextId = 1000;

const mov = (over: Partial<RawMovement> & { minutes: number }): RawMovement => {
    const { minutes, ...rest } = over;
    return {
        id: nextId++,
        product_id: 1,
        location_id: 10,
        delta: 1,
        reason: 'CARICO',
        notes: null,
        user_id: 7,
        user_name: 'Marco Rossi',
        created_at: new Date(T0 + minutes * 60_000).toISOString(),
        from_invoice: false,
        ...rest,
    };
};

// Dal più recente al più vecchio, come ORDER BY created_at DESC.
const newestFirst = (rows: RawMovement[]) =>
    [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);

describe('magazzino · voci dello storico', () => {
    it('dieci tocchi su + in un minuto: una voce «+10»', () => {
        const rows = Array.from({ length: 10 }, (_, i) => mov({ minutes: i / 10 }));
        const voci = groupMovements(newestFirst(rows));
        expect(voci).toHaveLength(1);
        expect(voci[0]).toMatchObject({ delta: 10, reason: 'CARICO', count: 10, user_name: 'Marco Rossi' });
        expect(voci[0].first_at).toBe(rows[0].created_at);
        expect(voci[0].at).toBe(rows[9].created_at);
    });

    it('tre + e un − (il tocco sbagliato): «+2»', () => {
        const rows = [
            mov({ minutes: 0 }), mov({ minutes: 0.1 }), mov({ minutes: 0.2 }),
            mov({ minutes: 0.3, delta: -1, reason: 'SCARICO' }),
        ];
        const voci = groupMovements(newestFirst(rows));
        expect(voci).toHaveLength(1);
        expect(voci[0]).toMatchObject({ delta: 2, reason: 'CARICO' });
    });

    it('scarichi di fila: «−3» e la voce è uno scarico', () => {
        const rows = [0, 1, 2].map(m => mov({ minutes: m, delta: -1, reason: 'SCARICO' }));
        expect(groupMovements(newestFirst(rows))).toMatchObject([{ delta: -3, reason: 'SCARICO', count: 3 }]);
    });

    it('un + e un − che si annullano: nessuna voce', () => {
        const rows = [mov({ minutes: 0 }), mov({ minutes: 0.2, delta: -1, reason: 'SCARICO' })];
        expect(groupMovements(newestFirst(rows))).toEqual([]);
    });

    it('oltre la pausa massima: due voci', () => {
        const gapMin = MOVEMENT_GROUP_GAP_MS / 60_000;
        const rows = [mov({ minutes: 0 }), mov({ minutes: 1 }), mov({ minutes: 1 + gapMin + 1 })];
        const voci = groupMovements(newestFirst(rows));
        expect(voci.map(v => v.delta)).toEqual([1, 2]);
    });

    it('un collega tocca lo stesso prodotto in mezzo: tre voci, nell\'ordine', () => {
        const rows = [
            mov({ minutes: 0 }), mov({ minutes: 0.1 }),
            mov({ minutes: 0.2, user_id: 8, user_name: 'Anna Bianchi' }),
            mov({ minutes: 0.3 }),
        ];
        const voci = groupMovements(newestFirst(rows));
        expect(voci.map(v => [v.user_name, v.delta])).toEqual([
            ['Marco Rossi', 1], ['Anna Bianchi', 1], ['Marco Rossi', 2],
        ]);
    });

    it('un altro prodotto in mezzo non spezza la voce', () => {
        const rows = [
            mov({ minutes: 0 }),
            mov({ minutes: 0.1, product_id: 2 }),
            mov({ minutes: 0.2 }),
        ];
        const voci = groupMovements(newestFirst(rows));
        expect(voci.map(v => [v.product_id, v.delta])).toEqual([[1, 2], [2, 1]]);
    });

    it('celle diverse: voci diverse', () => {
        const rows = [mov({ minutes: 0 }), mov({ minutes: 0.1, location_id: 11 })];
        expect(groupMovements(newestFirst(rows))).toHaveLength(2);
    });

    it('i conteggi si sommano fra loro, non ai tocchi', () => {
        const rows = [
            mov({ minutes: 0 }),
            mov({ minutes: 0.5, delta: 3, reason: 'RETTIFICA' }),
            mov({ minutes: 1, delta: 1, reason: 'RETTIFICA' }),
        ];
        const voci = groupMovements(newestFirst(rows));
        expect(voci.map(v => [v.reason, v.delta])).toEqual([['RETTIFICA', 4], ['CARICO', 1]]);
    });

    it('le righe di fattura restano una per una', () => {
        const rows = [
            mov({ minutes: 0, delta: 6, from_invoice: true, notes: 'Fattura 12 · Mollo' }),
            mov({ minutes: 0, delta: 4, from_invoice: true, notes: 'Fattura 12 · Mollo' }),
        ];
        expect(groupMovements(newestFirst(rows))).toHaveLength(2);
    });

    it('senza utente si confronta la firma', () => {
        const rows = [
            mov({ minutes: 0, user_id: null, user_name: 'cassa' }),
            mov({ minutes: 0.1, user_id: null, user_name: 'cassa' }),
            mov({ minutes: 0.2, user_id: null, user_name: 'altro' }),
        ];
        expect(groupMovements(newestFirst(rows)).map(v => v.delta)).toEqual([1, 2]);
    });

    it('i decimali non lasciano polvere', () => {
        const rows = [mov({ minutes: 0, delta: 0.1 }), mov({ minutes: 0.1, delta: 0.2 })];
        expect(groupMovements(newestFirst(rows))[0].delta).toBe(0.3);
    });

    describe('extendLatest (la pagina dopo un tocco)', () => {
        it('nessuna voce prima: la crea', () => {
            const m = mov({ minutes: 0, delta: -1, reason: 'SCARICO' });
            expect(extendLatest(null, m)).toMatchObject({ delta: -1, reason: 'SCARICO', count: 1, at: m.created_at });
        });

        it('stesso gesto: somma e sposta «at» in avanti', () => {
            const [first] = groupMovements([mov({ minutes: 0 })]);
            const m = mov({ minutes: 0.5 });
            expect(extendLatest(first, m)).toMatchObject({
                delta: 2, count: 2, first_at: first.first_at, at: m.created_at, id: m.id,
            });
        });

        it('un − che compensa: null (l\'ultima vera va riletta)', () => {
            const [first] = groupMovements([mov({ minutes: 0 })]);
            expect(extendLatest(first, mov({ minutes: 0.5, delta: -1, reason: 'SCARICO' }))).toBeNull();
        });

        it('un altro utente: voce nuova', () => {
            const [first] = groupMovements([mov({ minutes: 0 })]);
            expect(extendLatest(first, mov({ minutes: 0.5, user_id: 8, user_name: 'Anna Bianchi' })))
                .toMatchObject({ delta: 1, count: 1, user_name: 'Anna Bianchi' });
        });

        it('fa lo stesso conto del server', () => {
            const rows = [mov({ minutes: 0 }), mov({ minutes: 0.1 }), mov({ minutes: 0.2, delta: -1, reason: 'SCARICO' }), mov({ minutes: 0.3 })];
            let latest = null as ReturnType<typeof extendLatest>;
            for (const r of rows) latest = extendLatest(latest, r);
            expect(latest).toEqual(groupMovements(newestFirst(rows))[0]);
        });
    });
});
