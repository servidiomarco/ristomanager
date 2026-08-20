import { describe, it, expect, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Canali di risposta prenotazioni (Impostazioni → Canali di prenotazione):
// per fonte, lista di priorità email|whatsapp|sms + email in copia. Il GET
// senza riga salvata risponde col default, che riproduce il comportamento
// storico: web email-first, le altre fonti WhatsApp→SMS con email in copia.

describe('canali di risposta prenotazioni (/settings/booking-channels)', () => {
    // La riga app_settings scritta dal PUT va rimossa: i file di test girano
    // in sequenza sullo stesso database e un default alterato inquinerebbe
    // chi legge la policy dopo di noi.
    afterAll(async () => {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(
                `DELETE FROM app_settings WHERE tenant_id = 1 AND key = 'booking_channel_policy'`
            );
        } finally {
            await client.end();
        }
    });

    it('senza token → 401', async () => {
        const res = await api().get('/settings/booking-channels');
        expect(res.status).toBe(401);
    });

    it('il GET risponde col default storico quando non c\'è nulla di salvato', async () => {
        const token = await ownerToken();
        const res = await api().get('/settings/booking-channels').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.GOOGLE).toEqual({ priority: ['email', 'whatsapp', 'sms'], email_copy: false });
        expect(res.body.MANUAL).toEqual({ priority: ['whatsapp', 'sms'], email_copy: true });
        expect(res.body.VOICE).toEqual({ priority: ['whatsapp', 'sms'], email_copy: true });
        expect(res.body.WHATSAPP).toEqual({ priority: ['whatsapp', 'sms'], email_copy: true });
    });

    it('PUT parziale: aggiorna una fonte, le altre restano al default', async () => {
        const token = await ownerToken();
        const put = await api().put('/settings/booking-channels').set(bearer(token)).send({
            GOOGLE: { priority: ['sms'], email_copy: true },
        });
        expect(put.status).toBe(200);
        expect(put.body.GOOGLE).toEqual({ priority: ['sms'], email_copy: true });
        expect(put.body.MANUAL).toEqual({ priority: ['whatsapp', 'sms'], email_copy: true });

        // Persistita davvero, non solo eco della richiesta.
        const get = await api().get('/settings/booking-channels').set(bearer(token));
        expect(get.body.GOOGLE).toEqual({ priority: ['sms'], email_copy: true });
    });

    it('rifiuta policy malformate senza toccare nulla', async () => {
        const token = await ownerToken();

        const duplicato = await api().put('/settings/booking-channels').set(bearer(token)).send({
            VOICE: { priority: ['sms', 'sms'], email_copy: false },
        });
        expect(duplicato.status).toBe(400);
        expect(duplicato.body.error).toBe('invalid_policy');

        const vuota = await api().put('/settings/booking-channels').set(bearer(token)).send({
            VOICE: { priority: [], email_copy: false },
        });
        expect(vuota.status).toBe(400);

        const canaleIgnoto = await api().put('/settings/booking-channels').set(bearer(token)).send({
            VOICE: { priority: ['piccione'], email_copy: false },
        });
        expect(canaleIgnoto.status).toBe(400);

        const fonteIgnota = await api().put('/settings/booking-channels').set(bearer(token)).send({
            TELEGRAM: { priority: ['sms'], email_copy: false },
        });
        expect(fonteIgnota.status).toBe(400);
        expect(fonteIgnota.body.error).toBe('invalid_source');

        // VOICE non è stata toccata da nessuno dei tentativi falliti.
        const get = await api().get('/settings/booking-channels').set(bearer(token));
        expect(get.body.VOICE).toEqual({ priority: ['whatsapp', 'sms'], email_copy: true });
    });
});
