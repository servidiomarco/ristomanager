import pool, { queryWithRetry } from '../db.js';
import { UserRole } from '../types.js';
import type { Permission } from './permissions.js';

export type { Permission };

// All available permissions grouped by feature
export const ALL_PERMISSIONS: { feature: string; permissions: Permission[] }[] = [
  { feature: 'Dashboard', permissions: ['dashboard:view', 'dashboard:full'] },
  { feature: 'Sale e Tavoli', permissions: ['floorplan:view', 'floorplan:update_status', 'floorplan:full'] },
  { feature: 'Menu e Banchetti', permissions: ['menu:view', 'menu:full', 'banquet:view_price'] },
  { feature: 'Prenotazioni', permissions: ['reservations:view', 'reservations:full'] },
  { feature: 'Reception', permissions: ['reception:view'] },
  { feature: 'Personale', permissions: ['staff:view', 'staff:full'] },
  { feature: 'Clienti', permissions: ['customers:view', 'customers:full'] },
  { feature: 'Inventario', permissions: ['inventory:view', 'inventory:full'] },
  { feature: 'Impostazioni', permissions: ['settings:view', 'settings:full'] },
  { feature: 'Gestione Utenti', permissions: ['users:view', 'users:full'] },
  { feature: 'Report', permissions: ['reports:view', 'reports:full'] },
  { feature: 'Log Attività', permissions: ['logs:view', 'logs:full'] },
  { feature: 'Conversazioni', permissions: ['voice_calls:view'] },
  { feature: 'Pagamenti', permissions: ['payments:view', 'payments:full'] },
  { feature: 'Comande e Cucina', permissions: ['orders:view', 'orders:take', 'orders:kds', 'orders:expedite', 'orders:void'] }
];

// Fase B2 del piano SaaS: la matrice permessi è PER TENANT — ogni
// ristorante può personalizzare cosa fa un MANAGER senza toccare gli
// altri. La cache è keyed per tenant, con la stessa semantica
// last-known-good di prima: le voci stantie restano usabili quando il DB
// è irraggiungibile (Railway Postgres sul piano hobby ricicla il
// container ogni pochi minuti), così un'interruzione transitoria non
// nega ogni scrittura autenticata con un 403 fuorviante.
type TenantPermissionsCache = {
  permissions: Record<string, Permission[]>;
  lastSuccessfulRefresh: number;
  lastRefreshAttempt: number;
};

const cacheByTenant = new Map<number, TenantPermissionsCache>();
const CACHE_TTL = 5 * 60 * 1000;       // 5 min between proactive refreshes
const REFRESH_BACKOFF_MS = 5_000;      // after a failed refresh, wait 5s before retrying

const emptyRoleMap = (): Record<string, Permission[]> => ({
  OWNER: [], GENERAL_MANAGER: [], MANAGER: [], RECEPTION: [], WAITER: [], KITCHEN: []
});

const totalPermissionsIn = (snap: Record<string, Permission[]>): number =>
  Object.values(snap).reduce((n, arr) => n + arr.length, 0);

const tenantCache = (tenantId: number): TenantPermissionsCache => {
  let entry = cacheByTenant.get(tenantId);
  if (!entry) {
    entry = { permissions: emptyRoleMap(), lastSuccessfulRefresh: 0, lastRefreshAttempt: 0 };
    cacheByTenant.set(tenantId, entry);
  }
  return entry;
};

