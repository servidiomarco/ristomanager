import React, { useState, useEffect } from 'react';
import { X, Plus, Edit2, Trash2, Check, AlertCircle, Loader2, User as UserIcon, Shield, ChefHat, Utensils, AlertTriangle } from 'lucide-react';
import { User, UserRole } from '../types';
import { authApiService } from '../services/authApiService';
import { useAuth } from '../contexts/AuthContext';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';

interface UserManagementProps {
  onClose: () => void;
}

export const UserManagement: React.FC<UserManagementProps> = ({ onClose }) => {
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

  const getRoleIcon = (role: UserRole) => {
    switch (role) {
      case UserRole.OWNER:
        return <Shield className="h-4 w-4" />;
      case UserRole.MANAGER:
        return <UserIcon className="h-4 w-4" />;
      case UserRole.WAITER:
        return <Utensils className="h-4 w-4" />;
      case UserRole.KITCHEN:
        return <ChefHat className="h-4 w-4" />;
    }
  };

  const getRoleName = (role: UserRole): string => {
    const names: Record<UserRole, string> = {
      [UserRole.OWNER]: 'Proprietario',
      [UserRole.MANAGER]: 'Manager',
      [UserRole.WAITER]: 'Cameriere',
      [UserRole.KITCHEN]: 'Cucina'
    };
    return names[role];
  };

  const getRoleColor = (role: UserRole): string => {
    switch (role) {
      case UserRole.OWNER:
        return 'bg-violet-50 text-violet-700 border border-violet-100';
      case UserRole.MANAGER:
        return 'bg-blue-50 text-blue-700 border border-blue-100';
      case UserRole.WAITER:
        return 'bg-emerald-50 text-emerald-700 border border-emerald-100';
      case UserRole.KITCHEN:
        return 'bg-amber-50 text-amber-700 border border-amber-100';
    }
  };

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--color-line)] flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Gestione Utenti</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Error */}
          {error && (
            <div className="mb-4 px-3 py-2 bg-rose-50 border border-rose-100 rounded-md text-rose-700 text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Add/Edit Form */}
          {showAddForm && (
            <div className="mb-6 p-5 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-4">
                {editingUser ? 'Modifica Utente' : 'Nuovo Utente'}
              </h3>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">
                      Nome Completo
                    </label>
                    <input
                      type="text"
                      value={formData.full_name}
                      onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">
                      Password {editingUser && <span className="normal-case tracking-normal text-[var(--color-fg-subtle)]">(lascia vuoto per mantenere)</span>}
                    </label>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                      required={!editingUser}
                      minLength={6}
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">
                      Ruolo
                    </label>
                    <select
                      value={formData.role}
                      onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    >
                      <option value={UserRole.OWNER}>Proprietario</option>
                      <option value={UserRole.MANAGER}>Manager</option>
                      <option value={UserRole.WAITER}>Cameriere</option>
                      <option value={UserRole.KITCHEN}>Cucina</option>
                    </select>
                  </div>
                </div>

                {editingUser && (
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="is_active"
                      checked={formData.is_active}
                      onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                      className="w-4 h-4 rounded border-[var(--color-line)]"
                    />
                    <label htmlFor="is_active" className="text-sm text-[var(--color-fg)]">
                      Utente attivo
                    </label>
                  </div>
                )}

                {formError && (
                  <div className="px-3 py-2 bg-rose-50 border border-rose-100 rounded-md text-rose-700 text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {formError}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 flex items-center gap-2"
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    {editingUser ? 'Salva Modifiche' : 'Crea Utente'}
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
                  >
                    Annulla
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Users List */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--color-fg-muted)]" />
            </div>
          ) : (
            <div className="space-y-2">
              {users.map((user) => (
                <div
                  key={user.id}
                  className={`px-4 py-3 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg flex items-center gap-4 hover:bg-[var(--color-surface-hover)] transition ${
                    !user.is_active ? 'opacity-50' : ''
                  }`}
                >
                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg)] font-medium flex items-center justify-center text-sm">
                    {user.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-[var(--color-fg)] truncate">{user.full_name}</p>
                      {!user.is_active && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] text-[11px] font-medium rounded-full border border-[var(--color-line)]">
                          Disattivato
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--color-fg-muted)] truncate">{user.email}</p>
                  </div>

                  {/* Role Badge */}
                  <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${getRoleColor(user.role)}`}>
                    {getRoleIcon(user.role)}
                    {getRoleName(user.role)}
                  </div>

                  {/* Actions */}
                  {user.id !== currentUser?.id && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEdit(user)}
                        className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                        title="Modifica"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteClick(user)}
                        className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 hover:text-rose-600"
                        title="Elimina"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {user.id === currentUser?.id && (
                    <span className="text-xs text-[var(--color-fg-subtle)] italic">Tu</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!showAddForm && (
          <div className="px-5 py-3 border-t border-[var(--color-line)] flex justify-end">
            <button
              onClick={() => setShowAddForm(true)}
              className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Aggiungi Utente
            </button>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmDeleteModal
        isOpen={!!deleteConfirmUser}
        title="Elimina Utente"
        message="Stai per eliminare l'utente:"
        itemName={deleteConfirmUser?.full_name}
        onCancel={() => setDeleteConfirmUser(null)}
        onConfirm={handleDeleteConfirm}
      />

      {/* Error Modal */}
      {deleteError && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4">
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="px-5 py-6 text-center">
              <div className="mx-auto w-12 h-12 bg-rose-50 border border-rose-100 rounded-full flex items-center justify-center mb-4">
                <AlertCircle className="h-5 w-5 text-rose-600" />
              </div>
              <h3 className="text-[15px] font-semibold text-[var(--color-fg)] mb-2">Errore</h3>
              <p className="text-sm text-[var(--color-fg-muted)] mb-6">{deleteError}</p>
              <button
                onClick={() => setDeleteError('')}
                className="w-full rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
