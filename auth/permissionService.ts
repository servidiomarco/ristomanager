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
  { feature: 'Conversazioni', permissions: ['voice_calls:view'] }
];

// Last-known-good permissions cache. We deliberately keep stale entries
// usable when the DB is unreachable (Railway Postgres on the hobby tier
// recycles the container every few minutes), so a transient outage does
// not start denying every authenticated write with a misleading 403.
let permissionsCache: Record<string, Permission[]> = {};
let lastSuccessfulRefresh = 0;
let lastRefreshAttempt = 0;
const CACHE_TTL = 5 * 60 * 1000;       // 5 min between proactive refreshes
const REFRESH_BACKOFF_MS = 5_000;      // after a failed refresh, wait 5s before retrying

const totalPermissionsIn = (snap: Record<string, Permission[]>): number =>
  Object.values(snap).reduce((n, arr) => n + arr.length, 0);

const refreshPermissionCache = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastSuccessfulRefresh < CACHE_TTL) return;
  if (now - lastRefreshAttempt < REFRESH_BACKOFF_MS) return;
  lastRefreshAttempt = now;

  let fresh: Record<string, Permission[]>;
  try {
    fresh = await RolePermissionService.getAllRolePermissions();
  } catch (err) {
    if (lastSuccessfulRefresh > 0) {
      console.warn('[perms] DB read failed; using stale cache from',
        new Date(lastSuccessfulRefresh).toISOString(), '-', (err as Error)?.message);
      return;
    }
    throw err;
  }

  if (totalPermissionsIn(fresh) === 0) {
    if (lastSuccessfulRefresh > 0) {
      console.warn('[perms] DB returned empty role_permissions; keeping stale cache');
      return;
    }
    throw new Error('role_permissions table is empty');
  }

  permissionsCache = fresh;
  lastSuccessfulRefresh = now;
};

export class RolePermissionService {
  // Get all permissions for a role from database
  static async getPermissionsForRole(role: UserRole): Promise<Permission[]> {
    const result = await queryWithRetry(
      'SELECT permission FROM role_permissions WHERE role = $1',
      [role]
    );
    return result.rows.map(row => row.permission as Permission);
  }

  // Get all role permissions (for admin UI)
  static async getAllRolePermissions(): Promise<Record<string, Permission[]>> {
    const result = await queryWithRetry(
      'SELECT role, permission FROM role_permissions ORDER BY role, permission'
    );

    const permissions: Record<string, Permission[]> = {
      OWNER: [],
      GENERAL_MANAGER: [],
      MANAGER: [],
      RECEPTION: [],
      WAITER: [],
      KITCHEN: []
    };

    for (const row of result.rows) {
      if (permissions[row.role]) {
        permissions[row.role].push(row.permission as Permission);
      }
    }

    return permissions;
  }

  // Set permissions for a role (replaces existing permissions)
  static async setPermissionsForRole(role: UserRole, permissions: Permission[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing permissions for this role
      await client.query('DELETE FROM role_permissions WHERE role = $1', [role]);

      // Insert new permissions
      for (const permission of permissions) {
        await client.query(
          'INSERT INTO role_permissions (role, permission) VALUES ($1, $2)',
          [role, permission]
        );
      }

      await client.query('COMMIT');

      // Invalidate cache (next read will refresh)
      lastSuccessfulRefresh = 0;
      lastRefreshAttempt = 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Add a single permission to a role
  static async addPermission(role: UserRole, permission: Permission): Promise<void> {
    await queryWithRetry(
      'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [role, permission]
    );
    lastSuccessfulRefresh = 0;
    lastRefreshAttempt = 0;
  }

  // Remove a single permission from a role
  static async removePermission(role: UserRole, permission: Permission): Promise<void> {
    await queryWithRetry(
      'DELETE FROM role_permissions WHERE role = $1 AND permission = $2',
      [role, permission]
    );
    lastSuccessfulRefresh = 0;
    lastRefreshAttempt = 0;
  }

  // Check if a role has a specific permission. Falls back to a
  // last-known-good cache if the DB is temporarily unavailable.
  static async hasPermission(role: UserRole, permission: Permission): Promise<boolean> {
    await refreshPermissionCache();
    return permissionsCache[role]?.includes(permission) ?? false;
  }

  // Get cached permissions for a role (same fallback semantics)
  static async getCachedPermissions(role: UserRole): Promise<Permission[]> {
    await refreshPermissionCache();
    return permissionsCache[role] || [];
  }

  // Eager warm-up — call once after DB init so the first user request
  // doesn't pay the cache-miss latency, and the cache is populated
  // before Postgres has a chance to bounce.
  static async warmUp(): Promise<void> {
    try {
      await refreshPermissionCache();
    } catch (err) {
      console.warn('[perms] warm-up failed, will retry on first request:', (err as Error)?.message);
    }
  }
}
