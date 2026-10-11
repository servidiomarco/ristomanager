import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fin dove si prenota online (Impostazioni › Canali › Prenotazioni web):
// 7 o 14 giorni da oggi, oppure libera. Con un limite il server rifiuta le
// date oltre, il calendario della pagina si ferma lì e la modifica dal link
// pure; con la libera il server non ha limiti, come prima, e la modifica
// resta ai suoi 60 giorni.

const TENANT = 1;
const NAME = 'Collaudo Orizzonte';

const romeDay = (offsetDays: number): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(Date.now() + offsetDays * 86400_000));

describe('periodo prenotabile online', () => {
    let owner: string;
    let db: Client;
    let flagsPrima: Record<string, unknown> = {};
    let ospitePrima: Record<string, unknown> | null = null;

    const canali = (body: Record<string, unknown>) =>
        api().put('/settings/channels').set(bearer(owner)).send(body);
    const limite = async (days: number | null) => {
        const res = await canali({ public_booking_horizon_days: days });
        expect(res.status).toBe(200);
        expect(res.body.public_booking_horizon_days).toBe(days);
    };
    const prenota = (date: string) => api().post('/public/reservations').send({
        customer_name: NAME,
        phone: '+393331117744',
        date,
        time: '20:00',
        shift: 'DINNER',
        guests: 2,
    });

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        flagsPrima = (await api().get('/settings/features').set(bearer(owner))).body ?? {};
        const ospite = await api().get('/settings/guest-manage').set(bearer(owner));
        ospitePrima = ospite.status === 200 ? ospite.body : null;
        expect((await api().put('/settings/features').set(bearer(owner)).send({ public_bookings_enabled: true })).status).toBe(200);
        expect((await api().put('/settings/guest-manage').set(bearer(owner)).send({ enabled: true, cancel_cutoff_hours: 3 })).status).toBe(200);
        await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'public_booking_horizon_days'`, [TENANT]);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'public_booking_horizon_days'`, [TENANT]);
        await db.query(`DELETE FROM reservations WHERE tenant_id = $1 AND customer_name = $2`, [TENANT, NAME]);
        await api().put('/settings/features').set(bearer(owner))
            .send({ public_bookings_enabled: flagsPrima.public_bookings_enabled === true });
        if (ospitePrima) await api().put('/settings/guest-manage').set(bearer(owner)).send(ospitePrima);
        await db.end();
    });

    it('di serie è libera', async () => {
        const res = await api().get('/settings/channels').set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.public_booking_horizon_days).toBeNull();
        expect((await api().get('/public/contact')).body.bookingHorizonDays).toBeNull();
    });

    it('accetta solo 7, 14 o libera', async () => {
        expect((await canali({ public_booking_horizon_days: 10 })).status).toBe(400);
        expect((await canali({ public_booking_horizon_days: 'tanti' })).status).toBe(400);
        await limite(14);
        await limite(7);
        await limite(null);
        // Lo 0 è la libera salvata: torna come null.
        const zero = await canali({ public_booking_horizon_days: 0 });
        expect(zero.status).toBe(200);
        expect(zero.body.public_booking_horizon_days).toBeNull();
    });

    it('con 7 giorni la pagina e il server si fermano al settimo', async () => {
        await limite(7);
        expect((await api().get('/public/contact')).body.bookingHorizonDays).toBe(7);

        const calendario = await api().get('/public/availability').query({ from: romeDay(0), to: romeDay(30) });
        expect(calendario.status).toBe(200);
        expect(calendario.body.to).toBe(romeDay(7));
        expect(calendario.body.days.every((d: any) => d.date <= romeDay(7))).toBe(true);

        const oltre = await api().get('/public/availability').query({ date: romeDay(8) });
        expect(oltre.status).toBe(200);
        expect(oltre.body.out_of_range).toBe(true);
        expect(oltre.body.lunch.slots).toEqual([]);
        expect(oltre.body.dinner.slots).toEqual([]);

        const dentro = await api().get('/public/availability').query({ date: romeDay(3) });
        expect(dentro.status).toBe(200);
        expect(dentro.body.out_of_range).toBeUndefined();

        const tardi = await prenota(romeDay(8));
        expect(tardi.status).toBe(409);
        expect(tardi.body.error).toBe('out_of_range');
        expect(tardi.body.message).toContain('7 giorni');
        expect(tardi.body.last_date).toBe(romeDay(7));

        const ieri = await prenota(romeDay(-1));
        expect(ieri.status).toBe(409);
        expect(ieri.body.error).toBe('out_of_range');
    });

    it('con la libera il server non ha limiti, come prima', async () => {
        await limite(null);
        const lontano = await api().get('/public/availability').query({ date: romeDay(400) });
        expect(lontano.status).toBe(200);
        expect(lontano.body.out_of_range).toBeUndefined();

        const calendario = await api().get('/public/availability').query({ from: romeDay(300), to: romeDay(330) });
        expect(calendario.status).toBe(200);
        expect(calendario.body.to).toBe(romeDay(330));

        const tardi = await prenota(romeDay(400));
        expect(tardi.body.error).not.toBe('out_of_range');
    });

    it('la modifica dal link segue il limite scelto', async () => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone,
                                       payment_status, reservation_status, arrival_status)
             VALUES ($1, $2, ($3::timestamp AT TIME ZONE 'Europe/Rome'), 'DINNER', 2, '+393331117755',
                     'NONE', 'CONFIRMED', 'WAITING')
             RETURNING id`,
            [TENANT, NAME, `${romeDay(3)} 20:30`]
        );
        const link = await api().post(`/reservations/${r.rows[0].id}/guest-link`).set(bearer(owner));
        expect(link.status).toBe(200);
        const token = link.body.token as string;

        await limite(7);
        const vista = await api().get(`/r/${token}`);
        expect(vista.status).toBe(200);
        expect(vista.body.modify.last_date).toBe(romeDay(7));
        const sposta = await api().post(`/r/${token}/modify`).send({ date: romeDay(9), time: '20:30', guests: 2 });
        expect(sposta.status).toBe(400);
        expect(sposta.body.error).toBe('out_of_range');

        // Con la libera la modifica torna ai suoi 60 giorni.
        await limite(null);
        expect((await api().get(`/r/${token}`)).body.modify.last_date).toBe(romeDay(60));
    });
});
