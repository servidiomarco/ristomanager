import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, bearer } from './helpers';

// Sessione di piattaforma scopata («Entra») per i test delle azioni che dopo
// l'audit H-05 sono riservate alla piattaforma (dominio e certificato del
// nodo di sala). Come in platform-enter.test.ts l'utente PLATFORM_ADMIN si
// crea via SQL: è il flusso previsto in produzione (nessuna route di signup).
// I file girano in sequenza: chi la usa la chiude con dropPlatformSession().

const PA_EMAIL = 'platform.admin.sessione@example.com';
const PA_PASSWORD = 'password-piattaforma-sessione';
const tokens = new Map<number, string>();

export const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

export const platformSessionFor = async (tenantId: number): Promise<string> => {
    const cached = tokens.get(tenantId);
    if (cached) return cached;
    const client = await pgClient();
    try {
        const hash = await bcrypt.hash(PA_PASSWORD, 4);
        await client.query(
            `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
             VALUES ($1, $2, 'Platform Admin Sessione', 'PLATFORM_ADMIN', 1, TRUE)
             ON CONFLICT (email) DO NOTHING`,
            [PA_EMAIL, hash]
        );
    } finally {
        await client.end();
    }
    const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
    if (login.status !== 200) {
        throw new Error(`Login platform admin fallito (${login.status}): ${JSON.stringify(login.body)}`);
    }
    const entered = await api().post(`/admin/tenants/${tenantId}/enter`).set(bearer(login.body.accessToken));
    if (entered.status !== 200) {
        throw new Error(`Enter fallito (${entered.status}): ${JSON.stringify(entered.body)}`);
    }
    tokens.set(tenantId, entered.body.accessToken);
    return entered.body.accessToken as string;
};

export const dropPlatformSession = async (): Promise<void> => {
    tokens.clear();
    const client = await pgClient();
    try {
        await client.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
        await client.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [PA_EMAIL]);
        await client.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
    } finally {
        await client.end();
    }
};

// Tripwire per i test che passano APPOSTA tutti i controlli del nodo e si
// fermano al 503 tls_not_configured solo perché il token manca: se il token
// ci fosse, la chiamata successiva scriverebbe DNS veri in sympotia.com o
// chiederebbe un certificato vero. globalSetup lo azzera per server e worker;
// qui si verifica che l'abbia fatto, prima della prima chiamata.
export const assertNoCloudflareToken = (): void => {
    if ((process.env.CLOUDFLARE_API_TOKEN || '').trim()) {
        throw new Error('CLOUDFLARE_API_TOKEN è impostato nel processo dei test: questi test raggiungerebbero Cloudflare e Let\'s Encrypt veri');
    }
    if (process.env.ACME_STAGING !== '1') {
        throw new Error('ACME_STAGING non è 1 nel processo dei test: globalSetup non ha messo le protezioni');
    }
};
