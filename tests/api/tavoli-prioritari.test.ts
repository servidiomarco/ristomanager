import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Ordine di assegnazione dei tavoli (tables.assign_priority). L'assegnazione
// automatica sceglieva il tavolo libero più piccolo e, a parità di posti,
// quello creato per primo: al Vecchio Frantoio le coppie finivano sempre al
// 29 della Veranda. Un tavolo numerato passa davanti a quelli senza numero,
// in ordine (1 prima di 2) e anche se più grande; a pari numero, e fra i
// tavoli senza numero, resta il più piccolo che basta.
//
// Si prenota dal modulo pubblico con la sala richiesta, così la scelta resta
// dentro una sala dedicata qualunque tavolo abbiano creato i file precedenti.
// Ogni caso usa una data sua: le prenotazioni dei casi prima non pesano.

describe('ordine di assegnazione dei tavoli', () => {
    let token: string;
    let roomId: number;
    let p29: number; // 2 posti, creato per primo: senza ordine vince sempre lui
    let p23: number; // 3 posti
    let p24: number; // 4 posti

    const prenota = (nome: string, telefono: string, data: string) =>
        api().post('/public/reservations').send({
            customer_name: nome,
            phone: telefono,
            date: data,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
            room_id: roomId,
        });

    const tavoloDi = async (nome: string): Promise<number | null> => {
        const list = await api().get('/reservations').set(bearer(token));
        const r = list.body.find((x: any) => x.customer_name === nome);
        expect(r).toBeTruthy();
        return r.table_id;
    };

    const priorita = async (id: number, value: number | null) => {
        const res = await api().put(`/tables/${id}`).set(bearer(token)).send({ assign_priority: value });
        expect(res.status).toBe(200);
        expect(res.body.assign_priority).toBe(value);
    };

    beforeAll(async () => {
        token = await ownerToken();
        const acceso = await api().put('/settings/features').set(bearer(token)).send({ public_bookings_enabled: true });
        expect(acceso.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Ordine', width: 800, height: 600 });
        expect(room.status).toBe(201);
        roomId = room.body.id;

        const crea = async (name: string, seats: number, x: number) => {
            const t = await api().post('/tables').set(bearer(token)).send({
                name, shape: 'SQUARE', seats, x, y: 100, room_id: roomId, status: 'FREE',
            });
            expect(t.status).toBe(201);
            expect(t.body.assign_priority).toBeNull();
            return t.body.id as number;
        };
        p29 = await crea('P29', 2, 100);
        p23 = await crea('P23', 3, 300);
        p24 = await crea('P24', 4, 500);
    });

    afterAll(async () => {
        await api().put('/settings/features').set(bearer(token)).send({ public_bookings_enabled: false });
    });

    it('senza ordine vince il più piccolo creato per primo (il caso del 29)', async () => {
        expect((await prenota('Ordine Zero', '3391110000', '2027-07-13')).status).toBe(201);
        expect(await tavoloDi('Ordine Zero')).toBe(p29);
    });

    it('PUT /tables/:id rifiuta un ordine che non è un intero 1–99', async () => {
        for (const bad of [0, 100, 2.5, '1', true]) {
            const res = await api().put(`/tables/${p23}`).set(bearer(token)).send({ assign_priority: bad });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_assign_priority');
        }
    });

    it('si segue l\'ordine, anche contro la taglia, poi i tavoli senza numero', async () => {
        await priorita(p24, 1);
        await priorita(p23, 2);
        const data = '2027-07-14';
        expect((await prenota('Ordine Uno', '3391110001', data)).status).toBe(201);
        expect((await prenota('Ordine Due', '3391110002', data)).status).toBe(201);
        expect((await prenota('Ordine Tre', '3391110003', data)).status).toBe(201);
        expect(await tavoloDi('Ordine Uno')).toBe(p24);
        expect(await tavoloDi('Ordine Due')).toBe(p23);
        expect(await tavoloDi('Ordine Tre')).toBe(p29);
    });

    it('a pari numero vince il più piccolo che basta', async () => {
        await priorita(p23, 1);
        expect((await prenota('Ordine Pari', '3391110004', '2027-07-15')).status).toBe(201);
        expect(await tavoloDi('Ordine Pari')).toBe(p23);
    });

    it('tolto l\'ordine (null), vince di nuovo il più piccolo', async () => {
        await priorita(p23, null);
        await priorita(p24, null);
        expect((await prenota('Ordine Via', '3391110005', '2027-07-16')).status).toBe(201);
        expect(await tavoloDi('Ordine Via')).toBe(p29);
    });
});
