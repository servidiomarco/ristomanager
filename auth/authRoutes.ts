import { Router, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { AuthService } from './authService.js';
import { authenticate, authorize } from './authMiddleware.js';
import { UserRole, ViewState } from '../types.js';
import { RolePermissionService, ALL_PERMISSIONS, Permission } from './permissionService.js';
import { LogService, ActivityAction, ResourceType } from '../activityLogs/logService.js';
import { getTenantFeatures } from '../services/entitlements.js';
import { isSmtpConfigured, sendMail } from '../services/smtpService.js';
import { queryWithRetry } from '../db.js';

const router = Router();

// Policy minima condivisa da cambio password e reset: 8 caratteri. Niente
// regole di composizione — la lunghezza è l'unico requisito che non spinge
// verso password scritte su un post-it.
const MIN_PASSWORD_LENGTH = 8;

// POST /auth/login - User login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await AuthService.login(email, password);

    if (!result) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Credenziali giuste, ristorante spento: non è colpa dell'utente e la
    // UI deve poterlo dire (un 401 generico manderebbe a "password errata").
    if ('tenantSuspended' in result) {
      return res.status(403).json({ error: 'tenant_suspended', message: 'Il servizio per questo ristorante è sospeso.' });
    }

    // Get user's permissions from database
    const permissions = await RolePermissionService.getPermissionsForRole(result.user.tenant!.id, result.user.role);

    // Entitlements commerciali (Fase C1) dentro il tenant: il frontend li
    // legge da qui per sapere quali canali (voice/whatsapp/web_booking) il
    // ristorante ha comprato. Il gating UI arriva col wizard (Fase D).
    const features = await getTenantFeatures(result.user.tenant!.id);

    // Log login activity. Il tenant si legge dalla riga utente appena
    // caricata: qui non c'è ancora un JWT da cui ricavarlo.
    LogService.logActivity(
      result.user.tenant!.id,
      result.user.id,
      result.user.email,
      result.user.full_name,
      ActivityAction.LOGIN,
      ResourceType.AUTH,
      result.user.id,
      result.user.email
    );

    res.json({
      user: { ...result.user, tenant: { ...result.user.tenant!, features } },
      permissions,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/logout - User logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    if (req.user) {
      // Log logout activity
      LogService.logActivity(
        req.user.tenantId,
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.LOGOUT,
        ResourceType.AUTH,
        req.user.userId,
        req.user.email
      );

      await AuthService.logout(req.user.userId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/refresh - Refresh access token
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const tokens = await AuthService.refreshAccessToken(refreshToken);

    if (!tokens) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/me - Get current user with permissions
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await AuthService.getUserById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's permissions from database
    const permissions = await RolePermissionService.getPermissionsForRole(req.user.tenantId, user.role);

    // Entitlements commerciali (C1) — stessa forma della risposta di login.
    const features = await getTenantFeatures(req.user.tenantId);

    res.json({ ...user, tenant: user.tenant ? { ...user.tenant, features } : user.tenant, permissions });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /auth/me/preferences - Update current user's own preferences
// Self-service: any authenticated user can update *their own* preferences only.
// Currently exposes preferred_landing_view; pass null to clear it.
router.put('/me/preferences', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { preferred_landing_view } = req.body as { preferred_landing_view?: string | null };

    // Validate against the ViewState enum so this stays in sync with the
    // frontend automatically — the previous static list drifted (missing
    // RECEPTION, HACCP, PAGAMENTI…) and rejected legitimate choices.
    const allowedViews = Object.values(ViewState) as string[];
    if (preferred_landing_view !== null && preferred_landing_view !== undefined && !allowedViews.includes(preferred_landing_view)) {
      return res.status(400).json({ error: 'Invalid preferred_landing_view' });
    }

    const updated = await AuthService.updatePreferredLanding(
      req.user.userId,
      preferred_landing_view ?? null
    );

    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    const permissions = await RolePermissionService.getPermissionsForRole(req.user.tenantId, updated.role);
    res.json({ ...updated, permissions });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// SELF-SERVICE PROFILE (any authenticated user)
// ============================================

// PUT /auth/me/profile - Update own name and phone
router.put('/me/profile', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { full_name, phone } = req.body as { full_name?: unknown; phone?: unknown };

    const updates: { full_name?: string; phone?: string | null } = {};

    if (full_name !== undefined) {
      if (typeof full_name !== 'string' || full_name.trim().length === 0 || full_name.trim().length > 120) {
        return res.status(400).json({ error: 'invalid_full_name', message: 'Il nome deve avere da 1 a 120 caratteri.' });
      }
      updates.full_name = full_name.trim();
    }

    if (phone !== undefined) {
      if (phone !== null && typeof phone !== 'string') {
        return res.status(400).json({ error: 'invalid_phone' });
      }
      const trimmed = typeof phone === 'string' ? phone.trim() : null;
      if (trimmed && trimmed.length > 30) {
        return res.status(400).json({ error: 'invalid_phone', message: 'Il telefono può avere al massimo 30 caratteri.' });
      }
      // Stringa vuota → NULL: "cancella il telefono" non deve lasciare ''.
      updates.phone = trimmed || null;
    }

    const updated = await AuthService.updateOwnProfile(req.user.userId, updates);
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Stessa forma di /auth/me: user + permissions, così il frontend può
    // sovrascrivere lo user salvato senza un round-trip in più.
    const permissions = await RolePermissionService.getPermissionsForRole(req.user.tenantId, updated.role);
    res.json({ ...updated, permissions });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/me/password - Change own password (requires the current one)
router.post('/me/password', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { current_password, new_password } = req.body as { current_password?: unknown; new_password?: unknown };

    if (typeof current_password !== 'string' || typeof new_password !== 'string' || !current_password || !new_password) {
      return res.status(400).json({ error: 'current_password e new_password sono obbligatori' });
    }
    if (new_password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'weak_password', message: `La nuova password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri.` });
    }

    const outcome = await AuthService.changeOwnPassword(req.user.userId, current_password, new_password);
    if (outcome === 'not_found') {
      return res.status(404).json({ error: 'User not found' });
    }
    if (outcome === 'wrong_password') {
      return res.status(401).json({ error: 'wrong_password', message: 'La password attuale non è corretta.' });
    }

    // Il cambio password azzera refresh_token_hash (vedi changeOwnPassword):
    // le altre sessioni muoiono al primo refresh. Quella corrente vive fino
    // alla scadenza dell'access token e poi rifà il login.
    LogService.logActivity(
      req.user.tenantId,
      req.user.userId,
      req.user.email,
      req.user.email,
      ActivityAction.UPDATE,
      ResourceType.AUTH,
      req.user.userId,
      req.user.email,
      { event: 'password_change' }
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/me/email - Change own email (requires the current password)
router.post('/me/email', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { new_email, current_password } = req.body as { new_email?: unknown; current_password?: unknown };

    if (typeof new_email !== 'string' || typeof current_password !== 'string' || !new_email || !current_password) {
      return res.status(400).json({ error: 'new_email e current_password sono obbligatori' });
    }
    // Validazione volutamente minima (c'è una @ e niente spazi): il vero
    // controllo di un'email è riuscire a scriverci — qui basta non salvare
    // spazzatura evidente.
    const normalized = new_email.toLowerCase().trim();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return res.status(400).json({ error: 'invalid_email', message: 'Indirizzo email non valido.' });
    }

    const result = await AuthService.changeOwnEmail(req.user.userId, normalized, current_password);
    if (result === 'not_found') {
      return res.status(404).json({ error: 'User not found' });
    }
    if (result === 'wrong_password') {
      return res.status(401).json({ error: 'wrong_password', message: 'La password non è corretta.' });
    }
    if (result === 'email_conflict') {
      return res.status(409).json({ error: 'email_conflict', message: 'Questa email è già in uso.' });
    }

    const permissions = await RolePermissionService.getPermissionsForRole(req.user.tenantId, result.user.role);

    LogService.logActivity(
      req.user.tenantId,
      req.user.userId,
      // L'email nel log è quella NUOVA: il vecchio indirizzo resta nei
      // dettagli, così l'audit racconta il cambio per intero.
      result.user.email,
      result.user.full_name,
      ActivityAction.UPDATE,
      ResourceType.AUTH,
      req.user.userId,
      result.user.email,
      { event: 'email_change', previous_email: req.user.email }
    );

    // Token freschi nella risposta: il JWT contiene l'email — senza nuovi
    // token la sessione mente (e ogni log/audit riporterebbe quella vecchia).
    res.json({
      user: result.user,
      permissions,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken
    });
  } catch (error) {
    console.error('Change email error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// PASSWORD RESET (unauthenticated)
// ============================================

// Stesso pattern di publicBookingLimiter in server.ts: endpoint pubblico,
// cap per IP. 5 richieste ogni 15 minuti bastano a chi ha davvero
// dimenticato la password e stroncano l'harvesting di indirizzi.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Troppe richieste, riprova tra qualche minuto.' },
});

// POST /auth/forgot-password - Request a password reset email.
// NIENTE user enumeration: la risposta è SEMPRE 200 { ok: true }, identica
// per email esistente, inesistente, utente disattivato o SMTP mancante.
// Qualunque differenza (status, corpo, perfino un errore 500) direbbe a un
// attaccante quali indirizzi hanno un account.
router.post('/forgot-password', forgotPasswordLimiter, async (req: Request, res: Response) => {
  const uniformReply = () => res.json({ ok: true });

  try {
    const { email } = req.body as { email?: unknown };
    if (typeof email !== 'string' || !email.trim()) {
      // Anche il body malformato risponde 200: un 400 qui non serve a un
      // utente vero (il form manda sempre l'email) e differenzia le risposte.
      return uniformReply();
    }

    // businessIdentity() vive in server.ts e importarla da qui creerebbe un
    // ciclo (server.ts importa queste route): il nome del ristorante per
    // l'email arriva dalla stessa riga tenants che businessIdentity usa come
    // fallback.
    const result = await queryWithRetry(
      `SELECT u.id, u.full_name, u.tenant_id, t.name AS tenant_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active'
        WHERE u.email = $1 AND u.is_active = TRUE`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return uniformReply();
    }

    const userRow = result.rows[0];
    const tenantId = Number(userRow.tenant_id);

    if (!(await isSmtpConfigured(tenantId))) {
      // Il warn è l'unico posto dove la differenza è visibile — nei log del
      // server, mai nella risposta.
      console.warn(`[forgot-password] SMTP non configurato per il tenant ${tenantId}: reset non inviabile per l'utente ${userRow.id}`);
      return uniformReply();
    }

    // 32 byte random → 64 hex: il token vive in chiaro solo dentro l'email;
    // nel DB va il suo SHA-256, con scadenza a 60 minuti.
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await AuthService.storeResetToken(userRow.id, token, expiresAt);

    const baseUrl = (process.env.CRM_APP_BASE_URL || 'https://crm.vecchiofrantoio.com').replace(/\/+$/, '');
    const resetLink = `${baseUrl}/?reset=${token}`;
    const restaurantName = String(userRow.tenant_name || '');

    await sendMail(tenantId, {
      to: email.toLowerCase().trim(),
      subject: `Reimposta la tua password — ${restaurantName}`,
      text:
        `Ciao ${userRow.full_name},\n\n` +
        `per scegliere una nuova password apri questo link:\n\n` +
        `${resetLink}\n\n` +
        `Il link vale 1 ora e funziona una volta sola.\n` +
        `Se non hai chiesto tu il reset, ignora questa email: la password resta quella attuale.\n\n` +
        `${restaurantName}`,
      html:
        `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">` +
        `<p style="font-size:16px;margin:0 0 16px">Ciao ${userRow.full_name},</p>` +
        `<p style="font-size:15px;margin:0 0 20px">per scegliere una nuova password apri questo link:</p>` +
        `<p style="margin:0 0 20px"><a href="${resetLink}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:15px">Reimposta la password</a></p>` +
        `<p style="font-size:13px;color:#666;margin:0 0 8px">Il link vale 1 ora e funziona una volta sola.</p>` +
        `<p style="font-size:13px;color:#666;margin:0 0 20px">Se non hai chiesto tu il reset, ignora questa email: la password resta quella attuale.</p>` +
        `<p style="font-size:13px;color:#666;margin:0">${restaurantName}</p>` +
        `</div>`,
    });

    return uniformReply();
  } catch (error) {
    // Anche in errore la risposta resta identica: un 500 solo per certe
    // email sarebbe a sua volta un oracolo.
    console.error('Forgot password error:', error);
    return uniformReply();
  }
});

// POST /auth/reset-password - Consume a reset token and set a new password
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, new_password } = req.body as { token?: unknown; new_password?: unknown };

    if (typeof token !== 'string' || !token || typeof new_password !== 'string' || !new_password) {
      return res.status(400).json({ error: 'token e new_password sono obbligatori' });
    }
    if (new_password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'weak_password', message: `La nuova password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri.` });
    }

    const user = await AuthService.resetPasswordWithToken(token, new_password);
    if (!user) {
      // Token sbagliato, già usato o scaduto: stessa risposta in tutti i
      // casi, il chiamante non deve poter distinguere.
      return res.status(400).json({ error: 'invalid_or_expired', message: 'Il link non è più valido. Richiedi un nuovo reset.' });
    }

    LogService.logActivity(
      user.tenantId,
      user.id,
      user.email,
      user.full_name,
      ActivityAction.UPDATE,
      ResourceType.AUTH,
      user.id,
      user.email,
      { event: 'password_reset' }
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// USER MANAGEMENT ROUTES (Owner only)
// ============================================

// GET /auth/users - List all users
router.get('/users', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    console.log('Fetching all users...');
    const users = await AuthService.getAllUsers();
    console.log(`Found ${users.length} users`);
    res.json(users);
  } catch (error: any) {
    console.error('Get users error:', error.message, error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /auth/users/assignable - Minimal active-user list for task assignment pickers.
// Available to managers and above so they can assign todos to specific people.
// The list is scoped to the requester's rank: a manager only sees peers and below.
router.get(
  '/users/assignable',
  authenticate,
  authorize(UserRole.OWNER, UserRole.GENERAL_MANAGER, UserRole.MANAGER),
  async (req: Request, res: Response) => {
    try {
      const users = await AuthService.getAssignableUsers(req.user!.role);
      res.json(users);
    } catch (error: any) {
      console.error('Get assignable users error:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /auth/users - Create new user
router.post('/users', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'Email, password, full_name, and role are required' });
    }

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // PLATFORM_ADMIN sta sopra i tenant: se un OWNER potesse crearlo da qui
    // sarebbe una privilege escalation verso l'intera piattaforma. Si crea
    // solo a mano via SQL (Fase D2).
    if (role === UserRole.PLATFORM_ADMIN) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await AuthService.createUser(email, password, full_name, role, req.user!.tenantId);

    // Log activity
    if (req.user) {
      LogService.logActivity(
        req.user.tenantId,
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.CREATE,
        ResourceType.USER,
        user.id,
        user.email,
        { role, full_name }
      );
    }

    res.status(201).json(user);
  } catch (error: any) {
    console.error('Create user error:', error);
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /auth/users/:id - Update user
router.put('/users/:id', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { email, password, full_name, role, is_active } = req.body;

    if (role && !Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Stessa guardia della POST: nessuna promozione a PLATFORM_ADMIN dalla
    // gestione utenti di un tenant.
    if (role === UserRole.PLATFORM_ADMIN) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await AuthService.updateUser(userId, {
      email,
      password,
      full_name,
      role,
      is_active
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log activity
    if (req.user) {
      LogService.logActivity(
        req.user.tenantId,
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.UPDATE,
        ResourceType.USER,
        userId,
        user.email,
        { role, full_name, is_active }
      );
    }

    res.json(user);
  } catch (error: any) {
    console.error('Update user error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /auth/users/:id - Delete user
router.delete('/users/:id', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);

    // Prevent deleting yourself
    if (req.user && req.user.userId === userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Get user email before deleting
    const userToDelete = await AuthService.getUserById(userId);
    const userEmail = userToDelete?.email;

    const deleted = await AuthService.deleteUser(userId);

    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log activity
    if (req.user) {
      LogService.logActivity(
        req.user.tenantId,
        req.user.userId,
        req.user.email,
        req.user.email,
        ActivityAction.DELETE,
        ResourceType.USER,
        userId,
        userEmail
      );
    }

    res.status(204).send();
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// ROLE PERMISSIONS MANAGEMENT (Owner only)
// ============================================

// GET /auth/permissions - Get all available permissions
router.get('/permissions', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    res.json({
      features: ALL_PERMISSIONS,
      // PLATFORM_ADMIN è un ruolo di piattaforma, non di tenant: nella
      // matrice permessi di un ristorante non ha senso e non deve comparire.
      roles: Object.values(UserRole).filter(r => r !== UserRole.PLATFORM_ADMIN)
    });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/permissions/roles - Get all role permissions
router.get('/permissions/roles', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const permissions = await RolePermissionService.getAllRolePermissions(req.user!.tenantId);
    res.json(permissions);
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/permissions/roles/:role - Get permissions for a specific role
router.get('/permissions/roles/:role', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const role = req.params.role.toUpperCase() as UserRole;

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const permissions = await RolePermissionService.getPermissionsForRole(req.user!.tenantId, role);
    res.json({ role, permissions });
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /auth/permissions/roles/:role - Update permissions for a role
router.put('/permissions/roles/:role', authenticate, authorize(UserRole.OWNER), async (req: Request, res: Response) => {
  try {
    const role = req.params.role.toUpperCase() as UserRole;
    const { permissions } = req.body;

    if (!Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Permissions must be an array' });
    }

    // Prevent removing critical permissions from OWNER role
    if (role === UserRole.OWNER) {
      const requiredOwnerPermissions = ['users:full', 'settings:full'];
      for (const required of requiredOwnerPermissions) {
        if (!permissions.includes(required)) {
          return res.status(400).json({
            error: `Cannot remove ${required} permission from OWNER role`
          });
        }
      }
    }

    await RolePermissionService.setPermissionsForRole(req.user!.tenantId, role, permissions as Permission[]);

    const updatedPermissions = await RolePermissionService.getPermissionsForRole(req.user!.tenantId, role);
    res.json({ role, permissions: updatedPermissions });
  } catch (error) {
    console.error('Update role permissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
