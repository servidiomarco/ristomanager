import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Registro attività leggibile (11/10). Nasce da un'indagine vera: «chi ha
// unito il tavolo di Orlando stasera?» richiedeva tre query a mano, perché
// l'unione era un log TABLE senza legame con la prenotazione, la divisione
// non diceva quali tavoli erano uniti e il nome mostrato era l'email.
// Lo scenario qui sotto rifà quella serata: proposta di tre tavoli, divisione,
// nuova unione di due tavoli e spostamento della prenotazione.

const GIORNO = '2027-07-07';
const NOME = 'Orlando Registrotest';

// logActivity è fire-and-forget: si aspetta che i log arrivino.
const attendi = async <T>(leggi: () => Promise<T>, pronto: (v: T) => boolean): Promise<T> => {
    let v = await leggi();
    for (let i = 0; i < 30 && !pronto(v); i++) {
        await new Promise(r => setTimeout(r, 100));
        v = await leggi();
    }
    return v;
};

describe('registro attività: cronologia della prenotazione', () => {
    let token: string;
    let roomId: number;
    const tavolo: Record<string, number> = {};
    let resvId: number;
    let waiterId: number | null = null;

    const corpo = (extra: Record<string, unknown>) => ({
        customer_name: NOME,
        reservation_time: `${GIORNO}T20:30:00`,
        shift: 'DINNER',
        guests: 9,
        children: 0,
        phone: '+39 333 000 7711',
        reservation_status: 'CONFIRMED',
        arrival_status: 'WAITING',
        payment_status: 'PENDING',
        ...extra,
    });

    const storia = () => api().get(`/activity-logs/reservation/${resvId}`).set(bearer(token));

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Registro', width: 800, height: 600 });
        expect(room.status).toBe(201);
        roomId = room.body.id;
        for (const nome of ['R24', 'R23', 'R25', 'R26', 'R27']) {
            const t = await api().post('/tables').set(bearer(token)).send({
                name: nome, shape: 'SQUARE', seats: 4, x: 100, y: 100, room_id: roomId, status: 'FREE',
            });
            expect(t.status).toBe(201);
            tavolo[nome] = t.body.id;
        }

        const r = await api().post('/reservations').set(bearer(token)).send(corpo({}));
        expect(r.status).toBe(201);
        resvId = r.body.id;

        // Prima sistemazione: 24 + 23 + 25.
        const m1 = await api().post('/table-merges').set(bearer(token)).send({
            date: GIORNO, shift: 'DINNER', primary_id: tavolo.R24, merged_ids: [tavolo.R23, tavolo.R25],
        });
        expect(m1.status).toBe(201);
        const u1 = await api().put(`/reservations/${resvId}`).set(bearer(token)).send(corpo({ table_id: tavolo.R24 }));
        expect(u1.status).toBe(200);

        // Poi: divisione, unione 26 + 27 e spostamento (con un coperto e un
        // telefono in più), nell'ordine in cui lo fa il form.
        const d1 = await api().delete('/table-merges').set(bearer(token)).send({
            date: GIORNO, shift: 'DINNER', primary_id: tavolo.R24,
        });
        expect(d1.status).toBe(200);
        const m2 = await api().post('/table-merges').set(bearer(token)).send({
            date: GIORNO, shift: 'DINNER', primary_id: tavolo.R26, merged_ids: [tavolo.R27],
        });
        expect(m2.status).toBe(201);
        const u2 = await api().put(`/reservations/${resvId}`).set(bearer(token)).send(corpo({
            table_id: tavolo.R26, guests: 10, phone: '+39 333 000 7799',
        }));
        expect(u2.status).toBe(200);
    });

    afterAll(async () => {
        if (waiterId) await api().delete(`/auth/users/${waiterId}`).set(bearer(token));
        await api().delete('/table-merges').set(bearer(token)).send({ date: GIORNO, shift: 'DINNER', primary_id: tavolo.R26 });
        if (resvId) await api().delete(`/reservations/${resvId}`).set(bearer(token));
    });

    it('la cronologia mette in fila prenotazione, unioni e divisione, dalla più vecchia', async () => {
        const res = await attendi(storia, r => (r.body.logs ?? []).length >= 6);
        expect(res.status).toBe(200);
        const logs = res.body.logs as any[];
        // Il contenuto, non l'ordine esatto: i log sono fire-and-forget e due
        // richieste a pochi ms possono scriverli invertiti.
        const sequenza = logs.map(l => `${l.resource_type}:${l.action}`).sort();
        expect(sequenza).toEqual([
            'RESERVATION:CREATE',
            'RESERVATION:UPDATE',
            'RESERVATION:UPDATE',
            'TABLE:CREATE',      // unioni 24 + 23 + 25 e 26 + 27
            'TABLE:CREATE',
            'TABLE:DELETE',      // divisione
        ]);
        const tempi = logs.map(l => new Date(l.created_at).getTime());
        expect([...tempi].sort((a, b) => a - b)).toEqual(tempi);
    });

    it('la divisione dice quali tavoli erano uniti', async () => {
        const res = await storia();
        const divisione = (res.body.logs as any[]).find(l => l.resource_type === 'TABLE' && l.action === 'DELETE');
        expect(divisione.resource_id).toBe(tavolo.R24);
        expect(divisione.details.merged_ids).toEqual([tavolo.R23, tavolo.R25]);
    });

    it('i nomi arrivano già risolti: tavoli e chi ha agito', async () => {
        const res = await storia();
        const { refs, logs } = res.body;
        for (const nome of ['R24', 'R23', 'R25', 'R26', 'R27']) {
            expect(refs.tables[String(tavolo[nome])]).toBe(nome);
        }
        // Il nome della scheda utente, non l'email che il call site passa.
        const update = (logs as any[]).find(l => l.action === 'UPDATE');
        expect(update.user_name).toBe('Admin Owner');
        expect(update.user_email).toContain('@');

        const unione = (logs as any[]).filter(l => l.resource_type === 'TABLE' && l.action === 'CREATE').pop();
        expect(refs.merge_reservations[String(unione.id)]).toEqual([{ id: resvId, name: NOME }]);
    });

    it('la modifica scrive prima e dopo; i dati personali solo come «cambiato»', async () => {
        const res = await storia();
        const ultima = (res.body.logs as any[]).filter(l => l.action === 'UPDATE').pop();
        expect(ultima.details.changes.table_id).toEqual([tavolo.R24, tavolo.R26]);
        expect(ultima.details.changes.guests).toEqual([9, 10]);
        expect(ultima.details.changes.reservation_time).toBeUndefined();
        expect(ultima.details.changed_fields).toEqual(['phone']);
        // Nessun numero dentro i details: l'oblio del cliente non li ripulisce.
        expect(JSON.stringify(ultima.details)).not.toContain('7711');
        expect(JSON.stringify(ultima.details)).not.toContain('7799');
    });

    it('cercando il cliente nel registro esce anche l\'unione dei suoi tavoli', async () => {
        const res = await api().get('/activity-logs').query({ search: 'Registrotest' }).set(bearer(token));
        expect(res.status).toBe(200);
        const unioni = (res.body.logs as any[]).filter(l => l.resource_type === 'TABLE');
        // La 26 + 27, dove siede ora; la 24 + 23 + 25 è stata divisa e la
        // prenotazione non c'è più.
        expect(unioni.map(l => [l.action, l.resource_id])).toContainEqual(['CREATE', tavolo.R26]);
        expect(unioni.some(l => l.resource_id === tavolo.R24 && l.action === 'CREATE')).toBe(false);
        expect(res.body.refs.tables[String(tavolo.R27)]).toBe('R27');
    });

    it('filtro per resource_id', async () => {
        const res = await api().get('/activity-logs')
            .query({ resource_type: 'RESERVATION', resource_id: resvId }).set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect((res.body.logs as any[]).every(l => l.resource_id === resvId)).toBe(true);
    });

    it('prenotazione inesistente → 404, id non valido → 400', async () => {
        const nessuna = await api().get('/activity-logs/reservation/987654321').set(bearer(token));
        expect(nessuna.status).toBe(404);
        const storto = await api().get('/activity-logs/reservation/abc').set(bearer(token));
        expect(storto.status).toBe(400);
    });

    it('senza logs:view la cronologia è chiusa', async () => {
        const email = `cameriere.registro.${Date.now()}@example.com`;
        const created = await api().post('/auth/users').set(bearer(token))
            .send({ email, password: 'password-registro-1', full_name: 'Cameriere Registro', role: 'WAITER' });
        expect(created.status).toBe(201);
        waiterId = created.body.id;
        const login = await api().post('/auth/login').send({ email, password: 'password-registro-1' });
        expect(login.status).toBe(200);
        const res = await api().get(`/activity-logs/reservation/${resvId}`).set(bearer(login.body.accessToken));
        expect(res.status).toBe(403);
    });
});
