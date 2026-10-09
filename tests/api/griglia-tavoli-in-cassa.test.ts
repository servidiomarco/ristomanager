import { describe, it, expect } from 'vitest';
import { buildRows, buildMergeGroups, tableStatusLine } from '../../components/comande/tablesView';
import type { OpenOrderSummary } from '../../services/ordersApiService';
import type { Reservation, Table } from '../../types';

// La griglia di Comande coi tavoli aperti in cassa Passepartout: un tavolo
// aperto dalla cassa o dal palmare, senza comanda del CRM, sta fra le comande
// aperte col totale della cassa. Funzioni pure (components/comande/tablesView).

const tavolo = (id: number, name: string): Table => ({ id, name, seats: 4, room_id: 1 } as unknown as Table);
const tavoli = [tavolo(1, '80'), tavolo(2, '81'), tavolo(3, '82'), tavolo(4, '83')];
const nessuna = () => null;
const inCassa = (...ids: number[]) => new Map(ids.map((id) => [id, { totale_cents: 1750 }]));

describe('griglia di Comande: i tavoli aperti in cassa', () => {
    it('aperto solo in cassa: fra le comande aperte, col totale della cassa', () => {
        const rows = buildRows(tavoli, new Set(), new Set(), nessuna, undefined, 'ALL', new Map(), new Map(), inCassa(1));
        const r80 = rows.find((r) => r.table.id === 1)!;
        expect(r80).toMatchObject({ state: 'order', inCassa: { totale_cents: 1750 } });
        expect(r80.order).toBeUndefined();
        const riga = tableStatusLine(r80);
        expect(riga).toContain('in cassa');
        expect(riga).toMatch(/17[.,]50/);
        expect(rows.find((r) => r.table.id === 2)!.state).toBe('free');
    });

    it('la comanda e il conto del CRM vengono prima; la cassa batte la prenotazione', () => {
        const riassunto = { order_id: 9, total_cents: 4000 } as unknown as OpenOrderSummary;
        const prenotazione = { id: 5, table_id: 4, customer_name: 'Rossi' } as unknown as Reservation;
        const rows = buildRows(
            tavoli, new Set([1]), new Set([2]), (id) => (id === 4 ? prenotazione : null), undefined, 'ALL',
            new Map([[1, riassunto]]), new Map([[2, 900]]), inCassa(1, 2, 4),
        );
        const per = new Map(rows.map((r) => [r.table.id, r]));
        expect(per.get(1)).toMatchObject({ state: 'order', order: riassunto });
        expect(per.get(1)!.inCassa).toBeUndefined();
        expect(per.get(2)).toMatchObject({ state: 'bill', billCents: 900 });
        expect(per.get(2)!.inCassa).toBeUndefined();
        expect(per.get(4)).toMatchObject({ state: 'order', inCassa: { totale_cents: 1750 }, reservation: prenotazione });
    });

    it('tavoli uniti: si apre il tavolo che ha la comanda in cassa', () => {
        const unioni = buildMergeGroups([{ primary_id: 1, merged_ids: [2], shift: 'DINNER' } as any]);
        const rows = buildRows(tavoli, new Set(), new Set(), nessuna, unioni, 'DINNER', new Map(), new Map(), inCassa(2));
        const tessera = rows.find((r) => r.table.id === 1)!;
        expect(tessera).toMatchObject({ state: 'order', groupLabel: '80+81', pickId: 2, inCassa: { totale_cents: 1750 } });
        expect(rows.some((r) => r.table.id === 2)).toBe(false);
    });

    it('senza i tavoli aperti in cassa la griglia è quella di sempre', () => {
        const rows = buildRows(tavoli, new Set(), new Set(), nessuna, undefined, 'ALL', new Map(), new Map());
        expect(rows.every((r) => r.state === 'free' && r.inCassa === undefined)).toBe(true);
    });
});
