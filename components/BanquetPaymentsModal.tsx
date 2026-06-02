import React, { useEffect, useMemo, useState } from 'react';
import { BanquetMenu, BanquetPayment, BanquetPaymentType, BanquetPaymentMethod } from '../types';
import { X, Plus, Trash2, Wallet, Banknote, CreditCard, Building2, Loader2 } from 'lucide-react';
import { getBanquetPayments, createBanquetPayment, deleteBanquetPayment } from '../services/apiService';

interface Props {
  banquet: BanquetMenu;
  onClose: () => void;
}

const formatEuro = (n: number | string | null | undefined): string => {
  const num = Number(n ?? 0);
  return `€ ${num.toFixed(2).replace('.', ',')}`;
};

const formatDateIt = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
};

const TYPE_LABEL: Record<BanquetPaymentType, string> = {
  [BanquetPaymentType.DEPOSIT]: 'Acconto',
  [BanquetPaymentType.BALANCE]: 'Saldo',
  [BanquetPaymentType.OTHER]: 'Altro'
};

const TYPE_BADGE: Record<BanquetPaymentType, string> = {
  [BanquetPaymentType.DEPOSIT]: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  [BanquetPaymentType.BALANCE]: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  [BanquetPaymentType.OTHER]: 'bg-slate-100 text-slate-700'
};

const METHOD_LABEL: Record<BanquetPaymentMethod, string> = {
  [BanquetPaymentMethod.CASH]: 'Contanti',
  [BanquetPaymentMethod.CARD]: 'Carta',
  [BanquetPaymentMethod.TRANSFER]: 'Bonifico',
  [BanquetPaymentMethod.OTHER]: 'Altro'
};

const METHOD_ICON: Record<BanquetPaymentMethod, React.ComponentType<{ className?: string }>> = {
  [BanquetPaymentMethod.CASH]: Banknote,
  [BanquetPaymentMethod.CARD]: CreditCard,
  [BanquetPaymentMethod.TRANSFER]: Building2,
  [BanquetPaymentMethod.OTHER]: Wallet
};

