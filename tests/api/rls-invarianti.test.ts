import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// Invarianti della Row-Level Security, letti dai cataloghi di Postgres.
//
// rls.test.ts prova che la policy FUNZIONA su una tabella; questo file prova
// che copre TUTTE le tabelle e che nessuno l'ha indebolita. È la classe di
// regressione che i test di route non vedono: una migration che crea una
// tabella tenant senza RLS, una policy aggiuntiva permissiva (le policy
// PERMISSIVE si sommano in OR: una sola «USING (true)» annulla l'isolamento),
// una vista o una funzione SECURITY DEFINER che leggono scavalcando la
// policy. ensureRlsPolicies al boot riallinea la formula sulle tabelle con
// tenant_id, ma non vede niente di tutto questo.

// Tabelle senza tenant_id, e quindi senza RLS, per scelta: il registro dei
// tenant, le sessioni (cercate per digest del refresh token, prima di sapere
// il tenant) e il registro delle migration. Una tabella nuova qui dentro è
// una decisione da motivare, non una svista.
const TABELLE_SENZA_TENANT = ['pgmigrations', 'tenants', 'user_sessions'];

describe('invarianti RLS (cataloghi)', () => {
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // ensureRlsPolicies gira al boot DOPO che il login del seed risponde
        // (il probe di globalSetup): si aspetta che la formula sia uniforme,
        // cioè che il riallineamento sia passato su tutte le tabelle.
        const deadline = Date.now() + 60_000;
        for (;;) {
            const r = await db.query(
                `SELECT COUNT(DISTINCT pg_get_expr(polqual, polrelid))::int AS n FROM pg_policy`
            );
            if (r.rows[0].n <= 1 || Date.now() > deadline) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    });

    afterAll(async () => {
        await db.end();
    });

    it('le sole tabelle senza tenant_id sono quelle ammesse', async () => {
        const r = await db.query(`
            SELECT c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
               AND NOT EXISTS (
                   SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
               )
             ORDER BY c.relname`);
        expect(r.rows.map(x => x.relname)).toEqual(TABELLE_SENZA_TENANT);
    });

    it('ogni tabella con tenant_id ha RLS attiva E forzata, e tenant_id NOT NULL', async () => {
        const r = await db.query(`
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, a.attnotnull
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
        expect(r.rows.length).toBeGreaterThan(50);
        // Senza FORCE l'owner delle tabelle, cioè il ruolo con cui gira
        // l'app, scavalca la policy: la RLS sarebbe decorativa.
        const scoperte = r.rows
            .filter(x => !x.relrowsecurity || !x.relforcerowsecurity || !x.attnotnull)
            .map(x => `${x.relname} (rls=${x.relrowsecurity}, force=${x.relforcerowsecurity}, notnull=${x.attnotnull})`);
        expect(scoperte).toEqual([]);
    });

    it('una sola policy per tabella: tenant_isolation, permissiva, su tutti i comandi', async () => {
        const r = await db.query(`
            SELECT c.relname, p.polname, p.polpermissive, p.polcmd, p.polroles::text AS roles
              FROM pg_policy p
              JOIN pg_class c ON c.oid = p.polrelid`);
        // polroles = {0} significa PUBLIC: una policy ristretta a un ruolo
        // lascerebbe gli altri ruoli senza policy, cioè senza righe.
        const anomale = r.rows
            .filter(x => x.polname !== 'tenant_isolation' || !x.polpermissive || x.polcmd !== '*' || x.roles !== '{0}')
            .map(x => `${x.relname}.${x.polname}`);
        expect(anomale).toEqual([]);

        const perTabella = new Map<string, number>();
        for (const x of r.rows) perTabella.set(x.relname, (perTabella.get(x.relname) ?? 0) + 1);
        expect([...perTabella].filter(([, n]) => n !== 1)).toEqual([]);

        const conTenant = await db.query(`
            SELECT COUNT(*)::int AS n
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
        expect(perTabella.size).toBe(conTenant.rows[0].n);
    });

    it('la formula è la stessa ovunque, e USING coincide con WITH CHECK', async () => {
        // Confronto fra le policy, non con un testo canonico: pg_get_expr
        // cambia forma fra versioni di Postgres, l'uniformità no.
        const r = await db.query(`
            SELECT pg_get_expr(polqual, polrelid) AS q, pg_get_expr(polwithcheck, polrelid) AS w
              FROM pg_policy`);
        const formule = new Set(r.rows.map(x => x.q));
        expect(formule.size).toBe(1);
        expect(r.rows.filter(x => x.q !== x.w).length).toBe(0);
        const [formula] = [...formule];
        // Il ramo rigido deve esserci: senza, anche in produzione una query
        // senza contesto vedrebbe tutti i tenant.
        expect(formula).toContain('app.tenant_id');
        expect(formula).toContain('app.rls_strict');
        expect(formula).toContain('app.rls_bypass');
    });

    it('nessuna vista né funzione SECURITY DEFINER in public', async () => {
        // Una vista gira coi diritti del suo owner e una funzione SECURITY
        // DEFINER con quelli di chi l'ha creata: entrambe leggono le tabelle
        // senza passare dalla policy del chiamante.
        const viste = await db.query(`
            SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`);
        expect(viste.rows.map(x => x.relname)).toEqual([]);
        const definer = await db.query(`
            SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prosecdef`);
        expect(definer.rows.map(x => x.proname)).toEqual([]);
    });
});
