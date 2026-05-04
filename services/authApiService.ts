import { User, UserRole, LoginCredentials } from '../types';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// Token storage keys
const ACCESS_TOKEN_KEY = 'ristomanager_access_token';
const REFRESH_TOKEN_KEY = 'ristomanager_refresh_token';
const USER_KEY = 'ristomanager_user';
const PERMISSIONS_KEY = 'ristomanager_permissions';

// Session expired callback type
type SessionExpiredCallback = () => void;

export interface AuthResponse {
  user: User;
  permissions: string[];
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

class AuthApiService {
  private sessionExpiredCallbacks: Set<SessionExpiredCallback> = new Set();
  private isRefreshing: boolean = false;
  private refreshPromise: Promise<boolean> | null = null;

  // Register a callback for session expired events
  onSessionExpired(callback: SessionExpiredCallback): () => void {
    this.sessionExpiredCallbacks.add(callback);
    return () => this.sessionExpiredCallbacks.delete(callback);
  }

  // Trigger session expired callbacks
  private triggerSessionExpired(): void {
    this.sessionExpiredCallbacks.forEach(callback => callback());
  }

  // Get stored access token
  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  // Get stored refresh token
  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  }

  // Get stored user
  getUser(): User | null {
    const userJson = localStorage.getItem(USER_KEY);
    if (!userJson) return null;
    try {
      return JSON.parse(userJson);
    } catch {
      return null;
    }
  }

  // Store tokens, user and permissions
  private storeAuth(accessToken: string, refreshToken: string, user: User, permissions: string[]): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(PERMISSIONS_KEY, JSON.stringify(permissions));
  }

  // Clear stored auth data
  clearAuth(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(PERMISSIONS_KEY);
  }

  // Get stored permissions
  getPermissions(): string[] {
    const permissionsJson = localStorage.getItem(PERMISSIONS_KEY);
    if (!permissionsJson) return [];
    try {
      return JSON.parse(permissionsJson);
    } catch {
      return [];
    }
  }

  // Login
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(credentials)
      });
    } catch {
      throw new Error('Impossibile contattare il server. Verifica la connessione.');
    }

    if (!response.ok) {
      if (response.status === 400) throw new Error('Email e password sono obbligatori');
      if (response.status === 401) throw new Error('Email o password non corretti');
      if (response.status === 403) throw new Error('Account disattivato. Contatta un amministratore.');
      if (response.status >= 500) throw new Error('Errore del server, riprova tra qualche istante');
      throw new Error('Accesso non riuscito');
    }

    const data: AuthResponse = await response.json();
    this.storeAuth(data.accessToken, data.refreshToken, data.user, data.permissions || []);
    return data;
  }

  // Logout
  async logout(): Promise<void> {
    const token = this.getAccessToken();

    if (token) {
      try {
        await fetch(`${API_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });
      } catch {
        // Ignore errors during logout
      }
    }

    this.clearAuth();
  }

  // Refresh access token (with deduplication for concurrent calls)
  async refreshToken(): Promise<RefreshResponse | null> {
    const refreshToken = this.getRefreshToken();

    if (!refreshToken) {
      return null;
    }

    // If already refreshing, wait for the existing promise
    if (this.isRefreshing && this.refreshPromise) {
      const success = await this.refreshPromise;
      if (success) {
        return {
          accessToken: this.getAccessToken()!,
          refreshToken: this.getRefreshToken()!
        };
      }
      return null;
    }

    this.isRefreshing = true;
    this.refreshPromise = (async (): Promise<boolean> => {
      try {
        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ refreshToken })
        });

        if (!response.ok) {
          this.clearAuth();
          this.triggerSessionExpired();
          return false;
        }

        const data: RefreshResponse = await response.json();

        // Update stored tokens
        localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
        localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);

        return true;
      } catch {
        this.clearAuth();
        this.triggerSessionExpired();
        return false;
      } finally {
        this.isRefreshing = false;
        this.refreshPromise = null;
      }
    })();

    const success = await this.refreshPromise;
    if (success) {
      return {
        accessToken: this.getAccessToken()!,
        refreshToken: this.getRefreshToken()!
      };
    }
    return null;
  }

  // Get current user from API
  async getCurrentUser(): Promise<User | null> {
    const token = this.getAccessToken();

    if (!token) {
      return null;
    }

    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Try to refresh token
          const refreshed = await this.refreshToken();
          if (refreshed) {
            return this.getCurrentUser();
          }
        }
        return null;
      }

      const data = await response.json();
      const user: User = { ...data };
      delete (user as any).permissions;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      if (data.permissions) {
        localStorage.setItem(PERMISSIONS_KEY, JSON.stringify(data.permissions));
      }
      return user;
    } catch {
      return null;
    }
  }

  // Check if user is authenticated
  isAuthenticated(): boolean {
    return !!this.getAccessToken();
  }

  // Internal: fetch with auth header + automatic refresh on 401
  private async authFetch(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = this.getAccessToken();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401 && !retried) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        return this.authFetch(url, init, true);
      }
    }
    return response;
  }

  // ============================================
  // USER MANAGEMENT (Owner only)
  // ============================================

  async getUsers(): Promise<User[]> {
    const response = await this.authFetch(`${API_URL}/auth/users`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to fetch users' }));
      throw new Error(error.error || 'Failed to fetch users');
    }

    return response.json();
  }

  async createUser(userData: {
    email: string;
    password: string;
    full_name: string;
    role: UserRole;
  }): Promise<User> {
    const response = await this.authFetch(`${API_URL}/auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to create user' }));
      throw new Error(error.error || 'Failed to create user');
    }

    return response.json();
  }

  async updateUser(userId: number, userData: {
    email?: string;
    password?: string;
    full_name?: string;
    role?: UserRole;
    is_active?: boolean;
  }): Promise<User> {
    const response = await this.authFetch(`${API_URL}/auth/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to update user' }));
      throw new Error(error.error || 'Failed to update user');
    }

    return response.json();
  }

  async deleteUser(userId: number): Promise<void> {
    const response = await this.authFetch(`${API_URL}/auth/users/${userId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to delete user' }));
      throw new Error(error.error || 'Failed to delete user');
    }
  }
}

export const authApiService = new AuthApiService();
