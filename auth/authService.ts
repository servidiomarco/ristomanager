import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryWithRetry } from '../db.js';
import { User, UserRole } from '../types.js';
import { getAssignableRoles } from './permissions.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production';
const JWT_EXPIRES_IN = '6h';
const JWT_REFRESH_EXPIRES_IN = '7d';

export interface TokenPayload {
  userId: number;
  email: string;
  role: UserRole;
  // Fase B2 del piano SaaS: il tenant viaggia nel token. I token emessi
  // prima del deploy non hanno il claim (TTL 6h): chi li verifica
  // normalizza col fallback 1 — corretto per tutti gli utenti esistenti.
  // Il fallback va rimosso prima di accendere il secondo tenant.
  tenantId: number;
}

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

  // I refresh token sono JWT da ~250 byte, ma bcrypt considera solo i primi
  // 72: header e inizio payload sono identici per tutti i token dello stesso
  // utente, quindi il confronto diretto passava per QUALUNQUE token emesso e
  // la rotazione non revocava niente. Il digest SHA-256 (44 caratteri in
  // base64) porta l'intero token dentro la finestra di bcrypt.
  //
  // Il cambio di formato invalida gli hash già salvati: al primo refresh
  // dopo il deploy ogni sessione attiva riceve 401 e rifà il login una volta.
  private static digestRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('base64');
  }

  private static async hashRefreshToken(token: string): Promise<string> {
    return this.hashPassword(this.digestRefreshToken(token));
  }

  private static async verifyRefreshTokenHash(token: string, hash: string): Promise<boolean> {
    return this.verifyPassword(this.digestRefreshToken(token), hash);
  }

  // Generate access and refresh tokens
  static generateTokens(payload: TokenPayload): AuthTokens {
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
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
              u.created_at, u.updated_at, u.last_login, u.preferred_landing_view,
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

    // Store refresh token hash
    const refreshTokenHash = await this.hashRefreshToken(tokens.refreshToken);
    await queryWithRetry('UPDATE users SET refresh_token_hash = $1 WHERE id = $2', [refreshTokenHash, userRow.id]);

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

    // Dopo il logout l'hash è NULL: senza questo guard bcrypt.compare(token,
    // null) lancia e una revoca legittima risponde 500 invece di 401.
    if (!userRow.refresh_token_hash) {
      return null;
    }

    // Verify refresh token hash matches
    const isValidRefreshToken = await this.verifyRefreshTokenHash(refreshToken, userRow.refresh_token_hash);
    if (!isValidRefreshToken) {
      return null;
    }

    const newPayload: TokenPayload = {
      userId: userRow.id,
      email: userRow.email,
      role: userRow.role as UserRole,
      tenantId: Number(userRow.tenant_id)
    };

    const tokens = this.generateTokens(newPayload);

    // Update refresh token hash
    const newRefreshTokenHash = await this.hashRefreshToken(tokens.refreshToken);
    await queryWithRetry('UPDATE users SET refresh_token_hash = $1 WHERE id = $2', [newRefreshTokenHash, userRow.id]);

    return tokens;
  }

  // Logout user (invalidate refresh token)
  static async logout(userId: number): Promise<void> {
    await queryWithRetry('UPDATE users SET refresh_token_hash = NULL WHERE id = $1', [userId]);
  }

  // Get user by ID (con il tenant di appartenenza: /auth/me lo espone
  // alla UI, che da lì sa nome e slug del ristorante).
  static async getUserById(userId: number): Promise<User | null> {
    const result = await queryWithRetry(
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.is_active, u.created_at,
              u.updated_at, u.last_login, u.preferred_landing_view,
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

  // Update only the preferred landing view for a given user. Used by the
  // self-service /auth/me/preferences endpoint — narrower than updateUser
  // so non-owners can't accidentally touch role/email/etc.
  static async updatePreferredLanding(
    userId: number,
    view: string | null
  ): Promise<User | null> {
    const result = await queryWithRetry(
      `UPDATE users
       SET preferred_landing_view = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, email, full_name, phone, role, is_active, created_at, updated_at, last_login, preferred_landing_view`,
      [view, userId]
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
      preferred_landing_view: row.preferred_landing_view ?? null
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
    // refresh_token_hash a NULL insieme alla password: le altre sessioni
    // muoiono al primo refresh (l'access token residuo scade da solo entro
    // 6h). È il comportamento atteso dopo un cambio password — chi lo cambia
    // di solito lo fa perché teme che qualcun altro abbia la vecchia.
    await queryWithRetry(
      `UPDATE users
       SET password_hash = $1, refresh_token_hash = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [newHash, userId]
    );
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

    // La rotazione dell'hash revoca il refresh token precedente: eventuali
    // altre sessioni (che portano la vecchia email nel JWT) muoiono al primo
    // refresh invece di continuare a mentire.
    const refreshTokenHash = await this.hashRefreshToken(tokens.refreshToken);
    await queryWithRetry('UPDATE users SET refresh_token_hash = $1 WHERE id = $2', [refreshTokenHash, userId]);

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
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      tenantId: Number(row.tenant_id)
    };
  }
}
