import React, { useState, useEffect } from 'react';
import { UserRole } from '../types';

interface FeaturePermissions {
  feature: string;
  permissions: string[];
}

interface RolePermissionsProps {
  isOpen: boolean;
  onClose: () => void;
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Proprietario',
  MANAGER: 'Manager',
  WAITER: 'Cameriere',
  KITCHEN: 'Cucina'
};

const PERMISSION_LABELS: Record<string, string> = {
  'dashboard:view': 'Visualizza',
  'dashboard:full': 'Modifica',
  'floorplan:view': 'Visualizza',
  'floorplan:update_status': 'Aggiorna stato tavoli',
  'floorplan:full': 'Modifica completa',
  'menu:view': 'Visualizza',
  'menu:full': 'Modifica',
  'reservations:view': 'Visualizza',
  'reservations:full': 'Modifica',
  'settings:view': 'Visualizza',
  'settings:full': 'Modifica',
  'users:view': 'Visualizza',
  'users:full': 'Gestione completa',
  'reports:view': 'Visualizza',
  'reports:full': 'Modifica'
};

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export const RolePermissions: React.FC<RolePermissionsProps> = ({ isOpen, onClose }) => {
  const [features, setFeatures] = useState<FeaturePermissions[]>([]);
  const [roles] = useState<string[]>(['OWNER', 'MANAGER', 'WAITER', 'KITCHEN']);
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>({});
  const [selectedRole, setSelectedRole] = useState<string>('MANAGER');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('ristomanager_access_token');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
  };

  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
  }, [isOpen]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [permissionsRes, rolePermsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/auth/permissions`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE_URL}/auth/permissions/roles`, { headers: getAuthHeaders() })
      ]);

      if (!permissionsRes.ok || !rolePermsRes.ok) {
        throw new Error('Failed to fetch permissions');
      }

      const permissionsData = await permissionsRes.json();
      const rolePermsData = await rolePermsRes.json();

      setFeatures(permissionsData.features);
      setRolePermissions(rolePermsData);
    } catch (err) {
      setError('Errore nel caricamento dei permessi');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handlePermissionToggle = (permission: string) => {
    if (selectedRole === 'OWNER') {
      // Prevent modifying OWNER permissions
      return;
    }

    setRolePermissions(prev => {
      const currentPermissions = prev[selectedRole] || [];
      const newPermissions = currentPermissions.includes(permission)
        ? currentPermissions.filter(p => p !== permission)
        : [...currentPermissions, permission];

      return {
        ...prev,
        [selectedRole]: newPermissions
      };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/permissions/roles/${selectedRole}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ permissions: rolePermissions[selectedRole] })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save permissions');
      }

      setSuccessMessage(`Permessi per ${ROLE_LABELS[selectedRole]} salvati con successo`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Errore nel salvataggio dei permessi');
    } finally {
      setSaving(false);
    }
  };

  const hasPermission = (permission: string) => {
    return rolePermissions[selectedRole]?.includes(permission) ?? false;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--color-line)]">
          <div className="flex justify-between items-center">
            <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Gestione Permessi Ruoli</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-[var(--color-fg-muted)] mt-1">Configura i permessi per ogni ruolo utente</p>
        </div>

        {/* Content */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-fg)]"></div>
            </div>
          ) : error ? (
            <div className="bg-rose-50 border border-rose-100 text-rose-700 px-3 py-2 rounded-md text-sm">
              {error}
            </div>
          ) : (
            <>
              {/* Role Tabs */}
              <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full mb-6">
                {roles.map(role => (
                  <button
                    key={role}
                    onClick={() => setSelectedRole(role)}
                    className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
                      selectedRole === role
                        ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                        : 'text-[var(--color-fg-muted)]'
                    }`}
                  >
                    {ROLE_LABELS[role]}
                  </button>
                ))}
              </div>

              {selectedRole === 'OWNER' && (
                <div className="bg-amber-50 border border-amber-100 text-amber-800 px-3 py-2 rounded-md mb-6">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span className="text-sm font-medium">Il ruolo Proprietario ha sempre tutti i permessi e non può essere modificato.</span>
                  </div>
                </div>
              )}

              {/* Permissions Grid */}
              <div className="space-y-4">
                {features.map(feature => (
                  <div key={feature.feature} className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg overflow-hidden">
                    <div className="bg-[var(--color-surface-3)] px-4 py-2.5 border-b border-[var(--color-line)]">
                      <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">{feature.feature}</h3>
                    </div>
                    <div className="p-4">
                      <div className="flex flex-wrap gap-2">
                        {feature.permissions.map(permission => (
                          <label
                            key={permission}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium transition cursor-pointer ${
                              hasPermission(permission)
                                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                            } ${selectedRole === 'OWNER' ? 'opacity-60 cursor-not-allowed' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={hasPermission(permission)}
                              onChange={() => handlePermissionToggle(permission)}
                              disabled={selectedRole === 'OWNER'}
                              className="w-3.5 h-3.5 rounded"
                            />
                            <span>
                              {PERMISSION_LABELS[permission] || permission}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Success Message */}
              {successMessage && (
                <div className="mt-6 bg-emerald-50 border border-emerald-100 text-emerald-700 px-3 py-2 rounded-md flex items-center gap-2 text-sm">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {successMessage}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-line)] px-5 py-3 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
          >
            Chiudi
          </button>
          {selectedRole !== 'OWNER' && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-current"></div>
                  Salvataggio...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Salva Permessi
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
