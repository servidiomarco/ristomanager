import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Chiusura fiscale della giornata (docs/chiusura-fiscale-plan.md): il
// registro per giornata di calendario, coi tre comportamenti per provider —
// registrazione manuale (ponte), riscontro (mock/openapi), Z via agente
// (rt-local, simulato coi giri claim/ack del print agent di test).
//
// Le date sono FISSE e nel passato: la fotografia di un giorno vuoto è
// tutta zeri e non dipende da cosa gli altri file di test hanno chiuso
// "oggi". In coda si ripristina provider 'none' e si puliscono le righe:
// orders-fiscale, più avanti nell'ordine alfabetico, pretende di trovare
// le impostazioni fiscali vergini.

const AGENT = { 'x-print-agent-token': 'test-print-agent-token' };
const D = {
    manuale: '2026-01-10',
    delta: '2026-01-11',
    zeta: '2026-01-12',
    zetaFallita: '2026-01-13',
    riscontro: '2026-01-14',
};
const CASSA_EMAIL = 'cassa.chiusura.fiscale@example.com';
const PASSWORD = 'password-chiusura-fiscale';

describe('chiusura fiscale della giornata', () => {
    let owner = '';
    let cassaToken = '';

    beforeAll(async () => {
        // La coda dell'agente serve i job a pagine di 10: eventuali PENDING
        // lasciati dai file precedenti (ormai morti — quei test sono finiti)
        // nasconderebbero la Z di questo file. Si bonifica prima di partire.
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(`UPDATE print_jobs SET status = 'PRINTED', printed_at = CURRENT_TIMESTAMP WHERE status = 'PENDING'`);
        } finally {
            await client.end();
        }

        owner = await ownerToken();
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: CASSA_EMAIL, password: PASSWORD, full_name: 'Cassiere Chiusura', role: 'CASSA',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: CASSA_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        cassaToken = login.body.accessToken;
    });

    afterAll(async () => {
        // Provider com'era: i file successivi partono da 'none'.
        await api().put('/settings/fiscal').set(bearer(owner)).send({ provider: 'none' });
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(`DELETE FROM print_jobs WHERE kind = 'RT_CHIUSURA'`);
            await client.query(`DELETE FROM fiscal_closures`);
            await client.query(`DELETE FROM users WHERE email = $1`, [CASSA_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('la fotografia di un giorno vuoto è a zero, senza chiusura', async () => {
        const res = await api().get(`/fiscal/closure?date=${D.manuale}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.date).toBe(D.manuale);
        expect(res.body.closure).toBeNull();
        expect(res.body.receipts).toEqual({ count: 0, total_cents: 0 });
        expect(res.body.pending_count).toBe(0);
        expect(res.body.bills_without_doc).toBe(0);
    });

    it('valida data mancante, malformata e futura', async () => {
        const missing = await api().post('/fiscal/closure').set(bearer(owner)).send({});
        expect(missing.status).toBe(400);
        const bad = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: '10/01/2026' });
        expect(bad.status).toBe(400);
        const future = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: '2099-01-01' });
        expect(future.status).toBe(400);
    });

    it('senza cash:close_session la chiusura è negata, la lettura no', async () => {
        const read = await api().get(`/fiscal/closure?date=${D.manuale}`).set(bearer(cassaToken));
        expect(read.status).toBe(200);
        const write = await api().post('/fiscal/closure').set(bearer(cassaToken)).send({ date: D.manuale });
        expect(write.status).toBe(403);
    });

    it('il ponte registra la chiusura del tagliando, una sola volta per giornata', async () => {
        const res = await api().post('/fiscal/closure').set(bearer(owner)).send({
            date: D.manuale, zrep_number: '0934', rt_total_cents: 0,
        });
        expect(res.status).toBe(201);
        expect(res.body.closure.status).toBe('CONFIRMED');
        expect(res.body.closure.provider).toBe('none');
        expect(res.body.closure.zrep_number).toBe('0934');
        expect(res.body.closure.crm_total_cents).toBe(0);
        expect(res.body.closure.confirmed_at).toBeTruthy();
        expect(res.body.closure.requested_by_name).toBeTruthy();

        const again = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: D.manuale });
        expect(again.status).toBe(409);

        const read = await api().get(`/fiscal/closure?date=${D.manuale}`).set(bearer(owner));
        expect(read.body.closure.status).toBe('CONFIRMED');
    });

    it('il delta col registratore pretende la nota', async () => {
        const senzaNota = await api().post('/fiscal/closure').set(bearer(owner)).send({
            date: D.delta, rt_total_cents: 500,
        });
        expect(senzaNota.status).toBe(400);

        const conNota = await api().post('/fiscal/closure').set(bearer(owner)).send({
            date: D.delta, zrep_number: '0935', rt_total_cents: 500, note: 'battuto fuori CRM',
        });
        expect(conNota.status).toBe(201);
        expect(conNota.body.closure.rt_total_cents).toBe(500);
        expect(conNota.body.closure.note).toBe('battuto fuori CRM');
    });

    it('su rt-local la chiusura accoda la Z e la conferma arriva dall\'ack dell\'agente', async () => {
        const set = await api().put('/settings/fiscal').set(bearer(owner)).send({ provider: 'rt-local' });
        expect(set.status).toBe(200);

        const res = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: D.zeta });
        expect(res.status).toBe(201);
        expect(res.body.closure.status).toBe('PENDING');
        expect(res.body.closure.provider).toBe('rt-local');
        const closureId = res.body.closure.id;

        const queue = await api().get('/print-agent/jobs').set(AGENT);
        expect(queue.status).toBe(200);
        const job = queue.body.jobs.find((j: any) => j.kind === 'RT_CHIUSURA' && j.payload?.closure_id === closureId);
        expect(job).toBeTruthy();

        const claim = await api().post(`/print-agent/jobs/${job.id}/claim`).set(AGENT);
        expect(claim.body.claimed).toBe(true);
        const ack = await api().post(`/print-agent/jobs/${job.id}/ack`).set(AGENT).send({
            ok: true, result: { zrep_number: '936' },
        });
        expect(ack.status).toBe(200);

        const read = await api().get(`/fiscal/closure?date=${D.zeta}`).set(bearer(owner));
        expect(read.body.closure.status).toBe('CONFIRMED');
        expect(read.body.closure.zrep_number).toBe('936');
        expect(read.body.closure.confirmed_at).toBeTruthy();
    });

    it('la Z rifiutata va in FAILED e non blocca il nuovo tentativo', async () => {
        const res = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: D.zetaFallita });
        expect(res.status).toBe(201);
        const closureId = res.body.closure.id;

        const queue = await api().get('/print-agent/jobs').set(AGENT);
        const job = queue.body.jobs.find((j: any) => j.kind === 'RT_CHIUSURA' && j.payload?.closure_id === closureId);
        expect(job).toBeTruthy();
        await api().post(`/print-agent/jobs/${job.id}/claim`).set(AGENT);
        const nack = await api().post(`/print-agent/jobs/${job.id}/ack`).set(AGENT).send({
            ok: false, error: 'RT: EPTR_REC_EMPTY',
        });
        expect(nack.status).toBe(200);

        const failed = await api().get(`/fiscal/closure?date=${D.zetaFallita}`).set(bearer(owner));
        expect(failed.body.closure.status).toBe('FAILED');
        expect(failed.body.closure.error).toContain('EPTR_REC_EMPTY');

        // La FAILED non conta come chiusura: il POST riparte da capo.
        const retry = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: D.zetaFallita });
        expect(retry.status).toBe(201);
        expect(retry.body.closure.status).toBe('PENDING');

        // Si chiude il giro anche del secondo job, per non lasciare code.
        const queue2 = await api().get('/print-agent/jobs').set(AGENT);
        const job2 = queue2.body.jobs.find((j: any) => j.kind === 'RT_CHIUSURA' && j.payload?.closure_id === retry.body.closure.id);
        expect(job2).toBeTruthy();
        await api().post(`/print-agent/jobs/${job2.id}/claim`).set(AGENT);
        await api().post(`/print-agent/jobs/${job2.id}/ack`).set(AGENT).send({ ok: true, result: { zrep_number: '937' } });
    });

    it('su provider a trasmissione per documento la chiusura firma il riscontro', async () => {
        const set = await api().put('/settings/fiscal').set(bearer(owner)).send({ provider: 'mock' });
        expect(set.status).toBe(200);

        const res = await api().post('/fiscal/closure').set(bearer(owner)).send({ date: D.riscontro });
        expect(res.status).toBe(201);
        expect(res.body.closure.status).toBe('CONFIRMED');
        expect(res.body.closure.provider).toBe('mock');
        expect(res.body.closure.zrep_number).toBeNull();
    });
});
