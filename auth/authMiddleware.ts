import { Request, Response, NextFunction } from 'express';
import { AuthService, TokenPayload, isPlatformScopedSession } from './authService.js';
import { Permission, SERVICE_PERMISSIONS } from './permissions.js';
import { RolePermissionService } from './permissionService.js';
import { UserRole } from '../types.js';
import { runWithTenantContext } from '../db.js';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      // Tenant della richiesta (Fase B2). Impostato da authenticate; è il
      // valore su cui le route scopano le query man mano che la Fase B3
      // le converte.
      tenantId?: number;
    }
  }
}

// I token emessi prima della Fase B2 non hanno il claim tenantId (TTL 6h):
// il fallback 1 è corretto per tutti gli utenti esistenti e va rimosso
// prima di accendere il secondo tenant.
const normalizeTenantId = (payload: TokenPayload): number =>
  Number.isInteger(payload.tenantId) && payload.tenantId > 0 ? payload.tenantId : 1;

// La politica d'accesso del nodo di sala (fase A2 del piano «sala, comande e
// conto sul nodo»), iniettata da server.ts solo col profilo service-node
// (services/salaNodeAccess.ts). Sul cloud resta null e non cambia niente.
// - nodeTenant/loadNodeTenant: il nodo serve UN ristorante; il token di un
//   altro tenant, pur firmato dal cloud, qui non apre niente. Prima del
//   bootstrap il nodo non sa chi serve (e non ha dati): rifiuta tutto.
// - offlineGrace: a linea giù il cameriere non può rinnovare il token (il
//   refresh vive nel cloud). Un token scaduto da poco, di un utente attivo,
//   vale ancora: altrimenti dopo qualche ora di guasto tutti i palmari
//   cadrebbero insieme, in pieno servizio.
export type OfflineGraceVerdict = 'ok' | 'expired_offline' | 'not_offline' | 'invalid';
export interface NodeAccessPolicy {
  nodeTenant: () => number | null;
  loadNodeTenant: () => Promise<number | null>;
  offlineGrace: (payload: TokenPayload, expiresAtMs: number | null) => Promise<OfflineGraceVerdict>;
}
let nodeAccessPolicy: NodeAccessPolicy | null = null;
export const setNodeAccessPolicy = (policy: NodeAccessPolicy | null): void => {
  nodeAccessPolicy = policy;
};

export type AccessTokenResolution =
  | { ok: true; payload: TokenPayload }
  | { ok: false; error: 'Invalid or expired token' | 'session_expired_offline' };

const INVALID: AccessTokenResolution = { ok: false, error: 'Invalid or expired token' };

/** L'access token di una richiesta o di un handshake socket, con la
 *  politica del nodo applicata. Sincrona nel caso comune; sul nodo passa da
 *  una promessa per un token scaduto o finché il tenant non è letto. */
export const resolveAccessToken = (token: string): AccessTokenResolution | Promise<AccessTokenResolution> => {
  const inspected = AuthService.inspectAccessToken(token);
  if (!inspected) return INVALID;
  const payload: TokenPayload = { ...inspected.payload, tenantId: normalizeTenantId(inspected.payload) };
  const policy = nodeAccessPolicy;
  if (!policy) return inspected.expired ? INVALID : { ok: true, payload };
  const decide = (nodeTenant: number | null): AccessTokenResolution | Promise<AccessTokenResolution> => {
    if (nodeTenant === null || payload.tenantId !== nodeTenant) return INVALID;
    if (!inspected.expired) return { ok: true, payload };
    return offlineGraceFor(policy, payload, inspected.expiresAtMs);
  };
  const known = policy.nodeTenant();
  if (known !== null) return decide(known);
  return policy.loadNodeTenant().then(decide).catch(() => INVALID);
};

const offlineGraceFor = (policy: NodeAccessPolicy, payload: TokenPayload, expiresAtMs: number | null): Promise<AccessTokenResolution> =>
  policy.offlineGrace(payload, expiresAtMs).then((verdict): AccessTokenResolution => {
    if (verdict === 'ok') return { ok: true, payload };
    // Proroga finita (o utente disattivato) a linea giù: un codice a parte,
    // così il client mostra «sessione scaduta senza linea» invece di
    // sembrare collegato. A linea su resta il 401 di sempre e il client
    // rinnova il token col cloud.
    return verdict === 'expired_offline' ? { ok: false, error: 'session_expired_offline' } : INVALID;
  }).catch(() => INVALID);

// Authentication middleware - verifies JWT token
export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  const resolution = resolveAccessToken(token);
  if (resolution instanceof Promise) {
    resolution.then((r) => admit(req, res, next, r)).catch(() => {
      if (!res.headersSent) res.status(401).json({ error: 'Invalid or expired token' });
    });
    return;
  }
  return admit(req, res, next, resolution);
};

