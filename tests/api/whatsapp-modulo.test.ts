import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';
// Il sorgente, non dist: queste parti del modulo non toccano il database.
import { parseTwilioInbound } from '../../services/whatsapp/providers/twilio';
import { envTenantIds, twilioEnvSender, getSmsSender } from '../../services/whatsapp/config';
import { pickTemplate } from '../../services/whatsapp/templates/registry';

// WhatsApp, Fase 1: il modulo services/whatsapp/.
//
// Fino all'11/10/2026 il mittente WhatsApp era uno solo, letto dalle
// variabili d'ambiente: ogni ristorante con l'add-on scriveva ai suoi clienti
// dal numero e coi template del Frantoio, e il webhook in arrivo buttava nome
// del profilo, tocchi sui bottoni e posizioni, e registrava due volte i
// ritentativi di Twilio.

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO_NUMERO = 'whatsapp:+393895916494';
const CLIENTE = '+393478812201';
const CLIENTE_TASTO = '+393478812202';

const ENV = {
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_WHATSAPP_FROM: '+393895916494',
    TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
    TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED: 'HXitaliano',
    TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED_EN: 'HXinglese',
} as NodeJS.ProcessEnv;

describe('WhatsApp: mittente e template per ristorante', () => {
    it('le credenziali in env valgono solo per i ristoranti elencati', () => {
        expect([...envTenantIds({} as NodeJS.ProcessEnv)]).toEqual([1]);
        expect([...envTenantIds({ WHATSAPP_ENV_TENANT_IDS: '1, 4, x, -2' } as NodeJS.ProcessEnv)]).toEqual([1, 4]);
        expect(twilioEnvSender(ENV)?.from).toBe('whatsapp:+393895916494');
        expect(twilioEnvSender({ ...ENV, TWILIO_WHATSAPP_FROM: '' })).toBeNull();
    });

    it('un altro ristorante non riceve i template né il mittente SMS del Frantoio', () => {
        expect(pickTemplate(1, 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED', 'it', ENV)).toEqual({ contentSid: 'HXitaliano', english: false });
        expect(pickTemplate(1, 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED', 'en', ENV)).toEqual({ contentSid: 'HXinglese', english: true });
        expect(pickTemplate(2, 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED', 'it', ENV)).toBeUndefined();
        // Un demo ammesso a scrivere dal numero del Frantoio, esplicitamente.
        const conDemo = { ...ENV, WHATSAPP_ENV_TENANT_IDS: '1,4' } as NodeJS.ProcessEnv;
        expect(pickTemplate(4, 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED', null, conDemo)?.contentSid).toBe('HXitaliano');

        expect(getSmsSender(1, ENV)?.messagingServiceSid).toBe('MGtest');
        expect(getSmsSender(2, ENV)).toBeNull();
    });

    it('il webhook legge nome del profilo, posizione e tocco sui bottoni', () => {
        const posizione = parseTwilioInbound({
            From: `whatsapp:${CLIENTE}`, To: NOSTRO_NUMERO, Body: '', NumMedia: '0',
            Latitude: '38.9', Longitude: '16.6', Label: 'Casa', MessageSid: 'SMx', ProfileName: 'Marco',
        });
        expect(posizione?.body).toBe('📍 Casa https://maps.google.com/?q=38.9,16.6');
        expect(posizione?.profileName).toBe('Marco');
        expect(posizione?.location).toEqual({ latitude: 38.9, longitude: 16.6, label: 'Casa', address: null });

        const tasto = parseTwilioInbound({
            From: `whatsapp:${CLIENTE}`, To: NOSTRO_NUMERO, Body: 'Ci saremo',
            ButtonPayload: 'rsv_confirm:abc', ButtonText: 'Ci saremo', ButtonType: 'REPLY',
        });
        expect(tasto?.button).toEqual({ payload: 'rsv_confirm:abc', text: 'Ci saremo', type: 'REPLY' });
        expect(tasto?.channel).toBe('whatsapp');

        expect(parseTwilioInbound({ From: `whatsapp:${CLIENTE}`, To: NOSTRO_NUMERO, Body: '  ' })).toBeNull();
    });
});

describe('WhatsApp: webhook in arrivo', () => {
    let db: Client;

    const signed = (path: string, params: Record<string, string>) => {
        const url = `${process.env.TEST_BASE_URL}${path}`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post(path).set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const righe = async (digits: string) => (await db.query(
        `SELECT body, profile_name, button_payload, button_text, location, provider_sid
           FROM outbound_messages
          WHERE tenant_id = 1 AND direction = 'inbound' AND from_phone_digits = $1
          ORDER BY id`,
        [digits]
    )).rows;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
    });

    afterAll(async () => {
        await db.query(`DELETE FROM outbound_messages WHERE from_phone_digits = ANY($1)`,
            [[CLIENTE, CLIENTE_TASTO].map(n => n.replace(/\D/g, ''))]);
        await db.end();
    });

    it('rifiuta una firma sbagliata', async () => {
        const res = await api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', 'firma-falsa')
            .type('form').send({ From: `whatsapp:${CLIENTE}`, To: NOSTRO_NUMERO, Body: 'ciao' });
        expect(res.status).toBe(403);
    });

    it('registra una posizione e scarta il ritentativo dello stesso messaggio', async () => {
        const params = {
            From: `whatsapp:${CLIENTE}`, To: NOSTRO_NUMERO, Body: '', NumMedia: '0',
            Latitude: '38.9', Longitude: '16.6', Label: 'Parcheggio', ProfileName: 'Marco Prova',
            MessageSid: 'SMwhatsappmodulo0001',
        };
        expect((await signed('/webhook/twilio-whatsapp', params)).status).toBe(200);
        expect((await signed('/webhook/twilio-whatsapp', params)).status).toBe(200);

        const digits = CLIENTE.replace(/\D/g, '');
        let rows = await righe(digits);
        for (let i = 0; i < 30 && rows.length === 0; i++) {
            await new Promise(r => setTimeout(r, 100));
            rows = await righe(digits);
        }
        // La seconda richiesta è lo stesso messaggio: una riga sola.
        await new Promise(r => setTimeout(r, 300));
        rows = await righe(digits);
        expect(rows).toHaveLength(1);
        expect(rows[0].body).toBe('📍 Parcheggio https://maps.google.com/?q=38.9,16.6');
        expect(rows[0].profile_name).toBe('Marco Prova');
        expect(rows[0].location).toEqual({ latitude: 38.9, longitude: 16.6, label: 'Parcheggio', address: null });
    });

    it('registra il tocco su un bottone di risposta rapida', async () => {
        await signed('/webhook/twilio-whatsapp', {
            From: `whatsapp:${CLIENTE_TASTO}`, To: NOSTRO_NUMERO, Body: 'Ci saremo', NumMedia: '0',
            ButtonPayload: 'rsv_confirm:token-di-prova', ButtonText: 'Ci saremo', ButtonType: 'REPLY',
            MessageSid: 'SMwhatsappmodulo0002',
        });
        const digits = CLIENTE_TASTO.replace(/\D/g, '');
        let rows = await righe(digits);
        for (let i = 0; i < 30 && rows.length === 0; i++) {
            await new Promise(r => setTimeout(r, 100));
            rows = await righe(digits);
        }
        expect(rows).toHaveLength(1);
        expect(rows[0].button_payload).toBe('rsv_confirm:token-di-prova');
        expect(rows[0].button_text).toBe('Ci saremo');
    });
});
