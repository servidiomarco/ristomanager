import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Client } from 'pg';
import { api } from './helpers';

// «Salva il nostro numero»: in Italia chi riceve una chiamata vede solo il
// numero, quindi il locale manda una scheda contatto (vCard) con il numero
// con cui richiama (CRM e cordless), il telefono pubblico e WhatsApp.
const LINEA = '+390985010032';
const ALTRO_TENANT = 4471;
const TENANT_SENZA_NUMERI = 4472;

/** Le righe della vCard, già «srotolate» (RFC 2426: la continuazione
 *  comincia con uno spazio). */
const unfold = (body: string): string[] => body.replace(/\r\n /g, '').split('\r\n').filter(Boolean);

describe('scheda contatto del locale', () => {
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // La chiamata in arrivo più recente dice con che numero il locale
        // richiama: dev'essere la nostra linea anche se altri file di test
        // ne hanno scritte altre.
        await db.query(
            `INSERT INTO phone_calls (tenant_id, call_sid, direction, from_number, to_number, routing, status, started_at)
             VALUES (1, $1, 'inbound', '+393470000001', $2, 'solo_sofia', 'sofia', NOW() + interval '1 day')`,
            [`CAcontatto${crypto.randomBytes(8).toString('hex')}`, LINEA]
        );
        await db.query(
            `INSERT INTO tenants (id, slug, name) VALUES ($1, 'osteria-contatto', 'Osteria Contatto'), ($2, 'senza-numeri', 'Senza Numeri')
             ON CONFLICT (id) DO NOTHING`,
            [ALTRO_TENANT, TENANT_SENZA_NUMERI]
        );
        await db.query(
            `INSERT INTO app_settings (tenant_id, key, text_value) VALUES ($1, 'legal_config', $2)
             ON CONFLICT (tenant_id, key) DO UPDATE SET text_value = EXCLUDED.text_value`,
            [ALTRO_TENANT, JSON.stringify({ business_name: "Osteria dell'Angolo; da Gino", public_phone: '06 1234567', public_address: 'Via Roma 1, Bari' })]
        );
    });

    afterAll(async () => {
        await db.query(`DELETE FROM phone_calls WHERE call_sid LIKE 'CAcontatto%'`);
        await db.query(`DELETE FROM app_settings WHERE tenant_id = ANY($1::int[])`, [[ALTRO_TENANT, TENANT_SENZA_NUMERI]]);
        await db.query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [[ALTRO_TENANT, TENANT_SENZA_NUMERI]]);
        await db.end();
    });

    it('il locale: prima il numero con cui chiama, poi telefono e WhatsApp', async () => {
        const brand = (await api().get('/public/contact')).body.branding;
        const res = await api().get('/public/contatto.vcf');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/vcard/);
        expect(res.headers['content-disposition']).toMatch(/^inline; filename=".+\.vcf"/);
        const body = res.text;
        const lines = unfold(body);
        expect(lines[0]).toBe('BEGIN:VCARD');
        expect(lines[1]).toBe('VERSION:3.0');
        expect(lines.at(-1)).toBe('END:VCARD');
        expect(lines).toContain(`FN:${brand.name}`);
        expect(lines).toContain('X-ABShowAs:COMPANY');

        const tel = lines.filter(l => /(^|\.)TEL[;:]/.test(l));
        expect(tel[0]).toBe(`item1.TEL;TYPE=WORK,VOICE:${LINEA}`);
        expect(lines).toContain('item1.X-ABLabel:Prenotazioni');
        // Il telefono pubblico in E.164, senza etichetta (tipo «lavoro»).
        const fisso = '+39' + String(brand.phone).replace(/\D/g, '');
        expect(tel).toContain(`TEL;TYPE=WORK,VOICE:${fisso}`);
        expect(lines.some(l => /^item\d+\.X-ABLabel:WhatsApp$/.test(l))).toBe(true);

        // Righe di al massimo 75 ottetti, a capo CRLF.
        for (const raw of body.split('\r\n')) expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(75);
        const photo = lines.find(l => l.startsWith('PHOTO;'));
        if (photo) {
            const jpeg = Buffer.from(photo.slice(photo.indexOf(':') + 1), 'base64');
            expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
        }
    });

    it('in inglese cambia solo l\'etichetta della linea', async () => {
        const lines = unfold((await api().get('/public/contatto.vcf?lang=en')).text);
        expect(lines).toContain('item1.X-ABLabel:Bookings');
        expect(lines).toContain(`item1.TEL;TYPE=WORK,VOICE:${LINEA}`);
    });

    it('un altro locale ha la sua scheda, coi caratteri protetti', async () => {
        const res = await api().get('/public/osteria-contatto/contatto.vcf');
        expect(res.status).toBe(200);
        const lines = unfold(res.text);
        expect(lines).toContain("FN:Osteria dell'Angolo\\; da Gino");
        expect(lines).toContain('TEL;TYPE=WORK,VOICE:+39061234567');
        expect(lines).toContain('ADR;TYPE=WORK:;;Via Roma 1\\, Bari;;;;');
        // Niente numeri del Frantoio: né la sua linea né il suo WhatsApp.
        expect(res.text).not.toContain(LINEA);
        expect(lines.some(l => l.includes('WhatsApp'))).toBe(false);
        expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain("Osteria dell'Angolo; da Gino.vcf");
    });

    it('senza numeri non c\'è scheda, e uno slug ignoto è 404', async () => {
        const vuota = await api().get('/public/senza-numeri/contatto.vcf');
        expect(vuota.status).toBe(404);
        expect(vuota.body.error).toBe('no_contact');
        expect((await api().get('/public/slug-che-non-esiste/contatto.vcf')).status).toBe(404);
    });

    it('la pagina «La tua prenotazione» porta il campo del link', async () => {
        const token = crypto.randomBytes(32).toString('base64url');
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone,
                                       payment_status, reservation_status, arrival_status, guest_token)
             VALUES (1, 'Collaudo Contatto', NOW() + interval '3 days', 'DINNER', 2, '+393331112288', 'NONE', 'CONFIRMED', 'WAITING', $1)
             RETURNING id`,
            [token]
        );
        try {
            const res = await api().get(`/r/${token}`);
            expect(res.status).toBe(200);
            // Il test server non ha un indirizzo pubblico del backend: il link è
            // null, ma il campo c'è (la pagina lo legge in modo difensivo).
            expect(res.body.business).toHaveProperty('contact_card_url');
        } finally {
            await db.query(`DELETE FROM reservations WHERE id = $1`, [r.rows[0].id]);
        }
    });
});
