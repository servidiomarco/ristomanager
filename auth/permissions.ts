import { UserRole, ViewState } from '../types.js';

// Permission types
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
  | 'staff:view'
  | 'staff:full'
  | 'settings:view'
  | 'settings:full'
  | 'users:view'
  | 'users:full'
  | 'reports:view'
  | 'reports:full'
  | 'logs:view'
  | 'logs:full';

// Role-permission mapping
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.OWNER]: [
    'dashboard:view',
    'dashboard:full',
    'floorplan:view',
    'floorplan:update_status',
    'floorplan:full',
    'menu:view',
    'menu:full',
    'reservations:view',
    'reservations:full',
    'staff:view',
    'staff:full',
    'settings:view',
    'settings:full',
    'users:view',
    'users:full',
    'reports:view',
    'reports:full',
    'logs:view',
    'logs:full'
  ],
  [UserRole.MANAGER]: [
    'dashboard:view',
    'dashboard:full',
    'floorplan:view',
    'floorplan:update_status',
    'floorplan:full',
    'menu:view',
    'menu:full',
    'reservations:view',
    'reservations:full',
    'staff:view',
    'staff:full',
    'reports:view',
    'logs:view'
  ],
  [UserRole.WAITER]: [
    'dashboard:view',
    'floorplan:view',
    'floorplan:update_status',
    'reservations:view',
    'reservations:full'
  ],
  [UserRole.KITCHEN]: [
    'menu:view',
    'reservations:view'
  ]
};

// View access mapping
const VIEW_PERMISSIONS: Record<ViewState, Permission[]> = {
  [ViewState.DASHBOARD]: ['dashboard:view'],
  [ViewState.FLOOR_PLAN]: ['floorplan:view'],
  [ViewState.MENU]: ['menu:view'],
  [ViewState.RESERVATIONS]: ['reservations:view'],
  [ViewState.STAFF]: ['staff:view'],
  [ViewState.SETTINGS]: ['settings:view']
};

export class PermissionService {
  // Check if a role has a specific permission
  static hasPermission(role: UserRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
  }

  // Check if a role can access a view
  static canAccessView(role: UserRole, view: ViewState): boolean {
    const requiredPermissions = VIEW_PERMISSIONS[view];
    if (!requiredPermissions) return false;
    return requiredPermissions.some(permission => this.hasPermission(role, permission));
  }

  // Get all permissions for a role
  static getPermissions(role: UserRole): Permission[] {
    return ROLE_PERMISSIONS[role] || [];
  }

  // Get all accessible views for a role
  static getAccessibleViews(role: UserRole): ViewState[] {
    return Object.values(ViewState).filter(view => this.canAccessView(role, view));
  }

  // Check if role has full access to a feature
  static hasFullAccess(role: UserRole, feature: string): boolean {
    return this.hasPermission(role, `${feature}:full` as Permission);
  }

  // Check if role can manage users
  static canManageUsers(role: UserRole): boolean {
    return this.hasPermission(role, 'users:full');
  }

  // Check if role can view reports
  static canViewReports(role: UserRole): boolean {
    return this.hasPermission(role, 'reports:view');
  }

  // Check specific feature permissions
  static canEditMenu(role: UserRole): boolean {
    return this.hasPermission(role, 'menu:full');
  }

  static canEditFloorPlan(role: UserRole): boolean {
    return this.hasPermission(role, 'floorplan:full');
  }

  static canUpdateTableStatus(role: UserRole): boolean {
    return this.hasPermission(role, 'floorplan:update_status');
  }

  static canEditReservations(role: UserRole): boolean {
    return this.hasPermission(role, 'reservations:full');
  }

  static canEditSettings(role: UserRole): boolean {
    return this.hasPermission(role, 'settings:full');
  }
}