const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const BanquetPaymentsModal: React.FC<Props> = ({ banquet, onClose }) => {
  const [payments, setPayments] = useState<BanquetPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    amount: '',
    payment_date: todayLocal(),
    payment_type: BanquetPaymentType.DEPOSIT,
    payment_method: BanquetPaymentMethod.TRANSFER,
    notes: ''
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBanquetPayments(banquet.id)
      .then(rows => { if (!cancelled) setPayments(rows.map(r => ({ ...r, amount: Number(r.amount) }))); })
      .catch(err => { if (!cancelled) setError(err?.message || 'Errore caricamento pagamenti'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [banquet.id]);

  const gross = useMemo(() => {
    const guests = banquet.guests || 0;
    const children = Math.min(banquet.children || 0, guests);
    const adults = Math.max(0, guests - children);
    const adultPrice = Number(banquet.price_per_person) || 0;
    const childPrice = banquet.children_price != null ? Number(banquet.children_price) : adultPrice;
    return guests > 0 ? adults * adultPrice + children * childPrice : 0;
  }, [banquet.guests, banquet.children, banquet.price_per_person, banquet.children_price]);

  const discountAmount = useMemo(() => {
    if (!banquet.discount_type || banquet.discount_value == null) return 0;
    const v = Number(banquet.discount_value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (banquet.discount_type === 'PERCENT') return Math.min(gross, gross * (v / 100));
    return Math.min(gross, v);
  }, [banquet.discount_type, banquet.discount_value, gross]);

  const totalDue = Math.max(0, gross - discountAmount);

  const totalPaid = useMemo(
    () => payments.reduce((sum, p) => sum + Number(p.amount), 0),
    [payments]
  );

  const remaining = totalDue > 0 ? totalDue - totalPaid : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const amountNum = parseFloat(form.amount);
    if (!form.amount || isNaN(amountNum) || amountNum <= 0) {
      setFormError("L'importo deve essere maggiore di zero");
      return;
    }
    if (!form.payment_date) {
      setFormError('Inserisci la data del pagamento');
      return;
    }

    setSubmitting(true);
    try {
      const created = await createBanquetPayment(banquet.id, {
        amount: amountNum,
        payment_date: form.payment_date,
        payment_type: form.payment_type,
        payment_method: form.payment_method,
        notes: form.notes.trim() || undefined
      });
      setPayments(prev => [{ ...created, amount: Number(created.amount) }, ...prev]);
      setShowForm(false);
      setForm({
        amount: '',
        payment_date: todayLocal(),
        payment_type: BanquetPaymentType.DEPOSIT,
        payment_method: BanquetPaymentMethod.TRANSFER,
        notes: ''
      });
    } catch (err: any) {
      setFormError(err?.message || 'Errore durante la registrazione');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (paymentId: number) => {
    if (!window.confirm('Eliminare questo pagamento?')) return;
    try {
      await deleteBanquetPayment(banquet.id, paymentId);
      setPayments(prev => prev.filter(p => p.id !== paymentId));
    } catch (err: any) {
      setError(err?.message || 'Errore eliminazione pagamento');
    }
  };

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] truncate">Pagamenti</h3>
            <p className="text-sm text-[var(--color-fg-muted)] truncate">{banquet.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
            title="Chiudi"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
              <div className="text-[11px] tracking-wide font-semibold text-slate-500">Totale dovuto</div>
              <div className="text-xl font-bold text-slate-800 mt-1">
                {totalDue > 0 ? formatEuro(totalDue) : '—'}
              </div>
              {totalDue > 0 && (
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {(() => {
                    const guests = banquet.guests || 0;
                    const children = Math.min(banquet.children || 0, guests);
                    const adults = Math.max(0, guests - children);
                    const childPrice = banquet.children_price != null ? Number(banquet.children_price) : null;
                    if (children > 0 && childPrice != null) {
                      return `${adults} × ${formatEuro(banquet.price_per_person)} + ${children} × ${formatEuro(childPrice)}`;
                    }
                    return `${guests} × ${formatEuro(banquet.price_per_person)}`;
                  })()}
                </div>
              )}
              {discountAmount > 0 && (
                <div className="text-[11px] text-violet-700 dark:text-violet-300 mt-1 font-medium">
                  Sconto {banquet.discount_type === 'PERCENT' ? `${Number(banquet.discount_value)}%` : formatEuro(Number(banquet.discount_value))}: −{formatEuro(discountAmount)}
                </div>
              )}
            </div>
            <div className="rounded-lg bg-emerald-50 border border-emerald-100 dark:bg-emerald-500/15 dark:border-emerald-500/30 p-3">
              <div className="text-[11px] tracking-wide font-semibold text-emerald-700 dark:text-emerald-300">Già pagato</div>
              <div className="text-xl font-bold text-emerald-800 dark:text-emerald-200 mt-1">{formatEuro(totalPaid)}</div>
              <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5">
                {payments.length} {payments.length === 1 ? 'pagamento' : 'pagamenti'}
              </div>
            </div>
            <div className={`rounded-lg border p-3 ${remaining != null && remaining > 0 ? 'bg-rose-50 border-rose-100 dark:bg-rose-500/15 dark:border-rose-500/30' : 'bg-slate-50 border-slate-100'}`}>
              <div className={`text-[11px] tracking-wide font-semibold ${remaining != null && remaining > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-slate-500'}`}>Residuo</div>
              <div className={`text-xl font-bold mt-1 ${remaining != null && remaining > 0 ? 'text-rose-800 dark:text-rose-200' : 'text-slate-800'}`}>
                {remaining != null ? formatEuro(remaining) : '—'}
              </div>
              {remaining != null && remaining <= 0 && totalDue > 0 && (
                <div className="text-[11px] text-emerald-700 mt-0.5 font-medium">Saldato</div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300 p-3 text-sm text-rose-800">
              {error}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold tracking-wider text-slate-500">Pagamenti registrati</h3>
              {!showForm && (
                <button
                  type="button"
                  onClick={() => setShowForm(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Registra pagamento
                </button>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : payments.length === 0 ? (
              <p className="text-sm text-slate-400 italic text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                Nessun pagamento registrato.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden">
                {payments.map(p => {
                  const MethodIcon = METHOD_ICON[p.payment_method];
                  return (
                    <li key={p.id} className="flex items-center gap-3 p-3 bg-white">
                      <div className="h-9 w-9 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                        <MethodIcon className="h-4 w-4 text-slate-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded ${TYPE_BADGE[p.payment_type]}`}>
                            {TYPE_LABEL[p.payment_type]}
                          </span>
                          <span className="text-xs text-slate-500">{formatDateIt(p.payment_date)}</span>
                          <span className="text-xs text-slate-400">·</span>
                          <span className="text-xs text-slate-500">{METHOD_LABEL[p.payment_method]}</span>
                        </div>
                        {p.notes && <div className="text-xs text-slate-500 mt-0.5 truncate">{p.notes}</div>}
                        {p.created_by_user_name && (
                          <div className="text-[10px] text-slate-400 mt-0.5">Registrato da {p.created_by_user_name}</div>
                        )}
                      </div>
                      <div className="text-base font-bold text-slate-800 flex-shrink-0">{formatEuro(p.amount)}</div>
                      <button
                        type="button"
                        onClick={() => handleDelete(p.id)}
                        className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-500/15 flex-shrink-0"
                        title="Elimina"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-4 space-y-3">
              <div className="text-xs font-semibold tracking-wider text-indigo-700">Nuovo pagamento</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Importo (€) *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={form.amount}
                    onChange={e => setForm({ ...form, amount: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Data *</label>
                  <input
                    type="date"
                    required
                    value={form.payment_date}
                    onChange={e => setForm({ ...form, payment_date: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Tipo</label>
                  <select
                    value={form.payment_type}
                    onChange={e => setForm({ ...form, payment_type: e.target.value as BanquetPaymentType })}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value={BanquetPaymentType.DEPOSIT}>Acconto</option>
                    <option value={BanquetPaymentType.BALANCE}>Saldo</option>
                    <option value={BanquetPaymentType.OTHER}>Altro</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Metodo</label>
                  <select
                    value={form.payment_method}
                    onChange={e => setForm({ ...form, payment_method: e.target.value as BanquetPaymentMethod })}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value={BanquetPaymentMethod.CASH}>Contanti</option>
                    <option value={BanquetPaymentMethod.CARD}>Carta</option>
                    <option value={BanquetPaymentMethod.TRANSFER}>Bonifico</option>
                    <option value={BanquetPaymentMethod.OTHER}>Altro</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Note (opzionale)</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Es. Riferimento bonifico, ricevuta n. ..."
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              {formError && (
                <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 rounded-md px-2 py-1.5">
                  {formError}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => { setShowForm(false); setFormError(null); }}
                  className="rounded-full px-4 py-2 border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-full px-4 py-2 bg-indigo-600 text-white dark:text-[var(--color-fg-on-brand)] text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Registra
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