const refreshPermissionCache = async (tenantId: number): Promise<void> => {
  const entry = tenantCache(tenantId);
  const now = Date.now();
  if (now - entry.lastSuccessfulRefresh < CACHE_TTL) return;
  if (now - entry.lastRefreshAttempt < REFRESH_BACKOFF_MS) return;
  entry.lastRefreshAttempt = now;

  let fresh: Record<string, Permission[]>;
  try {
    fresh = await RolePermissionService.getAllRolePermissions(tenantId);
  } catch (err) {
    if (entry.lastSuccessfulRefresh > 0) {
      console.warn(`[perms] DB read failed (tenant ${tenantId}); using stale cache from`,
        new Date(entry.lastSuccessfulRefresh).toISOString(), '-', (err as Error)?.message);
      return;
    }
    throw err;
  }

  if (totalPermissionsIn(fresh) === 0) {
    if (entry.lastSuccessfulRefresh > 0) {
      console.warn(`[perms] DB returned empty role_permissions (tenant ${tenantId}); keeping stale cache`);
      return;
    }
    throw new Error(`role_permissions is empty for tenant ${tenantId}`);
  }

  entry.permissions = fresh;
  entry.lastSuccessfulRefresh = now;
};

const invalidate = (tenantId: number): void => {
  const entry = tenantCache(tenantId);
  entry.lastSuccessfulRefresh = 0;
  entry.lastRefreshAttempt = 0;
};

export class RolePermissionService {
  // Get all permissions for a role from database
  static async getPermissionsForRole(tenantId: number, role: UserRole): Promise<Permission[]> {
    const result = await queryWithRetry(
      'SELECT permission FROM role_permissions WHERE tenant_id = $1 AND role = $2',
      [tenantId, role]
    );
    return result.rows.map(row => row.permission as Permission);
  }

  // Get all role permissions (for admin UI)
  static async getAllRolePermissions(tenantId: number): Promise<Record<string, Permission[]>> {
    const result = await queryWithRetry(
      'SELECT role, permission FROM role_permissions WHERE tenant_id = $1 ORDER BY role, permission',
      [tenantId]
    );

    const permissions = emptyRoleMap();
    for (const row of result.rows) {
      if (permissions[row.role]) {
        permissions[row.role].push(row.permission as Permission);
      }
    }

    return permissions;
  }

  // Set permissions for a role (replaces existing permissions)
  static async setPermissionsForRole(tenantId: number, role: UserRole, permissions: Permission[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query('DELETE FROM role_permissions WHERE tenant_id = $1 AND role = $2', [tenantId, role]);

      for (const permission of permissions) {
        await client.query(
          'INSERT INTO role_permissions (tenant_id, role, permission) VALUES ($1, $2, $3)',
          [tenantId, role, permission]
        );
      }

      await client.query('COMMIT');
      invalidate(tenantId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Add a single permission to a role
  static async addPermission(tenantId: number, role: UserRole, permission: Permission): Promise<void> {
    await queryWithRetry(
      'INSERT INTO role_permissions (tenant_id, role, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [tenantId, role, permission]
    );
    invalidate(tenantId);
  }

  // Remove a single permission from a role
  static async removePermission(tenantId: number, role: UserRole, permission: Permission): Promise<void> {
    await queryWithRetry(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role = $2 AND permission = $3',
      [tenantId, role, permission]
    );
    invalidate(tenantId);
  }

  // Check if a role has a specific permission. Falls back to a
  // last-known-good cache if the DB is temporarily unavailable.
  static async hasPermission(tenantId: number, role: UserRole, permission: Permission): Promise<boolean> {
    await refreshPermissionCache(tenantId);
    return tenantCache(tenantId).permissions[role]?.includes(permission) ?? false;
  }

  // Get cached permissions for a role (same fallback semantics)
  static async getCachedPermissions(tenantId: number, role: UserRole): Promise<Permission[]> {
    await refreshPermissionCache(tenantId);
    return tenantCache(tenantId).permissions[role] || [];
  }

  // Eager warm-up — scalda la cache di tutti i tenant attivi dopo l'init
  // del DB, così la prima richiesta non paga la latenza del cache-miss.
  static async warmUp(): Promise<void> {
    try {
      const tenants = await queryWithRetry(`SELECT id FROM tenants WHERE status = 'active'`);
      for (const row of tenants.rows) {
        await refreshPermissionCache(Number(row.id));
      }
    } catch (err) {
      console.warn('[perms] warm-up failed, will retry on first request:', (err as Error)?.message);
    }
  }
}
