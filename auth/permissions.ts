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
  | 'fiscal:view'
  | 'logs:view'
  | 'logs:full'
  | 'banquet:view_price'
  | 'banquet:manage_payments'
  | 'customers:view'
  | 'customers:full'
  | 'inventory:view'
  | 'inventory:full'
  | 'voice_calls:view'
  | 'reception:view'
  | 'payments:view'
  | 'payments:full'
  // Gestionale di sala — vedi docs/gestionale-sala-plan.md.
  // `expedite` è separato da `kds` di proposito: lanciare un'uscita è una
  // decisione di coordinamento che tocca tutte le partite, mentre `kds`
  // autorizza solo a lavorare la propria coda.
  | 'orders:view'
  | 'orders:take'
  | 'orders:kds'
  | 'orders:expedite'
  | 'orders:void'
  // Cassa (docs/cassa-plan.md). Quattro permessi invece di allargare
  // payments:full: incassare, stornare un incasso, chiudere in ammanco e
  // chiudere il cassetto sono autorizzazioni diverse, ed è esattamente la
  // separazione che il titolare vuole poter fare fra chi sta in cassa e chi
  // risponde della giornata.
  | 'cash:operate'
  | 'cash:void_payment'
  | 'cash:close_partial'
  | 'cash:close_session'
  // Chat interna dello staff (docs/chat-staff-plan.md). Un solo permesso:
  // chi ce l'ha legge e scrive nei canali del suo ruolo e nei DM — cosa
  // vede lo decide la membership per ruolo in services/staffChat.ts.
  | 'staffchat:use';

// Role-permission mapping
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  // Il platform admin opera i tenant (lista, sospensione, impersonation),
  // non ha una matrice per-tenant propria: la lista rispecchia quella di
  // OWNER solo perché il Record è esaustivo per costruzione. Dentro un
  // tenant si entra impersonando l'OWNER, non con questo ruolo.
  [UserRole.PLATFORM_ADMIN]: [
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
    'fiscal:view',
    'logs:view',
    'logs:full',
    'banquet:view_price',
    'banquet:manage_payments',
    'customers:view',
    'customers:full',
    'inventory:view',
    'inventory:full',
    'voice_calls:view',
    'reception:view',
    'payments:view',
    'payments:full',
    'orders:view',
    'orders:take',
    'orders:kds',
    'orders:expedite',
    'orders:void',
    'cash:operate',
    'cash:void_payment',
    'cash:close_partial',
    'cash:close_session',
    'staffchat:use'
  ],
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
    'fiscal:view',
    'logs:view',
    'logs:full',
    'banquet:view_price',
    'banquet:manage_payments',
    'customers:view',
    'customers:full',
    'inventory:view',
    'inventory:full',
    'voice_calls:view',
    'reception:view',
    'payments:view',
    'payments:full',
    'orders:view',
    'orders:take',
    'orders:kds',
    'orders:expedite',
    'orders:void',
    'cash:operate',
    'cash:void_payment',
    'cash:close_partial',
    'cash:close_session',
    'staffchat:use'
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
    'reception:view',
    'payments:view',
    'payments:full',
    'orders:view',
    'orders:take',
    'orders:kds',
    'orders:expedite',
    'orders:void',
    'cash:operate',
    'cash:void_payment',
    'cash:close_partial',
    'cash:close_session',
    'staffchat:use'
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
    'reception:view',
    'payments:view',
    'orders:view',
    'orders:take',
    'orders:expedite',
    'orders:void',
    'cash:operate',
    'cash:void_payment',
    'cash:close_partial',
    'cash:close_session',
    'staffchat:use'
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
    'voice_calls:view',
    'payments:view',
    'orders:view',
    'staffchat:use'
  ],
  [UserRole.WAITER]: [
    'dashboard:view',
    'floorplan:view',
    'floorplan:update_status',
    'reservations:view',
    'reservations:full',
    'customers:view',
    'inventory:view',
    'reception:view',
    'orders:view',
    'orders:take',
    'staffchat:use'
  ],
  [UserRole.KITCHEN]: [
    'menu:view',
    'reservations:view',
    'inventory:view',
    'inventory:full',
    'orders:view',
    'orders:kds',
    'orders:expedite',
    'staffchat:use'
  ],
  // Il cassiere. `orders:void` c'è perché senza non si storna una riga né si
  // applica lo sconto conto — le due correzioni che in cassa si fanno di
  // continuo. Non ci sono `cash:close_partial` né `cash:close_session`:
  // chiudere in ammanco e contare il cassetto rispondono al titolare.
  // `payments:view` gli dà lo storico del conto senza aprirgli Pagamenti,
  // che resta il registro sul periodo.
  [UserRole.CASSA]: [
    'dashboard:view',
    'floorplan:view',
    'reservations:view',
    'customers:view',
    'customers:full',
    'reception:view',
    'payments:view',
    'orders:view',
    'orders:take',
    'orders:void',
    'cash:operate',
    'cash:void_payment',
    'staffchat:use'
  ]
};

