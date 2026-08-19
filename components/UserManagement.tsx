import React, { useState, useEffect } from 'react';
import { UserPlus, Edit2, Trash2, Check, AlertCircle, Loader2, User as UserIcon, Shield, ChefHat, Utensils, Headset } from 'lucide-react';
import { User, UserRole } from '../types';
import { authApiService } from '../services/authApiService';
import { useAuth } from '../contexts/AuthContext';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { SkeletonCustomerGrid } from './SkeletonCards';
import {
  ModalShell, FormCard, Field, Callout, Avatar, StatusPill, EmptyState,
  dsInput, dsSelect, dsButton,
} from './ds';

interface UserManagementProps {
  // When provided, the component renders as a modal with a close button.
  // When omitted, it renders as an inline page (no overlay).
  onClose?: () => void;
  autoOpenNew?: boolean;
  onAutoOpenNewHandled?: () => void;
}

const ROLE_NAMES: Record<UserRole, string> = {
  // Ruolo di piattaforma: mai assegnabile da questa UI (il server rifiuta
  // comunque), l'etichetta serve solo a mostrare un eventuale utente
  // esistente senza la costante grezza.
  [UserRole.PLATFORM_ADMIN]: 'Admin piattaforma',
  [UserRole.OWNER]: 'Proprietario',
  [UserRole.GENERAL_MANAGER]: 'General Manager',
  [UserRole.MANAGER]: 'Manager',
  [UserRole.RECEPTION]: 'Reception',
  [UserRole.WAITER]: 'Cameriere',
  [UserRole.KITCHEN]: 'Cucina',
};

const ROLE_ICONS: Record<UserRole, React.ComponentType<{ className?: string }>> = {
  [UserRole.PLATFORM_ADMIN]: Shield,
  [UserRole.OWNER]: Shield,
  [UserRole.GENERAL_MANAGER]: Shield,
  [UserRole.MANAGER]: UserIcon,
  [UserRole.RECEPTION]: Headset,
  [UserRole.WAITER]: Utensils,
  [UserRole.KITCHEN]: ChefHat,
};

/* Il ruolo si legge dall'etichetta, non da una tinta per ruolo. Le famiglie di
   colore del design system sono stati — seated, arriving, pending, critical —
   e sono quattro per sei ruoli: la versione precedente pescava violet, indigo,
   blue, cyan, emerald e amber da fuori sistema, sei sfumature che nessuno può
   tenere a mente e che in questa griglia non significavano niente.
   Resta una sola distinzione, e semantica: chi ha pieni poteri. */
const isPrivileged = (role: UserRole): boolean =>
  role === UserRole.OWNER || role === UserRole.GENERAL_MANAGER;

