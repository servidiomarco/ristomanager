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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white p-6">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-bold">Gestione Permessi Ruoli</h2>
            <button
              onClick={onClose}
              className="text-white/80 hover:text-white transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-purple-100 mt-2">Configura i permessi per ogni ruolo utente</p>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg">
              {error}
            </div>
          ) : (
            <>
              {/* Role Tabs */}
              <div className="flex gap-2 mb-6 flex-wrap">
                {roles.map(role => (
                  <button
                    key={role}
                    onClick={() => setSelectedRole(role)}
                    className={`px-4 py-2 rounded-lg font-medium transition-all ${
                      selectedRole === role
                        ? 'bg-purple-600 text-white shadow-lg'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {ROLE_LABELS[role]}
                  </button>
                ))}
              </div>

              {selectedRole === 'OWNER' && (
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 rounded-lg mb-6">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span className="font-medium">Il ruolo Proprietario ha sempre tutti i permessi e non può essere modificato.</span>
                  </div>
                </div>
              )}

              {/* Permissions Grid */}
              <div className="space-y-6">
                {features.map(feature => (
                  <div key={feature.feature} className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                      <h3 className="font-semibold text-gray-800">{feature.feature}</h3>
                    </div>
                    <div className="p-4">
                      <div className="flex flex-wrap gap-3">
                        {feature.permissions.map(permission => (
                          <label
                            key={permission}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all cursor-pointer ${
                              hasPermission(permission)
                                ? 'bg-purple-50 border-purple-300 text-purple-800'
                                : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                            } ${selectedRole === 'OWNER' ? 'opacity-60 cursor-not-allowed' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={hasPermission(permission)}
                              onChange={() => handlePermissionToggle(permission)}
                              disabled={selectedRole === 'OWNER'}
                              className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                            />
                            <span className="text-sm font-medium">
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
                <div className="mt-6 bg-green-50 border border-green-200 text-green-700 p-4 rounded-lg flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {successMessage}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 p-4 bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Chiudi
          </button>
          {selectedRole !== 'OWNER' && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  Salvataggio...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
