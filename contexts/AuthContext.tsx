import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User, UserRole, ViewState, LoginCredentials } from '../types';
import { authApiService } from '../services/authApiService';
import { PermissionService, Permission } from '../auth/permissions';
import { socketClient } from '../services/socketClient';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
  canAccessView: (view: ViewState) => boolean;
  getAccessibleViews: () => ViewState[];
  canManageUsers: () => boolean;
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check for existing auth on mount
  useEffect(() => {
    const initAuth = async () => {
      try {
        const storedUser = authApiService.getUser();
        if (storedUser && authApiService.isAuthenticated()) {
          // Verify token is still valid
          const currentUser = await authApiService.getCurrentUser();
          if (currentUser) {
            setUser(currentUser);
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

  const login = useCallback(async (credentials: LoginCredentials) => {
    const response = await authApiService.login(credentials);
    setUser(response.user);
    // Reconnect socket with the new auth token
    socketClient.reconnectWithToken();
  }, []);

  const logout = useCallback(async () => {
    await authApiService.logout();
    setUser(null);
    // Disconnect socket on logout
    socketClient.disconnect();
  }, []);

  const hasPermission = useCallback((permission: Permission): boolean => {
    if (!user) return false;
    return PermissionService.hasPermission(user.role, permission);
  }, [user]);

  const canAccessView = useCallback((view: ViewState): boolean => {
    if (!user) return false;
    return PermissionService.canAccessView(user.role, view);
  }, [user]);

  const getAccessibleViews = useCallback((): ViewState[] => {
    if (!user) return [];
    return PermissionService.getAccessibleViews(user.role);
  }, [user]);

  const canManageUsers = useCallback((): boolean => {
    if (!user) return false;
    return PermissionService.canManageUsers(user.role);
  }, [user]);

  const getAccessToken = useCallback((): string | null => {
    return authApiService.getAccessToken();
  }, []);

  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    logout,
    hasPermission,
    canAccessView,
    getAccessibleViews,
    canManageUsers,
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
