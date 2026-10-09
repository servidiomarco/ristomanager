import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
    normalizeGuestManagePolicy,
    guestActionsFor,
    guestReservationState,
    depositOutcomeOnCancel,
    newGuestToken,
    DEFAULT_GUEST_MANAGE_POLICY,
    GUEST_TOKEN_MIN_LENGTH,
    type GuestManagePolicy,
} from '../../services/guestManage';
import { api, ownerToken, bearer } from './helpers';

// «La tua prenotazione» (services/guestManage.ts): l'ospite conferma o
// annulla dal link di conferma e promemoria.
//
// Tre parti: le regole pure (cosa può fare l'ospite, la caparra), le rotte
// pubbliche a token contro il server vero — l'annullo deve liberare il
// tavolo e segnare chi l'ha fatto, come quello dello staff — e le
// impostazioni.

const ore = (n: number) => n * 3600_000;
const acceso: GuestManagePolicy = { enabled: true, cancel_cutoff_hours: 3 };
const now = new Date('2026-10-09T10:00:00Z');

describe('gestione dall\'ospite — regole', () => {
    it('la policy accetta da 1 a 72 ore e rifiuta il resto', () => {
        expect(normalizeGuestManagePolicy(acceso)).toEqual(acceso);
        expect(normalizeGuestManagePolicy({ enabled: false, cancel_cutoff_hours: 72 })).not.toBeNull();
        expect(normalizeGuestManagePolicy({ enabled: true, cancel_cutoff_hours: 0 })).toBeNull();
        expect(normalizeGuestManagePolicy({ enabled: true, cancel_cutoff_hours: 73 })).toBeNull();
        expect(normalizeGuestManagePolicy({ enabled: true, cancel_cutoff_hours: 2.5 })).toBeNull();
        expect(normalizeGuestManagePolicy({ enabled: 'si', cancel_cutoff_hours: 3 })).toBeNull();
        expect(normalizeGuestManagePolicy(null)).toBeNull();
    });

    it('di serie è spenta, annullo fino a 3 ore prima', () => {
        expect(DEFAULT_GUEST_MANAGE_POLICY).toEqual({ enabled: false, cancel_cutoff_hours: 3 });
    });

    it('lo stato racconta la prenotazione come la vede l\'ospite', () => {
        const fra = (h: number) => new Date(now.getTime() + ore(h));
        expect(guestReservationState({ now, reservationTime: fra(5), status: 'CONFIRMED' })).toBe('confirmed');
        expect(guestReservationState({ now, reservationTime: fra(5), status: 'PENDING' })).toBe('pending');
        expect(guestReservationState({ now, reservationTime: fra(5), status: 'CANCELLED' })).toBe('cancelled');
        expect(guestReservationState({ now, reservationTime: fra(5), status: 'DECLINED' })).toBe('declined');
        expect(guestReservationState({ now, reservationTime: fra(-1), status: 'CONFIRMED' })).toBe('past');
        // Già al tavolo: storia, anche prima dell'orario.
        expect(guestReservationState({ now, reservationTime: fra(1), status: 'CONFIRMED', arrivalStatus: 'ARRIVED' })).toBe('past');
    });

    it('conferma e annullo solo a gestione accesa e prima della soglia', () => {
        const base = { now, status: 'CONFIRMED', guestConfirmedAt: null };
        const lontana = guestActionsFor({ ...base, reservationTime: new Date(now.getTime() + ore(30)), policy: acceso });
        expect(lontana).toEqual({ state: 'confirmed', can_confirm: true, can_cancel: true, cancel_block: null, can_modify: true });

        const vicina = guestActionsFor({ ...base, reservationTime: new Date(now.getTime() + ore(2)), policy: acceso });
        expect(vicina.can_cancel).toBe(false);
        expect(vicina.cancel_block).toBe('too_late');
        expect(vicina.can_modify).toBe(false);
        // Confermare la presenza resta possibile fino all'ultimo.
        expect(vicina.can_confirm).toBe(true);

        const spenta = guestActionsFor({ ...base, reservationTime: new Date(now.getTime() + ore(30)), policy: DEFAULT_GUEST_MANAGE_POLICY });
        expect(spenta).toEqual({ state: 'confirmed', can_confirm: false, can_cancel: false, cancel_block: 'disabled', can_modify: false });

        const giaConfermata = guestActionsFor({ ...base, guestConfirmedAt: now, reservationTime: new Date(now.getTime() + ore(30)), policy: acceso });
        expect(giaConfermata.can_confirm).toBe(false);
        expect(giaConfermata.can_cancel).toBe(true);
    });

    it('una richiesta in attesa si ritira ma non si conferma', () => {
        const a = guestActionsFor({ now, status: 'PENDING', guestConfirmedAt: null, reservationTime: new Date(now.getTime() + ore(30)), policy: acceso });
        expect(a).toEqual({ state: 'pending', can_confirm: false, can_cancel: true, cancel_block: null, can_modify: false });
    });

    it('niente azioni su annullate, rifiutate e passate', () => {
        for (const status of ['CANCELLED', 'DECLINED', 'NO_SHOW']) {
            const a = guestActionsFor({ now, status, guestConfirmedAt: null, reservationTime: new Date(now.getTime() + ore(30)), policy: acceso });
            expect(a.can_confirm || a.can_cancel || a.can_modify, status).toBe(false);
            expect(a.cancel_block, status).toBeNull();
        }
    });

    it('la caparra si rimborsa solo con almeno 24 ore d\'anticipo', () => {
        expect(depositOutcomeOnCancel(now, new Date(now.getTime() + ore(24)))).toBe('refund');
        expect(depositOutcomeOnCancel(now, new Date(now.getTime() + ore(23.9)))).toBe('retained');
    });

    it('il token è lungo, casuale e sta in un URL', () => {
        const a = newGuestToken();
        const b = newGuestToken();
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThanOrEqual(GUEST_TOKEN_MIN_LENGTH);
        expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('gestione dall\'ospite — pagina e rotte pubbliche', () => {
    const TENANT = 1;
    const NAME = 'Collaudo Ospite';
    let owner: string;
    let db: Client;
    let tableId: number;

    const nuovaPrenotazione = async (offsetHours: number, extra: { status?: string; payment?: string; deposit?: number; noTable?: boolean } = {}): Promise<number> => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone, table_id,
                                       payment_status, deposit_amount, reservation_status, arrival_status)
             VALUES ($1, $2, date_trunc('minute', NOW()) + make_interval(mins => $3), 'DINNER', 4, '+393331112277', $4,
                     $5, $6, $7, 'WAITING')
             RETURNING id`,
            [TENANT, NAME, Math.round(offsetHours * 60), extra.noTable ? null : tableId, extra.payment ?? 'NONE', extra.deposit ?? null, extra.status ?? 'CONFIRMED']
        );
        return Number(r.rows[0].id);
    };
    const linkDi = async (id: number): Promise<string> => {
        const res = await api().post(`/reservations/${id}/guest-link`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.url).toContain(`/r/${res.body.token}`);
        return res.body.token as string;
    };
    const riga = async (id: number) => (await db.query(
        `SELECT reservation_status, table_id, guest_token, guest_confirmed_at, guest_cancelled_at FROM reservations WHERE id = $1`, [id]
    )).rows[0];
    const accendi = (body: Record<string, unknown>) => api().put('/settings/guest-manage').set(bearer(owner)).send(body);

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const t = await db.query(`SELECT id FROM tables WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [TENANT]);
        tableId = t.rows[0]?.id ?? null;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM reservations WHERE customer_name = $1 AND tenant_id = $2`, [NAME, TENANT]);
        // Torna al default: il resto della suite non deve trovarla accesa.
        await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'guest_manage_policy'`, [TENANT]);
        await db.end();
    });

    it('il link nasce una volta sola e resta stabile', async () => {
        const id = await nuovaPrenotazione(30);
        const primo = await linkDi(id);
        expect(primo.length).toBeGreaterThanOrEqual(GUEST_TOKEN_MIN_LENGTH);
        expect(await linkDi(id)).toBe(primo);
        expect((await riga(id)).guest_token).toBe(primo);
    });

    it('un token sbagliato o corto è un 404, senza indizi', async () => {
        expect((await api().get('/r/token-inventato-abbastanza-lungo')).status).toBe(404);
        expect((await api().get('/r/corto')).status).toBe(404);
        expect((await api().post('/r/token-inventato-abbastanza-lungo/cancel')).status).toBe(404);
    });

    it('a gestione spenta la pagina mostra la prenotazione e non lascia fare niente', async () => {
        const id = await nuovaPrenotazione(30);
        const token = await linkDi(id);
        const res = await api().get(`/r/${token}`);
        expect(res.status).toBe(200);
        expect(res.body.business.name).toBeTruthy();
        expect(res.body.reservation).toMatchObject({ customer_name: NAME, guests: 4, state: 'confirmed', guest_confirmed_at: null });
        expect(res.body.reservation.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(res.body.reservation.time).toMatch(/^\d{2}:\d{2}$/);
        expect(res.body.actions).toMatchObject({ can_confirm: false, can_cancel: false, cancel_block: 'disabled' });
        // Il tavolo e i dati interni non escono mai.
        expect(JSON.stringify(res.body)).not.toContain('table_id');
        expect(JSON.stringify(res.body)).not.toContain('+393331112277');

        expect((await api().post(`/r/${token}/cancel`)).status).toBe(409);
        expect((await riga(id)).reservation_status).toBe('CONFIRMED');
    });

    it('«ci saremo» segna la conferma dell\'ospite, una volta sola', async () => {
        expect((await accendi({ enabled: true })).status).toBe(200);
        const id = await nuovaPrenotazione(30);
        const token = await linkDi(id);

        const prima = await api().get(`/r/${token}`);
        expect(prima.body.actions).toMatchObject({ can_confirm: true, can_cancel: true, cancel_block: null, cancel_cutoff_hours: 3 });

        const conferma = await api().post(`/r/${token}/confirm`);
        expect(conferma.status).toBe(200);
        expect(conferma.body.reservation.guest_confirmed_at).toBeTruthy();
        expect(conferma.body.actions.can_confirm).toBe(false);
        const segnata = (await riga(id)).guest_confirmed_at;
        expect(segnata).toBeTruthy();

        const ancora = await api().post(`/r/${token}/confirm`);
        expect(ancora.status).toBe(200);
        expect(new Date((await riga(id)).guest_confirmed_at).getTime()).toBe(new Date(segnata).getTime());
    });

    it('l\'annullo libera il tavolo, segna l\'ospite e non si ripete', async () => {
        const id = await nuovaPrenotazione(30);
        const token = await linkDi(id);

        const annullo = await api().post(`/r/${token}/cancel`);
        expect(annullo.status).toBe(200);
        expect(annullo.body.reservation.state).toBe('cancelled');
        expect(annullo.body.actions).toMatchObject({ can_confirm: false, can_cancel: false });
        const r = await riga(id);
        expect(r.reservation_status).toBe('CANCELLED');
        expect(r.table_id).toBeNull();
        expect(r.guest_cancelled_at).toBeTruthy();

        const ancora = await api().post(`/r/${token}/cancel`);
        expect(ancora.status).toBe(200);
        expect(ancora.body.reservation.state).toBe('cancelled');
    });

    it('più vicino della soglia non si annulla: troppo tardi', async () => {
        const id = await nuovaPrenotazione(2);
        const token = await linkDi(id);
        const vista = await api().get(`/r/${token}`);
        expect(vista.body.actions).toMatchObject({ can_cancel: false, cancel_block: 'too_late', can_confirm: true });

        const annullo = await api().post(`/r/${token}/cancel`);
        expect(annullo.status).toBe(409);
        expect(annullo.body.error).toBe('too_late');
        expect((await riga(id)).reservation_status).toBe('CONFIRMED');
    });

    it('una richiesta in attesa si ritira', async () => {
        const id = await nuovaPrenotazione(30, { status: 'PENDING' });
        const token = await linkDi(id);
        expect((await api().post(`/r/${token}/confirm`)).status).toBe(409);
        const annullo = await api().post(`/r/${token}/cancel`);
        expect(annullo.status).toBe(200);
        expect((await riga(id)).reservation_status).toBe('CANCELLED');
    });

    it('la caparra pagata dice cosa succede se si annulla', async () => {
        const lontana = await nuovaPrenotazione(30, { payment: 'PAID_DEPOSIT', deposit: 40 });
        const vistaLontana = await api().get(`/r/${await linkDi(lontana)}`);
        expect(vistaLontana.body.deposit).toEqual({ amount: 40, on_cancel: 'refund' });

        const vicina = await nuovaPrenotazione(10, { payment: 'PAID_DEPOSIT', deposit: 40 });
        const vistaVicina = await api().get(`/r/${await linkDi(vicina)}`);
        expect(vistaVicina.body.deposit).toEqual({ amount: 40, on_cancel: 'retained' });

        const senza = await nuovaPrenotazione(30);
        expect((await api().get(`/r/${await linkDi(senza)}`)).body.deposit).toBeNull();
    });

    it('lo staff che sposta o ripristina la prenotazione azzera la risposta dell\'ospite', async () => {
        const staffPut = async (id: number, patch: Record<string, unknown>) => {
            const r = (await db.query(
                `SELECT customer_name, phone, reservation_time, shift, guests, children, table_id, notes, reservation_status, payment_status, arrival_status
                   FROM reservations WHERE id = $1`, [id])).rows[0];
            const res = await api().put(`/reservations/${id}`).set(bearer(owner)).send({
                customer_name: r.customer_name, phone: r.phone, reservation_time: new Date(r.reservation_time).toISOString(),
                shift: r.shift, guests: r.guests, children: r.children, table_id: r.table_id, notes: r.notes,
                reservation_status: r.reservation_status, payment_status: r.payment_status, arrival_status: r.arrival_status,
                ...patch,
            });
            expect(res.status).toBe(200);
        };

        // Senza tavolo: il PUT dello staff controlla i conflitti, e le altre
        // prenotazioni di prova stanno sullo stesso tavolo alla stessa ora.
        // Confermata dall'ospite, poi un salvataggio che non tocca l'orario: resta.
        const spostata = await nuovaPrenotazione(30, { noTable: true });
        const tokenSpostata = await linkDi(spostata);
        expect((await api().post(`/r/${tokenSpostata}/confirm`)).status).toBe(200);
        await staffPut(spostata, { notes: 'nota dello staff' });
        expect((await riga(spostata)).guest_confirmed_at).toBeTruthy();
        // Spostata di un'ora: il «ci saremo» era per l'orario di prima.
        const ora = (await db.query('SELECT reservation_time FROM reservations WHERE id = $1', [spostata])).rows[0].reservation_time;
        await staffPut(spostata, { reservation_time: new Date(new Date(ora).getTime() + ore(1)).toISOString() });
        expect((await riga(spostata)).guest_confirmed_at).toBeNull();

        // Annullata dall'ospite e ripristinata dallo staff: l'annullo non vale più.
        const ripristinata = await nuovaPrenotazione(30, { noTable: true });
        expect((await api().post(`/r/${await linkDi(ripristinata)}/cancel`)).status).toBe(200);
        await staffPut(ripristinata, { reservation_status: 'CONFIRMED' });
        const r = await riga(ripristinata);
        expect(r.reservation_status).toBe('CONFIRMED');
        expect(r.guest_cancelled_at).toBeNull();
    });

    it('il link della prenotazione è solo per chi gestisce le prenotazioni', async () => {
        const id = await nuovaPrenotazione(30);
        expect((await api().post(`/reservations/${id}/guest-link`)).status).toBe(401);
        expect((await api().post('/reservations/999999999/guest-link').set(bearer(owner))).status).toBe(404);
    });
});

