import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Il registro HACCP dopo la Fase 1 (docs/haccp-piano.md): punti di controllo
// del ristorante, correzioni che lasciano l'originale e chiedono il motivo,
// annullamenti al posto delle cancellazioni, non conformità che si aprono da
// sole e si chiudono con l'azione correttiva, report per periodo.

const KITCHEN_EMAIL = 'cucina.registro@example.com';
const PASSWORD = 'password-haccp-registro';
const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('HACCP · registro', () => {
    let owner = '';
    let kitchen = '';
    let db: Client;
    let hotId = 0;
    let fridgeId = 0;
    let weeklyId = 0;

    beforeAll(async () => {
        owner = await ownerToken();
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: KITCHEN_EMAIL, password: PASSWORD, full_name: 'Cuoca Registro', role: 'KITCHEN',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: KITCHEN_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        kitchen = login.body.accessToken;
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`UPDATE haccp_points SET active = false WHERE tenant_id = 1 AND label LIKE '% registro'`);
            await db.query(`DELETE FROM users WHERE email = $1`, [KITCHEN_EMAIL]);
        } finally {
            await db.end();
        }
    });

    describe('punti di controllo', () => {
        it('il Frantoio parte dai suoi punti di sempre', async () => {
            const res = await api().get('/haccp/points').set(bearer(owner));
            expect(res.status).toBe(200);
            const labels = res.body.points.map((p: any) => `${p.register}:${p.label}`);
            expect(labels).toContain('TEMPERATURE:Cella 1');
            expect(labels).toContain('OIL:Friggitrice 5');
            expect(labels).toContain('CLEANING:Affettatrice');
            expect(res.body.canManage).toBe(true);
        });

        it('la cucina li legge ma non li configura', async () => {
            expect((await api().get('/haccp/points').set(bearer(kitchen))).status).toBe(200);
            const res = await api().post('/haccp/points').set(bearer(kitchen)).send({
                register: 'TEMPERATURE', label: 'Abusivo registro', maxTemp: 4,
            });
            expect(res.status).toBe(403);
        });

        it('una postazione di temperatura ha almeno un limite e un nome unico', async () => {
            const noLimit = await api().post('/haccp/points').set(bearer(owner)).send({ register: 'TEMPERATURE', label: 'Senza limite registro' });
            expect(noLimit.status).toBe(400);

            const hot = await api().post('/haccp/points').set(bearer(owner)).send({
                register: 'TEMPERATURE', label: 'Banco caldo registro', minTemp: 65, checksPerDay: 2,
            });
            expect(hot.status).toBe(201);
            expect(hot.body.minTemp).toBe(65);
            expect(hot.body.maxTemp).toBeNull();
            expect(hot.body.checksPerDay).toBe(2);
            hotId = hot.body.id;

            const dup = await api().post('/haccp/points').set(bearer(owner)).send({
                register: 'TEMPERATURE', label: 'banco caldo REGISTRO', minTemp: 60,
            });
            expect(dup.status).toBe(409);

            const fridge = await api().post('/haccp/points').set(bearer(owner)).send({
                register: 'TEMPERATURE', label: 'Frigo registro', maxTemp: 4,
            });
            expect(fridge.status).toBe(201);
            fridgeId = fridge.body.id;
        });

        it('cambiare un limite resta nello storico con il motivo', async () => {
            const res = await api().put(`/haccp/points/${fridgeId}`).set(bearer(owner)).send({
                maxTemp: 3, reason: 'Manuale aggiornato',
            });
            expect(res.status).toBe(200);
            expect(res.body.maxTemp).toBe(3);
            const hist = await api().get('/haccp/changes').set(bearer(owner)).query({ entity: 'point', entityId: String(fridgeId) });
            const update = hist.body.changes.find((c: any) => c.action === 'UPDATE');
            expect(update.reason).toBe('Manuale aggiornato');
            expect(update.before.maxTemp).toBe(4);
            expect(update.after.maxTemp).toBe(3);
        });
    });

    describe('temperature', () => {
        let readingId = '';

        it('due rilevazioni al giorno sulla stessa postazione, la terza non è prevista', async () => {
            const first = await api().post('/haccp/temperatures').set(bearer(owner)).send({
                date: '2026-09-15', pointId: hotId, slot: 1, temperature: 58,
            });
            expect(first.status).toBe(201);
            readingId = first.body.id;
            const second = await api().post('/haccp/temperatures').set(bearer(owner)).send({
                date: '2026-09-15', pointId: hotId, slot: 2, temperature: 70,
            });
            expect(second.status).toBe(201);
            expect(second.body.id).not.toBe(readingId);
            const third = await api().post('/haccp/temperatures').set(bearer(owner)).send({
                date: '2026-09-15', pointId: hotId, slot: 3, temperature: 70,
            });
            expect(third.status).toBe(400);
        });

        it('sotto il minimo apre una non conformità', async () => {
            const day = await api().get('/haccp/day').set(bearer(owner)).query({ date: '2026-09-15' });
            expect(day.status).toBe(200);
            const nc = day.body.nonconformities.find((n: any) => n.sourceId === readingId);
            expect(nc).toBeTruthy();
            expect(nc.status).toBe('OPEN');
            expect(nc.source).toBe('TEMPERATURE');
            expect(nc.title).toContain('minimo 65 °C');
        });

        it('la correzione sulla riga di un altro chiede il motivo e conserva l\'originale', async () => {
            const blind = await api().post('/haccp/temperatures').set(bearer(kitchen)).send({
                date: '2026-09-15', pointId: hotId, slot: 1, temperature: 68,
            });
            expect(blind.status).toBe(409);
            expect(blind.body.code).toBe('reason_required');

            const ok = await api().post('/haccp/temperatures').set(bearer(kitchen)).send({
                date: '2026-09-15', pointId: hotId, slot: 1, temperature: 68, reason: 'Errore di battitura',
            });
            expect(ok.status).toBe(201);
            expect(ok.body.id).toBe(readingId);
            expect(ok.body.updatedByUserName).toBe('Cuoca Registro');

            const hist = await api().get('/haccp/changes').set(bearer(owner)).query({ entity: 'temperature', entityId: readingId });
            const actions = hist.body.changes.map((c: any) => c.action);
            expect(actions).toEqual(['CREATE', 'UPDATE']);
            expect(hist.body.changes[1].before.temperature).toBe(58);
            expect(hist.body.changes[1].after.temperature).toBe(68);
            expect(hist.body.changes[1].reason).toBe('Errore di battitura');
        });

        it('tornata in soglia, la non conformità senza azione si annulla da sola', async () => {
            const all = await api().get('/haccp/nonconformities').set(bearer(owner)).query({ status: 'all' });
            const nc = all.body.nonconformities.find((n: any) => n.sourceId === readingId);
            expect(nc.status).toBe('VOID');
            expect(nc.voidReason).toContain('Errore di battitura');
        });

        it('la non conformità si chiude solo con l\'azione correttiva', async () => {
            const out = await api().post('/haccp/temperatures').set(bearer(owner)).send({
                date: '2026-09-16', pointId: fridgeId, temperature: 8,
            });
            expect(out.status).toBe(201);
            const open = await api().get('/haccp/nonconformities').set(bearer(owner));
            const nc = open.body.nonconformities.find((n: any) => n.sourceId === out.body.id);
            expect(nc.status).toBe('OPEN');

            const empty = await api().post(`/haccp/nonconformities/${nc.id}/close`).set(bearer(kitchen)).send({ correctiveAction: '  ' });
            expect(empty.status).toBe(400);
            const closed = await api().post(`/haccp/nonconformities/${nc.id}/close`).set(bearer(kitchen)).send({
                correctiveAction: 'Prodotti spostati in cella 2',
            });
            expect(closed.status).toBe(200);
            expect(closed.body.status).toBe('CLOSED');
            expect(closed.body.closedByUserName).toBe('Cuoca Registro');

            // Annullata la lettura, l'azione fatta resta: la chiusa non si tocca.
            const voided = await api().post(`/haccp/temperatures/${out.body.id}/void`).set(bearer(owner)).send({});
            expect(voided.status).toBe(200);
            expect(voided.body.voidedAt).toBeTruthy();
            const after = await api().get('/haccp/nonconformities').set(bearer(owner)).query({ status: 'all' });
            expect(after.body.nonconformities.find((n: any) => n.id === nc.id).status).toBe('CLOSED');
        });

        it('un giorno che deve ancora venire non si registra', async () => {
            const res = await api().post('/haccp/temperatures').set(bearer(owner)).send({
                date: '2099-01-01', pointId: fridgeId, temperature: 2,
            });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('future_date');
        });

        it('un punto archiviato non si compila più ma resta nello storico', async () => {
            const archived = await api().put(`/haccp/points/${fridgeId}`).set(bearer(owner)).send({ active: false });
            expect(archived.status).toBe(200);
            const res = await api().post('/haccp/temperatures').set(bearer(owner)).send({
                date: '2026-09-17', pointId: fridgeId, temperature: 2,
            });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('archived_point');
            const active = await api().get('/haccp/points').set(bearer(owner));
            expect(active.body.points.some((p: any) => p.id === fridgeId)).toBe(false);
            const all = await api().get('/haccp/points').set(bearer(owner)).query({ all: '1' });
            expect(all.body.points.some((p: any) => p.id === fridgeId)).toBe(true);
        });
    });

    describe('ricevimento e annullamenti', () => {
        it('la merce respinta apre una non conformità; annullare la riga di un altro chiede il motivo', async () => {
            const rec = await api().post('/haccp/receipts').set(bearer(owner)).send({
                date: '2026-09-18', product: 'Filetto registro', lotNumber: 'L123', temperature: 9, accepted: false, note: 'Catena del freddo interrotta',
            });
            expect(rec.status).toBe(201);
            let open = await api().get('/haccp/nonconformities').set(bearer(owner));
            let nc = open.body.nonconformities.find((n: any) => n.sourceId === rec.body.id);
            expect(nc.source).toBe('RECEIPT');
            expect(nc.title).toContain('Filetto registro');

            const blind = await api().post(`/haccp/receipts/${rec.body.id}/void`).set(bearer(kitchen)).send({});
            expect(blind.status).toBe(409);
            const ok = await api().post(`/haccp/receipts/${rec.body.id}/void`).set(bearer(kitchen)).send({ reason: 'Registrata due volte' });
            expect(ok.status).toBe(200);

            const day = await api().get('/haccp/day').set(bearer(owner)).query({ date: '2026-09-18' });
            expect(day.body.receipts.some((r: any) => r.id === rec.body.id)).toBe(false);
            const all = await api().get('/haccp/nonconformities').set(bearer(owner)).query({ status: 'all' });
            nc = all.body.nonconformities.find((n: any) => n.sourceId === rec.body.id);
            expect(nc.status).toBe('VOID');

            const report = await api().get('/haccp/report').set(bearer(owner)).query({ from: '2026-09-18', to: '2026-09-18' });
            expect(report.status).toBe(200);
            const voided = report.body.receipts.find((r: any) => r.id === rec.body.id);
            expect(voided.voidReason).toBe('Registrata due volte');
            expect(report.body.changes.some((c: any) => c.entity === 'receipt' && c.action === 'VOID')).toBe(true);
            open = await api().get('/haccp/nonconformities').set(bearer(owner));
            expect(open.body.nonconformities.some((n: any) => n.sourceId === rec.body.id)).toBe(false);
        });

        it('la vecchia DELETE è un annullamento: la riga resta', async () => {
            const rec = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-18', product: 'Salsa registro',
            });
            expect(rec.status).toBe(201);
            const del = await api().delete(`/haccp/production/${rec.body.id}`).set(bearer(owner));
            expect(del.status).toBe(204);
            const row = await db.query(`SELECT voided_at FROM haccp_production_logs WHERE id = $1`, [rec.body.id]);
            expect(row.rows[0].voided_at).not.toBeNull();
        });
    });

    describe('pulizie con frequenza', () => {
        it('una settimanale fatta lunedì copre la settimana', async () => {
            const point = await api().post('/haccp/points').set(bearer(owner)).send({
                register: 'CLEANING', label: 'Cappe registro', frequency: 'WEEKLY',
            });
            expect(point.status).toBe(201);
            weeklyId = point.body.id;
            const done = await api().post('/haccp/cleaning').set(bearer(owner)).send({ date: '2026-09-07', pointId: weeklyId, done: true });
            expect(done.status).toBe(201);
            const thursday = await api().get('/haccp/day').set(bearer(owner)).query({ date: '2026-09-10' });
            expect(thursday.body.cleaning.some((c: any) => c.pointId === weeklyId && c.date === '2026-09-07')).toBe(true);
        });

        it('togliere la spunta annulla la registrazione', async () => {
            const undone = await api().post('/haccp/cleaning').set(bearer(owner)).send({ date: '2026-09-07', pointId: weeklyId, done: false });
            expect(undone.status).toBe(201);
            const day = await api().get('/haccp/day').set(bearer(owner)).query({ date: '2026-09-07' });
            expect(day.body.cleaning.some((c: any) => c.pointId === weeklyId)).toBe(false);
        });
    });

    describe('non conformità segnalate a mano', () => {
        it('con l\'azione già fatta nasce chiusa; annullarla è da responsabile e motivato', async () => {
            const res = await api().post('/haccp/nonconformities').set(bearer(kitchen)).send({
                date: '2026-09-19', title: 'Prodotto scaduto in cella registro', correctiveAction: 'Eliminato',
            });
            expect(res.status).toBe(201);
            expect(res.body.status).toBe('CLOSED');
            expect(res.body.source).toBe('MANUAL');

            expect((await api().post(`/haccp/nonconformities/${res.body.id}/void`).set(bearer(kitchen)).send({ reason: 'x' })).status).toBe(403);
            expect((await api().post(`/haccp/nonconformities/${res.body.id}/void`).set(bearer(owner)).send({})).status).toBe(409);
            const voided = await api().post(`/haccp/nonconformities/${res.body.id}/void`).set(bearer(owner)).send({ reason: 'Segnalata per errore' });
            expect(voided.status).toBe(200);
            expect(voided.body.status).toBe('VOID');
        });
    });

    describe('report e storico', () => {
        it('il report rifiuta un periodo rovesciato o più lungo di un anno', async () => {
            expect((await api().get('/haccp/report').set(bearer(owner)).query({ from: '2026-09-10', to: '2026-09-01' })).status).toBe(400);
            expect((await api().get('/haccp/report').set(bearer(owner)).query({ from: '2024-01-01', to: '2026-09-01' })).status).toBe(400);
        });

        it('il report del periodo porta punti, letture annullate e correzioni', async () => {
            const res = await api().get('/haccp/report').set(bearer(owner)).query({ from: '2026-09-01', to: '2026-09-30' });
            expect(res.status).toBe(200);
            expect(res.body.points.some((p: any) => p.id === hotId)).toBe(true);
            expect(res.body.temperatures.some((r: any) => r.pointId === hotId && r.slot === 2)).toBe(true);
            expect(res.body.changes.some((c: any) => c.entity === 'temperature' && c.action === 'UPDATE' && c.reason === 'Errore di battitura')).toBe(true);
            expect(res.body.changes.every((c: any) => c.action !== 'CREATE')).toBe(true);
        });

        it('lo storico è in sola aggiunta', async () => {
            await expect(db.query(`UPDATE haccp_changes SET reason = 'riscritto' WHERE tenant_id = 1`)).rejects.toThrow(/sola aggiunta/);
        });
    });
});
