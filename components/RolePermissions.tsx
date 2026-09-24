import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, Lock } from 'lucide-react';
import { UserRole } from '../types';
import { Loader } from './Loader';
import { ModalShell, dsButton } from './ds';
import { useToast } from '../contexts/ToastContext';

interface FeaturePermissions {
  feature: string;
  permissions: string[];
}

interface RolePermissionsProps {
  isOpen: boolean;
  onClose: () => void;
}

/* I nomi dei ruoli vivono in common.role e si traducono una volta sola:
   erano duplicati in sei file, e due di quei sei non andavano d'accordo
   («Direttore» contro «General Manager» per lo stesso ruolo). */
const ROLE_LABELS_IT: Record<string, string> = {
  OWNER: 'Proprietario',
  GENERAL_MANAGER: 'General Manager',
  MANAGER: 'Manager',
  RECEPTION: 'Reception',
  WAITER: 'Cameriere',
  KITCHEN: 'Cucina',
  CASSA: 'Cassa'
};

/* Otto permessi si chiamano «Visualizza» e cinque «Modifica»: la chiave
   accanto all'italiano tiene i sinonimi in una voce sola di dizionario. */
const PERMISSION_LABELS: Record<string, { key: string; it: string }> = {
  'dashboard:view':          { key: 'perm.p.view', it: 'Visualizza' },
  'dashboard:full':          { key: 'perm.p.edit', it: 'Modifica' },
  'floorplan:view':          { key: 'perm.p.view', it: 'Visualizza' },
  'floorplan:update_status': { key: 'perm.p.tableStatus', it: 'Aggiorna stato tavoli' },
  'floorplan:full':          { key: 'perm.p.fullEdit', it: 'Modifica completa' },
  'menu:view':               { key: 'perm.p.view', it: 'Visualizza' },
  'menu:full':               { key: 'perm.p.edit', it: 'Modifica' },
  'banquet:view_price':      { key: 'perm.p.banquetPrice', it: 'Visualizza prezzo banchetti' },
  'reservations:view':       { key: 'perm.p.view', it: 'Visualizza' },
  'reservations:full':       { key: 'perm.p.edit', it: 'Modifica' },
  'staff:view':              { key: 'perm.p.view', it: 'Visualizza' },
  'staff:full':              { key: 'perm.p.edit', it: 'Modifica' },
  'staff:payments':          { key: 'perm.p.staffPayments', it: 'Compensi e acconti' },
  'settings:view':           { key: 'perm.p.view', it: 'Visualizza' },
  'settings:full':           { key: 'perm.p.edit', it: 'Modifica' },
  'users:view':              { key: 'perm.p.view', it: 'Visualizza' },
  'users:full':              { key: 'perm.p.usersFull', it: 'Gestione completa' },
  'reports:view':            { key: 'perm.p.view', it: 'Visualizza' },
  'reports:full':            { key: 'perm.p.edit', it: 'Modifica' },
  'fiscal:view':             { key: 'perm.p.fiscalView', it: 'Registro e report fiscali' },
  'orders:view':             { key: 'perm.p.ordersView', it: 'Visualizza comande' },
  'orders:take':             { key: 'perm.p.ordersTake', it: 'Prende e invia comande' },
  'orders:kds':              { key: 'perm.p.ordersKds', it: 'Monitor di partita' },
  'orders:expedite':         { key: 'perm.p.ordersExpedite', it: 'Passe — lancia le uscite' },
  'orders:void':             { key: 'perm.p.ordersVoid', it: 'Storna righe inviate' },
  'takeaway:view':           { key: 'perm.p.takeawayView', it: 'Visualizza ordini asporto' },
  'takeaway:manage':         { key: 'perm.p.takeawayManage', it: 'Gestisce ordini asporto' }
};

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export const RolePermissions: React.FC<RolePermissionsProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation(['impostazioni', 'common'], { useSuspense: false });
  const [features, setFeatures] = useState<FeaturePermissions[]>([]);

  const roleLabel = (r: string): string => t(`common:role.${r}`, ROLE_LABELS_IT[r] ?? r);
  /* I gruppi arrivano dal server come stringhe italiane. Se il server ne
     cambia una — o ne aggiunge una che qui non c'è — si legge l'italiano
     che è arrivato: lo stesso fallback di ogni t() di questo cantiere. */
  const groupLabel = (g: string): string => t(`perm.group.${g}`, g);
  const permissionLabel = (p: string): string => {
    const l = PERMISSION_LABELS[p];
    return l ? t(l.key, l.it) : p;
  };
  const [roles] = useState<string[]>(['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN']);
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>({});
  // Permessi riservati alla piattaforma: qui si mostrano col lucchetto e
  // non si toccano — li amministra il pannello. Il server li congela
  // comunque, la UI evita solo di promettere un salvataggio che non avverrà.
  const [locked, setLocked] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>('MANAGER');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();

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
      setLocked(permissionsData.locked || []);
      setRolePermissions(rolePermsData);
    } catch (err) {
      setError(t('perm.errLoad', 'Errore nel caricamento dei permessi'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handlePermissionToggle = (permission: string) => {
    if (selectedRole === 'OWNER' || locked.includes(permission)) {
      // OWNER non si modifica; un permesso riservato nemmeno.
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

      addToast(t('perm.saved', 'Permessi per {{ruolo}} salvati', { ruolo: roleLabel(selectedRole) }), 'success');
    } catch (err: any) {
      setError(err.message || t('perm.errSave', 'Errore nel salvataggio dei permessi'));
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
      title={t('perm.title', 'Gestione permessi ruoli')}
      subtitle={t('perm.subtitle', 'Configura i permessi per ogni ruolo utente')}
      size="lg"
      bodyClassName="px-5 py-5 sm:px-6"
      footer={
        <>
          <button type="button" onClick={onClose} className={dsButton.secondary}>
            {t('perm.close', 'Chiudi')}
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
                  {t('perm.saving', 'Salvataggio…')}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" aria-hidden />
                  {t('perm.save', 'Salva permessi')}
                </>
              )}
            </button>
          )}
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader size={40} />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-[var(--ds-radius)] bg-[var(--ds-critical-tint)] px-4 py-3 text-[14px] text-[var(--ds-critical-text)]">
          {error}
        </div>
      ) : (
        <>
          {/* Role tabs — pill group on the canvas, so the strip reads as
              chrome rather than as one more card. */}
          <div className="mb-6 inline-flex items-center gap-0.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-card)]">
            {roles.map(role => (
              <button
                key={role}
                type="button"
                onClick={() => setSelectedRole(role)}
                aria-pressed={selectedRole === role}
                className={`rounded-[var(--ds-radius-control)] px-3 py-1.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                  selectedRole === role
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                {roleLabel(role)}
              </button>
            ))}
          </div>

          {selectedRole === 'OWNER' && (
            <div className="mb-6 flex items-start gap-2.5 rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] p-4 text-[14px] leading-relaxed text-[var(--ds-pending-text)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              <span>{t('perm.ownerNote', 'Il ruolo Proprietario ha sempre tutti i permessi e non può essere modificato.')}</span>
            </div>
          )}

          {/* Permissions grid */}
          <div className="space-y-3">
            {features.map(feature => (
              <div key={feature.feature} className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                <div className="border-b border-[var(--ds-border)] px-4 py-2.5">
                  <h3 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{groupLabel(feature.feature)}</h3>
                </div>
                <div className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {feature.permissions.map(permission => {
                      const isLocked = locked.includes(permission);
                      return (
                        <label
                          key={permission}
                          title={isLocked ? t('perm.reserved', 'Riservato alla piattaforma') : undefined}
                          className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--ds-radius-control)] px-3.5 text-[14px] font-medium transition-colors ${
                            hasPermission(permission)
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                              : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                          } ${selectedRole === 'OWNER' || isLocked ? 'cursor-not-allowed opacity-60' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={hasPermission(permission)}
                            onChange={() => handlePermissionToggle(permission)}
                            disabled={selectedRole === 'OWNER' || isLocked}
                            className="h-4 w-4 rounded accent-[var(--ds-action-bg)]"
                          />
                          <span>
                            {permissionLabel(permission)}
                          </span>
                          {isLocked && <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-label={t('perm.reserved', 'Riservato alla piattaforma')} />}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>

        </>
      )}
    </ModalShell>
  );
};
