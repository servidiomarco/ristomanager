import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from 'pg';
import { isWebSource, policySourceOf } from '../../utils/reservationSource';
import { DEFAULT_BOOKING_CHANNEL_POLICY, policyForSource } from '../../services/bookingChannelPolicy';
import { DEFAULT_BLACKLIST_POLICY, blacklistBehaviorFor } from '../../services/blacklistPolicy';
import { api, ownerToken, bearer } from './helpers';

// La fonte 'WEB' (form pubblico) arriva accanto alla storica 'GOOGLE': le
// regole del ristorante devono trattarle allo stesso modo, e la Reportistica
// deve contarle come un solo canale. Finestra di date tutta sua (febbraio
// 2028) perché il conteggio per canale sia deterministico.

const DAY = '2028-02-14';

describe('fonte WEB — stesse regole del web storico', () => {
    it('policySourceOf: WEB e GOOGLE sono il web, il resto resta com\'è, ignoto → MANUAL', () => {
        expect(policySourceOf('WEB')).toBe('GOOGLE');
        expect(policySourceOf('GOOGLE')).toBe('GOOGLE');
        expect(policySourceOf('VOICE')).toBe('VOICE');
        expect(policySourceOf('WHATSAPP')).toBe('WHATSAPP');
        expect(policySourceOf('MANUAL')).toBe('MANUAL');
        expect(policySourceOf(null)).toBe('MANUAL');
        expect(policySourceOf(undefined)).toBe('MANUAL');
        expect(policySourceOf('TELEGRAM')).toBe('MANUAL');
        expect(isWebSource('WEB')).toBe(true);
        expect(isWebSource('GOOGLE')).toBe(true);
        expect(isWebSource('MANUAL')).toBe(false);
    });

    it('canali di risposta: una prenotazione WEB parte con l\'email come quelle del web', () => {
        expect(policyForSource(DEFAULT_BOOKING_CHANNEL_POLICY, 'WEB')).toEqual(DEFAULT_BOOKING_CHANNEL_POLICY.GOOGLE);
        expect(policyForSource(DEFAULT_BOOKING_CHANNEL_POLICY, 'WEB').priority[0]).toBe('email');
        expect(policyForSource(DEFAULT_BOOKING_CHANNEL_POLICY, 'ALTRO')).toEqual(DEFAULT_BOOKING_CHANNEL_POLICY.MANUAL);
    });

    it('blacklist: con il web su block anche WEB è bloccata, su warn passa', () => {
        expect(blacklistBehaviorFor({ ...DEFAULT_BLACKLIST_POLICY, GOOGLE: 'block' }, 'WEB')).toBe('block');
        expect(blacklistBehaviorFor({ ...DEFAULT_BLACKLIST_POLICY, GOOGLE: 'warn' }, 'WEB')).toBe('warn');
        expect(blacklistBehaviorFor({ ...DEFAULT_BLACKLIST_POLICY, MANUAL: 'block' }, null)).toBe('block');
    });
});

describe('fonte WEB — Reportistica', () => {
    let owner = '';

    beforeAll(async () => {
        owner = await ownerToken();
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        try {
            await db.query(
                `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, payment_status, source)
                 VALUES (1, 'Web Vecchia Fonte', $1, 'DINNER', 2, 'PENDING', 'GOOGLE'),
                        (1, 'Web Nuova Fonte', $2, 'DINNER', 3, 'PENDING', 'WEB')`,
                [`${DAY}T19:00:00Z`, `${DAY}T19:30:00Z`]);
        } finally {
            await db.end();
        }
    });

    it('GOOGLE e WEB sono un solo canale, con la chiave che i frontend conoscono', async () => {
        const res = await api().get(`/reports/reservations?from=${DAY}&to=${DAY}`).set(bearer(owner));
        expect(res.status).toBe(200);
        const web = res.body.per_canale.filter((c: any) => c.canale === 'GOOGLE' || c.canale === 'WEB');
        expect(web).toHaveLength(1);
        expect(web[0].canale).toBe('GOOGLE');
        expect(web[0].prenotazioni).toBe(2);
        expect(web[0].coperti).toBe(5);
    });
});
