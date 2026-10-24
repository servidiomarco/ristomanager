import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// CRM della piattaforma (pannello Piattaforma): lead e clienti di Sympotia,
// con referenti, cronologia, promemoria, opportunità, salute e aggancio al
// provisioning. Rotte /admin/crm, solo per la piattaforma.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const PA_EMAIL = 'platform.admin.crm@example.com';
const PA_PASSWORD = 'password-crm-piattaforma';
const SLUG = 'trattoria-test-crm';

const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

const romeDay = (offsetDays = 0): string => {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
};

describe('CRM della piattaforma', () => {
    let db: Client;
    let owner = '';
    let platform = '';
    let createdTenantId = 0;

    const admin = () => ({ ...bearer(platform) });

    beforeAll(async () => {
        db = await pgClient();
        owner = await ownerToken();
        await db.query(
            `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
             VALUES ($1, $2, 'Admin CRM', 'PLATFORM_ADMIN', 1, TRUE)
             ON CONFLICT (email) DO NOTHING`,
            [PA_EMAIL, bcrypt.hashSync(PA_PASSWORD, 4)]
        );
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), GREATEST((SELECT MAX(id) FROM tenants), 100))`);
        const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        expect(login.status).toBe(200);
        platform = login.body.accessToken;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM crm_accounts`);
        await db.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
        await db.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [PA_EMAIL]);
        await db.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
        if (createdTenantId) {
            for (const table of ['activity_logs', 'user_sessions', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [createdTenantId]).catch(() => {});
            }
            await db.query('DELETE FROM tenants WHERE id = $1', [createdTenantId]);
        }
        await db.end();
    });

    it('è chiuso a chi non è la piattaforma', async () => {
        expect((await api().get('/admin/crm/accounts')).status).toBe(401);
        expect((await api().get('/admin/crm/accounts').set(bearer(owner))).status).toBe(401);
        expect((await api().post('/admin/crm/accounts').set(bearer(owner)).send({ name: 'X' })).status).toBe(401);
        expect((await api().get('/admin/crm/accounts').set(ADMIN_HEADER)).status).toBe(200);
    });

    it('dà una scheda a ogni ristorante, con salute e fase dal billing', async () => {
        const res = await api().get('/admin/crm/accounts').set(admin());
        expect(res.status).toBe(200);
        const home = res.body.accounts.find((a: any) => a.customer_tenant_id === 1);
        expect(home).toBeTruthy();
        // Fase dal billing: senza abbonamento (grandfathered) è cliente.
        const fromBilling: Record<string, string> = { trialing: 'prova', canceled: 'disdetto' };
        expect(home.stage).toBe(fromBilling[home.tenant.billing_status] ?? 'cliente');
        expect(home.tenant.slug).toBeTruthy();
        expect(typeof home.health.score).toBe('number');
        expect(['sano', 'da_seguire', 'a_rischio']).toContain(home.health.level);
        // Le schede le scrive il ristorante di casa di chi agisce (RLS).
        const row = await db.query(`SELECT tenant_id FROM crm_accounts WHERE id = $1`, [home.id]);
        expect(Number(row.rows[0].tenant_id)).toBe(1);
        // Un secondo giro non raddoppia niente.
        const again = await api().get('/admin/crm/accounts').set(admin());
        expect(again.body.accounts.filter((a: any) => a.customer_tenant_id === 1)).toHaveLength(1);
    });

    describe('un lead dal primo contatto alla prova', () => {
        let accountId = 0;
        let firstContactId = 0;

        it('valida i campi', async () => {
            expect((await api().post('/admin/crm/accounts').set(admin()).send({ city: 'Roma' })).status).toBe(400);
            expect((await api().post('/admin/crm/accounts').set(admin()).send({ name: 'X', stage: 'boh' })).status).toBe(400);
            expect((await api().post('/admin/crm/accounts').set(admin()).send({ name: 'X', email: 'senza-chiocciola' })).status).toBe(400);
            expect((await api().post('/admin/crm/accounts').set(admin()).send({ name: 'X', seats: -3 })).status).toBe(400);
            expect((await api().post('/admin/crm/accounts').set(admin()).send({ name: 'X', renewal_date: '2026-02-31' })).status).toBe(400);
        });

        it('crea il lead con il primo referente come principale', async () => {
            const res = await api().post('/admin/crm/accounts').set(admin()).send({
                name: 'Osteria del Ponte', city: 'Bologna', source: 'fiera', seats: 80, expected_mrr_cents: 9900,
                tags: ['Bologna', 'fiera 2026', 'bologna'],
                contact: { full_name: 'Marco Rossi', role: 'titolare', phone: '333 1234567' },
            });
            expect(res.status).toBe(201);
            accountId = res.body.id;
            expect(res.body.stage).toBe('lead');
            expect(res.body.tags).toEqual(['bologna', 'fiera 2026']);
            expect(res.body.contacts).toHaveLength(1);
            expect(res.body.contacts[0].is_primary).toBe(true);
            expect(res.body.primary_contact.full_name).toBe('Marco Rossi');
            expect(res.body.mrr_cents).toBe(0);
            firstContactId = res.body.contacts[0].id;
        });

        it('il cambio di fase finisce in cronologia', async () => {
            const res = await api().patch(`/admin/crm/accounts/${accountId}`).set(admin()).send({ stage: 'contattato' });
            expect(res.status).toBe(200);
            expect(res.body.stage).toBe('contattato');
            expect(res.body.timeline.some((x: any) => x.kind === 'sistema' && x.body === 'Fase: lead → contattato')).toBe(true);
            // Un PATCH senza cambio di fase non scrive una riga di sistema.
            const same = await api().patch(`/admin/crm/accounts/${accountId}`).set(admin()).send({ stage: 'contattato', city: 'Bologna' });
            expect(same.body.timeline.filter((x: any) => x.kind === 'sistema')).toHaveLength(1);
        });

        it('registra e cancella le attività scritte a mano, non quelle di sistema', async () => {
            expect((await api().post(`/admin/crm/accounts/${accountId}/activities`).set(admin()).send({ kind: 'sistema', body: 'x' })).status).toBe(400);
            expect((await api().post(`/admin/crm/accounts/${accountId}/activities`).set(admin()).send({ kind: 'nota', body: '  ' })).status).toBe(400);
            const res = await api().post(`/admin/crm/accounts/${accountId}/activities`).set(admin()).send({
                kind: 'chiamata', body: 'Interessato a Sofia, richiamare dopo le 15', contact_id: firstContactId,
            });
            expect(res.status).toBe(201);
            const call = res.body.timeline.find((x: any) => x.kind === 'chiamata');
            expect(call.contact_name).toBe('Marco Rossi');
            expect(call.author_name).toBe('Admin CRM');
            expect(res.body.last_activity_at).toBeTruthy();

            const system = res.body.timeline.find((x: any) => x.kind === 'sistema');
            expect(system.activity_id).toBeNull();
            const sysRow = await db.query(`SELECT id FROM crm_activities WHERE account_id = $1 AND kind = 'sistema' LIMIT 1`, [accountId]);
            expect((await api().delete(`/admin/crm/activities/${sysRow.rows[0].id}`).set(admin())).status).toBe(404);

            const del = await api().delete(`/admin/crm/activities/${call.activity_id}`).set(admin());
            expect(del.status).toBe(200);
            expect(del.body.timeline.some((x: any) => x.kind === 'chiamata')).toBe(false);
        });

        it('un solo referente principale per azienda', async () => {
            const added = await api().post(`/admin/crm/accounts/${accountId}/contacts`).set(admin()).send({ full_name: 'Giulia Bianchi', role: 'socia', is_primary: true });
            expect(added.status).toBe(201);
            const primaries = added.body.contacts.filter((c: any) => c.is_primary);
            expect(primaries).toHaveLength(1);
            expect(primaries[0].full_name).toBe('Giulia Bianchi');
            const giulia = primaries[0].id;
            // Tolto il principale, lo diventa chi resta.
            const after = await api().delete(`/admin/crm/contacts/${giulia}`).set(admin());
            expect(after.status).toBe(200);
            expect(after.body.contacts).toHaveLength(1);
            expect(after.body.contacts[0].is_primary).toBe(true);
            expect((await api().patch(`/admin/crm/contacts/${firstContactId}`).set(admin()).send({ full_name: '' })).status).toBe(400);
        });

        it('promemoria: in ritardo nella panoramica, fatto in cronologia', async () => {
            const bad = await api().post('/admin/crm/tasks').set(admin()).send({ title: 'x', due_date: 'domani' });
            expect(bad.status).toBe(400);
            const late = await api().post('/admin/crm/tasks').set(admin()).send({
                title: 'Richiamare Marco', due_date: romeDay(-2), account_id: accountId, priority: 'alta',
            });
            expect(late.status).toBe(201);
            expect(late.body.account_name).toBe('Osteria del Ponte');
            const loose = await api().post('/admin/crm/tasks').set(admin()).send({ title: 'Preparare listino', due_date: romeDay(5) });
            expect(loose.status).toBe(201);
            expect(loose.body.account_id).toBeNull();

            const list = await api().get(`/admin/crm/accounts`).set(admin());
            const row = list.body.accounts.find((a: any) => a.id === accountId);
            expect(row.open_tasks).toBe(1);
            expect(row.overdue_tasks).toBe(1);
            expect(row.next_task_due).toBe(romeDay(-2));

            const overview = await api().get('/admin/crm/overview').set(admin());
            expect(overview.status).toBe(200);
            expect(overview.body.tasks_due.map((t: any) => t.id)).toContain(late.body.id);
            expect(overview.body.tasks_due.map((t: any) => t.id)).not.toContain(loose.body.id);

            const done = await api().patch(`/admin/crm/tasks/${late.body.id}`).set(admin()).send({ done: true });
            expect(done.status).toBe(200);
            expect(done.body.done).toBe(true);
            const open = await api().get('/admin/crm/tasks').set(admin());
            expect(open.body.tasks.map((t: any) => t.id)).not.toContain(late.body.id);
            const detail = await api().get(`/admin/crm/accounts/${accountId}`).set(admin());
            expect(detail.body.timeline.some((x: any) => x.body === 'Promemoria fatto: Richiamare Marco')).toBe(true);

            expect((await api().delete(`/admin/crm/tasks/${loose.body.id}`).set(admin())).status).toBe(204);
        });

        it('opportunità: la vinta chiude e pesa nel mese', async () => {
            const created = await api().post(`/admin/crm/accounts/${accountId}/deals`).set(admin()).send({
                title: 'Sympotia + Sofia', mrr_cents: 14900, setup_cents: 30000, stage: 'proposta',
            });
            expect(created.status).toBe(201);
            expect(created.body.effective_probability).toBe(50);
            expect(created.body.closed_at).toBeNull();

            const before = await api().get('/admin/crm/overview').set(admin());
            expect(before.body.pipeline.open_deals).toBeGreaterThanOrEqual(1);
            expect(before.body.pipeline.weighted_mrr_cents).toBeGreaterThanOrEqual(7450);

            expect((await api().patch(`/admin/crm/deals/${created.body.id}`).set(admin()).send({ probability: 150 })).status).toBe(400);
            const won = await api().patch(`/admin/crm/deals/${created.body.id}`).set(admin()).send({ stage: 'vinta' });
            expect(won.status).toBe(200);
            expect(won.body.closed_at).toBeTruthy();
            const detail = await api().get(`/admin/crm/accounts/${accountId}`).set(admin());
            expect(detail.body.timeline.some((x: any) => x.body.startsWith('Opportunità vinta: Sympotia + Sofia'))).toBe(true);

            const after = await api().get('/admin/crm/overview').set(admin());
            expect(after.body.pipeline.won_month).toBeGreaterThanOrEqual(1);
            const deals = await api().get('/admin/crm/deals').set(admin());
            expect(deals.body.deals.find((d: any) => d.id === created.body.id).stage).toBe('vinta');
        });

        it('avviamento: i passi a mano si segnano e si tolgono', async () => {
            const bad = await api().patch(`/admin/crm/accounts/${accountId}`).set(admin()).send({ onboarding: { inventato: true } });
            expect(bad.status).toBe(400);
            const on = await api().patch(`/admin/crm/accounts/${accountId}`).set(admin()).send({ onboarding: { formazione: true } });
            expect(on.status).toBe(200);
            const step = on.body.onboarding_steps.find((s: any) => s.key === 'formazione');
            expect(step.done).toBe(true);
            expect(step.auto).toBe(false);
            expect(step.done_at).toBe(romeDay());
            const off = await api().patch(`/admin/crm/accounts/${accountId}`).set(admin()).send({ onboarding: { formazione: false } });
            expect(off.body.onboarding_steps.find((s: any) => s.key === 'formazione').done).toBe(false);
        });

        it('creare il ristorante dalla scheda lo lega e porta il lead in prova', async () => {
            const created = await api().post('/admin/tenants').set(admin()).send({
                slug: SLUG, name: 'Osteria del Ponte', owner_email: 'owner.crm@example.com', owner_full_name: 'Marco Rossi',
                crm_account_id: accountId,
            });
            expect(created.status).toBe(201);
            expect(created.body.crm_link).toBe('linked');
            createdTenantId = created.body.tenant.id;

            const detail = await api().get(`/admin/crm/accounts/${accountId}`).set(admin());
            expect(detail.body.customer_tenant_id).toBe(createdTenantId);
            expect(detail.body.stage).toBe('prova');
            expect(detail.body.tenant.slug).toBe(SLUG);
            expect(detail.body.timeline.some((x: any) => x.body.startsWith('Ristorante collegato su Sympotia'))).toBe(true);
            expect(detail.body.timeline.some((x: any) => x.body === 'Ristorante creato su Sympotia')).toBe(true);
            const account = detail.body.onboarding_steps.find((s: any) => s.key === 'account');
            expect(account.done).toBe(true);
            expect(account.auto).toBe(true);

            // Il giro di allineamento non gli crea una seconda scheda.
            const list = await api().get('/admin/crm/accounts').set(admin());
            expect(list.body.accounts.filter((a: any) => a.customer_tenant_id === createdTenantId)).toHaveLength(1);

            // Una scheda legata a un ristorante non si cancella.
            expect((await api().delete(`/admin/crm/accounts/${accountId}`).set(admin())).status).toBe(409);
        });
    });

    it('collega a mano un ristorante, togliendo la sua scheda automatica vuota', async () => {
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: `${SLUG}-due`, name: 'Pizzeria Due', owner_email: 'owner.crm.due@example.com',
        });
        expect(created.status).toBe(201);
        const tenantId = created.body.tenant.id;
        try {
            // La lettura dà al ristorante la sua scheda automatica.
            const list = await api().get('/admin/crm/accounts').set(admin());
            const auto = list.body.accounts.find((a: any) => a.customer_tenant_id === tenantId);
            expect(auto).toBeTruthy();

            const lead = await api().post('/admin/crm/accounts').set(admin()).send({ name: 'Pizzeria Due (lead)', stage: 'demo' });
            const linked = await api().post(`/admin/crm/accounts/${lead.body.id}/link`).set(admin()).send({ tenant_id: tenantId });
            expect(linked.status).toBe(200);
            expect(linked.body.customer_tenant_id).toBe(tenantId);
            expect(linked.body.stage).toBe('prova');
            const gone = await db.query(`SELECT 1 FROM crm_accounts WHERE id = $1`, [auto.id]);
            expect(gone.rows).toHaveLength(0);

            // Già legata: un altro ristorante no.
            expect((await api().post(`/admin/crm/accounts/${lead.body.id}/link`).set(admin()).send({ tenant_id: 1 })).status).toBe(409);
        } finally {
            for (const table of ['activity_logs', 'user_sessions', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => {});
            }
            await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
        }
    });

    it('importa da CSV saltando i doppioni e le righe senza nome', async () => {
        const res = await api().post('/admin/crm/accounts/import').set(admin()).send({
            rows: [
                { name: 'Trattoria Uno', city: 'Firenze', contact_name: 'Anna', contact_phone: '055 111', tags: 'firenze; fiera' },
                { name: 'trattoria uno', city: 'firenze' },
                { city: 'Senza nome' },
                { name: 'Bar Due', seats: '30', expected_mrr_cents: '5900', stage: 'demo' },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(2);
        expect(res.body.skipped).toBe(1);
        expect(res.body.errors).toEqual([{ row: 3, message: 'Il nome è obbligatorio' }]);
        const again = await api().post('/admin/crm/accounts/import').set(admin()).send({ rows: [{ name: 'Bar Due' }] });
        expect(again.body).toMatchObject({ created: 0, skipped: 1 });

        const list = await api().get('/admin/crm/accounts').set(admin());
        const uno = list.body.accounts.find((a: any) => a.name === 'Trattoria Uno');
        expect(uno.tags).toEqual(['firenze', 'fiera']);
        expect(uno.primary_contact.full_name).toBe('Anna');
        const bar = list.body.accounts.find((a: any) => a.name === 'Bar Due');
        expect(bar.stage).toBe('demo');
        expect(bar.seats).toBe(30);

        expect((await api().post('/admin/crm/accounts/import').set(admin()).send({ rows: [] })).status).toBe(400);
        // Senza ristorante la scheda si cancella.
        expect((await api().delete(`/admin/crm/accounts/${bar.id}`).set(admin())).status).toBe(204);
    });

    it('demo e locali interni restano fuori dai numeri', async () => {
        const before = await api().get('/admin/crm/overview').set(admin());
        const customer = await api().post('/admin/crm/accounts').set(admin()).send({ name: 'Cliente a mano', stage: 'cliente', expected_mrr_cents: 4900 });
        expect(customer.body.mrr_source).toBe('accordo');
        expect(customer.body.mrr_cents).toBe(4900);
        await api().post('/admin/crm/accounts').set(admin()).send({ name: 'Demo interna', stage: 'cliente', expected_mrr_cents: 100000, internal: true });
        const after = await api().get('/admin/crm/overview').set(admin());
        expect(after.body.customers).toBe(before.body.customers + 1);
        expect(after.body.mrr_cents).toBe(before.body.mrr_cents + 4900);
    });
});
