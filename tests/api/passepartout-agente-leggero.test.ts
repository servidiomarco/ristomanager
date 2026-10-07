import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { api, bearer, ownerToken } from './helpers';

// Il pacchetto leggero dell'agente (scripts/build-agent-bundle.mjs): un
// solo file JavaScript, senza node_modules. Qui lo si costruisce e lo si
// avvia DAVVERO, fuori dal repo, contro il server di test e una cassa SOAP
// finta: si collega, si annuncia con la versione del pacchetto, e la
// verifica guidata passa da lui fino alla cassa.

const SHA = 'e2e0001';
const busta = (op: string, risultato: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<${op}Response xmlns="http://tempuri.org/"><${op}Result xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${risultato}</${op}Result>` +
    `</${op}Response></s:Body></s:Envelope>`;
const fault = (msg: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode>` +
    `<faultstring>${msg}</faultstring></s:Fault></s:Body></s:Envelope>`;

describe('agente leggero in un solo file', () => {
    let token: string;
    let cassa: http.Server;
    let agente: ChildProcess | null = null;
    let cartella: string;
    let log = '';
    const ops: string[] = [];

    beforeAll(async () => {
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });

        cassa = http.createServer((req, res) => {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => {
                const op = String(req.headers.soapaction ?? '').replace(/"/g, '').split('/').pop() ?? '';
                ops.push(op);
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                if (op === 'GetVersioneGestionale') return res.end(busta(op, '2026C1'));
                if (op === 'GetTipiPagamento') {
                    return res.end(busta(op,
                        `<b:PMBTipoPagamento xmlns:b="x"><b:Categoria>Varie1</b:Categoria><b:Codice>ESTERNO</b:Codice></b:PMBTipoPagamento>`));
                }
                res.end(fault(`op ${op} non prevista dalla cassa finta`));
            });
        });
        await new Promise<void>((resolve) => cassa.listen(0, '127.0.0.1', resolve));
        const porta = (cassa.address() as AddressInfo).port;

        // Costruito nel repo, copiato fuori: deve girare senza node_modules.
        execFileSync('node', ['scripts/build-agent-bundle.mjs'], { env: { ...process.env, BUILD_SHA: SHA }, stdio: 'pipe' });
        cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-leggero-'));
        fs.cpSync(path.join('build', 'agente', SHA), cartella, { recursive: true });
        expect(fs.existsSync(path.join(cartella, 'node_modules'))).toBe(false);

        agente = spawn(process.execPath, ['passepartout-agent.js'], {
            cwd: cartella,
            env: {
                PATH: process.env.PATH ?? '',
                PP_AGENT_SERVER_URL: process.env.TEST_BASE_URL!,
                PP_AGENT_TOKEN: 'test-pp-agent-token',
                PP_AGENT_CONFIG: path.join(cartella, 'nessuno.json'),
                PASSEPARTOUT_WS_URL: `http://127.0.0.1:${porta}/AdapterWS`,
                PASSEPARTOUT_WS_USER: 'prova',
                PASSEPARTOUT_WS_PASSWORD: 'prova',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        agente.stdout?.on('data', (d) => { log += d; });
        agente.stderr?.on('data', (d) => { log += d; });
    });

    afterAll(async () => {
        agente?.kill();
        await new Promise<void>((resolve) => cassa.close(() => resolve()));
        fs.rmSync(cartella, { recursive: true, force: true });
        fs.rmSync(path.join('build', 'agente', SHA), { recursive: true, force: true });
    });

    it('si collega e si annuncia con la versione del pacchetto', async () => {
        const deadline = Date.now() + 15_000;
        let stato: any = null;
        while (Date.now() < deadline) {
            stato = (await api().get('/passepartout/status').set(bearer(token))).body;
            if (stato?.connected && stato.versione_agente === SHA) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        expect(stato, log).toMatchObject({ connected: true, versione_agente: SHA, versione_gestionale: '2026C1' });
        expect(stato.capabilities).toContain('diagnosi');
    });

    it('la verifica guidata passa dal bundle fino alla cassa', async () => {
        const r = await api().post('/passepartout/diagnosi').set(bearer(token));
        expect(r.status, log).toBe(200);
        const voci = Object.fromEntries((r.body.voci as any[]).map((v) => [v.voce, v]));
        expect(voci.agente).toMatchObject({ esito: 'ok', dati: { versione: SHA } });
        expect(voci.cassa).toMatchObject({ esito: 'ok', dati: { versione: '2026C1' } });
        expect(voci.pagamento.dati).toMatchObject({ tipo: 'ESTERNO', categoria: 'Varie1' });
        expect(ops).toContain('GetTipiPagamento');
    });
});