// View access mapping
const VIEW_PERMISSIONS: Record<ViewState, Permission[]> = {
  [ViewState.DASHBOARD]: ['dashboard:view'],
  [ViewState.FLOOR_PLAN]: ['floorplan:view'],
  [ViewState.MENU]: ['menu:view'],
  // Stessi permessi di Menu: la pagina Banchetti è la vecchia metà eventi
  // della pagina Menu & Banchetti, separata in sidebar.
  [ViewState.BANCHETTI]: ['menu:view'],
  [ViewState.COMANDE]: ['orders:take'],
  [ViewState.CASSA]: ['cash:operate'],
  [ViewState.CUCINA]: ['orders:kds'],
  [ViewState.PASSE]: ['orders:expedite'],
  [ViewState.RESERVATIONS]: ['reservations:view'],
  [ViewState.RECEPTION]: ['reception:view'],
  [ViewState.ATTIVITA]: ['dashboard:view'],
  [ViewState.LISTA_DELLA_SPESA]: ['dashboard:view'],
  [ViewState.HACCP]: ['dashboard:view'],
  [ViewState.CONVERSAZIONI]: ['voice_calls:view'],
  [ViewState.MESSAGGI]: ['reservations:view'],
  [ViewState.CHAT_STAFF]: ['staffchat:use'],
  [ViewState.STAFF]: ['staff:view'],
  [ViewState.CLIENTI]: ['customers:view'],
  [ViewState.INVENTARIO]: ['inventory:view'],
  [ViewState.USERS]: ['users:view'],
  [ViewState.SETTINGS]: ['settings:view'],
  [ViewState.PAGAMENTI]: ['payments:view'],
  // Reportistica fiscale: permesso dedicato, di default del solo titolare
  // (e concedibile per ruolo dalla matrice permessi): il registro documenti
  // non è né la cassa del giorno né i report operativi.
  [ViewState.FISCALITA]: ['fiscal:view'],
  // Email inbox reuses the same permission as the SMS/WhatsApp inbox — anyone
  // who can read reservations can read the email thread with those customers.
  [ViewState.EMAIL]: ['reservations:view'],
  // Notifiche is a personal centre — dashboard-level visibility is enough.
  [ViewState.NOTIFICHE]: ['dashboard:view'],
  // Consumi AI (token monitoring) and Development (dev board) are gated by
  // account email, not by role permissions — see requireDevBoardAdmin in
  // server.ts. No role can reach them through the permission system.
  [ViewState.MONITORING]: [],
  [ViewState.DEVELOPMENT]: [],
  [ViewState.ROADMAP]: [],
  // Pannello piattaforma (Fase D2): gate sul ruolo PLATFORM_ADMIN (vedi
  // canAccessView nel frontend e platformAdminAuth in server.ts), non sulla
  // matrice per-tenant. Nessun permesso lo apre.
  [ViewState.PLATFORM]: []
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
  // Sopra OWNER: fuori dalla gerarchia del tenant (Fase D2).
  [UserRole.PLATFORM_ADMIN]: 5,
  [UserRole.OWNER]: 4,
  [UserRole.GENERAL_MANAGER]: 3,
  [UserRole.MANAGER]: 2,
  [UserRole.RECEPTION]: 1,
  [UserRole.WAITER]: 1,
  [UserRole.KITCHEN]: 1,
  [UserRole.CASSA]: 1,
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
