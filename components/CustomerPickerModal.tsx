import React, { useEffect, useMemo, useState } from 'react';
import { Customer } from '../types';
import { createCustomer, getCustomers } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { X, Search, UserPlus, Phone, Mail, BookUser } from 'lucide-react';

interface Props {
  isOpen: boolean;
  initialQuery?: string;
  onClose: () => void;
  onSelect: (customer: Customer) => void;
  onCreated?: (customer: Customer) => void;
}

interface NewCustomerDraft {
  name: string;
  phone: string;
  email: string;
}

export const CustomerPickerModal: React.FC<Props> = ({ isOpen, initialQuery, onClose, onSelect, onCreated }) => {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('customers:full');

  const [query, setQuery] = useState(initialQuery || '');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<NewCustomerDraft>({ name: '', phone: '', email: '' });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setQuery(initialQuery || '');
    setShowCreate(false);
    setDraft({ name: initialQuery?.trim() || '', phone: '', email: '' });
    setError(null);
  }, [isOpen, initialQuery]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const handle = setTimeout(async () => {
      try {
        const data = await getCustomers(query);
        if (!cancelled) setCustomers(data);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Errore caricamento clienti');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, query ? 200 : 0);

    return () => { cancelled = true; clearTimeout(handle); };
  }, [isOpen, query]);

  const handleSelect = (c: Customer) => {
    onSelect(c);
    onClose();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim() || !draft.phone.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const created = await createCustomer({
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        email: draft.email.trim() || null,
      });
      onCreated?.(created);
      onSelect(created);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Errore salvataggio cliente');
    } finally {
      setIsSaving(false);
    }
  };

  const sortedCustomers = useMemo(
    () => [...customers].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })),
    [customers]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
          <div className="flex items-center gap-2">
            <BookUser className="h-5 w-5 text-indigo-600" />
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Rubrica Clienti</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!showCreate && (
          <>
            <div className="p-3 border-b border-[var(--color-line)]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Cerca per nome, telefono, email..."
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] dark:bg-white/[0.04] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoading && (
                <div className="p-6 text-center text-sm text-slate-400">Caricamento...</div>
              )}
              {error && !isLoading && (
                <div className="p-4 text-sm text-rose-600 bg-rose-50 border-b border-rose-100 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30">{error}</div>
              )}
              {!isLoading && !error && sortedCustomers.length === 0 && (
                <div className="p-6 text-center text-sm text-slate-500">
                  Nessun cliente trovato.
                </div>
              )}
              {!isLoading && sortedCustomers.length > 0 && (
                <ul className="divide-y divide-slate-100">
                  {sortedCustomers.map(c => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => handleSelect(c)}
                        className="w-full text-left px-4 py-3 hover:bg-indigo-50/60 transition-colors"
                      >
                        <div className="font-medium text-slate-800">{c.name}</div>
                        <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-slate-500">
                          {c.phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="h-3 w-3" /> {c.phone}
                            </span>
                          )}
                          {c.email && (
                            <span className="inline-flex items-center gap-1">
                              <Mail className="h-3 w-3" /> {c.email}
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canCreate && (
              <div className="p-4 border-t border-[var(--color-line)]">
                <button
                  type="button"
                  onClick={() => {
                    setDraft({ name: query.trim(), phone: '', email: '' });
                    setShowCreate(true);
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90"
                >
                  <UserPlus className="h-4 w-4" />
                  Nuovo cliente
                </button>
              </div>
            )}
          </>
        )}

        {showCreate && (
          <form onSubmit={handleCreate} className="flex-1 overflow-y-auto">
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Nome *</label>
                <input
                  type="text"
                  autoFocus
                  required
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Telefono *</label>
                <input
                  type="tel"
                  required
                  value={draft.phone}
                  onChange={e => setDraft({ ...draft, phone: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  value={draft.email}
                  onChange={e => setDraft({ ...draft, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                />
              </div>
              {error && <p className="text-sm text-rose-600">{error}</p>}
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="flex-1 px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={isSaving || !draft.name.trim() || !draft.phone.trim()}
                className="flex-1 px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Salvataggio...' : 'Salva e seleziona'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
