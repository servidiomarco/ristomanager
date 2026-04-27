import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User, UserRole, ViewState, LoginCredentials } from '../types';
import { authApiService } from '../services/authApiService';
import { socketClient } from '../services/socketClient';

// Permission type (must match backend)
type Permission = string;

// View to permission mapping
const VIEW_PERMISSIONS: Record<ViewState, string> = {
  [ViewState.DASHBOARD]: 'dashboard:view',
  [ViewState.FLOOR_PLAN]: 'floorplan:view',
  [ViewState.MENU]: 'menu:view',
  [ViewState.RESERVATIONS]: 'reservations:view',
  [ViewState.SETTINGS]: 'settings:view'
};

interface AuthContextType {
  user: User | null;
  permissions: string[];
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  canAccessView: (view: ViewState) => boolean;
  getAccessibleViews: () => ViewState[];
  canManageUsers: () => boolean;
  canViewLogs: () => boolean;
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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
      // Show alert to user
      alert('La tua sessione è scaduta. Effettua nuovamente il login.');
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

  const canAccessView = useCallback((view: ViewState): boolean => {
    const requiredPermission = VIEW_PERMISSIONS[view];
    if (!requiredPermission) return false;
    return permissions.includes(requiredPermission);
  }, [permissions]);

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

  const value: AuthContextType = {
    user,
    permissions,
    isAuthenticated: !!user,
    isLoading,
    login,
    logout,
    hasPermission,
    canAccessView,
    getAccessibleViews,
    canManageUsers,
    canViewLogs,
    getAccessToken
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
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
