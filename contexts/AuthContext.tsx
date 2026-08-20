import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User, UserRole, ViewState, LoginCredentials } from '../types';
import { authApiService } from '../services/authApiService';
import { completeOnboarding as apiCompleteOnboarding } from '../services/apiService';
import { socketClient } from '../services/socketClient';
import { AlertTriangle } from 'lucide-react';

// Permission type (must match backend)
type Permission = string;

// View to permission mapping
const VIEW_PERMISSIONS: Record<ViewState, string> = {
  [ViewState.DASHBOARD]: 'dashboard:view',
  [ViewState.FLOOR_PLAN]: 'floorplan:view',
  [ViewState.MENU]: 'menu:view',
  [ViewState.COMANDE]: 'orders:take',
  [ViewState.CUCINA]: 'orders:kds',
  [ViewState.PASSE]: 'orders:expedite',
  [ViewState.RESERVATIONS]: 'reservations:view',
  [ViewState.RECEPTION]: 'reception:view',
  [ViewState.ATTIVITA]: 'dashboard:view',
  [ViewState.LISTA_DELLA_SPESA]: 'dashboard:view',
  [ViewState.HACCP]: 'dashboard:view',
  [ViewState.CONVERSAZIONI]: 'voice_calls:view',
  [ViewState.MESSAGGI]: 'reservations:view',
  [ViewState.STAFF]: 'staff:view',
  [ViewState.CLIENTI]: 'customers:view',
  [ViewState.INVENTARIO]: 'inventory:view',
  [ViewState.USERS]: 'users:view',
  [ViewState.SETTINGS]: 'settings:view',
  [ViewState.PAGAMENTI]: 'payments:view',
  [ViewState.EMAIL]: 'reservations:view',
  [ViewState.NOTIFICHE]: 'dashboard:view',
  [ViewState.MONITORING]: '', // gated by account email, not by permission — see canAccessView
  [ViewState.DEVELOPMENT]: '', // gated by account email, not by permission — see canAccessView
  [ViewState.PLATFORM]: '' // gated by role PLATFORM_ADMIN, not by permission — see canAccessView
};

/** The dev board is a project tool tied to one specific account, not a role. */
const DEV_BOARD_ADMIN_EMAIL = 'admin@ristomanager.com';

// Entitlements commerciali (Fase C1, gating UI della nota D1): la vista di un
// canale non compreso nel piano non compare proprio — niente bottone che
// risponde 403. L'enforcement vero resta il server; qui si toglie solo la
// porta dalla parete. EMAIL non c'è: l'email è canale base, non un add-on.
export type TenantFeatureKey = 'voice' | 'whatsapp' | 'web_booking' | 'pay_at_table';
const VIEW_FEATURES: Partial<Record<ViewState, TenantFeatureKey>> = {
  [ViewState.CONVERSAZIONI]: 'voice',
  [ViewState.MESSAGGI]: 'whatsapp',
};

interface AuthContextType {
  user: User | null;
  permissions: string[];
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  /** Entitlement commerciale del tenant. `features` assente (sessione nata
   *  prima della Fase C1) = tutto acceso: meglio non nascondere che
   *  nascondere per sbaglio — il server fa comunque da guardia. */
  hasFeature: (feature: TenantFeatureKey) => boolean;
  canAccessView: (view: ViewState) => boolean;
  getAccessibleViews: () => ViewState[];
  canManageUsers: () => boolean;
  canViewLogs: () => boolean;
  getAccessToken: () => string | null;
  updatePreferences: (prefs: { preferred_landing_view?: string | null }) => Promise<void>;
  /** Profilo self-service: nome e telefono propri. */
  updateProfile: (data: { full_name?: string; phone?: string | null }) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Cambio email: il service salva anche i token nuovi (il JWT porta
   *  l'email), qui si aggiorna solo lo user in stato. */
  changeEmail: (newEmail: string, currentPassword: string) => Promise<void>;
  /** Chiude il wizard di primo accesso (D1): server + stato locale, così
   *  l'app compare senza rifare il login. */
  completeOnboarding: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSessionExpiredModal, setShowSessionExpiredModal] = useState(false);

