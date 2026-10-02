import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
// Il sorgente, non dist: la logica non ha dipendenze (vedi event-registry).
import { isTransientLockError, retryOnLockContention } from '../../utils/lockRetry';

// Boot che ritenta sulla contesa di lock. Il 02/10/2026 un deploy è stato
// scartato da Railway perché createSchema è finito in deadlock col container
// vecchio ancora in servizio (customers/reservations) e /ready è rimasto a
// 503. Qui: la regola su cosa si ritenta, e un deadlock VERO di Postgres
// provocato fra due connessioni, per non fidarsi di un codice d'errore finto.

const SCHEMA = 'lockretry_test';
const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

describe('retryOnLockContention', () => {
    it('ritenta solo le contese di lock e si ferma ai tentativi previsti', async () => {
        expect(isTransientLockError({ code: '40P01' })).toBe(true);
        expect(isTransientLockError({ code: '55P03' })).toBe(true);
        expect(isTransientLockError({ code: '40001' })).toBe(true);
        expect(isTransientLockError({ code: '23505' })).toBe(false);
        expect(isTransientLockError(new Error('boom'))).toBe(false);
        expect(isTransientLockError(null)).toBe(false);

        let calls = 0;
        const ok = await retryOnLockContention('prova', async () => {
            calls++;
            if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
            return 'fatto';
        }, { baseDelayMs: 1, log: () => {} });
        expect(ok).toBe('fatto');
        expect(calls).toBe(3);

        // Un errore vero non si ritenta: esce subito.
        let other = 0;
        await expect(retryOnLockContention('prova', async () => {
            other++;
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }, { baseDelayMs: 1, log: () => {} })).rejects.toThrow('duplicate key');
        expect(other).toBe(1);

        // Contesa che non passa mai: dopo l'ultimo tentativo l'errore risale.
        let stuck = 0;
        await expect(retryOnLockContention('prova', async () => {
            stuck++;
            throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        }, { attempts: 3, baseDelayMs: 1, log: () => {} })).rejects.toThrow('deadlock detected');
        expect(stuck).toBe(3);
    });

    describe('con un deadlock vero', () => {
        let a: Client;
        let b: Client;

        // Uno schema a parte e non public: rls-invarianti pretende la RLS su
        // ogni tabella di public, e queste due sono solo un banco di prova.
        beforeAll(async () => {
            a = await pgClient();
            b = await pgClient();
            await a.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
            await a.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.t1 (id int)`);
            await a.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.t2 (id int)`);
        });

        afterAll(async () => {
            await a?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
            await a?.end();
            await b?.end();
        });

        it('il passo che perde il deadlock fa ROLLBACK e al secondo giro passa', async () => {
            // B tiene t2. A prende t1 e chiede t2 (aspetta); poco dopo B
            // chiede t1 e chiude il cerchio. A aspetta da prima, quindi il
            // suo controllo di deadlock scatta per primo: la vittima è A.
            await b.query('BEGIN');
            await b.query(`LOCK TABLE ${SCHEMA}.t2 IN ACCESS EXCLUSIVE MODE`);
            let attempts = 0;
            let bDone: Promise<unknown> = Promise.resolve();
            let bError: unknown = null;
            const codes: string[] = [];

            const result = await retryOnLockContention('banco di prova', async () => {
                attempts++;
                await a.query('BEGIN');
                try {
                    await a.query(`LOCK TABLE ${SCHEMA}.t1 IN ACCESS EXCLUSIVE MODE`);
                    const second = a.query(`LOCK TABLE ${SCHEMA}.t2 IN ACCESS EXCLUSIVE MODE`);
                    if (attempts === 1) {
                        await new Promise(res => setTimeout(res, 200));
                        bDone = b.query(`LOCK TABLE ${SCHEMA}.t1 IN ACCESS EXCLUSIVE MODE`)
                            .then(() => b.query('COMMIT'))
                            .catch(async err => { bError = err; await b.query('ROLLBACK'); });
                    }
                    await second;
                    await a.query('COMMIT');
                    return 'passato';
                } catch (err) {
                    codes.push(String((err as { code?: string }).code));
                    await a.query('ROLLBACK');
                    throw err;
                }
            }, { baseDelayMs: 50, log: () => {} });
            await bDone;

            expect(bError).toBeNull();
            expect(codes).toEqual(['40P01']);
            expect(attempts).toBe(2);
            expect(result).toBe('passato');
        }, 20_000);
    });
});
