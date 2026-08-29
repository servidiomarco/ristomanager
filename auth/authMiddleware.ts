import { Request, Response, NextFunction } from 'express';
import { AuthService, TokenPayload } from './authService.js';
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
  // (pannello, impersonation) attraversano i tenant di mestiere.
  if (req.user.role === UserRole.PLATFORM_ADMIN) {
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

    if (!allowedRoles.includes(req.user.role)) {
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