export const UserManagement: React.FC<UserManagementProps> = ({ onClose, autoOpenNew, onAutoOpenNewHandled }) => {
  const isModal = typeof onClose === 'function';
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    full_name: '',
    role: UserRole.WAITER,
    is_active: true
  });
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Modal states
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<User | null>(null);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (autoOpenNew) {
      setShowAddForm(true);
      onAutoOpenNewHandled?.();
    }
  }, [autoOpenNew]);

  const fetchUsers = async () => {
    try {
      setIsLoading(true);
      const data = await authApiService.getUsers();
      setUsers(data);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Errore nel caricamento degli utenti');
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      email: '',
      password: '',
      full_name: '',
      role: UserRole.WAITER,
      is_active: true
    });
    setFormError('');
    setEditingUser(null);
    setShowAddForm(false);
  };

  const handleEdit = (user: User) => {
    setEditingUser(user);
    setFormData({
      email: user.email,
      password: '',
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active
    });
    setShowAddForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setIsSubmitting(true);

    try {
      if (editingUser) {
        // Update existing user
        const updateData: any = {
          email: formData.email,
          full_name: formData.full_name,
          role: formData.role,
          is_active: formData.is_active
        };
        if (formData.password) {
          updateData.password = formData.password;
        }
        await authApiService.updateUser(editingUser.id, updateData);
      } else {
        // Create new user
        if (!formData.password) {
          setFormError('La password è obbligatoria per i nuovi utenti');
          setIsSubmitting(false);
          return;
        }
        await authApiService.createUser({
          email: formData.email,
          password: formData.password,
          full_name: formData.full_name,
          role: formData.role
        });
      }
      await fetchUsers();
      resetForm();
    } catch (err: any) {
      setFormError(err.message || 'Errore nel salvataggio');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteClick = (user: User) => {
    setDeleteConfirmUser(user);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmUser) return;

    try {
      await authApiService.deleteUser(deleteConfirmUser.id);
      await fetchUsers();
      setDeleteConfirmUser(null);
    } catch (err: any) {
      setDeleteConfirmUser(null);
      setDeleteError(err.message || 'Errore nell\'eliminazione');
    }
  };

  const cardAction =
    'inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  const newUserLabel = (
    <>
      <UserPlus className="h-4 w-4" aria-hidden />
      Nuovo utente
    </>
  );
  /** Per l'empty state e il piede del modal: si centra, quindi non a tutta larghezza. */
  const addButton = (
    <button type="button" onClick={() => setShowAddForm(true)} className={dsButton.primary}>
      {newUserLabel}
    </button>
  );

  const content = (
    <>
      {/* Come su Personale: col mouse la "+" della barra in alto è l'unica via,
          come in tutto il resto dell'app. Al tocco apre la colonna — la barra
          in alto è una distanza di pollice dalla lista in cui stai lavorando. */}
      {!isModal && (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          className={`${dsButton.primary} w-full lg:hidden`}
        >
          {newUserLabel}
        </button>
      )}

      {error && (
        <Callout tone="critical" icon={AlertCircle}>{error}</Callout>
      )}

      {isLoading ? (
        <SkeletonCustomerGrid count={6} />
      ) : users.length === 0 ? (
        <EmptyState icon={UserIcon} action={addButton}>Nessun utente configurato.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {users.map((user) => {
            const RoleIcon = ROLE_ICONS[user.role];
            return (
              <div
                key={user.id}
                className="flex flex-col gap-3 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={user.full_name} icon={user.full_name ? undefined : UserIcon} />
                    <div className="min-w-0">
                      {/* Un utente disattivato si dice con la pill, non con
                          un'opacità che porta sotto contrasto tutta la card. */}
                      <p
                        className={`truncate text-[15px] font-semibold ${
                          user.is_active ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'
                        }`}
                      >
                        {user.full_name}
                      </p>
                      <p className="truncate text-[13px] text-[var(--ds-text-muted)]">{user.email}</p>
                    </div>
                  </div>
                  {user.id !== currentUser?.id ? (
                    <div className="flex flex-shrink-0 items-center">
                      <button
                        type="button"
                        onClick={() => handleEdit(user)}
                        className={cardAction}
                        aria-label={`Modifica ${user.full_name}`}
                        title="Modifica"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteClick(user)}
                        className={`${cardAction} hover:text-[var(--ds-critical-text)]`}
                        aria-label={`Elimina ${user.full_name}`}
                        title="Elimina"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <StatusPill className="flex-shrink-0">Tu</StatusPill>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={isPrivileged(user.role) ? 'info' : 'neutral'}>
                    <RoleIcon className="h-3 w-3 flex-shrink-0" />
                    {ROLE_NAMES[user.role]}
                  </StatusPill>
                  {!user.is_active && <StatusPill tone="pending">Disattivato</StatusPill>}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </>
  );

  return (
    <>
      {isModal ? (
        <ModalShell
          open
          onClose={onClose!}
          title="Gestione utenti"
          size="lg"
          bodyClassName="space-y-4 p-4 sm:p-6"
          footer={addButton}
        >
          {content}
        </ModalShell>
      ) : (
        // Scorrimento della pagina, non del contenitore dell'app: è quello che
        // tiene il contenuto sopra la barra di navigazione flottante del
        // telefono invece di lasciarlo passare dietro e ricomparire sotto. Vale
        // solo per la versione a pagina — dentro il modal scorre il modal.
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6 lg:p-8">
            {content}
          </div>
        </div>
      )}

      {/* Il form è un modal come su ogni altra schermata: la versione a
          pannello che si apriva sopra la griglia spingeva le card fuori
          dallo schermo proprio mentre si compilava.

          z-[60] perché quando Utenti è già un modal questo si apre sopra:
          l'ordine di pittura lo direbbe comunque, ma non per caso. */}
      <ModalShell
        open={showAddForm}
        onClose={resetForm}
        title={editingUser ? 'Modifica utente' : 'Nuovo utente'}
        subtitle={editingUser ? editingUser.email : 'Nome, email, password e ruolo.'}
        size="md"
        className={isModal ? 'z-[60]' : undefined}
        bodyClassName="p-4 sm:p-6"
        footerStart={formError ? <span className="text-[var(--ds-critical-text)]">{formError}</span> : undefined}
        footer={
          <button
            type="submit"
            form="user-form"
            disabled={isSubmitting}
            className={dsButton.primary}
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {editingUser ? 'Salva modifiche' : 'Crea utente'}
          </button>
        }
      >
        <form id="user-form" onSubmit={handleSubmit}>
          <FormCard>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nome completo" htmlFor="user-full-name" required>
                <input
                  id="user-full-name"
                  type="text"
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                  className={dsInput}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Email" htmlFor="user-email" required>
                <input
                  id="user-email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={dsInput}
                  required
                />
              </Field>
              <Field
                label="Password"
                htmlFor="user-password"
                required={!editingUser}
                aside={editingUser ? 'lascia vuoto per mantenere' : 'almeno 6 caratteri'}
              >
                <input
                  id="user-password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className={dsInput}
                  required={!editingUser}
                  minLength={6}
                />
              </Field>
              <Field label="Ruolo" htmlFor="user-role">
                <select
                  id="user-role"
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
                  className={dsSelect}
                >
                  {(Object.keys(ROLE_NAMES) as UserRole[])
                    // Il ruolo di piattaforma non si assegna da qui: si crea
                    // solo a mano via SQL, e il server rifiuta comunque.
                    .filter(role => role !== UserRole.PLATFORM_ADMIN)
                    .map(role => (
                      <option key={role} value={role}>{ROLE_NAMES[role]}</option>
                    ))}
                </select>
              </Field>
            </div>

            {editingUser && (
              // 44px di bersaglio attorno a una casella da 16: la casella nuda
              // era il controllo più piccolo della pagina.
              <label
                htmlFor="is_active"
                className="mt-4 inline-flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-full pr-3 text-[15px] text-[var(--ds-text-primary)]"
              >
                <input
                  type="checkbox"
                  id="is_active"
                  checked={formData.is_active}
                  onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                  className="h-5 w-5 flex-shrink-0 rounded accent-[var(--ds-action-bg)]"
                />
                Utente attivo
              </label>
            )}
          </FormCard>
        </form>
      </ModalShell>

      {/* Delete Confirmation Modal */}
      <ConfirmDeleteModal
        isOpen={!!deleteConfirmUser}
        title="Elimina utente"
        message="Stai per eliminare l'utente:"
        itemName={deleteConfirmUser?.full_name}
        onCancel={() => setDeleteConfirmUser(null)}
        onConfirm={handleDeleteConfirm}
      />

      <ModalShell
        open={!!deleteError}
        onClose={() => setDeleteError('')}
        title="Non è stato possibile eliminare"
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
        footer={
          <button type="button" onClick={() => setDeleteError('')} className={dsButton.primary}>
            Ho capito
          </button>
        }
      >
        <Callout tone="critical" icon={AlertCircle}>{deleteError}</Callout>
      </ModalShell>
    </>
  );
};
