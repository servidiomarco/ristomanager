import pool from '../db.js';
import { UserRole } from '../types.js';

export type Permission =
  | 'dashboard:view'
  | 'dashboard:full'
  | 'floorplan:view'
  | 'floorplan:update_status'
  | 'floorplan:full'
  | 'menu:view'
  | 'menu:full'
  | 'reservations:view'
  | 'reservations:full'
  | 'settings:view'
  | 'settings:full'
  | 'users:view'
  | 'users:full'
  | 'reports:view'
  | 'reports:full';

// All available permissions grouped by feature
export const ALL_PERMISSIONS: { feature: string; permissions: Permission[] }[] = [
  { feature: 'Dashboard', permissions: ['dashboard:view', 'dashboard:full'] },
  { feature: 'Sala e Tavoli', permissions: ['floorplan:view', 'floorplan:update_status', 'floorplan:full'] },
  { feature: 'Menu e Banchetti', permissions: ['menu:view', 'menu:full'] },
  { feature: 'Prenotazioni', permissions: ['reservations:view', 'reservations:full'] },
  { feature: 'Impostazioni', permissions: ['settings:view', 'settings:full'] },
  { feature: 'Gestione Utenti', permissions: ['users:view', 'users:full'] },
  { feature: 'Report', permissions: ['reports:view', 'reports:full'] }
];

// Cache for permissions (refreshed periodically)
let permissionsCache: Record<string, Permission[]> = {};
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minute

export class RolePermissionService {
  // Get all permissions for a role from database
  static async getPermissionsForRole(role: UserRole): Promise<Permission[]> {
    const result = await pool.query(
      'SELECT permission FROM role_permissions WHERE role = $1',
      [role]
    );
    return result.rows.map(row => row.permission as Permission);
  }

  // Get all role permissions (for admin UI)
  static async getAllRolePermissions(): Promise<Record<string, Permission[]>> {
    const result = await pool.query(
      'SELECT role, permission FROM role_permissions ORDER BY role, permission'
    );

    const permissions: Record<string, Permission[]> = {
      OWNER: [],
      MANAGER: [],
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

      // Invalidate cache
      cacheTimestamp = 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Add a single permission to a role
  static async addPermission(role: UserRole, permission: Permission): Promise<void> {
    await pool.query(
      'INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [role, permission]
    );
    cacheTimestamp = 0;
  }

  // Remove a single permission from a role
  static async removePermission(role: UserRole, permission: Permission): Promise<void> {
    await pool.query(
      'DELETE FROM role_permissions WHERE role = $1 AND permission = $2',
      [role, permission]
    );
    cacheTimestamp = 0;
  }

  // Check if a role has a specific permission (with caching)
  static async hasPermission(role: UserRole, permission: Permission): Promise<boolean> {
    // Refresh cache if expired
    if (Date.now() - cacheTimestamp > CACHE_TTL) {
      permissionsCache = await this.getAllRolePermissions();
      cacheTimestamp = Date.now();
    }

    return permissionsCache[role]?.includes(permission) ?? false;
  }

  // Get cached permissions for a role
  static async getCachedPermissions(role: UserRole): Promise<Permission[]> {
    if (Date.now() - cacheTimestamp > CACHE_TTL) {
      permissionsCache = await this.getAllRolePermissions();
      cacheTimestamp = Date.now();
    }

    return permissionsCache[role] || [];
  }
}