const admit = (req: Request, res: Response, next: NextFunction, resolution: AccessTokenResolution) => {
  if ('error' in resolution) {
    return res.status(401).json({ error: resolution.error });
  }
  const payload = resolution.payload;
  req.user = { ...payload, tenantId: normalizeTenantId(payload) };
  req.tenantId = req.user.tenantId;
  // Il resto della richiesta gira nel contesto del tenant: da qui in giù
  // ogni query del pool si scopa da sola (RLS rigida compresa, quando
  // accesa). Vale anche per PLATFORM_ADMIN. Scopato («Entra») il suo
  // tenantId è quello bersaglio; senza scope (la sessione del pannello) è
  // il tenant di casa della riga utente. Il pannello non passa da qui:
  // /admin/* ha platformAdminAuth con il suo runAsPlatform. Fino
  // all'audit isolamento M-03 il token di pannello girava in runAsPlatform
  // su OGNI route: quelle che si affidavano alla RLS invece che al WHERE
  // tenant_id mescolavano i tenant. Il report AI, per esempio, leggeva le
  // sale dei tenant demo, e con quelle le prompt injection di chi ha le
  // credenziali demo. Fuori da /admin quel token è un utente del tenant di
  // casa senza permessi, niente di più.
  return runWithTenantContext(req.tenantId, () => next());
};

// Authorization middleware factory - checks role permissions
export const authorize = (...allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // I gate di ruolo proteggono amministrazione (utenti, permessi,
    // onboarding): una sessione col PIN di sala non ci entra mai, nemmeno
    // quella di un titolare.
    if (req.user.scope === 'service') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Layer di piattaforma: una sessione scopata su un tenant passa ogni
    // gate di ruolo — PLATFORM_ADMIN sta sopra OWNER per costruzione
    // (ROLE_RANK) e elencarlo route per route sarebbe solo rumore. Senza
    // scope invece vale la lista: il token di pannello non opera nel tenant.
    if (!allowedRoles.includes(req.user.role) && !isPlatformScopedSession(req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

// Permission-based authorization middleware factory.
// Reads from the DB-backed `role_permissions` table (with 1-minute cache)
// so that changes made via the role permissions UI take effect on the API.
export const requirePermission = (permission: Permission) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Il bypass della matrice è il cuore del layer di piattaforma: la
    // sessione scopata ha OGNI permesso nel tenant, e in particolare quelli
    // che la Fase B (permessi riservati) toglierà ai ruoli del tenant.
    // PLATFORM_ADMIN non ha righe in role_permissions e non deve averne.
    if (isPlatformScopedSession(req.user)) {
      return next();
    }

    // Sessione col PIN di sala: solo i permessi di servizio.
    if (req.user.scope === 'service' && !SERVICE_PERMISSIONS.has(permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    try {
      const allowed = await RolePermissionService.hasPermission(req.user.tenantId, req.user.role, permission);
      if (!allowed) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch (err) {
      console.error('Permission check failed:', err);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

// Step-up: la sezione riservata (es. Compensi) esige, OLTRE alla sessione e
// al permesso, un token di sblocco fresco ottenuto ridigitando la password
// (POST /auth/step-up). Viaggia nell'header X-Step-Up-Token e deve
// appartenere allo stesso utente e tenant della sessione: un token raccolto
// altrove non apre niente. Il 401 con error dedicato è il segnale al client
// di rimostrare il prompt password — da distinguere sul BODY, perché
// fetchWithAuth su un 401 prova prima il refresh dell'access token.
export const requireStepUp = (scope: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = req.headers['x-step-up-token'];
    const payload = typeof token === 'string' ? AuthService.verifyStepUpToken(token, scope) : null;
    if (!payload || payload.userId !== req.user.userId || payload.tenantId !== req.user.tenantId) {
      return res.status(401).json({ error: 'step_up_required' });
    }

    next();
  };
};

// Come requirePermission, ma basta uno dei permessi elencati. Serve alle
// azioni condivise fra sala e passe (es. segnare servita un'uscita): WAITER
// ha orders:take senza expedite, KITCHEN l'inverso, e un permesso nuovo solo
// per questo gonfierebbe la matrice.
export const requireAnyPermission = (...permissions: Permission[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Stesso bypass di requirePermission: la sessione di piattaforma
    // scopata passa senza consultare la matrice.
    if (isPlatformScopedSession(req.user)) {
      return next();
    }

    try {
      for (const permission of permissions) {
        // Sessione col PIN di sala: contano solo i permessi di servizio.
        if (req.user.scope === 'service' && !SERVICE_PERMISSIONS.has(permission)) continue;
        if (await RolePermissionService.hasPermission(req.user.tenantId, req.user.role, permission)) {
          return next();
        }
      }
      return res.status(403).json({ error: 'Insufficient permissions' });
    } catch (err) {
      console.error('Permission check failed:', err);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
};

// Optional authentication - doesn't fail if no token, but adds user if present
export const optionalAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const payload = AuthService.verifyAccessToken(token);
    if (payload) {
      req.user = { ...payload, tenantId: normalizeTenantId(payload) };
      req.tenantId = req.user.tenantId;
    }
  }

  next();
};
