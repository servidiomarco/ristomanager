import React, { useState, useEffect } from 'react';
import { X, Plus, Edit2, Trash2, Check, AlertCircle, Loader2, User as UserIcon, Shield, ChefHat, Utensils } from 'lucide-react';
import { User, UserRole } from '../types';
import { authApiService } from '../services/authApiService';
import { useAuth } from '../contexts/AuthContext';

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

  const handleDelete = async (userId: number) => {
    if (!confirm('Sei sicuro di voler eliminare questo utente?')) return;

    try {
      await authApiService.deleteUser(userId);
      await fetchUsers();
    } catch (err: any) {
      alert(err.message || 'Errore nell\'eliminazione');
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
        return 'bg-purple-100 text-purple-700';
      case UserRole.MANAGER:
        return 'bg-blue-100 text-blue-700';
      case UserRole.WAITER:
        return 'bg-emerald-100 text-emerald-700';
      case UserRole.KITCHEN:
        return 'bg-orange-100 text-orange-700';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold text-slate-800">Gestione Utenti</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Error */}
          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-center gap-2">
              <AlertCircle className="h-5 w-5" />
              {error}
            </div>
          )}

          {/* Add/Edit Form */}
          {showAddForm && (
            <div className="mb-6 p-6 bg-slate-50 rounded-xl">
              <h3 className="text-lg font-semibold text-slate-800 mb-4">
                {editingUser ? 'Modifica Utente' : 'Nuovo Utente'}
              </h3>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Nome Completo
                    </label>
                    <input
                      type="text"
                      value={formData.full_name}
                      onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Password {editingUser && <span className="text-slate-400">(lascia vuoto per mantenere)</span>}
                    </label>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      required={!editingUser}
                      minLength={6}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Ruolo
                    </label>
                    <select
                      value={formData.role}
                      onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
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
                      className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500"
                    />
                    <label htmlFor="is_active" className="text-sm text-slate-700">
                      Utente attivo
                    </label>
                  </div>
                )}

                {formError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {formError}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
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
                    className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl font-medium transition-colors"
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
              <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
            </div>
          ) : (
            <div className="space-y-3">
              {users.map((user) => (
                <div
                  key={user.id}
                  className={`p-4 bg-white border border-slate-200 rounded-xl flex items-center gap-4 ${
                    !user.is_active ? 'opacity-50' : ''
                  }`}
                >
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-sm">
                    {user.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-800 truncate">{user.full_name}</p>
                      {!user.is_active && (
                        <span className="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs rounded-full">
                          Disattivato
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500 truncate">{user.email}</p>
                  </div>

                  {/* Role Badge */}
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${getRoleColor(user.role)}`}>
                    {getRoleIcon(user.role)}
                    {getRoleName(user.role)}
                  </div>

                  {/* Actions */}
                  {user.id !== currentUser?.id && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEdit(user)}
                        className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="Modifica"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Elimina"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {user.id === currentUser?.id && (
                    <span className="text-xs text-slate-400 italic">Tu</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!showAddForm && (
          <div className="p-6 border-t border-slate-200">
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="h-5 w-5" />
              Aggiungi Utente
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
