import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Account self-service (profilo, cambio password/email) + recupero password.
//
// Tutte le mutazioni girano su utenti creati ad hoc, MAI sul seed owner: il
// suo login è cache-ato da helpers.ts e usato da tutti gli altri file — un
// cambio password qui li farebbe fallire tutti a valle.
describe('account self-service e recupero password', () => {
    let owner: string;
    let db: Client;
    const createdUserIds: number[] = [];

    const PASSWORD = 'password-iniziale-1';

    const createUser = async (email: string, fullName: string): Promise<number> => {
        const res = await api()
            .post('/auth/users')
            .set(bearer(owner))
            .send({ email, password: PASSWORD, full_name: fullName, role: 'WAITER' });
        expect(res.status).toBe(201);
        createdUserIds.push(res.body.id);
        return res.body.id as number;
    };

    const login = (email: string, password: string) =>
        api().post('/auth/login').send({ email, password });

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        // Cleanup diretto via pg: più robusto della DELETE API se un test a
        // metà ha cambiato la password o l'email dell'utente.
        if (createdUserIds.length > 0) {
            await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
        }
        await db.end();
    });

    it('aggiorna nome e telefono e li rilegge da /auth/me', async () => {
        await createUser('account-profilo@test.local', 'Utente Profilo');
        const session = await login('account-profilo@test.local', PASSWORD);
        expect(session.status).toBe(200);
        const token = session.body.accessToken as string;

        const put = await api()
            .put('/auth/me/profile')
            .set(bearer(token))
            .send({ full_name: 'Profilo Rinominato', phone: '+39 333 1234567' });
        expect(put.status).toBe(200);
        expect(put.body.full_name).toBe('Profilo Rinominato');
        expect(put.body.phone).toBe('+39 333 1234567');

        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.full_name).toBe('Profilo Rinominato');
        expect(me.body.phone).toBe('+39 333 1234567');
    });

    it('rifiuta un profilo con nome vuoto o telefono troppo lungo', async () => {
        await createUser('account-profilo-invalido@test.local', 'Profilo Invalido');
        const session = await login('account-profilo-invalido@test.local', PASSWORD);
        const token = session.body.accessToken as string;

        const nomeVuoto = await api().put('/auth/me/profile').set(bearer(token)).send({ full_name: '   ' });
        expect(nomeVuoto.status).toBe(400);

        const telefonoLungo = await api().put('/auth/me/profile').set(bearer(token)).send({ phone: '3'.repeat(31) });
        expect(telefonoLungo.status).toBe(400);
    });

    it('cambia la password: nuova valida, vecchia morta, refresh precedente revocato', async () => {
        await createUser('account-password@test.local', 'Utente Password');
        const session = await login('account-password@test.local', PASSWORD);
        const token = session.body.accessToken as string;
        const oldRefreshToken = session.body.refreshToken as string;

        // Password corrente sbagliata → 401, non cambia niente.
        const sbagliata = await api()
            .post('/auth/me/password')
            .set(bearer(token))
            .send({ current_password: 'non-e-questa', new_password: 'nuova-password-1' });
        expect(sbagliata.status).toBe(401);
        expect(sbagliata.body.error).toBe('wrong_password');

        // Policy: minimo 8 caratteri.
        const debole = await api()
            .post('/auth/me/password')
            .set(bearer(token))
            .send({ current_password: PASSWORD, new_password: 'corta' });
        expect(debole.status).toBe(400);
        expect(debole.body.error).toBe('weak_password');

        const ok = await api()
            .post('/auth/me/password')
            .set(bearer(token))
            .send({ current_password: PASSWORD, new_password: 'nuova-password-1' });
        expect(ok.status).toBe(200);

        // Login con la nuova password passa, con la vecchia no.
        const conNuova = await login('account-password@test.local', 'nuova-password-1');
        expect(conNuova.status).toBe(200);
        const conVecchia = await login('account-password@test.local', PASSWORD);
        expect(conVecchia.status).toBe(401);

        // Il refresh token emesso PRIMA del cambio è stato revocato
        // (refresh_token_hash azzerato): le altre sessioni muoiono al primo
        // refresh.
        const replay = await api().post('/auth/refresh').send({ refreshToken: oldRefreshToken });
        expect(replay.status).toBe(401);
    });

    it("cambia l'email: 409 se già in uso, token nuovi che aprono /auth/me con l'email nuova", async () => {
        await createUser('account-email@test.local', 'Utente Email');
        // Bersaglio del conflitto: un secondo utente ad hoc, non il seed owner.
        await createUser('account-email-occupata@test.local', 'Email Occupata');

        const session = await login('account-email@test.local', PASSWORD);
        const token = session.body.accessToken as string;

        // Password sbagliata → 401.
        const sbagliata = await api()
            .post('/auth/me/email')
            .set(bearer(token))
            .send({ new_email: 'account-email-libera@test.local', current_password: 'non-e-questa' });
        expect(sbagliata.status).toBe(401);

        // Email già di un altro utente → 409 email_conflict.
        const conflitto = await api()
            .post('/auth/me/email')
            .set(bearer(token))
            .send({ new_email: 'account-email-occupata@test.local', current_password: PASSWORD });
        expect(conflitto.status).toBe(409);
        expect(conflitto.body.error).toBe('email_conflict');

        // Successo: la risposta porta token NUOVI (il JWT contiene l'email)
        // e lo user aggiornato.
        const ok = await api()
            .post('/auth/me/email')
            .set(bearer(token))
            .send({ new_email: 'Account-Email-Nuova@Test.Local', current_password: PASSWORD });
        expect(ok.status).toBe(200);
        expect(ok.body.user.email).toBe('account-email-nuova@test.local');
        expect(ok.body.accessToken).toBeTruthy();
        expect(ok.body.refreshToken).toBeTruthy();

        const me = await api().get('/auth/me').set(bearer(ok.body.accessToken));
        expect(me.status).toBe(200);
        expect(me.body.email).toBe('account-email-nuova@test.local');

        // E il login funziona con l'email nuova, non con la vecchia.
        expect((await login('account-email-nuova@test.local', PASSWORD)).status).toBe(200);
        expect((await login('account-email@test.local', PASSWORD)).status).toBe(401);
    });

    it('forgot-password risponde 200 identico per email esistente e inesistente', async () => {
        await createUser('account-forgot@test.local', 'Utente Forgot');

        // Nei test SMTP non è configurato: per l'email esistente il server
        // logga un warn e basta. La risposta DEVE restare indistinguibile —
        // è la difesa contro l'enumerazione degli account.
        const esistente = await api().post('/auth/forgot-password').send({ email: 'account-forgot@test.local' });
        const inesistente = await api().post('/auth/forgot-password').send({ email: 'nessuno-con-questa@test.local' });

        expect(esistente.status).toBe(200);
        expect(inesistente.status).toBe(200);
        expect(esistente.body).toEqual({ ok: true });
        expect(inesistente.body).toEqual(esistente.body);
    });

    it('reset-password con token fasullo → 400 invalid_or_expired', async () => {
        const res = await api()
            .post('/auth/reset-password')
            .send({ token: 'f'.repeat(64), new_password: 'password-valida-1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_or_expired');
    });

    it('flusso completo di reset: token valido una volta sola, poi 400', async () => {
        const userId = await createUser('account-reset@test.local', 'Utente Reset');

        // Token noto inserito direttamente in DB (nei test non parte nessuna
        // email): in tabella vive solo lo SHA-256, come fa il server.
        const token = 'ab12'.repeat(16); // 64 hex, la stessa forma di randomBytes(32).hex
        const tokenHash = createHash('sha256').update(token).digest('hex');
        await db.query(
            `UPDATE users
             SET reset_token_hash = $1, reset_token_expires_at = NOW() + interval '30 minutes'
             WHERE id = $2`,
            [tokenHash, userId]
        );

        // Policy anche qui: minimo 8 caratteri.
        const debole = await api().post('/auth/reset-password').send({ token, new_password: 'corta' });
        expect(debole.status).toBe(400);
        expect(debole.body.error).toBe('weak_password');

        const ok = await api().post('/auth/reset-password').send({ token, new_password: 'password-dal-reset-1' });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ ok: true });

        // La nuova password apre il login; la vecchia no.
        expect((await login('account-reset@test.local', 'password-dal-reset-1')).status).toBe(200);
        expect((await login('account-reset@test.local', PASSWORD)).status).toBe(401);

        // Single-use: il secondo uso dello stesso token fallisce.
        const riuso = await api().post('/auth/reset-password').send({ token, new_password: 'ancora-un-altra-1' });
        expect(riuso.status).toBe(400);
        expect(riuso.body.error).toBe('invalid_or_expired');
    });
});
