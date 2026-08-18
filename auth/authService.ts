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
      `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.is_active,
              u.created_at, u.updated_at, u.last_login, u.preferred_landing_view,
              u.tenant_id, t.status AS tenant_status, t.slug AS tenant_slug, t.name AS tenant_name
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
      role: userRow.role as UserRole,
      is_active: userRow.is_active,
      created_at: userRow.created_at,
      updated_at: userRow.updated_at,
      last_login: userRow.last_login,
      preferred_landing_view: userRow.preferred_landing_view ?? null,
      tenant: {
        id: Number(userRow.tenant_id),
        slug: userRow.tenant_slug,
        name: userRow.tenant_name
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
      `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at,
              u.updated_at, u.last_login, u.preferred_landing_view,
              u.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name
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
      role: row.role as UserRole,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login: row.last_login,
      preferred_landing_view: row.preferred_landing_view ?? null,
      tenant: {
        id: Number(row.tenant_id),
        slug: row.tenant_slug,
        name: row.tenant_name
      }
    };
  }

  // Get all users
  static async getAllUsers(): Promise<User[]> {
    const result = await queryWithRetry(
      'SELECT id, email, full_name, role, is_active, created_at, updated_at, last_login, preferred_landing_view FROM users ORDER BY created_at DESC'
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
       RETURNING id, email, full_name, role, is_active, created_at, updated_at, last_login, preferred_landing_view`,
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
    actorRole: UserRole
  ): Promise<Array<{ id: number; full_name: string; role: UserRole }>> {
    const allowedRoles = getAssignableRoles(actorRole);
    if (allowedRoles.length === 0) return [];
    const result = await queryWithRetry(
      `SELECT id, full_name, role
       FROM users
       WHERE is_active = TRUE AND role = ANY($1::text[])
       ORDER BY full_name`,
      [allowedRoles]
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
    role: UserRole
  ): Promise<User> {
    const passwordHash = await this.hashPassword(password);

    const result = await queryWithRetry(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role, is_active, created_at, updated_at`,
      [email.toLowerCase(), passwordHash, fullName, role]
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
  static async updateUser(
    userId: number,
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

    const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, email, full_name, role, is_active, created_at, updated_at, last_login, preferred_landing_view`;

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

  // Delete user
  static async deleteUser(userId: number): Promise<boolean> {
    const result = await queryWithRetry('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
    return result.rows.length > 0;
  }
}
