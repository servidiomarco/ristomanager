import React, { useEffect, useMemo, useState } from 'react';
import { Customer, Reservation, BanquetMenu } from '../types';
import { getCustomers, createCustomer, updateCustomer, deleteCustomer } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { Search, Plus, Pencil, Trash2, X, Phone, Mail, MapPin, BookUser, History, UtensilsCrossed } from 'lucide-react';

interface Props {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

interface FormState {
  id?: number;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  postal_code: string;
  notes: string;
}

const emptyForm: FormState = {
  name: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  postal_code: '',
  notes: '',
};

const customerToForm = (c: Customer): FormState => ({
  id: c.id,
  name: c.name,
  phone: c.phone || '',
  email: c.email || '',
  address: c.address || '',
  city: c.city || '',
  postal_code: c.postal_code || '',
  notes: c.notes || '',
});

const formatLastVisit = (date: string | undefined): string => {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const CustomerList: React.FC<Props> = ({ reservations, banquetMenus, showToast }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('customers:full');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const [detailCustomer, setDetailCustomer] = useState<Customer | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getCustomers()
      .then(data => { if (!cancelled) { setCustomers(data); setError(null); } })
      .catch(err => { if (!cancelled) setError(err?.message || 'Errore caricamento clienti'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Aggregate reservation/banquet stats per customer for the detail panel.
  // Customers are matched on phone (when available) or normalised name to
  // mirror the way the picker re-attaches them to existing reservations.
  const stats = useMemo(() => {
    const byKey = new Map<string, { reservations: Reservation[]; banquetIds: number[]; lastVisit?: string }>();
    const customerKey = (c: Customer): string =>
      c.phone ? `p:${c.phone.trim()}` : `n:${c.name.trim().toLowerCase()}`;
    const reservationKey = (r: Reservation): string =>
      r.phone && r.phone.trim() ? `p:${r.phone.trim()}` : `n:${r.customer_name.trim().toLowerCase()}`;

    for (const c of customers) {
      byKey.set(customerKey(c), { reservations: [], banquetIds: [], lastVisit: undefined });
    }
    for (const r of reservations) {
      const key = reservationKey(r);
      const entry = byKey.get(key);
      if (!entry) continue;
      entry.reservations.push(r);
      if (!entry.lastVisit || r.reservation_time > entry.lastVisit) {
        entry.lastVisit = r.reservation_time;
      }
    }
    for (const b of banquetMenus) {
      if (!b.customer_id) continue;
      const customer = customers.find(c => c.id === b.customer_id);
      if (!customer) continue;
      const entry = byKey.get(customerKey(customer));
      if (entry) entry.banquetIds.push(b.id);
    }

    const result = new Map<number, { reservationCount: number; banquetCount: number; lastVisit?: string }>();
    for (const c of customers) {
      const e = byKey.get(customerKey(c));
      result.set(c.id, {
        reservationCount: e?.reservations.length || 0,
        banquetCount: e?.banquetIds.length || 0,
        lastVisit: e?.lastVisit,
      });
    }
    return result;
  }, [customers, reservations, banquetMenus]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = !term
      ? customers
      : customers.filter(c => {
          const haystack = [c.name, c.phone, c.email, c.city].filter(Boolean).join(' ').toLowerCase();
          return haystack.includes(term);
        });
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
  }, [customers, search]);

  const openCreate = () => {
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (c: Customer) => {
    setForm(customerToForm(c));
    setFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setIsSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        postal_code: form.postal_code.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (form.id) {
        const updated = await updateCustomer(form.id, payload);
        setCustomers(prev => prev.map(c => c.id === updated.id ? updated : c));
        showToast('Cliente aggiornato', 'success');
      } else {
        const created = await createCustomer(payload);
        setCustomers(prev => [...prev, created]);
        showToast('Cliente aggiunto alla rubrica', 'success');
      }
      setFormOpen(false);
    } catch (err: any) {
      showToast(err?.message || 'Errore salvataggio cliente', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteCustomer(id);
      setCustomers(prev => prev.filter(c => c.id !== id));
      setConfirmDeleteId(null);
      if (detailCustomer?.id === id) setDetailCustomer(null);
      showToast('Cliente eliminato', 'info');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione cliente', 'error');
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <BookUser className="h-6 w-6 text-indigo-600" />
            <h1 className="text-xl sm:text-2xl font-bold text-slate-800">Clienti</h1>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">Rubrica degli ospiti del ristorante e dei banchetti</p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white font-semibold hover:bg-indigo-700 shadow-sm"
          >
            <Plus className="h-5 w-5" />
            Nuovo cliente
          </button>
        )}
      </div>

      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Cerca per nome, telefono, email, città..."
          className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-slate-200 bg-white focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
        />
      </div>

      {error && (
        <div className="p-3 mb-3 rounded-lg bg-rose-50 text-rose-700 text-sm border border-rose-100">{error}</div>
      )}

      {isLoading ? (
        <div className="p-12 text-center text-sm text-slate-400">Caricamento...</div>
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 shadow-sm">
          <BookUser className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">
            {search ? 'Nessun cliente corrisponde alla ricerca.' : 'La rubrica è vuota.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(c => {
            const s = stats.get(c.id);
            return (
              <div
                key={c.id}
                className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col gap-2 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setDetailCustomer(c)}
                    className="text-left flex-1 min-w-0"
                  >
                    <h3 className="font-bold text-slate-800 truncate">{c.name}</h3>
                    {c.city && <p className="text-xs text-slate-500 truncate">{c.city}</p>}
                  </button>
                  {canEdit && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => openEdit(c)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                        title="Modifica"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(c.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                        title="Elimina"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-1 text-sm">
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      className="flex items-center gap-1.5 text-slate-600 hover:text-indigo-600"
                    >
                      <Phone className="h-3.5 w-3.5 text-slate-400" />
                      <span className="truncate">{c.phone}</span>
                    </a>
                  )}
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      className="flex items-center gap-1.5 text-slate-600 hover:text-indigo-600"
                    >
                      <Mail className="h-3.5 w-3.5 text-slate-400" />
                      <span className="truncate">{c.email}</span>
                    </a>
                  )}
                </div>

                {(s?.reservationCount || s?.banquetCount) ? (
                  <div className="mt-1 pt-2 border-t border-slate-100 flex items-center gap-3 text-xs text-slate-500">
                    {s?.reservationCount ? (
                      <span className="inline-flex items-center gap-1">
                        <History className="h-3.5 w-3.5" /> {s.reservationCount} prenot.
                      </span>
                    ) : null}
                    {s?.banquetCount ? (
                      <span className="inline-flex items-center gap-1">
                        <UtensilsCrossed className="h-3.5 w-3.5" /> {s.banquetCount} banch.
                      </span>
                    ) : null}
                    {s?.lastVisit && (
                      <span className="ml-auto">Ultima: {formatLastVisit(s.lastVisit)}</span>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit/Create form modal */}
      {formOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => !isSaving && setFormOpen(false)}>
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-800">
                {form.id ? 'Modifica cliente' : 'Nuovo cliente'}
              </h2>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                disabled={isSaving}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Nome *</label>
                  <input
                    type="text"
                    autoFocus
                    required
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Telefono</label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={e => setForm({ ...form, phone: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={e => setForm({ ...form, email: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Indirizzo</label>
                  <input
                    type="text"
                    value={form.address}
                    onChange={e => setForm({ ...form, address: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Città</label>
                    <input
                      type="text"
                      value={form.city}
                      onChange={e => setForm({ ...form, city: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">CAP</label>
                    <input
                      type="text"
                      value={form.postal_code}
                      onChange={e => setForm({ ...form, postal_code: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Note</label>
                  <textarea
                    rows={3}
                    value={form.notes}
                    onChange={e => setForm({ ...form, notes: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 outline-none resize-none"
                  />
                </div>
              </div>
              <div className="p-3 border-t border-slate-100 bg-slate-50/50 flex gap-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  disabled={isSaving}
                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={isSaving || !form.name.trim()}
                  className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? 'Salvataggio...' : (form.id ? 'Salva modifiche' : 'Aggiungi alla rubrica')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDeleteId !== null && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setConfirmDeleteId(null)}>
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-5">
              <h3 className="font-bold text-slate-800 mb-2">Eliminare il cliente?</h3>
              <p className="text-sm text-slate-600">
                I banchetti collegati manterranno la storia ma non saranno più associati al cliente.
              </p>
            </div>
            <div className="p-3 border-t border-slate-100 bg-slate-50/50 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => handleDelete(confirmDeleteId)}
                className="flex-1 px-3 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700"
              >
                Elimina
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {detailCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setDetailCustomer(null)}>
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <div className="flex items-center gap-2 min-w-0">
                <BookUser className="h-5 w-5 text-indigo-600 flex-shrink-0" />
                <h2 className="font-bold text-slate-800 truncate">{detailCustomer.name}</h2>
              </div>
              <button
                type="button"
                onClick={() => setDetailCustomer(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-3 text-sm">
              {detailCustomer.phone && (
                <div className="flex items-center gap-2 text-slate-700">
                  <Phone className="h-4 w-4 text-slate-400" />
                  <a href={`tel:${detailCustomer.phone}`} className="hover:text-indigo-600">{detailCustomer.phone}</a>
                </div>
              )}
              {detailCustomer.email && (
                <div className="flex items-center gap-2 text-slate-700">
                  <Mail className="h-4 w-4 text-slate-400" />
                  <a href={`mailto:${detailCustomer.email}`} className="hover:text-indigo-600 truncate">{detailCustomer.email}</a>
                </div>
              )}
              {(detailCustomer.address || detailCustomer.city || detailCustomer.postal_code) && (
                <div className="flex items-start gap-2 text-slate-700">
                  <MapPin className="h-4 w-4 text-slate-400 mt-0.5" />
                  <div>
                    {detailCustomer.address && <div>{detailCustomer.address}</div>}
                    {(detailCustomer.postal_code || detailCustomer.city) && (
                      <div>{[detailCustomer.postal_code, detailCustomer.city].filter(Boolean).join(' ')}</div>
                    )}
                  </div>
                </div>
              )}
              {detailCustomer.notes && (
                <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 text-slate-700 whitespace-pre-wrap">
                  {detailCustomer.notes}
                </div>
              )}

              {(() => {
                const s = stats.get(detailCustomer.id);
                if (!s || (!s.reservationCount && !s.banquetCount)) {
                  return <p className="text-xs text-slate-500 italic">Nessuna prenotazione registrata.</p>;
                }
                return (
                  <div className="border-t border-slate-100 pt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="bg-indigo-50 rounded-lg py-2">
                      <div className="text-xl font-bold text-indigo-700">{s.reservationCount}</div>
                      <div className="text-[11px] uppercase tracking-wide text-indigo-600">Prenot.</div>
                    </div>
                    <div className="bg-emerald-50 rounded-lg py-2">
                      <div className="text-xl font-bold text-emerald-700">{s.banquetCount}</div>
                      <div className="text-[11px] uppercase tracking-wide text-emerald-600">Banch.</div>
                    </div>
                    <div className="bg-slate-50 rounded-lg py-2">
                      <div className="text-xs font-bold text-slate-700 mt-1">{formatLastVisit(s.lastVisit) || '—'}</div>
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">Ultima</div>
                    </div>
                  </div>
                );
              })()}
            </div>
            {canEdit && (
              <div className="p-3 border-t border-slate-100 bg-slate-50/50 flex gap-2">
                <button
                  type="button"
                  onClick={() => { openEdit(detailCustomer); setDetailCustomer(null); }}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  <Pencil className="h-4 w-4" />
                  Modifica
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
