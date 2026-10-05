import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// HACCP Fase 2 (docs/haccp-piano.md): i processi con orari e temperature vere
// e l'esito calcolato sui limiti del locale, l'olio con i composti polari, il
// ricevimento con fornitore e scadenza, la rintracciabilità per lotto, la
// taratura dei termometri.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

const ncFor = async (token: string, sourceId: string) => {
    const all = await api().get('/haccp/nonconformities').set(bearer(token)).query({ status: 'all' });
    return all.body.nonconformities.filter((n: any) => n.sourceId === sourceId);
};

describe('HACCP · processi e rintracciabilità', () => {
    let owner = '';
    let db: Client;
    let blastId = 0;
    let thermoId = 0;
    let supplierId = '';

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
        const blast = await api().post('/haccp/points').set(bearer(owner)).send({ register: 'EQUIPMENT', label: 'Abbattitore processi' });
        expect(blast.status).toBe(201);
        blastId = blast.body.id;
        const thermo = await api().post('/haccp/points').set(bearer(owner)).send({ register: 'THERMOMETER', label: 'Sonda processi' });
        expect(thermo.status).toBe(201);
        expect(thermo.body.frequency).toBe('SEMIANNUAL');
        thermoId = thermo.body.id;
        const sup = await api().post('/suppliers').set(bearer(owner)).send({ name: 'Caseificio Processi', categories: ['CUCINA'] });
        expect(sup.status).toBe(201);
        supplierId = sup.body.id;
    });

    afterAll(async () => {
        try {
            await db.query(`UPDATE haccp_points SET active = false WHERE tenant_id = 1 AND label LIKE '% processi'`);
            await db.query(`DELETE FROM haccp_settings WHERE tenant_id = 1`);
        } finally {
            await db.end();
        }
    });

    describe('limiti del locale', () => {
        it('senza riga valgono i riferimenti', async () => {
            const res = await api().get('/haccp/settings').set(bearer(owner));
            expect(res.status).toBe(200);
            expect(res.body.limits.blastChill).toEqual({ targetTemp: 3, maxMinutes: 90 });
            expect(res.body.limits.anisakis).toEqual([{ temp: -20, hours: 24 }, { temp: -35, hours: 15 }]);
            expect(res.body.limits.receipt.PESCE).toBe(2);
        });

        it('si cambiano interi, e un valore non numerico torna al riferimento', async () => {
            const res = await api().put('/haccp/settings').set(bearer(owner)).send({
                limits: { cooking: { minCore: 72 }, hotHolding: { minTemp: 'caldo' } },
                reason: 'Manuale rivisto',
            });
            expect(res.status).toBe(200);
            expect(res.body.limits.cooking.minCore).toBe(72);
            expect(res.body.limits.hotHolding.minTemp).toBe(65);
            const hist = await api().get('/haccp/changes').set(bearer(owner)).query({ entity: 'settings', entityId: '1' });
            expect(hist.body.changes.at(-1).reason).toBe('Manuale rivisto');
        });
    });

    describe('processi', () => {
        it('un abbattimento si avvia e si chiude; fuori tempo apre una non conformità', async () => {
            const start = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'ABBATTIMENTO', product: 'Ragù processi', internalLot: 'R-0920',
                equipmentPointId: blastId, startedAt: '2026-09-20T10:00:00Z', startTemp: 72, sourceLots: 'CARNE-77',
            });
            expect(start.status).toBe(201);
            expect(start.body.compliant).toBeNull();
            expect(start.body.equipmentLabel).toBe('Abbattitore processi');

            // Il ciclo aperto ieri si vede nel registro di oggi.
            const nextDay = await api().get('/haccp/day').set(bearer(owner)).query({ date: '2026-09-21' });
            expect(nextDay.body.production.some((p: any) => p.id === start.body.id)).toBe(true);

            const close = await api().put(`/haccp/production/${start.body.id}`).set(bearer(owner)).send({
                endedAt: '2026-09-20T12:00:00Z', endTemp: 5,
            });
            expect(close.status).toBe(200);
            // Chiudere il ciclo è il suo secondo tempo, non una correzione.
            expect(close.body.updatedAt).toBeNull();
            expect(close.body.endedByUserName).toBeTruthy();
            expect(close.body.compliant).toBe(false);
            expect(close.body.problem).toContain('dopo 2 ore (limite +3 °C entro 90 minuti)');
            const ncs = await ncFor(owner, start.body.id);
            expect(ncs).toHaveLength(1);
            expect(ncs[0].source).toBe('PROCESS');
            expect(ncs[0].title).toContain('Abbattimento · Ragù processi');
        });

        it('la cottura al cuore usa il limite del locale', async () => {
            const ok = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'COTTURA', product: 'Pollo processi', endTemp: 73,
            });
            expect(ok.status).toBe(201);
            expect(ok.body.compliant).toBe(true);
            expect(ok.body.endedAt).toBeTruthy();
            const low = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'COTTURA', product: 'Arrosto processi', endTemp: 68,
            });
            expect(low.body.compliant).toBe(false);
            expect(low.body.problem).toContain('minimo 72');
        });

        it('la bonifica anti-Anisakis conta le ore alla temperatura', async () => {
            const short = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'ANISAKIS', product: 'Tonno processi', internalLot: 'T1',
                startedAt: '2026-09-20T08:00:00Z', startTemp: -21, endedAt: '2026-09-21T02:00:00Z', endTemp: -22,
            });
            expect(short.body.compliant).toBe(false);
            const long = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'ANISAKIS', product: 'Salmone processi', internalLot: 'S1',
                startedAt: '2026-09-20T08:00:00Z', startTemp: -21, endedAt: '2026-09-21T09:00:00Z', endTemp: -22,
            });
            expect(long.body.compliant).toBe(true);
        });

        it('il campione testimone si conserva 72 ore', async () => {
            const res = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'CAMPIONE', product: 'Lasagna processi', eventLabel: 'Matrimonio Rossi',
                endedAt: '2026-09-20T20:00:00Z',
            });
            expect(res.status).toBe(201);
            expect(new Date(res.body.keepUntil).toISOString()).toBe('2026-09-23T20:00:00.000Z');
        });

        it('un processo sconosciuto o una fine prima dell\'inizio sono rifiutati', async () => {
            expect((await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'FRITTURA', product: 'x',
            })).status).toBe(400);
            expect((await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', process: 'ABBATTIMENTO', product: 'x',
                startedAt: '2026-09-20T10:00:00Z', endedAt: '2026-09-20T09:00:00Z', endTemp: 2,
            })).status).toBe(400);
        });

        it('un client vecchio registra ancora range e durata', async () => {
            const res = await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-20', product: 'Salsa processi', blastTempRange: '0°/-5°', blastDuration: '30MIN',
            });
            expect(res.status).toBe(201);
            expect(res.body.process).toBe('LEGACY');
            expect(res.body.compliant).toBeNull();
        });
    });

    describe('olio', () => {
        it('composti polari oltre il limite aprono una non conformità, se l\'olio non è stato cambiato', async () => {
            const kept = await api().post('/haccp/oil').set(bearer(owner)).send({
                date: '2026-09-22', fryerLabel: 'Friggitrice 1', action: 'UTILIZZABILE', polarCompounds: 27,
            });
            expect(kept.status).toBe(201);
            expect(kept.body.polarCompounds).toBe(27);
            let ncs = await ncFor(owner, kept.body.id);
            expect(ncs).toHaveLength(1);
            expect(ncs[0].title).toContain('composti polari 27%');

            const changed = await api().post('/haccp/oil').set(bearer(owner)).send({
                date: '2026-09-22', fryerLabel: 'Friggitrice 1', action: 'SOSTITUITO', polarCompounds: 27,
            });
            expect(changed.status).toBe(201);
            ncs = await ncFor(owner, kept.body.id);
            expect(ncs[0].status).toBe('VOID');
        });
    });

    describe('ricevimento e rintracciabilità', () => {
        let receiptId = '';

        it('il fornitore dell\'anagrafica lascia il suo nome; fuori temperatura e scaduto aprono la non conformità', async () => {
            const res = await api().post('/haccp/receipts').set(bearer(owner)).send({
                date: '2026-09-23', product: 'Burrata processi', lotNumber: 'BUR-0923', category: 'LATTICINI',
                temperature: 7, accepted: true, supplierId, ddtNumber: 'DDT 451', expiryDate: '2026-09-22', packagingOk: true,
            });
            expect(res.status).toBe(201);
            receiptId = res.body.id;
            expect(res.body.supplierName).toBe('Caseificio Processi');
            const ncs = await ncFor(owner, receiptId);
            expect(ncs).toHaveLength(1);
            expect(ncs[0].title).toContain('Ricevimento fuori norma');
            expect(ncs[0].detail).toContain('arrivata a +7 °C (massimo +4 °C)');
            expect(ncs[0].detail).toContain('scaduta');
        });

        it('un tipo di merce sconosciuto è rifiutato', async () => {
            expect((await api().post('/haccp/receipts').set(bearer(owner)).send({
                date: '2026-09-23', product: 'x', category: 'GELATI',
            })).status).toBe(400);
        });

        it('il lotto si ritrova fra ricevimenti e processi', async () => {
            await api().post('/haccp/production').set(bearer(owner)).send({
                date: '2026-09-24', process: 'COTTURA', product: 'Pizza processi', endTemp: 90, sourceLots: 'BUR-0923, FAR-12',
            });
            const res = await api().get('/haccp/trace').set(bearer(owner)).query({ q: 'bur-0923' });
            expect(res.status).toBe(200);
            expect(res.body.receipts.some((r: any) => r.id === receiptId)).toBe(true);
            expect(res.body.production.some((p: any) => p.product === 'Pizza processi')).toBe(true);
            expect((await api().get('/haccp/trace').set(bearer(owner)).query({ q: 'b' })).status).toBe(400);
            // I caratteri jolly si cercano alla lettera.
            const wildcard = await api().get('/haccp/trace').set(bearer(owner)).query({ q: '%%' });
            expect(wildcard.body.receipts).toHaveLength(0);
        });

        it('un richiamo è una non conformità con la sua fonte', async () => {
            const res = await api().post('/haccp/nonconformities').set(bearer(owner)).send({
                date: '2026-09-25', source: 'RECALL', title: 'Richiamo · Burrata processi lotto BUR-0923',
                detail: 'Avviso del fornitore',
            });
            expect(res.status).toBe(201);
            expect(res.body.source).toBe('RECALL');
            expect(res.body.status).toBe('OPEN');
        });
    });

    describe('taratura dei termometri', () => {
        it('scarto oltre il limite: non conformità, chiusa se il termometro è già stato sostituito', async () => {
            const ok = await api().post('/haccp/calibrations').set(bearer(owner)).send({
                date: '2026-09-26', pointId: thermoId, method: 'GHIACCIO', referenceTemp: 0, measuredTemp: 0.6,
            });
            expect(ok.status).toBe(201);
            expect(ok.body.instrument).toBe('Sonda processi');
            expect(ok.body.maxDeviation).toBe(1);
            expect(await ncFor(owner, ok.body.id)).toHaveLength(0);

            const replaced = await api().post('/haccp/calibrations').set(bearer(owner)).send({
                date: '2026-09-27', pointId: thermoId, method: 'GHIACCIO', referenceTemp: 0, measuredTemp: 2.4, outcome: 'SOSTITUITO',
            });
            const ncs = await ncFor(owner, replaced.body.id);
            expect(ncs).toHaveLength(1);
            expect(ncs[0].status).toBe('CLOSED');
            expect(ncs[0].correctiveAction).toBe('Termometro sostituito');

            const day = await api().get('/haccp/day').set(bearer(owner)).query({ date: '2026-09-28' });
            const last = day.body.calibrations.find((c: any) => c.pointId === thermoId);
            expect(last.date).toBe('2026-09-27');
        });

        it('un punto che non è un termometro non si tara', async () => {
            const res = await api().post('/haccp/calibrations').set(bearer(owner)).send({
                date: '2026-09-26', pointId: blastId, method: 'GHIACCIO', referenceTemp: 0, measuredTemp: 0,
            });
            expect(res.status).toBe(400);
        });
    });

    describe('report', () => {
        it('porta processi, tarature e limiti del periodo', async () => {
            const res = await api().get('/haccp/report').set(bearer(owner)).query({ from: '2026-09-20', to: '2026-09-30' });
            expect(res.status).toBe(200);
            expect(res.body.production.some((p: any) => p.process === 'ANISAKIS')).toBe(true);
            expect(res.body.calibrations.length).toBeGreaterThanOrEqual(2);
            expect(res.body.limits.cooking.minCore).toBe(72);
        });
    });
});
