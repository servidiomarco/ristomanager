import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// HACCP Fase 3 (docs/haccp-piano.md): l'archivio che l'ispettore chiede per
// primo — documenti con il loro file, formazione del personale con scadenza,
// interventi esterni (che aprono una non conformità se hanno rilievi), lo
// scadenzario, il libro allergeni e il fascicolo per l'ispezione.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>').toString('base64');

const isoPlus = (days: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

describe('HACCP · archivio', () => {
    let owner = '';
    let kitchen = '';
    let db: Client;
    let documentId = 0;
    let staffId = '';

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
        const email = 'cucina.archivio@example.com';
        await api().post('/auth/users').set(bearer(owner)).send({ email, password: 'password-archivio', full_name: 'Cuoca Archivio', role: 'KITCHEN' });
        kitchen = (await api().post('/auth/login').send({ email, password: 'password-archivio' })).body.accessToken;
        const staff = await api().post('/staff').set(bearer(owner)).send({
            name: 'Lucia', surname: 'Archivio', category: 'CUCINA', staffType: 'FISSO',
        });
        expect(staff.status).toBe(201);
        staffId = staff.body.id;
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM haccp_trainings WHERE tenant_id = 1`);
            await db.query(`UPDATE haccp_documents SET archived = true WHERE tenant_id = 1`);
            await db.query(`DELETE FROM users WHERE email = 'cucina.archivio@example.com'`);
        } finally {
            await db.end();
        }
    });

    describe('documenti', () => {
        it('si carica il manuale con il suo file e si riscarica uguale', async () => {
            const res = await api().post('/haccp/documents').set(bearer(owner)).send({
                category: 'MANUALE', title: 'Manuale di autocontrollo 2026', filename: 'manuale.pdf',
                contentType: 'application/pdf', data: PDF_B64, validUntil: isoPlus(20),
            });
            expect(res.status).toBe(201);
            expect(res.body.hasFile).toBe(true);
            expect(res.body.bytes).toBeUndefined();
            documentId = res.body.id;
            const file = await api().get(`/haccp/documents/${documentId}/file`).set(bearer(kitchen)).buffer(true);
            expect(file.status).toBe(200);
            expect(file.headers['content-type']).toContain('application/pdf');
            expect(Buffer.from(file.body).toString('base64')).toBe(PDF_B64);
        });

        it('un documento può essere solo un riferimento, senza file', async () => {
            const res = await api().post('/haccp/documents').set(bearer(owner)).send({
                category: 'CONTRATTO', title: 'Contratto disinfestazione (originale in ufficio)',
            });
            expect(res.status).toBe(201);
            expect(res.body.hasFile).toBe(false);
        });

        it('tipi non ammessi e la cucina che carica vengono rifiutati', async () => {
            expect((await api().post('/haccp/documents').set(bearer(owner)).send({
                category: 'MANUALE', title: 'x', filename: 'x.exe', contentType: 'application/x-msdownload', data: PDF_B64,
            })).status).toBe(415);
            expect((await api().post('/haccp/documents').set(bearer(kitchen)).send({
                category: 'MANUALE', title: 'x',
            })).status).toBe(403);
        });
    });

    describe('formazione', () => {
        it('l\'attestato prende il nome dal Personale e va nello scadenzario', async () => {
            const res = await api().post('/haccp/trainings').set(bearer(owner)).send({
                staffMemberId: staffId, course: 'ALIMENTARISTA', provider: 'Ente regionale', hours: 8,
                completedOn: '2021-11-01', expiresOn: isoPlus(-3), documentId,
            });
            expect(res.status).toBe(201);
            expect(res.body.personName).toBe('Lucia Archivio');
            const archive = await api().get('/haccp/archive').set(bearer(owner));
            expect(archive.status).toBe(200);
            const d = archive.body.deadlines.find((x: any) => x.kind === 'training' && x.id === String(res.body.id));
            expect(d.status).toBe('expired');
            expect(archive.body.staff.some((s: any) => s.id === staffId)).toBe(true);
        });

        it('un corso rinnovato supera il vecchio nello scadenzario', async () => {
            const renewed = await api().post('/haccp/trainings').set(bearer(owner)).send({
                staffMemberId: staffId, course: 'ALIMENTARISTA', completedOn: isoPlus(-1), expiresOn: isoPlus(1800),
            });
            expect(renewed.status).toBe(201);
            const archive = await api().get('/haccp/archive').set(bearer(owner));
            expect(archive.body.deadlines.some((x: any) => x.kind === 'training' && x.title.includes('Lucia Archivio'))).toBe(false);
        });

        it('la scadenza prima del corso e la cucina che scrive sono rifiutate', async () => {
            expect((await api().post('/haccp/trainings').set(bearer(owner)).send({
                personName: 'Mario', course: 'ALLERGENI', completedOn: '2026-05-01', expiresOn: '2026-04-01',
            })).status).toBe(400);
            expect((await api().post('/haccp/trainings').set(bearer(kitchen)).send({
                personName: 'Mario', course: 'ALLERGENI', completedOn: '2026-05-01',
            })).status).toBe(403);
        });
    });

    describe('interventi esterni', () => {
        it('una disinfestazione con rilievi apre una non conformità; la prossima va nello scadenzario', async () => {
            const res = await api().post('/haccp/interventions').set(bearer(kitchen)).send({
                date: '2026-09-29', type: 'DISINFESTAZIONE', provider: 'Ditta Pulita', outcomeOk: false,
                findings: 'Tracce di roditori in dispensa', nextDue: isoPlus(7), documentId,
            });
            expect(res.status).toBe(201);
            const ncs = await api().get('/haccp/nonconformities').set(bearer(owner)).query({ status: 'all' });
            const nc = ncs.body.nonconformities.find((n: any) => n.sourceId === res.body.id);
            expect(nc.source).toBe('INTERVENTION');
            expect(nc.title).toBe('Disinfestazione · Ditta Pulita: rilievi');
            expect(nc.detail).toBe('Tracce di roditori in dispensa');
            const archive = await api().get('/haccp/archive').set(bearer(owner));
            const d = archive.body.deadlines.find((x: any) => x.kind === 'intervention');
            expect(d.status).toBe('soon');
            expect(d.due).toBe(isoPlus(7));
        });

        it('il ritiro dell\'olio esausto tiene quantità e formulario', async () => {
            const res = await api().post('/haccp/interventions').set(bearer(kitchen)).send({
                date: '2026-09-30', type: 'RITIRO_OLIO', provider: 'Consorzio', quantity: '40 kg', reference: 'FIR 12345',
            });
            expect(res.status).toBe(201);
            expect(res.body.outcomeOk).toBe(true);
            expect(res.body.reference).toBe('FIR 12345');
        });
    });

    describe('scadenzario e promemoria', () => {
        it('il registro del giorno porta lo scadenzario', async () => {
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
            const day = await api().get('/haccp/day').set(bearer(owner)).query({ date: today });
            expect(day.status).toBe(200);
            expect(day.body.deadlines.some((d: any) => d.kind === 'document')).toBe(true);
        });

        it('il promemoria delle scadenze è seminato come gli altri', async () => {
            const res = await api().get('/reminders').set(bearer(owner));
            const r = res.body.reminders.find((x: any) => x.system_key === 'HACCP_EXPIRIES');
            expect(r).toBeTruthy();
            expect(r.schedule_time).toBe('09:00');
        });
    });

    describe('libro allergeni', () => {
        it('elenca i piatti attivi con i loro allergeni', async () => {
            const dish = await api().post('/dishes').set(bearer(owner)).send({
                name: 'Tagliolini archivio', price: 14, category: 'Primi', allergens: ['Glutine', 'Uova'],
            });
            expect(dish.status).toBe(201);
            const res = await api().get('/haccp/allergens').set(bearer(kitchen));
            expect(res.status).toBe(200);
            const row = res.body.dishes.find((d: any) => d.id === dish.body.id);
            expect(row.allergens).toEqual(['Glutine', 'Uova']);
        });
    });

    describe('fascicolo per l\'ispezione', () => {
        it('il report con dossier porta documenti, formazione e interventi', async () => {
            const res = await api().get('/haccp/report').set(bearer(owner)).query({ from: '2026-09-01', to: '2026-09-30', dossier: '1' });
            expect(res.status).toBe(200);
            expect(res.body.documents.some((d: any) => d.id === documentId)).toBe(true);
            expect(res.body.documents.every((d: any) => d.bytes === undefined)).toBe(true);
            expect(res.body.trainings.some((t: any) => t.personName === 'Lucia Archivio')).toBe(true);
            expect(res.body.interventions.some((i: any) => i.type === 'DISINFESTAZIONE')).toBe(true);
            const plain = await api().get('/haccp/report').set(bearer(owner)).query({ from: '2026-09-01', to: '2026-09-30' });
            expect(plain.body.documents).toBeUndefined();
        });
    });
});
