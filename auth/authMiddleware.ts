import { Request, Response, NextFunction } from 'express';
import { AuthService, TokenPayload, isPlatformScopedSession } from './authService.js';
import { Permission } from './permissions.js';
import { RolePermissionService } from './permissionService.js';
import { UserRole } from '../types.js';
import { runWithTenantContext, runAsPlatform } from '../db.js';

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

// Authentication middleware - verifies JWT token
export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  const payload = AuthService.verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = { ...payload, tenantId: normalizeTenantId(payload) };
  req.tenantId = req.user.tenantId;
  // Il resto della richiesta gira nel contesto del tenant: da qui in giù
  // ogni query del pool si scopa da sola (RLS rigida compresa, quando
  // accesa). PLATFORM_ADMIN è piattaforma per definizione: le sue letture
  // (pannello, impersonation) attraversano i tenant di mestiere — MA una
  // sessione scopata su un tenant (claim scopedTenantId) è operativa e gira
  // nel contesto di QUEL tenant, così non attraversa gli altri per sbaglio.
  if (req.user.role === UserRole.PLATFORM_ADMIN && !isPlatformScopedSession(req.user)) {
    return runAsPlatform(() => next());
  }
  return runWithTenantContext(req.tenantId, () => next());
};

// Authorization middleware factory - checks role permissions
export const authorize = (...allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
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
