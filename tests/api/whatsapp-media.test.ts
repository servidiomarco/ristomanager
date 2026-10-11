import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import sharp from 'sharp';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { AI_STUB_PORT, startAiStub, stubText, type AiStub } from './aiStub';

// WhatsApp, Fase 9: i vocali trascritti e le foto che l'agente guarda
// (services/whatsapp/media/).
//
// Gli allegati si scaricano col mittente del ristorante, quindi il file gira
// nel passo col mittente finto (TWILIO_WHATSAPP_FROM). Twilio (allegati e
// invii) è lo stub di questo file sulla porta del server + 12, la
// speech-to-text di ElevenLabs quello sulla porta + 13 (globalSetup). La
// parte delle foto vuole anche lo stub di Anthropic.

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO = 'whatsapp:+393895916494';
const PORT = Number(process.env.TEST_API_PORT || 3199);
const TWILIO_PORT = PORT + 12;
const STT_PORT = PORT + 13;
const MEDIA = `http://127.0.0.1:${TWILIO_PORT}/media`;
const N = {
    spento: '3391188501',
    vocale: '3391188502',
    rotto: '3391188503',
    foto: '3391188504',
};

describe.runIf(!!process.env.TWILIO_WHATSAPP_FROM)('WhatsApp: vocali e foto', () => {
    let twilio: http.Server;
    let stt: http.Server;
    const trascrizioni: Array<{ key: string | undefined; body: string }> = [];
    let foto: Buffer;
    let db: Client;
    let token = '';
    let sid = 0;

    const inbound = (numero: string, body: string, media: Array<[string, string]> = []) => {
        const params: Record<string, string> = {
            From: `whatsapp:+39${numero}`, To: NOSTRO, Body: body, NumMedia: String(media.length),
            MessageSid: `SMmedia${Date.now()}${sid++}`,
        };
        media.forEach(([url, type], i) => { params[`MediaUrl${i}`] = url; params[`MediaContentType${i}`] = type; });
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', signature).type('form').send(params);
    };
    /** L'ultimo messaggio del numero; con `trascritto`, quando la
     *  trascrizione ha finito (il webhook risponde prima di lavorarlo). */
    const ultimo = async (numero: string, trascritto = true, ms = 5000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const r = await db.query(
                `SELECT * FROM outbound_messages WHERE tenant_id = 1 AND from_phone_digits = $1 ORDER BY id DESC LIMIT 1`, [`39${numero}`]);
            const row = r.rows[0];
            if (row && (!trascritto || ['done', 'failed'].includes(row.transcript_status))) return row;
            if (Date.now() > deadline) throw new Error(`trascrizione non finita: ${JSON.stringify(row)}`);
            await new Promise(res => setTimeout(res, 100));
        }
    };
    const impostazioni = (body: Record<string, unknown>) => api().put('/whatsapp/settings').set(bearer(token)).send(body);

    beforeAll(async () => {
        foto = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
        twilio = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/media/vocale') {
                res.writeHead(200, { 'content-type': 'audio/ogg' });
                return res.end(Buffer.from('OggS-vocale-finto'));
            }
            if (req.method === 'GET' && req.url === '/media/foto') {
                res.writeHead(200, { 'content-type': 'image/png' });
                return res.end(foto);
            }
            if (req.method === 'GET') { res.writeHead(404); return res.end(); }
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ sid: `SMstubmedia${Date.now()}`, status: 'queued' }));
            });
        });
        stt = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                trascrizioni.push({ key: req.headers['xi-api-key'] as string | undefined, body: Buffer.concat(chunks).toString('latin1') });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ language_code: 'ita', language_probability: 0.97, text: 'Vorrei spostare la prenotazione a domani' }));
            });
        });
        await new Promise<void>(resolve => twilio.listen(TWILIO_PORT, '127.0.0.1', () => resolve()));
        await new Promise<void>(resolve => stt.listen(STT_PORT, '127.0.0.1', () => resolve()));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
    });

    afterAll(async () => {
        await impostazioni({ media: { transcribe_voice: false, read_photos: false }, agent: { mode: 'off' } });
        await new Promise<void>(resolve => twilio.close(() => resolve()));
        await new Promise<void>(resolve => stt.close(() => resolve()));
        await db.end();
    });

    it('spenti di serie: un vocale resta un vocale', async () => {
        const g = await api().get('/whatsapp/settings').set(bearer(token));
        expect(g.body).toMatchObject({ media: { transcribe_voice: false, read_photos: false }, transcription_ready: true });
        expect((await impostazioni({ media: { read_photos: 'sì' } })).status).toBe(400);
        await inbound(N.spento, '', [[`${MEDIA}/vocale`, 'audio/ogg']]);
        const row = await ultimo(N.spento, false);
        expect(row.transcript_status).toBeNull();
        expect(trascrizioni).toHaveLength(0);
    });

    it('acceso: il vocale si trascrive con scribe_v2, e Messaggi lo mostra scritto', async () => {
        await impostazioni({ media: { transcribe_voice: true } });
        await inbound(N.vocale, '', [[`${MEDIA}/vocale`, 'audio/ogg']]);
        const row = await ultimo(N.vocale);
        expect(row).toMatchObject({ transcript: 'Vorrei spostare la prenotazione a domani', transcript_status: 'done', transcript_language: 'it' });
        expect(trascrizioni[0].key).toBe('test-stt-key');
        expect(trascrizioni[0].body).toContain('scribe_v2');
        expect(trascrizioni[0].body).toContain('OggS-vocale-finto');
        const thread = await api().get(`/messages/conversations/${N.vocale}`).set(bearer(token));
        expect(thread.body.messages.at(-1)).toMatchObject({ transcript: 'Vorrei spostare la prenotazione a domani', transcript_status: 'done' });
    });

    it('un vocale che non si scarica: «Trascrizione non riuscita», senza bloccare niente', async () => {
        await inbound(N.rotto, '', [[`${MEDIA}/sparito`, 'audio/ogg']]);
        expect((await ultimo(N.rotto)).transcript_status).toBe('failed');
    });

    it('l\'agente legge il vocale scritto e guarda la foto, ridotta a 1568 px', { skip: AI_STUB_PORT === 0 }, async () => {
        const stub: AiStub = await startAiStub();
        try {
            await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
            await db.query(`INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Media test', 'Siamo aperti a cena')`);
            await impostazioni({ media: { transcribe_voice: true, read_photos: true }, agent: { mode: 'draft' } });
            stub.load(stubText('Ho visto la foto, ti rispondo subito.'));
            await inbound(N.foto, 'Questa è la mia prenotazione', [[`${MEDIA}/foto`, 'image/png']]);
            await inbound(N.foto, '', [[`${MEDIA}/vocale`, 'audio/ogg']]);
            const deadline = Date.now() + 8000;
            while (stub.received.length === 0 && Date.now() < deadline) await new Promise(res => setTimeout(res, 150));
            expect(stub.received.length).toBeGreaterThan(0);
            const messages = stub.received[0].body.messages as any[];
            const blocks = messages.flatMap(m => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]));
            const immagine = blocks.find(b => b.type === 'image');
            expect(immagine.source.media_type).toBe('image/jpeg');
            const meta = await sharp(Buffer.from(immagine.source.data, 'base64')).metadata();
            expect(Math.max(meta.width!, meta.height!)).toBe(1568);
            expect(JSON.stringify(messages)).toContain('[Vocale, trascrizione automatica]: \\"Vorrei spostare la prenotazione a domani\\"');
        } finally {
            await stub.close();
            await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
            await db.query(`DELETE FROM ai_knowledge_entries WHERE tenant_id = 1 AND title = 'Media test'`);
        }
    });
});
