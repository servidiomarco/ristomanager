import React, { useState, useEffect } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { UserRole } from '../types';
import { Loader } from './Loader';
import { ModalShell, dsButton } from './ds';

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
  GENERAL_MANAGER: 'General Manager',
  MANAGER: 'Manager',
  RECEPTION: 'Reception',
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
  'banquet:view_price': 'Visualizza prezzo banchetti',
  'reservations:view': 'Visualizza',
  'reservations:full': 'Modifica',
  'settings:view': 'Visualizza',
  'settings:full': 'Modifica',
  'users:view': 'Visualizza',
  'users:full': 'Gestione completa',
  'reports:view': 'Visualizza',
  'reports:full': 'Modifica',
  'orders:view': 'Visualizza comande',
  'orders:take': 'Prende e invia comande',
  'orders:kds': 'Monitor di partita',
  'orders:expedite': 'Passe — lancia le uscite',
  'orders:void': 'Storna righe inviate'
};

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export const RolePermissions: React.FC<RolePermissionsProps> = ({ isOpen, onClose }) => {
  const [features, setFeatures] = useState<FeaturePermissions[]>([]);
  const [roles] = useState<string[]>(['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN']);
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
    <ModalShell
      open={isOpen}
      onClose={onClose}
      title="Gestione Permessi Ruoli"
      subtitle="Configura i permessi per ogni ruolo utente"
      size="lg"
      bodyClassName="px-5 py-5 sm:px-6"
      footer={
        <>
          <button type="button" onClick={onClose} className={dsButton.secondary}>
            Chiudi
          </button>
          {selectedRole !== 'OWNER' && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className={dsButton.primary}
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Salvataggio...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" aria-hidden />
                  Salva Permessi
                </>
              )}
            </button>
          )}
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader label="Caricamento…" size={40} />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-[16px] bg-[var(--ds-critical-tint)] px-4 py-3 text-[14px] text-[var(--ds-critical-text)]">
          {error}
        </div>
      ) : (
        <>
          {/* Role tabs — pill group on the canvas, so the strip reads as
              chrome rather than as one more card. */}
          <div className="mb-6 inline-flex items-center gap-0.5 rounded-full bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-card)]">
            {roles.map(role => (
              <button
                key={role}
                type="button"
                onClick={() => setSelectedRole(role)}
                aria-pressed={selectedRole === role}
                className={`rounded-full px-3 py-1.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                  selectedRole === role
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                {ROLE_LABELS[role]}
              </button>
            ))}
          </div>

          {selectedRole === 'OWNER' && (
            <div className="mb-6 flex items-start gap-2.5 rounded-[16px] bg-[var(--ds-pending-tint)] p-4 text-[14px] leading-relaxed text-[var(--ds-pending-text)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              <span>Il ruolo Proprietario ha sempre tutti i permessi e non può essere modificato.</span>
            </div>
          )}

          {/* Permissions grid */}
          <div className="space-y-3">
            {features.map(feature => (
              <div key={feature.feature} className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                <div className="border-b border-[var(--ds-border)] px-4 py-2.5">
                  <h3 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{feature.feature}</h3>
                </div>
                <div className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {feature.permissions.map(permission => (
                      <label
                        key={permission}
                        className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[14px] font-medium transition-colors ${
                          hasPermission(permission)
                            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                            : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                        } ${selectedRole === 'OWNER' ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={hasPermission(permission)}
                          onChange={() => handlePermissionToggle(permission)}
                          disabled={selectedRole === 'OWNER'}
                          className="h-4 w-4 rounded accent-[var(--ds-action-bg)]"
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

          {/* Success message */}
          {successMessage && (
            <div role="status" className="mt-6 flex items-center gap-2.5 rounded-[16px] bg-[var(--ds-seated-tint)] p-4 text-[14px] text-[var(--ds-seated-text)]">
              <Check className="h-4 w-4 flex-shrink-0" aria-hidden />
              {successMessage}
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
};
