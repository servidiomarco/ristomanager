import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Verifica guidata della cassa (piano «plug and play», punto 2): la sezione
// controlla da sé quello che prima si controllava con script dal PC — agente
// e capacità, cassa raggiungibile e versione, tipo di pagamento dedicato,
// tavoli, menu, comande aperte — e fa la prova di scrittura con una
// prenotazione subito annullata. Agente finto col token storico del
// ristorante 1 (tipo di pagamento ESTERNO dall'env).

const TOKEN_STORICO = 'test-pp-agent-token';
const CAPACITA_TUTTE = ['chiudi-riprendi', 'prenotazioni', 'conti', 'tavoli-aperti', 'chiudi-preconto', 'preconto', 'specchio', 'diagnosi', 'sconto-cassa', 'comanda-viva', 'comanda-viva-invio', 'comanda-viva-coperto', 'chiudi-senza-invio'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Gestore = (params: any) => { ok: true; result: unknown } | { ok: false; error: string; kind: string };

describe('verifica guidata della cassa', () => {
    let token: string;
    let db: Client;
    let roomId: number;
    let tavoloProva: number;
    const aperti: Socket[] = [];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(100);
        }
    };
    const stato = async () => (await api().get('/passepartout/status').set(bearer(token))).body;

    /** Agente finto: le op che conosce rispondono coi gestori dati, le
     *  altre con un errore. Registra le chiamate. */
    const agente = async (hostname: string, capabilities: string[], gestori: Record<string, Gestore>) => {
        const calls: Array<{ op: string; params: any }> = [];
        const socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: TOKEN_STORICO }, transports: ['websocket'], reconnection: false,
        });
        aperti.push(socket);
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            calls.push({ op: payload?.op, params: payload?.params });
            const g = gestori[payload?.op];
            ack(g ? g(payload?.params) : { ok: false, error: 'op non prevista', kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket.on('connect', () => resolve());
            socket.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname, versioneGestionale: '2026C1', versioneAgente: 'abc1234', capabilities });
        await finoA(async () => (await stato()).hostname === hostname, `agente ${hostname} annunciato`);
        return { socket, calls };
    };
    const stacca = async (socket: Socket) => {
        socket.close();
        await finoA(async () => (await stato()).connected === false, 'agente staccato');
    };
    const verifica = async () => {
        const r = await api().post('/passepartout/diagnosi').set(bearer(token));
        expect(r.status).toBe(200);
        return Object.fromEntries((r.body.voci as any[]).map((v) => [v.voce, v]));
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        await db.query(`UPDATE passepartout_config SET esterno_elettronico_confermato = false WHERE tenant_id = 1`);
        // Un tavolo abbinato e confermato per la prova, in una sala sua.
        roomId = (await db.query(
            `INSERT INTO rooms (tenant_id, name, width, height) VALUES (1, 'Sala Verifica Cassa', 800, 600) RETURNING id`
        )).rows[0].id;
        tavoloProva = (await db.query(
            `INSERT INTO tables (tenant_id, room_id, name, shape, seats, x, y, status)
             VALUES (1, $1, 'V29', 'SQUARE', 4, 100, 100, 'FREE') RETURNING id`, [roomId]
        )).rows[0].id;
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato)
             VALUES ($1, 1, 'DENTRO', '29', 'manuale', true)`, [tavoloProva]
        );
    });

    afterAll(async () => {
        for (const s of aperti) s.close();
        await db.query(`DELETE FROM tables WHERE tenant_id = 1 AND room_id = $1`, [roomId]);
        await db.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        await api().put('/passepartout/config').set(bearer(token)).send({ tipo_pagamento_esterno: null });
        await db.query(
            `UPDATE passepartout_config SET esterno_elettronico_confermato = false, diagnosi = NULL, diagnosi_at = NULL,
                    prova_prenotazione_at = NULL, prova_prenotazione_esito = NULL WHERE tenant_id = 1`
        );
        await db.end();
    });

    it('senza PC collegato: agente in errore, niente voce della cassa, il resto si controlla lo stesso', async () => {
        await finoA(async () => (await stato()).connected === false, 'nessun agente dai file prima');
        const v = await verifica();
        expect(v.agente.esito).toBe('errore');
        expect(v.cassa).toBeUndefined();
        expect(v.pagamento).toMatchObject({ esito: 'attenzione', dati: { tipo: 'ESTERNO', motivo: 'da_confermare' } });
        expect(v.fiscale.esito).toBe('info');
        expect(['ok', 'attenzione']).toContain(v.tavoli.esito);
        // Resta salvata: la scheda la mostra senza rifarla.
        const salvata = await api().get('/passepartout/diagnosi').set(bearer(token));
        expect(salvata.body.voci.map((x: any) => x.voce)).toEqual(Object.keys(v));
        expect(salvata.body.eseguita_at).toBeTruthy();
    });

    it('agente aggiornato: cassa, tipi di pagamento e comande in una chiamata; la conferma del pagamento elettronico chiude la voce', async () => {
        const { socket, calls } = await agente('PC-CASSA', CAPACITA_TUTTE, {
            diagnosi: () => ({
                ok: true,
                result: {
                    raggiungibile: true, errore: null, versione: '2026C1', tempo_ms: 42,
                    tipi_pagamento: [{ codice: 'CONTANTI', categoria: 'Contanti' }, { codice: 'ESTERNO', categoria: 'Varie1' }],
                    sale: [{ sala: 'DENTRO', tavoli: 30 }], comande_aperte: 3,
                },
            }),
        });
        let v = await verifica();
        expect(calls.map((c) => c.op)).toEqual(['diagnosi']);
        expect(v.agente).toMatchObject({ esito: 'ok', dati: { pc: 'PC-CASSA', versione: 'abc1234', mancano: [] } });
        expect(v.cassa).toMatchObject({ esito: 'ok', dati: { versione: '2026C1', ms: 42 } });
        expect(v.pagamento).toMatchObject({ esito: 'attenzione', dati: { tipo: 'ESTERNO', categoria: 'Varie1', motivo: 'da_confermare' } });
        expect(v.comande).toMatchObject({ esito: 'ok', dati: { aperte: 3 } });

        expect((await api().put('/passepartout/diagnosi/elettronico').set(bearer(token)).send({ confermato: true })).status).toBe(200);
        v = await verifica();
        expect(v.pagamento).toMatchObject({ esito: 'ok', dati: { tipo: 'ESTERNO' } });
        expect((await api().get('/passepartout/diagnosi').set(bearer(token))).body.elettronico_confermato).toBe(true);

        // Un altro tipo va riconfermato; e se la cassa non ce l'ha è un errore.
        await api().put('/passepartout/config').set(bearer(token)).send({ tipo_pagamento_esterno: 'ONLINE' });
        v = await verifica();
        expect(v.pagamento).toMatchObject({ esito: 'errore', dati: { tipo: 'ONLINE', motivo: 'non_in_cassa' } });
        expect((await api().get('/passepartout/diagnosi').set(bearer(token))).body.elettronico_confermato).toBe(false);
        await api().put('/passepartout/config').set(bearer(token)).send({ tipo_pagamento_esterno: null });
        await stacca(socket);
    });

    it('agente vecchio: capacità mancanti e versione non provata sono «attenzione»; cassa irraggiungibile è errore', async () => {
        const vecchio = await agente('PC-VECCHIO', ['chiudi-riprendi'], {
            versione: () => ({ ok: true, result: '2025B2' }),
        });
        let v = await verifica();
        expect(vecchio.calls.map((c) => c.op)).toEqual(['versione']);
        expect(v.agente.esito).toBe('attenzione');
        expect(v.agente.dati.mancano).toEqual(expect.arrayContaining(['diagnosi', 'preconto', 'prenotazioni']));
        expect(v.cassa).toMatchObject({ esito: 'attenzione', dati: { versione: '2025B2' } });
        expect(v.comande).toBeUndefined();
        await stacca(vecchio.socket);

        const giu = await agente('PC-GIU', CAPACITA_TUTTE, {
            diagnosi: () => ({ ok: true, result: { raggiungibile: false, errore: 'connect ECONNREFUSED 192.168.1.10:7606', versione: null, tipi_pagamento: null, sale: null, comande_aperte: null } }),
        });
        v = await verifica();
        expect(v.cassa).toMatchObject({ esito: 'errore', dati: { errore: expect.stringContaining('ECONNREFUSED') } });
        expect(v.comande).toBeUndefined();
        await stacca(giu.socket);
    });

    it('prova di scrittura: prenotazione di prova domani alle 5 sul tavolo scelto, annullata subito', async () => {
        const domani = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date(Date.now() + 86_400_000));

        // Senza agente: 409, niente scritto.
        expect((await api().post('/passepartout/prova/prenotazione').set(bearer(token)).send({ table_id: tavoloProva })).status).toBe(409);

        let annullaRisponde: unknown = { esito: 'scritta', prenotazione: { idGestionale: 555, stato: 'Mancata' } };
        const { socket, calls } = await agente('PC-CASSA', CAPACITA_TUTTE, {
            prenotazione: (p) => ({
                ok: true,
                result: p?.azione === 'annulla' ? annullaRisponde : { esito: 'scritta', prenotazione: { idGestionale: 555, stato: 'Confermata' } },
            }),
        });

        // Un tavolo non abbinato non si usa.
        expect((await api().post('/passepartout/prova/prenotazione').set(bearer(token)).send({ table_id: 999999 })).status).toBe(400);

        const r = await api().post('/passepartout/prova/prenotazione').set(bearer(token)).send({ table_id: tavoloProva });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, id: 555 });
        const [scrivi, annulla] = calls;
        expect(scrivi.op).toBe('prenotazione');
        expect(scrivi.params).toMatchObject({
            sala: 'DENTRO', tavoli: ['29'], dataOra: `${domani}T05:00:00`, intestazione: 'PROVA Sympotia', stato: 'Confermata',
        });
        expect(scrivi.params.tag).toMatch(/^sympotia-prova:\d+$/);
        expect(annulla.params).toMatchObject({ azione: 'annulla', tag: scrivi.params.tag, idGestionale: 555, giorno: domani });
        let salvata = (await api().get('/passepartout/diagnosi').set(bearer(token))).body;
        expect(salvata.prova).toMatchObject({ esito: 'ok' });

        // Se l'annullamento non va a buon fine lo dice, e lo salva.
        annullaRisponde = { esito: 'cambiata_in_cassa', prenotazione: { idGestionale: 555, stato: 'Arrivata' } };
        const ko = await api().post('/passepartout/prova/prenotazione').set(bearer(token)).send({ table_id: tavoloProva });
        expect(ko.status).toBe(502);
        expect(ko.body.error).toBe('prova_non_riuscita');
        expect(ko.body.message).toContain('Mancata');
        salvata = (await api().get('/passepartout/diagnosi').set(bearer(token))).body;
        expect(salvata.prova.esito).toContain('cambiata_in_cassa');
        await stacca(socket);
    });
});
