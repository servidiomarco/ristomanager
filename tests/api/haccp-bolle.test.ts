import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// HACCP Fase 4: la lettura AI del documento di trasporto. Propone righe di
// ricevimento, non scrive niente. Nella suite ordinaria non c'è la chiave: si
// provano validazione e «non disponibile». Il comportamento col modello gira
// con lo stub locale di Anthropic (job «Test API (report AI, stub locale)»):
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/haccp-bolle.test.ts

const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    return m && process.env.ANTHROPIC_API_KEY ? Number(m[1]) : 0;
})();

// Una «foto» minima: il server controlla tipo e dimensione, non i pixel.
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex').toString('base64');

describe('HACCP · lettura delle bolle', () => {
    let owner = '';
    let db: Client;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        await db.end();
    });

    it('rifiuta i file che non sono foto o PDF', async () => {
        const res = await api().post('/haccp/receipts/scan').set(bearer(owner)).send({ contentType: 'text/plain', data: PNG_B64 });
        expect(res.status).toBe(415);
    });

    it.runIf(!process.env.ANTHROPIC_API_KEY)('senza chiave risponde «non disponibile»', async () => {
        const res = await api().post('/haccp/receipts/scan').set(bearer(owner)).send({ contentType: 'image/png', data: PNG_B64 });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('ddt_not_configured');
    });

    describe.runIf(AI_STUB_PORT > 0)('con lo stub locale di Anthropic', () => {
        const received: any[] = [];
        let stub: http.Server;
        const proposal = {
            supplier: 'Caseificio Bolle Srl',
            ddt_number: '1127/A',
            document_date: '2026-10-05',
            lines: [
                { product: 'Mozzarella di bufala', lot_number: 'MB-55', expiry_date: '2026-10-09', quantity: '6 kg', category: 'LATTICINI' },
                { product: 'Ricotta', lot_number: null, expiry_date: 'domani', quantity: null, category: 'FORMAGGI' },
                { product: '   ', lot_number: null, expiry_date: null, quantity: null, category: null },
            ],
            warnings: ['lotto della ricotta illeggibile'],
        };

        beforeAll(async () => {
            await db.query(`INSERT INTO suppliers (tenant_id, name, categories) VALUES (1, 'Caseificio Bolle', ARRAY['CUCINA'])`);
            stub = http.createServer((req, res) => {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try { received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); } catch { received.push(null); }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'msg_stub_bolle', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
                        content: [{ type: 'text', text: JSON.stringify(proposal) }],
                        stop_reason: 'end_turn', stop_sequence: null,
                        usage: { input_tokens: 1500, output_tokens: 300 },
                    }));
                });
            });
            await new Promise<void>(resolve => stub.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));
        });

        afterAll(async () => {
            await new Promise<void>(resolve => stub.close(() => resolve()));
            await db.query(`DELETE FROM suppliers WHERE tenant_id = 1 AND name = 'Caseificio Bolle'`);
        });

        it('propone le righe ripulite e aggancia il fornitore dell\'anagrafica', async () => {
            const res = await api().post('/haccp/receipts/scan').set(bearer(owner)).send({ contentType: 'image/png', data: PNG_B64 });
            expect(res.status).toBe(200);
            expect(res.body.supplier).toBe('Caseificio Bolle Srl');
            expect(res.body.supplierMatch.name).toBe('Caseificio Bolle');
            expect(res.body.ddtNumber).toBe('1127/A');
            expect(res.body.lines).toHaveLength(2);
            expect(res.body.lines[0]).toEqual({ product: 'Mozzarella di bufala', lotNumber: 'MB-55', expiryDate: '2026-10-09', quantity: '6 kg', category: 'LATTICINI' });
            // Una data scritta male e un tipo inventato tornano null.
            expect(res.body.lines[1].expiryDate).toBeNull();
            expect(res.body.lines[1].category).toBeNull();
            expect(res.body.warnings).toEqual(['lotto della ricotta illeggibile']);

            const last = received[received.length - 1];
            expect(last.body.model).toBe('claude-opus-5-5');
            expect(last.body.output_config.format.type).toBe('json_schema');
            expect(last.body.fallbacks).toBe('default');
            expect(String(last.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
            expect(last.body.messages[0].content[0].type).toBe('image');
            // Niente scritto a registro: è solo una proposta.
            const rows = await db.query(`SELECT 1 FROM haccp_goods_receipts WHERE tenant_id = 1 AND product = 'Mozzarella di bufala'`);
            expect(rows.rows).toHaveLength(0);
        });

        it('registra il consumo in Consumi AI', async () => {
            let row: any = null;
            for (let i = 0; i < 40 && !row; i++) {
                const r = await db.query(`SELECT model, prompt_tokens, output_tokens FROM ai_token_usage WHERE feature = 'haccp_ddt' ORDER BY id DESC LIMIT 1`);
                row = r.rows[0] ?? null;
                if (!row) await new Promise(res => setTimeout(res, 50));
            }
            expect(row).toEqual({ model: 'claude-opus-5-5', prompt_tokens: 1500, output_tokens: 300 });
        });
    });
});
