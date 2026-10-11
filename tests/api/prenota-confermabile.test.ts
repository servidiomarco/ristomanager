import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Prenotazioni web «solo confermabili subito» (public_bookings_instant_only).
// Al Frantoio il web è stato spento il 21/08/2026 perché i gestori si
// stancavano di confermare le richieste: con l'interruttore acceso il web
// offre solo i turni dove un tavolo c'è adesso, e dove non c'è risponde 409
// con le alternative invece di creare una richiesta PENDING.
//
// Una sala dedicata con UN tavolo, e tutte le altre sale chiuse nei giorni
// del test (room_closed_overrides): così «pieno» dipende solo da questo file,
// qualunque tavolo abbiano creato i file prima. Ogni caso usa una data sua.

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

const D_PIENO = '2027-11-09';
const D_GARA = '2027-11-10';
const D_SPENTO = '2027-11-11';
const D_SOGLIA = '2027-11-16';
const DATE = [D_PIENO, D_GARA, D_SPENTO, D_SOGLIA];

describe('prenotazioni web solo confermabili subito', () => {
    let token: string;
    let salaId: number;
    let tavoloId: number;
    let capsPrima: any[] = [];

    const prenota = (nome: string, telefono: string, data: string, extra: Record<string, unknown> = {}) =>
        api().post('/public/reservations').send({
            customer_name: nome,
            phone: telefono,
            date: data,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
            ...extra,
        });

    const prenotazioneDi = async (nome: string) => {
        const list = await api().get('/reservations').set(bearer(token));
        expect(list.status).toBe(200);
        return list.body.find((x: any) => x.customer_name === nome) ?? null;
    };

    const interruttore = async (instant: boolean) => {
        const res = await api().put('/settings/features').set(bearer(token)).send({
            public_bookings_enabled: true,
            public_bookings_instant_only: instant,
        });
        expect(res.status).toBe(200);
        expect(res.body.public_bookings_instant_only).toBe(instant);
    };

    const creaSala = async (name: string) => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name, width: 800, height: 600 });
        expect(room.status).toBe(201);
        return room.body.id as number;
    };

    const creaTavolo = async (roomId: number, name: string, x: number) => {
        const t = await api().post('/tables').set(bearer(token)).send({
            name, shape: 'SQUARE', seats: 4, x, y: 100, room_id: roomId, status: 'FREE',
        });
        expect(t.status).toBe(201);
        return t.body.id as number;
    };

    // Chiude nei giorni del test tutte le sale tranne quelle indicate.
    const chiudiAltreSale = async (tranne: number[]) => {
        await dbQuery(
            `INSERT INTO room_closed_overrides (tenant_id, date, shift, room_id)
             SELECT 1, d::date, s, r.id
               FROM rooms r, unnest($1::text[]) AS d, unnest(ARRAY['LUNCH', 'DINNER']) AS s
              WHERE r.tenant_id = 1 AND NOT (r.id = ANY($2::int[]))
             ON CONFLICT DO NOTHING`,
            [DATE, tranne]
        );
    };

    beforeAll(async () => {
        token = await ownerToken();
        await interruttore(true);
        salaId = await creaSala('Sala Istantanea');
        tavoloId = await creaTavolo(salaId, 'I1', 100);
        await chiudiAltreSale([salaId]);
        const canali = await api().get('/settings/channels').set(bearer(token));
        expect(canali.status).toBe(200);
        capsPrima = canali.body.room_occupancy_caps ?? [];
    });

    afterAll(async () => {
        await api().put('/settings/channels').set(bearer(token)).send({ room_occupancy_caps: capsPrima });
        await api().put('/settings/features').set(bearer(token)).send({
            public_bookings_enabled: false,
            public_bookings_instant_only: false,
        });
        // Le sale del file restano aperte, come quelle degli altri file:
        // chiuderle faceva fallire voice-double-seating, che prenota a mano
        // su TUTTI i tavoli del tenant (e una sala chiusa risponde 400).
        await dbQuery(`DELETE FROM room_closed_overrides WHERE date = ANY($1::date[])`, [DATE]);
    });

    it('la pagina lo sa da /public/contact', async () => {
        const res = await api().get('/public/contact');
        expect(res.status).toBe(200);
        expect(res.body.bookingsEnabled).toBe(true);
        expect(res.body.instantOnly).toBe(true);
        expect('phone' in res.body.branding).toBe(true);
        expect('whatsapp' in res.body.branding).toBe(true);
    });

    it('il calendario risponde (dal 22/08/2026 dava 500 su una colonna inesistente)', async () => {
        const res = await api().get(`/public/availability?from=${D_PIENO}&to=2027-11-12`);
        expect(res.status).toBe(200);
        expect(res.body.days).toHaveLength(4);
        expect(res.body.days[0]).toMatchObject({ date: D_PIENO });
    });

    it('un turno senza tavolo è pieno, con le alternative; la POST risponde 409 e non crea richieste', async () => {
        const prima = await prenota('Istante Primo', '3391230001', D_PIENO);
        expect(prima.status).toBe(201);
        expect(prima.body.confirmed).toBe(true);
        const salvata = await prenotazioneDi('Istante Primo');
        expect(salvata.table_id).toBe(tavoloId);
        expect(salvata.reservation_status).toBe('CONFIRMED');
        expect(salvata.requires_review).toBe(false);

        // Senza persone resta la griglia di sempre (la pagina di oggi).
        const griglia = await api().get(`/public/availability?date=${D_PIENO}`);
        expect(griglia.status).toBe(200);
        expect(griglia.body.instant).toBeUndefined();
        expect(griglia.body.dinner.slots.length).toBeGreaterThan(0);

        const disp = await api().get(`/public/availability?date=${D_PIENO}&guests=2&time=20:00`);
        expect(disp.status).toBe(200);
        expect(disp.body.instant).toBe(true);
        expect(disp.body.dinner).toEqual({ slots: [], full: true });
        expect(disp.body.lunch.full).toBe(false);
        expect(disp.body.lunch.slots.length).toBeGreaterThan(0);
        // Prima l'altro turno dello stesso giorno, poi i giorni dopo.
        expect(disp.body.alternatives[0]).toMatchObject({ date: D_PIENO, shift: 'LUNCH' });
        expect(disp.body.alternatives[0].slots.length).toBeLessThanOrEqual(2);
        expect(disp.body.alternatives.length).toBeGreaterThan(1);
        expect(disp.body.alternatives[1].date > D_PIENO).toBe(true);

        const seconda = await prenota('Istante Secondo', '3391230002', D_PIENO);
        expect(seconda.status).toBe(409);
        expect(seconda.body.error).toBe('not_confirmable');
        expect(seconda.body.alternatives[0]).toMatchObject({ date: D_PIENO, shift: 'LUNCH' });
        expect(await prenotazioneDi('Istante Secondo')).toBeNull();

        // La domanda persa resta contata, senza dati personali.
        const misses = await dbQuery(
            `SELECT reason, count FROM public_booking_misses
              WHERE tenant_id = 1 AND service_date = $1 AND shift = 'DINNER' AND guests = 2`,
            [D_PIENO]
        );
        const motivi = misses.rows.map(r => r.reason).sort();
        expect(motivi).toEqual(['full', 'not_confirmable']);
    });

    it('due POST insieme sull\'ultimo tavolo: una conferma e un 409', async () => {
        const [a, b] = await Promise.all([
            prenota('Istante Gara A', '3391230011', D_GARA),
            prenota('Istante Gara B', '3391230012', D_GARA),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        const vinta = a.status === 201 ? 'Istante Gara A' : 'Istante Gara B';
        const persa = a.status === 201 ? 'Istante Gara B' : 'Istante Gara A';
        expect((await prenotazioneDi(vinta)).table_id).toBe(tavoloId);
        expect(await prenotazioneDi(persa)).toBeNull();
    });

    it('con l\'interruttore spento resta il flusso di sempre (richiesta PENDING)', async () => {
        await interruttore(false);
        try {
            expect((await prenota('Istante Spento A', '3391230021', D_SPENTO)).status).toBe(201);
            const res = await prenota('Istante Spento B', '3391230022', D_SPENTO);
            expect(res.status).toBe(201);
            expect(res.body.confirmed).toBe(false);
            const pendente = await prenotazioneDi('Istante Spento B');
            expect(pendente.reservation_status).toBe('PENDING');
            expect(pendente.table_id).toBeNull();

            const disp = await api().get(`/public/availability?date=${D_SPENTO}&guests=2`);
            expect(disp.status).toBe(200);
            expect(disp.body.instant).toBeUndefined();
            expect(disp.body.dinner.full).toBeUndefined();
        } finally {
            await interruttore(true);
        }
    });

    it('una sala oltre la soglia sparisce da /public/rooms', async () => {
        const soglia = await creaSala('Sala Soglia');
        await creaTavolo(soglia, 'S1', 100);
        await creaTavolo(soglia, 'S2', 300);
        const caps = await api().put('/settings/channels').set(bearer(token)).send({
            room_occupancy_caps: [...capsPrima, { room_id: soglia, percent: 50, basis: 'TABLES' }],
        });
        expect(caps.status).toBe(200);

        const presa = await prenota('Istante Soglia', '3391230031', D_SOGLIA, { room_id: soglia });
        expect(presa.status).toBe(201);
        expect(presa.body.confirmed).toBe(true);

        const sale = await api().get(`/public/rooms?date=${D_SOGLIA}&shift=DINNER&guests=2`);
        expect(sale.status).toBe(200);
        const ids = sale.body.rooms.map((r: any) => r.id);
        expect(ids).toContain(salaId);
        expect(ids).not.toContain(soglia);

        // Spento, la stessa sala torna come «richiesta» (over_threshold).
        await interruttore(false);
        try {
            const vecchie = await api().get(`/public/rooms?date=${D_SOGLIA}&shift=DINNER&guests=2`);
            expect(vecchie.body.rooms.find((r: any) => r.id === soglia)?.over_threshold).toBe(true);
        } finally {
            await interruttore(true);
        }

        // E la POST in quella sala non diventa una richiesta: 409.
        const oltre = await prenota('Istante Oltre', '3391230032', D_SOGLIA, { room_id: soglia });
        expect(oltre.status).toBe(409);
        expect(await prenotazioneDi('Istante Oltre')).toBeNull();
    });
});
