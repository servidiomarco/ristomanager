import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// Verifica DIRETTA della Row-Level Security (Fase B4), sotto il livello
// API: crea un secondo tenant e un suo piatto, poi dimostra che dentro
// una transazione con app.tenant_id = 1 quel piatto non esiste — anche
// per una query volutamente NON scopata, che è esattamente il caso che
// la RLS deve coprire.
describe('row-level security', () => {
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL });
        await db.connect();
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES (2, 'trattoria-rls', 'Trattoria RLS')
                        ON CONFLICT (id) DO NOTHING`);
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
        await db.query(`INSERT INTO dishes (tenant_id, name, price) VALUES (2, 'Piatto Fantasma', 9.99)`);
        // I SUPERUSER bypassano la RLS anche con FORCE: i test girano come
        // postgres, quindi le asserzioni si declassano a un ruolo applicativo
        // senza privilegi speciali via SET ROLE — lo stesso assetto che la
        // produzione dovrà avere prima del tenant 2 (vedi warning al boot).
        await db.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_probe') THEN
                    CREATE ROLE rls_probe NOLOGIN;
                END IF;
            END $$;
        `);
        await db.query(`GRANT USAGE ON SCHEMA public TO rls_probe`);
        await db.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO rls_probe`);
        await db.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rls_probe`);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM dishes WHERE tenant_id = 2`);
        await db.query(`DELETE FROM role_permissions WHERE tenant_id = 2`);
        await db.query(`DELETE FROM tenants WHERE id = 2`);
        await db.query(`DROP OWNED BY rls_probe`);
        await db.query(`DROP ROLE IF EXISTS rls_probe`);
        await db.end();
    });

    it('senza contesto la policy è permissiva (fase di transizione)', async () => {
        const r = await db.query(`SELECT COUNT(*)::int AS c FROM dishes WHERE name = 'Piatto Fantasma'`);
        expect(r.rows[0].c).toBe(1);
    });

    it('dentro il contesto tenant 1 le righe del tenant 2 non esistono', async () => {
        await db.query('BEGIN');
        await db.query(`SET LOCAL ROLE rls_probe`);
        await db.query(`SELECT set_config('app.tenant_id', '1', true)`);
        const r = await db.query(`SELECT COUNT(*)::int AS c FROM dishes WHERE name = 'Piatto Fantasma'`);
        // Query deliberatamente non scopata: è la RLS a nascondere la riga.
        expect(r.rows[0].c).toBe(0);
        // E una scrittura sul tenant sbagliato viene rifiutata (WITH CHECK).
        await expect(
            db.query(`INSERT INTO dishes (tenant_id, name, price) VALUES (2, 'Intruso', 1)`)
        ).rejects.toThrow(/row-level security/i);
        await db.query('ROLLBACK');
    });

    it('dentro il contesto tenant 2 si vede solo il suo piatto', async () => {
        await db.query('BEGIN');
        await db.query(`SET LOCAL ROLE rls_probe`);
        await db.query(`SELECT set_config('app.tenant_id', '2', true)`);
        const suo = await db.query(`SELECT COUNT(*)::int AS c FROM dishes WHERE name = 'Piatto Fantasma'`);
        expect(suo.rows[0].c).toBe(1);
        const altrui = await db.query(`SELECT COUNT(*)::int AS c FROM dishes WHERE tenant_id = 1`);
        expect(altrui.rows[0].c).toBe(0);
        await db.query('ROLLBACK');
    });
});
