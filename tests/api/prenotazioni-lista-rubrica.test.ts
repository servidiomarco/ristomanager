import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// La lista prenotazioni aggancia la rubrica per telefono normalizzato (solo
// cifre) con una CTE invece della LATERAL per riga: sotto la RLS di
// produzione la LATERAL non poteva usare l'indice e costava 5 s a ogni avvio
// dell'app (23/09). Qui si fissa che il risultato resti quello di prima:
// formati diversi dello stesso numero si agganciano alla stessa scheda, un
// altro numero no, senza telefono niente aggancio, e ogni prenotazione esce
// una volta sola.
const ORARIO = '2027-04-14T20:30:00';

describe('lista prenotazioni: aggancio alla rubrica', () => {
    let token: string;
    let tableId: number;
    let tableName: string;

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Rubrica Lista', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'RL1', shape: 'SQUARE', seats: 4, x: 100, y: 100,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
        tableName = table.body.name;

        const vip = await api().post('/customers').set(bearer(token)).send({
            name: 'Ospite Abituale',
            phone: '+39 347 555 0101',
            is_vip: true,
            preferred_table_id: tableId,
            dietary_notes: 'celiaco',
        });
        expect(vip.status).toBe(201);
    });

    const prenota = async (customer_name: string, phone?: string) => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name, reservation_time: ORARIO, shift: 'DINNER', guests: 2,
            ...(phone ? { phone } : {}),
        });
        expect(res.status).toBe(201);
        return res.body.id as number;
    };

    it('aggancia lo stesso numero scritto in un altro formato, una riga per prenotazione', async () => {
        const abituale = await prenota('Ospite Abituale', '39 347-555-0101');
        const sconosciuto = await prenota('Mai Visto', '+39 333 000 0000');
        const senzaTelefono = await prenota('Senza Telefono');

        for (const query of ['', '?from=2027-04-14&to=2027-04-14']) {
            const res = await api().get(`/reservations${query}`).set(bearer(token));
            expect(res.status).toBe(200);
            const rows = res.body as any[];

            const mine = rows.filter(r => r.id === abituale);
            expect(mine).toHaveLength(1);
            expect(mine[0].customer_is_vip).toBe(true);
            expect(mine[0].customer_dietary_notes).toBe('celiaco');
            expect(mine[0].customer_preferred_table_id).toBe(tableId);
            expect(mine[0].customer_preferred_table_name).toBe(tableName);

            // Creare la prenotazione mette il numero in rubrica: l'aggancio
            // c'è, ma alla sua scheda (non VIP), non a quella dell'abituale.
            const other = rows.find(r => r.id === sconosciuto);
            expect(other.customer_is_vip).not.toBe(true);
            expect(other.customer_dietary_notes ?? null).toBeNull();
            const none = rows.find(r => r.id === senzaTelefono);
            expect(none.customer_is_vip).toBeNull();

            // Nessuna prenotazione moltiplicata dall'aggancio.
            expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
        }
    });
});
