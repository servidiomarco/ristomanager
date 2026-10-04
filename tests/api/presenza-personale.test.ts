import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// «Chi è di turno» (GET /staff/presence) legge il giorno come la pagina
// Personale (slotState) e l'avviso del cambio turno (isOnDuty): la riga
// esplicita vince; poi l'assenza; poi il riposo settimanale; poi la presenza
// implicita di FISSO e STAGIONALE nel periodo di contratto. La Sala dal vivo
// ne fa i camerieri che girano in sala: devono essere le persone che il
// responsabile vede di turno in griglia.
//
// Una data fra dieci giorni e solo le schede create qui: altri file lasciano
// schede FISSO nel tenant, che risultano di turno ogni giorno, quindi si
// guarda dove stanno le nostre e mai quante sono le liste.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
// Un altro ristorante, con un FISSO che sarebbe di turno ogni giorno: non
// deve mai comparire nelle nostre liste. I test girano come postgres, che
// salta la RLS: se una query perdesse il suo filtro sul tenant, lo direbbe
// solo questo.
const OTHER_TENANT_ID = 903;

const romeToday = (): string => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (iso: string, n: number): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const weekdayOf = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();

type Service = 'LUNCH' | 'DINNER';

describe('presenze del personale · la stessa regola di Personale', () => {
    let owner = '';
    const day = addDays(romeToday(), 10);
    const restDay = weekdayOf(day);
    const ids: Record<string, string> = {};

    const make = async (key: string, body: Record<string, unknown>) => {
        const res = await api().post('/staff').set(bearer(owner)).send({
            name: key, surname: 'Presenza', category: 'SALA', ...body,
        });
        expect(res.status, key).toBe(201);
        ids[key] = res.body.id;
    };
    const shift = async (key: string, service: Service, present: boolean) => {
        const res = await api().post('/staff/shifts').set(bearer(owner))
            .send({ staffId: ids[key], date: day, shift: service, present });
        expect(res.status, key).toBe(201);
    };
    const timeOff = async (key: string, service: Service | null, type: string, from = day, to = day) => {
        const res = await api().post('/staff/time-off').set(bearer(owner))
            .send({ staffId: ids[key], startDate: from, endDate: to, type, shift: service });
        expect(res.status, key).toBe(201);
    };
    let otherId = '';

    beforeAll(async () => {
        owner = await ownerToken();

        // Nessuna riga: il contratto basta.
        await make('Stagionale', { staffType: 'STAGIONALE' });
        // Un giorno di contratto solo, quel giorno: i confini sono compresi.
        await make('Giornata', { staffType: 'STAGIONALE', hireDate: day, contractEndDate: day });
        // In ferie tutto il giorno, ma richiamata a pranzo: la riga vince.
        await make('Richiamata', { staffType: 'FISSO' });
        await timeOff('Richiamata', null, 'VACANZA');
        await shift('Richiamata', 'LUNCH', true);
        // Il riposo settimanale cade quel giorno.
        await make('Riposo', { staffType: 'FISSO', weeklyRestDay: restDay });
        // A riposo, ma con una cena scritta in griglia.
        await make('RiposoCena', { staffType: 'FISSO', weeklyRestDay: restDay });
        await shift('RiposoCena', 'DINNER', true);
        // Extra: solo quello che è scritto.
        await make('Extra', { staffType: 'EXTRA' });
        await make('ExtraCena', { staffType: 'EXTRA' });
        await shift('ExtraCena', 'DINNER', true);
        // Un permesso per la sola cena: il pranzo resta.
        await make('PermessoCena', { staffType: 'FISSO' });
        await timeOff('PermessoCena', 'DINNER', 'PERMESSO');
        // Un «assente» scritto a pranzo batte la presenza da contratto.
        await make('AssentePranzo', { staffType: 'FISSO' });
        await shift('AssentePranzo', 'LUNCH', false);
        // Fuori dal periodo di contratto, da una parte e dall'altra.
        await make('Finito', { staffType: 'FISSO', contractEndDate: addDays(day, -1) });
        await make('NonAncora', { staffType: 'STAGIONALE', hireDate: addDays(day, 1) });
        // Disattivato: mai in lista, nemmeno con un turno scritto.
        await make('Inattivo', { staffType: 'FISSO' });
        await shift('Inattivo', 'DINNER', true);
        const off = await api().put(`/staff/${ids.Inattivo}`).set(bearer(owner)).send({ isActive: false });
        expect(off.status).toBe(200);
        // La cucina sta nelle liste della cucina.
        await make('Cucina', { staffType: 'FISSO', category: 'CUCINA' });
        // Un'assenza di cinque giorni che quel giorno sta nel mezzo: la
        // finestra start_date ≤ giorno ≤ end_date, non solo il giorno esatto.
        await make('InFerie', { staffType: 'FISSO' });
        await timeOff('InFerie', null, 'VACANZA', addDays(day, -2), addDays(day, 2));

        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            await db.query(
                `INSERT INTO tenants (id, slug, name) VALUES ($1, 'trattoria-presenze', 'Trattoria Presenze')
                 ON CONFLICT (id) DO NOTHING`,
                [OTHER_TENANT_ID],
            );
            await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
            const altro = await db.query(
                `INSERT INTO staff_members (tenant_id, name, surname, category, staff_type)
                 VALUES ($1, 'Altrui', 'Presenza', 'SALA', 'FISSO') RETURNING id`,
                [OTHER_TENANT_ID],
            );
            otherId = altro.rows[0].id;
        } finally {
            await db.end();
        }
    });

    afterAll(async () => {
        const db = new Client({ connectionString: dbUrl() });
        await db.connect();
        try {
            // Turni e assenze cascano con le schede.
            await db.query('DELETE FROM staff_members WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
            await db.query('DELETE FROM staff_members WHERE tenant_id = $1', [OTHER_TENANT_ID]);
            await db.query('DELETE FROM role_permissions WHERE tenant_id = $1', [OTHER_TENANT_ID]);
            await db.query('DELETE FROM tenants WHERE id = $1', [OTHER_TENANT_ID]);
        } finally {
            await db.end();
        }
    });

    it('legge ogni scheda come la griglia turni', async () => {
        const res = await api().get(`/staff/presence?date=${day}`).set(bearer(owner));
        expect(res.status).toBe(200);
        const idsIn = (list: Array<{ id: string }>) => new Set(list.map(s => s.id));
        const sala = { LUNCH: idsIn(res.body.sala.lunch), DINNER: idsIn(res.body.sala.dinner) };
        const cucina = { LUNCH: idsIn(res.body.cucina.lunch), DINNER: idsIn(res.body.cucina.dinner) };
        const servicesOf = (lists: Record<Service, Set<string>>, key: string): Service[] =>
            (['LUNCH', 'DINNER'] as const).filter(s => lists[s].has(ids[key]));

        expect(servicesOf(sala, 'Stagionale')).toEqual(['LUNCH', 'DINNER']);
        expect(servicesOf(sala, 'Giornata')).toEqual(['LUNCH', 'DINNER']);
        expect(servicesOf(sala, 'Richiamata')).toEqual(['LUNCH']);
        expect(servicesOf(sala, 'Riposo')).toEqual([]);
        expect(servicesOf(sala, 'RiposoCena')).toEqual(['DINNER']);
        expect(servicesOf(sala, 'Extra')).toEqual([]);
        expect(servicesOf(sala, 'ExtraCena')).toEqual(['DINNER']);
        expect(servicesOf(sala, 'PermessoCena')).toEqual(['LUNCH']);
        expect(servicesOf(sala, 'AssentePranzo')).toEqual(['DINNER']);
        expect(servicesOf(sala, 'Finito')).toEqual([]);
        expect(servicesOf(sala, 'NonAncora')).toEqual([]);
        expect(servicesOf(sala, 'Inattivo')).toEqual([]);
        expect(servicesOf(cucina, 'Inattivo')).toEqual([]);
        expect(servicesOf(sala, 'Cucina')).toEqual([]);
        expect(servicesOf(cucina, 'Cucina')).toEqual(['LUNCH', 'DINNER']);
        expect(servicesOf(sala, 'InFerie')).toEqual([]);
    });

    it('le schede di un altro ristorante non compaiono mai', async () => {
        expect(otherId).not.toBe('');
        const res = await api().get(`/staff/presence?date=${day}`).set(bearer(owner));
        expect(res.status).toBe(200);
        for (const list of [res.body.sala.lunch, res.body.sala.dinner, res.body.cucina.lunch, res.body.cucina.dinner]) {
            expect(list.some((s: { id: string }) => s.id === otherId)).toBe(false);
        }
    });

    it('la forma della risposta non cambia', async () => {
        const res = await api().get(`/staff/presence?date=${day}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['cucina', 'sala']);
        const row = res.body.sala.lunch.find((s: { id: string }) => s.id === ids.Stagionale);
        expect(row).toEqual({
            id: ids.Stagionale,
            name: 'Stagionale',
            surname: 'Presenza',
            category: 'SALA',
            staffType: 'STAGIONALE',
            role: null,
        });
    });

    it('una data che non è una data: 400', async () => {
        for (const query of ['', '?date=', '?date=domani', '?date=2026-02-30', '?date=2026-10-4']) {
            const res = await api().get(`/staff/presence${query}`).set(bearer(owner));
            expect(res.status, query).toBe(400);
        }
    });
});
