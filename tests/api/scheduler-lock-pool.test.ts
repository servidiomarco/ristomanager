import { describe, it, expect, afterAll } from 'vitest';
import { Client } from 'pg';
// Il sorgente, non dist: si prova il pool in questo processo (vedi billing.test.ts).
import { queryWithRetry, runSchedulerTickWithLock } from '../../db';

// Il 18/10, a ogni deploy, cinque scheduler fallivano insieme cinque secondi
// dopo l'avvio con «timeout exceeded when trying to connect». Partono tutti
// nello stesso istante; ognuno teneva una connessione del pool delle query
// (max 10) per il suo lock e le sue query ne chiedevano un'altra: con dieci
// giri insieme il pool era tutto in mano ai lock e le query restavano in
// coda fino al timeout. I lock hanno ora un pool loro.

const LOCK_BASE = 990_100;

describe('lock degli scheduler e pool delle query', () => {
    const errori: string[] = [];
    const consoleError = console.error;

    afterAll(() => { console.error = consoleError; });

    it('dodici giri partiti insieme finiscono tutti, senza timeout', async () => {
        console.error = (...args: unknown[]) => { errori.push(args.map(String).join(' ')); };
        const fatti: number[] = [];
        const inizio = Date.now();
        try {
            await Promise.all(Array.from({ length: 12 }, (_, i) =>
                runSchedulerTickWithLock(LOCK_BASE + i, `prova-${i}`, async () => {
                    await queryWithRetry('SELECT pg_sleep(0.2)');
                    await queryWithRetry('SELECT 1');
                    fatti.push(i);
                })
            ));
        } finally {
            console.error = consoleError;
        }
        expect(errori).toEqual([]);
        expect(fatti.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
        expect(Date.now() - inizio).toBeLessThan(4_000);
    });

    it("con il lock tenuto da un'altra replica il giro si salta, e il lock torna libero dopo", async () => {
        const altra = new Client({ connectionString: process.env.DATABASE_URL });
        await altra.connect();
        try {
            await altra.query('SELECT pg_advisory_lock($1)', [LOCK_BASE + 50]);
            let girato = false;
            await runSchedulerTickWithLock(LOCK_BASE + 50, 'prova-occupato', async () => { girato = true; });
            expect(girato).toBe(false);
            await altra.query('SELECT pg_advisory_unlock($1)', [LOCK_BASE + 50]);
            await runSchedulerTickWithLock(LOCK_BASE + 50, 'prova-libero', async () => { girato = true; });
            expect(girato).toBe(true);
            // Il giro ha lasciato il lock: un'altra sessione lo riprende.
            const r = await altra.query('SELECT pg_try_advisory_lock($1) AS preso', [LOCK_BASE + 50]);
            expect(r.rows[0].preso).toBe(true);
            await altra.query('SELECT pg_advisory_unlock($1)', [LOCK_BASE + 50]);
        } finally {
            await altra.end();
        }
    });
});
