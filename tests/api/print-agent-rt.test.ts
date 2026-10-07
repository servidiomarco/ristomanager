import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

// L'agente di stampa VERO (scripts/print-agent.mjs) davanti a un backend
// finto e a un registratore finto. Niente database: si prova solo cosa
// arriva all'RT. L'incidente del 07/10: un conto da 0,01 € tutto omaggio
// è partito come scontrino senza pagamenti, l'RT ha stampato ANNULLO ed è
// rimasto con lo scontrino aperto — la cassa non ha più emesso scontrini.
// Un documento così non deve nemmeno toccare il registratore.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const listen = (handler: http.RequestListener): Promise<http.Server> => new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const portOf = (srv: http.Server) => (srv.address() as AddressInfo).port;

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
});

const rtJob = (id: number, payload: Record<string, unknown>) => ({
    id, kind: 'RT_FISCALE', printer: 'rt',
    payload: { fiscal_doc_id: id, bill_id: id, payload },
});

const base = {
    type: 'sale', fiscal_id: '11122211133', lottery_code: null, invoice_issuing: false,
    ticket_restaurant_quantity: 0, services_uncollected_amount: '0.00', ticket_restaurant_payment_amount: '0.00',
};

describe('agente di stampa: registratore', () => {
    const jobs = [
        // Il conto 108 com'era: riga da 0,01, sconto (omaggio) 0,01, nessun pagamento.
        rtJob(1, { ...base, items: [{ quantity: '1.00', unit_price: '0.01', description: 'Consumazione', vat_rate_code: '10.00' }], discount: '0.01', cash_payment_amount: '0.00', electronic_payment_amount: '0.00' }),
        // Righe positive ma nessun pagamento: anche questo lascerebbe lo scontrino aperto.
        rtJob(2, { ...base, items: [{ quantity: '1.00', unit_price: '5.00', description: 'Acqua', vat_rate_code: '10.00' }], discount: '0.00', cash_payment_amount: '0.00', electronic_payment_amount: '0.00' }),
        // Un documento normale: deve arrivare all'RT, a riprova che il giro funziona.
        rtJob(3, { ...base, items: [{ quantity: '2.00', unit_price: '3.50', description: 'Caffe', vat_rate_code: '10.00' }], discount: '0.00', cash_payment_amount: '7.00', electronic_payment_amount: '0.00' }),
    ];
    const pending = new Set(jobs.map(j => j.id));
    const acks = new Map<number, any>();
    const rtBodies: string[] = [];
    let backend: http.Server;
    let rt: http.Server;
    let agent: ChildProcess | null = null;
    let agentLog = '';

    beforeAll(async () => {
        backend = await listen(async (req, res) => {
            const url = req.url ?? '';
            const json = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (url === '/print-agent/config') return json({ printers: [] });
            if (url === '/print-agent/jobs') return json({ jobs: jobs.filter(j => pending.has(j.id)) });
            const claim = url.match(/^\/print-agent\/jobs\/(\d+)\/claim$/);
            if (claim) return json({ claimed: pending.delete(Number(claim[1])) });
            const ack = url.match(/^\/print-agent\/jobs\/(\d+)\/ack$/);
            if (ack) { acks.set(Number(ack[1]), JSON.parse(await readBody(req))); return json({ ok: true }); }
            res.writeHead(404); res.end();
        });
        rt = await listen(async (req, res) => {
            rtBodies.push(await readBody(req));
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end('<response success="true" code="" status="2"><addInfo><zRepNumber>12</zRepNumber><fiscalReceiptNumber>3</fiscalReceiptNumber></addInfo></response>');
        });
        agent = spawn(process.execPath, [path.resolve('scripts/print-agent.mjs')], {
            env: {
                ...process.env,
                API_URL: `http://127.0.0.1:${portOf(backend)}`,
                NODE_URL: '',
                PRINT_AGENT_TOKEN: 'test-print-agent-token',
                RT_FISCAL_HOST: `127.0.0.1:${portOf(rt)}`,
                RT_FISCAL_REPARTI: '22=1,10=2',
                POLL_MS: '200',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        agent.stdout?.on('data', d => { agentLog += d; });
        agent.stderr?.on('data', d => { agentLog += d; });
        for (let i = 0; i < 100 && acks.size < jobs.length; i++) await sleep(100);
    });

    afterAll(async () => {
        agent?.kill();
        await new Promise(r => backend?.close(r));
        await new Promise(r => rt?.close(r));
    });

    it('un documento a zero o senza pagamento finisce FAILED senza toccare il registratore', () => {
        expect(acks.size, agentLog).toBe(jobs.length);
        for (const id of [1, 2]) {
            expect(acks.get(id)?.ok, `job ${id}`).toBe(false);
            expect(acks.get(id)?.error).toContain('senza pagamento');
        }
        // All'RT è arrivato solo il documento normale.
        expect(rtBodies).toHaveLength(1);
        expect(rtBodies[0]).toContain('description="Caffe"');
        expect(rtBodies[0]).toContain('<printRecTotal payment="7.00"');
        expect(acks.get(3)).toMatchObject({ ok: true, result: { doc_number: '0012-0003' } });
    });
});
