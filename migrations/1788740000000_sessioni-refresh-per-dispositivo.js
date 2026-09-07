/**
 * Sessioni di refresh per dispositivo (user_sessions).
 *
 * Fin qui il refresh token viveva in UNA colonna per utente
 * (users.refresh_token_hash): ogni login la sovrascriveva e ogni refresh la
 * ruotava. Con più dispositivi sullo stesso account (palmari, cassa, cucina)
 * l'ultimo arrivato revocava tutti gli altri, che morivano alla prima
 * scadenza dell'access token — cioè a metà servizio. Questa tabella dà a
 * ogni dispositivo la propria riga: le sessioni convivono e il logout di
 * uno non tocca gli altri.
 *
 * `token_digest` è lo SHA-256 base64 del refresh token, usato come chiave di
 * lookup diretta (il token è un JWT firmato ad alta entropia: il digest non
 * è invertibile e non basta a coniare niente — stessa ragione per cui i
 * reset token stanno in DB come SHA-256).
 *
 * `prev_token_digest` + `rotated_at` sono la finestra di grazia della
 * rotazione: se la risposta di /auth/refresh si perde sul WiFi del
 * ristorante, il client resta col token appena ruotato e senza grazia il
 * suo prossimo refresh sarebbe un 401 → logout. Il token precedente resta
 * valido per pochi minuti dopo la rotazione (la finestra la decide
 * authService), poi muore.
 *
 * NIENTE RLS, di proposito: come `tenant_domains`, si consulta nelle route
 * PRE-auth (login/refresh girano con runAsPlatform) e nelle route
 * autenticate arriva sempre filtrata per user_id — una policy su
 * app.tenant_id non avrebbe il contesto per funzionare nel percorso che
 * più le serve.
 *
 * users.refresh_token_hash resta al suo posto come fallback di lettura: i
 * dispositivi già loggati al momento del deploy hanno solo quel hash, e
 * authService li migra a una riga di sessione al loro primo refresh invece
 * di sbatterli fuori.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id                BIGSERIAL PRIMARY KEY,
            user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_digest      TEXT NOT NULL UNIQUE,
            prev_token_digest TEXT,
            rotated_at        TIMESTAMPTZ,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at        TIMESTAMPTZ NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
            ON user_sessions(user_id);
        -- La lookup di grazia cerca per prev_token_digest: senza indice
        -- ogni refresh "in ritardo" farebbe una scansione completa.
        CREATE INDEX IF NOT EXISTS idx_user_sessions_prev_digest
            ON user_sessions(prev_token_digest)
            WHERE prev_token_digest IS NOT NULL;
    `);
};
