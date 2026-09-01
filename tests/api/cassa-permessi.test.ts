import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Modulo Cassa, prima tranche (docs/cassa-plan.md §5): il ruolo CASSA esiste
// davvero e la matrice dei permessi lo separa dalla direzione.
//
// Il primo test è meno banale di quanto sembri: creare un utente CASSA prova
// che l'allargamento dei CHECK su users.role è arrivato a destinazione. Se la
// migration non gira — o se createSchema li ha ri-ristretti a ogni boot senza
// che ensureRoleChecks li riallarghi — la INSERT fallisce qui.

const CASSA_EMAIL = 'cassa.permessi@example.com';
const PASSWORD = 'password-cassa-permessi';

describe('cassa — ruolo e permessi', () => {
    let owner = '';
    let cassaToken = '';

    beforeAll(async () => {
        owner = await ownerToken();
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: CASSA_EMAIL, password: PASSWORD, full_name: 'Test Cassa', role: 'CASSA',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: CASSA_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        cassaToken = login.body.accessToken;
    });

    afterAll(async () => {
        // I file di test condividono il database e girano in sequenza: si
        // rimuove quello che questo file ha creato.
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(`DELETE FROM users WHERE email = $1`, [CASSA_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('il ruolo CASSA si crea e si autentica', async () => {
        const me = await api().get('/auth/me').set(bearer(cassaToken));
        expect(me.status).toBe(200);
        expect(me.body.role).toBe('CASSA');
    });

    it('la cassa incassa e storna, ma non chiude il cassetto', async () => {
        const res = await api().get('/auth/permissions/roles/CASSA').set(bearer(owner));
        expect(res.status).toBe(200);
        const perms: string[] = res.body.permissions;

        // Quello che il cassiere fa tutto il giorno.
        expect(perms).toContain('cash:operate');
        expect(perms).toContain('cash:void_payment');
        // Senza orders:void non si storna una riga né si applica lo sconto
        // conto: sono le due correzioni che in cassa si fanno di continuo.
        expect(perms).toContain('orders:take');
        expect(perms).toContain('orders:void');

        // Quello che risponde al titolare, non a chi sta in cassa.
        expect(perms).not.toContain('cash:close_partial');
        expect(perms).not.toContain('cash:close_session');
        // Cassa non è Pagamenti: il registro sul periodo resta altrove.
        expect(perms).not.toContain('payments:full');
    });

    it('la direzione ha tutti e quattro i permessi di cassa', async () => {
        for (const role of ['OWNER', 'GENERAL_MANAGER', 'MANAGER']) {
            const res = await api().get(`/auth/permissions/roles/${role}`).set(bearer(owner));
            expect(res.status).toBe(200);
            const perms: string[] = res.body.permissions;
            for (const p of ['cash:operate', 'cash:void_payment', 'cash:close_partial', 'cash:close_session']) {
                expect(perms, `${role} deve avere ${p}`).toContain(p);
            }
        }
    });

    it('i ruoli di sala e cucina restano fuori dalla cassa', async () => {
        for (const role of ['WAITER', 'KITCHEN', 'RECEPTION']) {
            const res = await api().get(`/auth/permissions/roles/${role}`).set(bearer(owner));
            expect(res.status).toBe(200);
            const perms: string[] = res.body.permissions;
            expect(perms.filter(p => p.startsWith('cash:')), `${role} non deve avere permessi di cassa`).toEqual([]);
        }
    });

    it('senza payments:full la cassa non passa dalle route di Pagamenti', async () => {
        // Conto inesistente di proposito: quello che conta è che il 403 del
        // permesso arrivi PRIMA del 404 della risorsa.
        const res = await api().post('/bills/999999/close').set(bearer(cassaToken)).send({});
        expect(res.status).toBe(403);
    });

    it('la cassa legge il cassetto ma non lo apre né lo chiude', async () => {
        const read = await api().get('/cash/session').set(bearer(cassaToken));
        expect(read.status).toBe(200);

        const open = await api().post('/cash/session').set(bearer(cassaToken)).send({
            opening_float_cents: 15000,
        });
        expect(open.status).toBe(403);

        const close = await api().post('/cash/session/999999/close').set(bearer(cassaToken)).send({
            counted_cents: 0,
        });
        expect(close.status).toBe(403);
    });
});
