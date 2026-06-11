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
  | 'logs:full'
  | 'banquet:view_price'
  | 'banquet:manage_payments'
  | 'customers:view'
  | 'customers:full'
  | 'inventory:view'
  | 'inventory:full'
  | 'voice_calls:view'
  | 'reception:view';

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
    'logs:full',
    'banquet:view_price',
    'banquet:manage_payments',
    'customers:view',
    'customers:full',
    'inventory:view',
    'inventory:full',
    'voice_calls:view',
    'reception:view'
  ],
  [UserRole.GENERAL_MANAGER]: [
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
    'reports:full',
    'logs:view',
    'banquet:view_price',
    'banquet:manage_payments',
    'customers:view',
    'customers:full',
    'inventory:view',
    'inventory:full',
    'voice_calls:view',
    'reception:view'
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
    'logs:view',
    'customers:view',
    'customers:full',
    'inventory:view',
    'inventory:full',
    'voice_calls:view',
    'reception:view'
  ],
  [UserRole.RECEPTION]: [
    'dashboard:view',
    'floorplan:view',
    'floorplan:update_status',
    'reservations:view',
    'reservations:full',
    'customers:view',
    'customers:full',
    'reception:view',
    'voice_calls:view'
  ],
  [UserRole.WAITER]: [
    'dashboard:view',
    'floorplan:view',
    'floorplan:update_status',
    'reservations:view',
    'reservations:full',
    'customers:view',
    'inventory:view',
    'reception:view'
  ],
  [UserRole.KITCHEN]: [
    'menu:view',
    'reservations:view',
    'inventory:view',
    'inventory:full'
  ]
};

// View access mapping
const VIEW_PERMISSIONS: Record<ViewState, Permission[]> = {
  [ViewState.DASHBOARD]: ['dashboard:view'],
  [ViewState.FLOOR_PLAN]: ['floorplan:view'],
  [ViewState.MENU]: ['menu:view'],
  [ViewState.RESERVATIONS]: ['reservations:view'],
  [ViewState.RECEPTION]: ['reception:view'],
  [ViewState.ATTIVITA]: ['dashboard:view'],
  [ViewState.LISTA_DELLA_SPESA]: ['dashboard:view'],
  [ViewState.HACCP]: ['dashboard:view'],
  [ViewState.CONVERSAZIONI]: ['voice_calls:view'],
  [ViewState.STAFF]: ['staff:view'],
  [ViewState.CLIENTI]: ['customers:view'],
  [ViewState.INVENTARIO]: ['inventory:view'],
  [ViewState.USERS]: ['users:view'],
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

// Hierarchy used for task assignment: an actor can only assign work to
// peers or subordinates, never up the ladder.
// WAITER and KITCHEN sit at the same rank (lateral assignment is fine).
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.OWNER]: 4,
  [UserRole.GENERAL_MANAGER]: 3,
  [UserRole.MANAGER]: 2,
  [UserRole.RECEPTION]: 1,
  [UserRole.WAITER]: 1,
  [UserRole.KITCHEN]: 1,
};

export const canAssignToRole = (actorRole: UserRole, targetRole: UserRole): boolean => {
  const actor = ROLE_RANK[actorRole];
  const target = ROLE_RANK[targetRole];
  if (actor === undefined || target === undefined) return false;
  return actor >= target;
};

export const getAssignableRoles = (actorRole: UserRole): UserRole[] => {
  const actorRank = ROLE_RANK[actorRole];
  if (actorRank === undefined) return [];
  return (Object.values(UserRole) as UserRole[]).filter(r => ROLE_RANK[r] <= actorRank);
};