describe('gestione dall\'ospite — impostazioni', () => {
    let owner: string;
    let db: Client;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await db.query(`DELETE FROM app_settings WHERE tenant_id = 1 AND key = 'guest_manage_policy'`);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM app_settings WHERE tenant_id = 1 AND key = 'guest_manage_policy'`);
        await db.end();
    });

    it('di serie è spenta; update parziale; valori fuori limite rifiutati', async () => {
        const base = await api().get('/settings/guest-manage').set(bearer(owner));
        expect(base.status).toBe(200);
        expect(base.body).toEqual({ enabled: false, cancel_cutoff_hours: 3 });

        const accesa = await api().put('/settings/guest-manage').set(bearer(owner)).send({ enabled: true });
        expect(accesa.body).toEqual({ enabled: true, cancel_cutoff_hours: 3 });
        const ore = await api().put('/settings/guest-manage').set(bearer(owner)).send({ cancel_cutoff_hours: 24 });
        expect(ore.body).toEqual({ enabled: true, cancel_cutoff_hours: 24 });

        const troppe = await api().put('/settings/guest-manage').set(bearer(owner)).send({ cancel_cutoff_hours: 100 });
        expect(troppe.status).toBe(400);
        expect(troppe.body.error).toBe('invalid_policy');
        expect((await api().get('/settings/guest-manage').set(bearer(owner))).body.cancel_cutoff_hours).toBe(24);
    });
});
