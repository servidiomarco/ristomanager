import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryWithRetry } from '../db.js';
import { User, UserRole } from '../types.js';
import { getAssignableRoles } from './permissions.js';

// In produzione i segreti DEVONO arrivare dall'ambiente: per mesi Railway è
// andato in produzione senza JWT_SECRET e i token erano firmati col fallback
// committato qui sotto — chiunque leggesse il sorgente poteva coniarsi un
// token OWNER valido (scoperto e sanato il 2026-08-22). Il boot fallisce
// piuttosto che ripetere quella condizione.
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET)) {
  throw new Error('JWT_SECRET e JWT_REFRESH_SECRET sono obbligatori in produzione');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production';
const JWT_EXPIRES_IN = '6h';
const JWT_REFRESH_EXPIRES_IN = '7d';
// Vita della riga in user_sessions: DEVE rispecchiare JWT_REFRESH_EXPIRES_IN
// (il JWT e la riga scadono insieme; la rotazione rinnova entrambi).
const SESSION_LIFETIME_SQL = "interval '7 days'";
// Finestra di grazia della rotazione: dopo un refresh il token PRECEDENTE
// resta accettato per questo intervallo. Serve al WiFi del ristorante: se la
// risposta di /auth/refresh si perde, il client resta col token vecchio e
// senza grazia il suo prossimo tentativo sarebbe un 401 → logout a metà
// servizio. Due minuti bastano a qualunque retry e tengono minima la
// finestra di replay di un token rubato.
const ROTATION_GRACE_SQL = "interval '2 minutes'";

export interface TokenPayload {
  userId: number;
  email: string;
  role: UserRole;
  // Fase B2 del piano SaaS: il tenant viaggia nel token. I token emessi
  // prima del deploy non hanno il claim (TTL 6h): chi li verifica
  // normalizza col fallback 1 — corretto per tutti gli utenti esistenti.
  // Il fallback va rimosso prima di accendere il secondo tenant.
  tenantId: number;
  // Sessione di piattaforma scopata su un tenant: un PLATFORM_ADMIN che
  // "entra" in un ristorante mantiene la propria identità e ruolo, ma opera
  // dentro quel tenant (tenantId = scopedTenantId). Il claim distingue la
  // sessione operativa da quella di pannello: SOLO con lo scope il ruolo
  // bypassa la matrice permessi del tenant — un token di piattaforma senza
  // scope resta confinato al pannello, come prima.
  scopedTenantId?: number;
}

// Vero solo per una sessione di piattaforma entrata in un tenant. Ogni
// bypass (matrice permessi, authorize) passa da qui: il ruolo da solo non
// basta, serve lo scope esplicito nel token.
export const isPlatformScopedSession = (payload: TokenPayload): boolean =>
  payload.role === UserRole.PLATFORM_ADMIN
  && Number.isInteger(payload.scopedTenantId)
  && (payload.scopedTenantId as number) > 0;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  // Hash password using bcrypt
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  // Verify password against hash
  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  // Il digest SHA-256 base64 del refresh token è la chiave di lookup in
  // user_sessions: il token è un JWT firmato ad alta entropia, il digest non
  // è invertibile e da solo non conia niente (stessa ragione dei reset token).
  private static digestRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('base64');
  }

  // bcrypt(SHA-256) sopravvive SOLO per il fallback legacy su
  // users.refresh_token_hash: i dispositivi loggati prima del deploy delle
  // sessioni per-dispositivo hanno il refresh token in quel formato, e al
  // primo refresh vengono migrati a una riga di user_sessions invece di
  // essere sbattuti fuori. (Lo SHA-256 dentro bcrypt c'è perché bcrypt
  // tronca a 72 byte e i JWT condividono i primi 72 — senza digest qualunque
  // token dello stesso utente passava il confronto.)
  private static async verifyRefreshTokenHash(token: string, hash: string): Promise<boolean> {
    return this.verifyPassword(this.digestRefreshToken(token), hash);
  }

  // Registra una nuova sessione (login, cambio email, migrazione legacy) e
  // approfitta del giro per potare le righe scadute dell'utente.
  private static async createSession(userId: number, refreshToken: string): Promise<void> {
    await queryWithRetry(
      `INSERT INTO user_sessions (user_id, token_digest, expires_at)
       VALUES ($1, $2, now() + ${SESSION_LIFETIME_SQL})`,
      [userId, this.digestRefreshToken(refreshToken)]
    );
    await queryWithRetry('DELETE FROM user_sessions WHERE user_id = $1 AND expires_at < now()', [userId]);
  }

  // Generate access and refresh tokens
  static generateTokens(payload: TokenPayload): AuthTokens {
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    // jti casuale: due login dello stesso utente nello stesso secondo
    // producono altrimenti JWT byte-identici (stesso iat), stesso digest, e
    // l'INSERT in user_sessions viola la UNIQUE su token_digest.
    const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
      expiresIn: JWT_REFRESH_EXPIRES_IN,
      jwtid: randomUUID()
    });
    return { accessToken, refreshToken };
  }

  // Impersonation (Fase D2): un access token NORMALE — stesso secret, stessa
  // forma di payload, quindi `authenticate` lo accetta senza saperne niente —
  // ma corto (15 min) e con il claim impersonated_by per l'audit. Nessun
  // refresh token, di proposito: la sessione impersonata muore da sola e non
  // può rinnovarsi, perché il refresh richiede un refresh token firmato col
  // secret di refresh e qui non ne viene emesso nessuno.
  static readonly IMPERSONATION_TTL_SECONDS = 15 * 60;

  static generateImpersonationToken(payload: TokenPayload, impersonatedBy: string): string {
    return jwt.sign(
      { ...payload, impersonated_by: impersonatedBy },
      JWT_SECRET,
      { expiresIn: AuthService.IMPERSONATION_TTL_SECONDS }
    );
  }

  // Sessione di piattaforma scopata su un tenant: a differenza
  // dell'impersonation è una sessione PIENA (access + refresh, riga in
  // user_sessions) con l'identità dell'admin — è lo strumento di lavoro
  // quotidiano del layer di piattaforma, non un intervento di soccorso.
  // Il refresh preserva lo scope leggendolo dal claim (vedi
  // refreshAccessToken): ricostruirlo dalla riga utente riporterebbe la
  // sessione al tenant di casa dell'admin al primo rinnovo.
  static async createPlatformTenantSession(
    adminUserId: number,
    targetTenantId: number
  ): Promise<{ tokens: AuthTokens; email: string } | null> {
    const result = await queryWithRetry(
      'SELECT id, email, role, is_active FROM users WHERE id = $1',
      [adminUserId]
    );
    const row = result.rows[0];
    if (!row || !row.is_active || row.role !== UserRole.PLATFORM_ADMIN) {
      return null;
    }
    const payload: TokenPayload = {
      userId: row.id,
      email: row.email,
      role: UserRole.PLATFORM_ADMIN,
      tenantId: targetTenantId,
      scopedTenantId: targetTenantId
    };
    const tokens = this.generateTokens(payload);
    await this.createSession(row.id, tokens.refreshToken);
    return { tokens, email: row.email };
  }

  // Verify access token
  static verifyAccessToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  }

  // Verify refresh token
  static verifyRefreshToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  }

  // Login user
  static async login(email: string, password: string): Promise<{ user: User; tokens: AuthTokens } | { tenantSuspended: true } | null> {
    const result = await queryWithRetry(
      `SELECT u.id, u.email, u.password_hash, u.full_name, u.phone, u.role, u.is_active,
              u.created_at, u.updated_at, u.last_login, u.preferred_landing_view, u.preferred_orderpad_layout,
              u.tenant_id, t.status AS tenant_status, t.slug AS tenant_slug, t.name AS tenant_name,
              t.onboarding_completed_at IS NULL AS tenant_needs_onboarding
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const userRow = result.rows[0];

    if (!userRow.is_active) {
      return null;
    }

    // Tenant sospeso: l'account è valido ma il ristorante è spento (mancato
    // pagamento, dismissione). Distinto dalle credenziali errate: la UI deve
    // poter spiegare, non dire "password sbagliata".
    if (userRow.tenant_status !== 'active') {
      return { tenantSuspended: true };
    }

    const isValidPassword = await this.verifyPassword(password, userRow.password_hash);
    if (!isValidPassword) {
      return null;
    }

    // Update last login
    await queryWithRetry('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [userRow.id]);

    const payload: TokenPayload = {
      userId: userRow.id,
      email: userRow.email,
      role: userRow.role as UserRole,
      tenantId: Number(userRow.tenant_id)
    };

    const tokens = this.generateTokens(payload);

    // Sessione per-dispositivo: il login NON tocca le sessioni esistenti.
    // Prima viveva tutto in users.refresh_token_hash e ogni login revocava
    // gli altri dispositivi dello stesso account, che morivano alla prima
    // scadenza dell'access token — a metà servizio.
    await this.createSession(userRow.id, tokens.refreshToken);

    const user: User = {
      id: userRow.id,
      email: userRow.email,
      full_name: userRow.full_name,
      phone: userRow.phone ?? null,
      role: userRow.role as UserRole,
      is_active: userRow.is_active,
      created_at: userRow.created_at,
      updated_at: userRow.updated_at,
      last_login: userRow.last_login,
      preferred_landing_view: userRow.preferred_landing_view ?? null,
      preferred_orderpad_layout: userRow.preferred_orderpad_layout ?? null,
      tenant: {
        id: Number(userRow.tenant_id),
        slug: userRow.tenant_slug,
        name: userRow.tenant_name,
        needs_onboarding: userRow.tenant_needs_onboarding === true
      }
    };

    return { user, tokens };
  }

  // Refresh access token
  static async refreshAccessToken(refreshToken: string): Promise<AuthTokens | null> {
    const payload = this.verifyRefreshToken(refreshToken);
    if (!payload) {
      return null;
    }

    // Verify refresh token is still valid in database. Il join sul tenant
    // fa anche da interruttore: sospendere un tenant taglia i refresh, e
    // quindi ogni sessione muore entro il TTL dell'access token (6h).
    const result = await queryWithRetry(
      `SELECT u.id, u.email, u.role, u.is_active, u.refresh_token_hash, u.tenant_id
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active'
        WHERE u.id = $1`,
      [payload.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return null;
    }

    const userRow = result.rows[0];
    const digest = this.digestRefreshToken(refreshToken);

    // La sessione del dispositivo: match sul digest corrente, oppure sul
    // digest precedente entro la finestra di grazia (risposta di refresh
    // persa in rete: il client ritenta col token appena ruotato).
    const sessionResult = await queryWithRetry(
      `SELECT id FROM user_sessions
        WHERE user_id = $1
          AND expires_at > now()
          AND (token_digest = $2
               OR (prev_token_digest = $2 AND rotated_at > now() - ${ROTATION_GRACE_SQL}))
        LIMIT 1`,
      [userRow.id, digest]
    );

    let sessionId: number | null = sessionResult.rows[0]?.id ?? null;

    if (sessionId === null) {
      // Fallback legacy: dispositivo loggato prima delle sessioni
      // per-dispositivo, col suo hash in users.refresh_token_hash. Lo si
      // migra a una riga di sessione e si consuma l'hash (single-use).
      // Il guard sul NULL evita che bcrypt.compare(token, null) lanci e
      // trasformi una revoca legittima in un 500.
      if (!userRow.refresh_token_hash) {
        return null;
      }
      const isLegacyToken = await this.verifyRefreshTokenHash(refreshToken, userRow.refresh_token_hash);
      if (!isLegacyToken) {
        return null;
      }
      const migrated = await queryWithRetry(
        `INSERT INTO user_sessions (user_id, token_digest, expires_at)
         VALUES ($1, $2, now() + ${SESSION_LIFETIME_SQL})
         RETURNING id`,
        [userRow.id, digest]
      );
      sessionId = migrated.rows[0].id;
      await queryWithRetry('UPDATE users SET refresh_token_hash = NULL WHERE id = $1', [userRow.id]);
    }

    const newPayload: TokenPayload = {
      userId: userRow.id,
      email: userRow.email,
      role: userRow.role as UserRole,
      tenantId: Number(userRow.tenant_id)
    };

    // Sessione di piattaforma scopata: lo scope vive solo nel claim (la
    // riga utente punta al tenant di casa dell'admin), quindi va riportato
    // a mano nel payload nuovo. Il ruolo si ricontrolla dalla riga — un
    // admin retrocesso perde lo scope al primo rinnovo — e il tenant
    // bersaglio deve essere ancora attivo: sospenderlo taglia il refresh
    // esattamente come il join qui sopra fa per il tenant di appartenenza.
    if (isPlatformScopedSession({ ...payload, role: userRow.role as UserRole })) {
      const target = await queryWithRetry(
        `SELECT id FROM tenants WHERE id = $1 AND status = 'active'`,
        [payload.scopedTenantId]
      );
      if (target.rows.length === 0) {
        return null;
      }
      newPayload.tenantId = Number(payload.scopedTenantId);
      newPayload.scopedTenantId = Number(payload.scopedTenantId);
    }

    const tokens = this.generateTokens(newPayload);

    // Rotazione con finestra scorrevole: il digest corrente scivola in
    // prev_token_digest (non quello appena presentato: se due tab dello
    // stesso dispositivo si sorpassano in grazia, il token dell'altra tab
    // resta così raggiungibile) e la scadenza riparte da 7 giorni — la
    // sessione vive finché il dispositivo la usa almeno una volta a settimana.
    const newDigest = this.digestRefreshToken(tokens.refreshToken);
    await queryWithRetry(
      `UPDATE user_sessions
          SET prev_token_digest = token_digest,
              rotated_at = now(),
              token_digest = $1,
              last_seen_at = now(),
              expires_at = now() + ${SESSION_LIFETIME_SQL}
        WHERE id = $2`,
      [newDigest, sessionId]
    );

    return tokens;
  }

  // Logout: col refresh token si spegne SOLO la sessione di quel
  // dispositivo (gli altri palmari sullo stesso account restano dentro);
  // senza — o se il token non corrisponde a nessuna sessione, com'è per
  // quelle legacy pre-deploy — si revoca tutto per non lasciare code.
  static async logout(userId: number, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      const digest = this.digestRefreshToken(refreshToken);
      const deleted = await queryWithRetry(
        `DELETE FROM user_sessions
          WHERE user_id = $1 AND (token_digest = $2 OR prev_token_digest = $2)
          RETURNING id`,
        [userId, digest]
      );
      if (deleted.rows.length > 0) {
        return;
      }
    }
    await queryWithRetry('UPDATE users SET refresh_token_hash = NULL WHERE id = $1', [userId]);
    await queryWithRetry('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
  }

  // Get user by ID (con il tenant di appartenenza: /auth/me lo espone
  // alla UI, che da lì sa nome e slug del ristorante).
  static async getUserById(userId: number): Promise<User | null> {
    const result = await queryWithRetry(
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.is_active, u.created_at,
              u.updated_at, u.last_login, u.preferred_landing_view, u.preferred_orderpad_layout,
              u.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name,
              t.onboarding_completed_at IS NULL AS tenant_needs_onboarding
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      phone: row.phone ?? null,
      role: row.role as UserRole,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login: row.last_login,
      preferred_landing_view: row.preferred_landing_view ?? null,
      preferred_orderpad_layout: row.preferred_orderpad_layout ?? null,
      tenant: {
        id: Number(row.tenant_id),
        slug: row.tenant_slug,
        name: row.tenant_name,
        needs_onboarding: row.tenant_needs_onboarding === true
      }
    };
  }

  // Get all users
  // tenantId obbligatorio: senza filtro la lista utenti era di TUTTA la
  // piattaforma — l'owner del tenant Demo vedeva lo staff del Frantoio.
  // PLATFORM_ADMIN escluso sempre: sta sopra i tenant, non appartiene alla
  // gestione utenti di nessun ristorante.
  static async getAllUsers(tenantId: number): Promise<User[]> {
    const result = await queryWithRetry(
      `SELECT id, email, full_name, role, is_active, created_at, updated_at, last_login, preferred_landing_view
         FROM users
        WHERE tenant_id = $1 AND role <> 'PLATFORM_ADMIN'
        ORDER BY created_at DESC`,
      [tenantId]
    );

    return result.rows.map(row => ({
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      role: row.role as UserRole,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login: row.last_login,
      preferred_landing_view: row.preferred_landing_view ?? null
    }));
  }

  // Update only the self-service preferences for a given user (landing view,
  // layout comande). Used by /auth/me/preferences — narrower than updateUser
  // so non-owners can't accidentally touch role/email/etc. `undefined` leaves
  // a field as it is; `null` clears it.
  static async updatePreferences(
    userId: number,
    prefs: { preferred_landing_view?: string | null; preferred_orderpad_layout?: string | null }
  ): Promise<User | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (prefs.preferred_landing_view !== undefined) {
      fields.push(`preferred_landing_view = $${values.length + 1}`);
      values.push(prefs.preferred_landing_view);
    }
    if (prefs.preferred_orderpad_layout !== undefined) {
      fields.push(`preferred_orderpad_layout = $${values.length + 1}`);
      values.push(prefs.preferred_orderpad_layout);
    }
    if (fields.length === 0) {
      return this.getUserById(userId);
    }
    values.push(userId);

    const result = await queryWithRetry(
      `UPDATE users
       SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length}
       RETURNING id, email, full_name, phone, role, is_active, created_at, updated_at, last_login, preferred_landing_view, preferred_orderpad_layout`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      // phone incluso anche qui: il frontend sovrascrive lo user salvato con
      // questa risposta, e senza il campo il telefono "sparirebbe" fino al
      // prossimo /auth/me.
      phone: row.phone ?? null,
      role: row.role as UserRole,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login: row.last_login,
      preferred_landing_view: row.preferred_landing_view ?? null,
      preferred_orderpad_layout: row.preferred_orderpad_layout ?? null
    };
  }

  // Minimal user projection for assignment pickers (no email or audit fields).
  // Returns only active users at or below the actor's rank, sorted alphabetically.
  static async getAssignableUsers(
    actorRole: UserRole,
    tenantId: number
  ): Promise<Array<{ id: number; full_name: string; role: UserRole }>> {
    const allowedRoles = getAssignableRoles(actorRole);
    if (allowedRoles.length === 0) return [];
    const result = await queryWithRetry(
      `SELECT id, full_name, role
       FROM users
       WHERE is_active = TRUE AND role = ANY($1::text[]) AND tenant_id = $2
       ORDER BY full_name`,
      [allowedRoles, tenantId]
    );
    return result.rows.map(row => ({
      id: row.id,
      full_name: row.full_name,
      role: row.role as UserRole,
    }));
  }

  // Create new user
  static async createUser(
    email: string,
    password: string,
    fullName: string,
    role: UserRole,
    // Tenant esplicito: senza, l'INSERT cadeva sul DEFAULT 1 di Fase B e
    // l'OWNER di un tenant nuovo creava il suo staff dentro il tenant 1.
    tenantId: number
  ): Promise<User> {
    const passwordHash = await this.hashPassword(password);

    const result = await queryWithRetry(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
       VALUES ($5, $1, $2, $3, $4)
       RETURNING id, email, full_name, role, is_active, created_at, updated_at`,
      [email.toLowerCase(), passwordHash, fullName, role, tenantId]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      role: row.role as UserRole,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // Update user
  // tenantId obbligatorio: senza, un OWNER poteva modificare (password
  // inclusa) un utente di un ALTRO ristorante conoscendone l'id. Il target
  // PLATFORM_ADMIN è fuori portata per la stessa ragione della lista.
  static async updateUser(
    userId: number,
    tenantId: number,
    updates: { email?: string; full_name?: string; role?: UserRole; is_active?: boolean; password?: string }
  ): Promise<User | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.email !== undefined) {
      fields.push(`email = $${paramIndex++}`);
      values.push(updates.email.toLowerCase());
    }
    if (updates.full_name !== undefined) {
      fields.push(`full_name = $${paramIndex++}`);
      values.push(updates.full_name);
    }
    if (updates.role !== undefined) {
      fields.push(`role = $${paramIndex++}`);
      values.push(updates.role);
    }
    if (updates.is_active !== undefined) {
      fields.push(`is_active = $${paramIndex++}`);
      values.push(updates.is_active);
    }
    if (updates.password !== undefined) {
      const passwordHash = await this.hashPassword(updates.password);
      fields.push(`password_hash = $${paramIndex++}`);
      values.push(passwordHash);
    }

    if (fields.length === 0) {
      return this.getUserById(userId);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);
    values.push(tenantId);

    const query = `UPDATE users SET ${fields.join(', ')}
                   WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1} AND role <> 'PLATFORM_ADMIN'
                   RETURNING id, email, full_name, role, is_active, created_at, updated_at, last_login, preferred_landing_view`;

    const result = await queryWithRetry(query, values);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      role: row.role as UserRole,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login: row.last_login,
      preferred_landing_view: row.preferred_landing_view ?? null
    };
  }

  // Delete user — stesso scoping di updateUser: solo il proprio tenant,
  // mai un PLATFORM_ADMIN.
  static async deleteUser(userId: number, tenantId: number): Promise<boolean> {
    const result = await queryWithRetry(
      `DELETE FROM users WHERE id = $1 AND tenant_id = $2 AND role <> 'PLATFORM_ADMIN' RETURNING id`,
      [userId, tenantId]
    );
    return result.rows.length > 0;
  }

  // ============================================
  // SELF-SERVICE (profilo, password, email, reset)
  // ============================================

  // Update only name and phone for the user themselves. Narrower than
  // updateUser on purpose (same reasoning as updatePreferredLanding): from
  // here nobody can toccare role/email/is_active.
  static async updateOwnProfile(
    userId: number,
    updates: { full_name?: string; phone?: string | null }
  ): Promise<User | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.full_name !== undefined) {
      fields.push(`full_name = $${paramIndex++}`);
      values.push(updates.full_name);
    }
    if (updates.phone !== undefined) {
      fields.push(`phone = $${paramIndex++}`);
      values.push(updates.phone);
    }

    if (fields.length === 0) {
      return this.getUserById(userId);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    const result = await queryWithRetry(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id`,
      values
    );
    if (result.rows.length === 0) {
      return null;
    }
    // Rilettura via getUserById: è la stessa forma (tenant incluso) che
    // login e /auth/me ritornano, così il frontend può sovrascrivere lo
    // user salvato senza perdere campi.
    return this.getUserById(userId);
  }

  // Change own password after re-verifying the current one.
  static async changeOwnPassword(
    userId: number,
    currentPassword: string,
    newPassword: string
  ): Promise<'ok' | 'wrong_password' | 'not_found'> {
    const result = await queryWithRetry('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return 'not_found';
    }

    const isValid = await this.verifyPassword(currentPassword, result.rows[0].password_hash);
    if (!isValid) {
      return 'wrong_password';
    }

    const newHash = await this.hashPassword(newPassword);
    // Tutte le sessioni revocate insieme alla password (l'access token
    // residuo scade da solo entro 6h). È il comportamento atteso dopo un
    // cambio password — chi lo cambia di solito lo fa perché teme che
    // qualcun altro abbia la vecchia.
    await queryWithRetry(
      `UPDATE users
       SET password_hash = $1, refresh_token_hash = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [newHash, userId]
    );
    await queryWithRetry('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    return 'ok';
  }

  // Change own email after re-verifying the password. On success returns the
  // fresh user AND fresh tokens: il JWT contiene l'email — senza nuovi token
  // la sessione mente (ogni middleware leggerebbe ancora quella vecchia).
  static async changeOwnEmail(
    userId: number,
    newEmail: string,
    currentPassword: string
  ): Promise<{ user: User; tokens: AuthTokens } | 'wrong_password' | 'email_conflict' | 'not_found'> {
    const result = await queryWithRetry(
      'SELECT password_hash, tenant_id, role FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return 'not_found';
    }

    const row = result.rows[0];
    const isValid = await this.verifyPassword(currentPassword, row.password_hash);
    if (!isValid) {
      return 'wrong_password';
    }

    const normalizedEmail = newEmail.toLowerCase().trim();
    try {
      await queryWithRetry(
        'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [normalizedEmail, userId]
      );
    } catch (error: any) {
      // UNIQUE globale su email: il controllo sta nel vincolo, non in una
      // SELECT preventiva — così due richieste simultanee non passano entrambe.
      if (error?.code === '23505') {
        return 'email_conflict';
      }
      throw error;
    }

    const payload: TokenPayload = {
      userId,
      email: normalizedEmail,
      role: row.role as UserRole,
      tenantId: Number(row.tenant_id)
    };
    const tokens = this.generateTokens(payload);

    // Tutte le altre sessioni revocate: portano la vecchia email nel JWT e
    // al primo refresh morirebbero comunque invece di continuare a mentire.
    // Solo questa (coi token appena emessi) riparte pulita.
    await queryWithRetry('UPDATE users SET refresh_token_hash = NULL WHERE id = $1', [userId]);
    await queryWithRetry('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    await this.createSession(userId, tokens.refreshToken);

    const user = await this.getUserById(userId);
    if (!user) {
      return 'not_found';
    }
    return { user, tokens };
  }

  // Il token di reset viaggia in chiaro solo nell'email; nel DB vive il suo
  // SHA-256 hex (64 char): un dump del database non basta a resettare niente.
  static digestResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // Store the reset token hash + expiry for a user. Il token in chiaro lo
  // genera la route (crypto.randomBytes) e finisce solo nell'email.
  static async storeResetToken(userId: number, token: string, expiresAt: Date): Promise<void> {
    await queryWithRetry(
      `UPDATE users
       SET reset_token_hash = $1, reset_token_expires_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [this.digestResetToken(token), expiresAt, userId]
    );
  }

  // Consume a reset token: match su hash E scadenza, in un solo UPDATE così
  // due richieste simultanee con lo stesso token non passano entrambe (la
  // seconda non trova più la riga). Ritorna la riga per l'audit log.
  static async resetPasswordWithToken(
    token: string,
    newPassword: string
  ): Promise<{ id: number; email: string; full_name: string; tenantId: number } | null> {
    const newHash = await this.hashPassword(newPassword);
    const result = await queryWithRetry(
      `UPDATE users
       SET password_hash = $1,
           -- single-use: il token si consuma qui, e refresh_token_hash a NULL
           -- fa logout ovunque (chi aveva rubato la sessione la perde).
           reset_token_hash = NULL,
           reset_token_expires_at = NULL,
           refresh_token_hash = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE reset_token_hash = $2
         AND reset_token_expires_at > NOW()
         AND is_active = TRUE
       RETURNING id, email, full_name, tenant_id`,
      [newHash, this.digestResetToken(token)]
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    // Logout ovunque anche per le sessioni per-dispositivo (il NULL su
    // refresh_token_hash nell'UPDATE copre solo quelle legacy).
    await queryWithRetry('DELETE FROM user_sessions WHERE user_id = $1', [row.id]);
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      tenantId: Number(row.tenant_id)
    };
  }
}