  // Check for existing auth on mount
  useEffect(() => {
    const initAuth = async () => {
      try {
        const storedUser = authApiService.getUser();
        const storedPermissions = authApiService.getPermissions();

        if (storedUser && authApiService.isAuthenticated()) {
          // Verify token is still valid and get fresh permissions
          const currentUser = await authApiService.getCurrentUser();
          if (currentUser) {
            setUser(currentUser);
            // Get fresh permissions from storage (updated by getCurrentUser)
            setPermissions(authApiService.getPermissions());
            // Connect socket for already authenticated user
            socketClient.connect();
          } else {
            authApiService.clearAuth();
          }
        }
      } catch {
        authApiService.clearAuth();
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, []);

  // Listen for session expired events
  useEffect(() => {
    const unsubscribe = authApiService.onSessionExpired(() => {
      console.log('Session expired, logging out...');
      setUser(null);
      setPermissions([]);
      socketClient.disconnect();
      // Show session expired modal
      setShowSessionExpiredModal(true);
    });

    return unsubscribe;
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    const response = await authApiService.login(credentials);
    setUser(response.user);
    setPermissions(response.permissions || []);
    // Reconnect socket with the new auth token
    socketClient.reconnectWithToken();
  }, []);

  const logout = useCallback(async () => {
    await authApiService.logout();
    setUser(null);
    setPermissions([]);
    // Disconnect socket on logout
    socketClient.disconnect();
  }, []);

  const hasPermission = useCallback((permission: string): boolean => {
    return permissions.includes(permission);
  }, [permissions]);

  const hasFeature = useCallback((feature: TenantFeatureKey): boolean => {
    const features = user?.tenant?.features;
    if (!features) return true;
    return features[feature] !== false;
  }, [user]);

  const canAccessView = useCallback((view: ViewState): boolean => {
    if (view === ViewState.DEVELOPMENT || view === ViewState.MONITORING) {
      return (user?.email || '').toLowerCase() === DEV_BOARD_ADMIN_EMAIL;
    }
    // Il pannello piattaforma è legato al ruolo, non a un permesso per-tenant:
    // PLATFORM_ADMIN sta sopra i tenant e la matrice permessi è per-tenant.
    if (view === ViewState.PLATFORM) {
      return user?.role === UserRole.PLATFORM_ADMIN;
    }
    // Prima l'entitlement, poi il permesso: un canale fuori dal piano non
    // appare a nessun ruolo, nemmeno all'OWNER.
    const requiredFeature = VIEW_FEATURES[view];
    if (requiredFeature && !hasFeature(requiredFeature)) return false;
    const requiredPermission = VIEW_PERMISSIONS[view];
    if (!requiredPermission) return false;
    return permissions.includes(requiredPermission);
  }, [permissions, user, hasFeature]);

  const getAccessibleViews = useCallback((): ViewState[] => {
    return Object.values(ViewState).filter(view => canAccessView(view));
  }, [canAccessView]);

  const canManageUsers = useCallback((): boolean => {
    return permissions.includes('users:full');
  }, [permissions]);

  const canViewLogs = useCallback((): boolean => {
    return permissions.includes('logs:view');
  }, [permissions]);

  const getAccessToken = useCallback((): string | null => {
    return authApiService.getAccessToken();
  }, []);

  const updatePreferences = useCallback(async (prefs: { preferred_landing_view?: string | null }) => {
    const updated = await authApiService.updatePreferences(prefs);
    setUser(updated);
  }, []);

  const updateProfile = useCallback(async (data: { full_name?: string; phone?: string | null }) => {
    const updated = await authApiService.updateProfile(data);
    setUser(updated);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await authApiService.changePassword(currentPassword, newPassword);
  }, []);

  const changeEmail = useCallback(async (newEmail: string, currentPassword: string) => {
    // Il service ha già salvato token e user nuovi in storage; il socket si
    // riconnette col token fresco, come dopo un login.
    const updated = await authApiService.changeEmail(newEmail, currentPassword);
    setUser(updated);
    socketClient.reconnectWithToken();
  }, []);

  const completeOnboarding = useCallback(async () => {
    await apiCompleteOnboarding();
    // Il flag vive dentro user.tenant: si aggiorna in place, il prossimo
    // /auth/me lo confermerà dal server.
    setUser(prev => (prev && prev.tenant)
      ? { ...prev, tenant: { ...prev.tenant, needs_onboarding: false } }
      : prev);
  }, []);

  const value: AuthContextType = {
    user,
    permissions,
    isAuthenticated: !!user,
    isLoading,
    login,
    logout,
    hasPermission,
    hasFeature,
    canAccessView,
    getAccessibleViews,
    canManageUsers,
    canViewLogs,
    getAccessToken,
    updatePreferences,
    updateProfile,
    changePassword,
    changeEmail,
    completeOnboarding
  };

  return (
    <AuthContext.Provider value={value}>
      {children}

      {/* Session Expired Modal */}
      {showSessionExpiredModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mb-4">
                <AlertTriangle className="h-8 w-8 text-amber-600" />
              </div>
              <h3 className="text-xl font-semibold text-slate-800 mb-2">Sessione Scaduta</h3>
              <p className="text-slate-600 mb-6">
                La tua sessione è scaduta. Effettua nuovamente il login per continuare.
              </p>
              <button
                onClick={() => setShowSessionExpiredModal(false)}
                className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                Accedi
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
