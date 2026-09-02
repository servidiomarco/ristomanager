import React, { useEffect, useMemo, useState } from 'react';
import { BanquetMenu, BanquetPayment, BanquetPaymentType, BanquetPaymentMethod, BanquetStatus } from '../types';
import { X, Plus, Trash2, Wallet, Banknote, CreditCard, Building2, Loader2, Check } from 'lucide-react';
import { Loader } from './Loader';
import { getBanquetPayments, createBanquetPayment, deleteBanquetPayment, setBanquetStatus } from '../services/apiService';

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
  [BanquetPaymentType.DEPOSIT]: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
  [BanquetPaymentType.BALANCE]: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  [BanquetPaymentType.OTHER]: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
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
  // Un acconto su un preventivo è il segnale di conferma per eccellenza: la
  // registrazione lo propone, non lo impone — la decisione resta allo staff.
  const [suggestConfirm, setSuggestConfirm] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
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
      if (banquet.status === BanquetStatus.QUOTE && !confirmed) setSuggestConfirm(true);
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
    <div className="fixed inset-0 bg-[var(--ds-backdrop)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-raised)] border border-[var(--ds-border)] max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--ds-border)]">
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)] truncate">Pagamenti</h3>
            <p className="text-sm text-[var(--ds-text-muted)] truncate">{banquet.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            title="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {suggestConfirm && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ds-pending-tint)] bg-[var(--ds-pending-tint)] p-3">
              <p className="text-sm text-[var(--ds-pending-text)]">
                Pagamento registrato su un preventivo: confermare il banchetto?
              </p>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={confirmBusy}
                  onClick={async () => {
                    setConfirmBusy(true);
                    try {
                      // La lista si aggiorna via socket banquet:updated.
                      await setBanquetStatus(banquet.id, BanquetStatus.CONFIRMED);
                      setConfirmed(true);
                      setSuggestConfirm(false);
                    } catch { /* resta preventivo: nessun falso ok */ }
                    finally { setConfirmBusy(false); }
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {confirmBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Conferma banchetto
                </button>
                <button
                  type="button"
                  onClick={() => setSuggestConfirm(false)}
                  className="inline-flex h-9 items-center rounded-full px-3 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)]"
                >
                  Resta preventivo
                </button>
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
              <div className="text-[11px] tracking-wide font-semibold text-[var(--ds-text-muted)]">Totale dovuto</div>
              <div className="text-xl font-bold text-[var(--ds-text-primary)] mt-1">
                {totalDue > 0 ? formatEuro(totalDue) : '—'}
              </div>
              {totalDue > 0 && (
                <div className="text-[11px] text-[var(--ds-text-muted)] mt-0.5">
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
                <div className="text-[11px] text-[var(--ds-arriving-text)] mt-1 font-medium">
                  Sconto {banquet.discount_type === 'PERCENT' ? `${Number(banquet.discount_value)}%` : formatEuro(Number(banquet.discount_value))}: −{formatEuro(discountAmount)}
                </div>
              )}
            </div>
            <div className="rounded-lg bg-[var(--ds-seated-tint)] border border-[var(--ds-seated-tint)] p-3">
              <div className="text-[11px] tracking-wide font-semibold text-[var(--ds-seated-text)]">Già pagato</div>
              <div className="text-xl font-bold text-[var(--ds-seated-text)] mt-1">{formatEuro(totalPaid)}</div>
              <div className="text-[11px] text-[var(--ds-seated-text)] mt-0.5">
                {payments.length} {payments.length === 1 ? 'pagamento' : 'pagamenti'}
              </div>
            </div>
            <div className={`rounded-lg border p-3 ${remaining != null && remaining > 0 ? 'bg-[var(--ds-critical-tint)] border-[var(--ds-critical-tint)]' : 'bg-[var(--ds-surface-row)] border-[var(--ds-border)]'}`}>
              <div className={`text-[11px] tracking-wide font-semibold ${remaining != null && remaining > 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`}>Residuo</div>
              <div className={`text-xl font-bold mt-1 ${remaining != null && remaining > 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'}`}>
                {remaining != null ? formatEuro(remaining) : '—'}
              </div>
              {remaining != null && remaining <= 0 && totalDue > 0 && (
                <div className="text-[11px] text-[var(--ds-seated-text)] mt-0.5 font-medium">Saldato</div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-[var(--ds-critical-tint)] border border-[var(--ds-critical-tint)] p-3 text-sm text-[var(--ds-critical-text)]">
              {error}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Pagamenti registrati</h3>
              {!showForm && (
                <button
                  type="button"
                  onClick={() => setShowForm(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ds-arriving-text)] hover:text-[var(--ds-arriving-text)]"
                >
                  <Plus className="h-3.5 w-3.5" /> Registra pagamento
                </button>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8 text-[var(--ds-text-subtle)]">
                <Loader label="Caricamento…" size={40} />
              </div>
            ) : payments.length === 0 ? (
              <p className="text-sm text-[var(--ds-text-subtle)] italic text-center py-6 bg-[var(--ds-surface-row)] rounded-lg border border-dashed border-[var(--ds-border)]">
                Nessun pagamento registrato.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--ds-border)] border border-[var(--ds-border)] rounded-lg overflow-hidden">
                {payments.map(p => {
                  const MethodIcon = METHOD_ICON[p.payment_method];
                  return (
                    <li key={p.id} className="flex items-center gap-3 p-3 bg-white">
                      <div className="h-9 w-9 rounded-full bg-[var(--ds-surface-row)] flex items-center justify-center flex-shrink-0">
                        <MethodIcon className="h-4 w-4 text-[var(--ds-text-secondary)]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded ${TYPE_BADGE[p.payment_type]}`}>
                            {TYPE_LABEL[p.payment_type]}
                          </span>
                          <span className="text-xs text-[var(--ds-text-muted)]">{formatDateIt(p.payment_date)}</span>
                          <span className="text-xs text-[var(--ds-text-subtle)]">·</span>
                          <span className="text-xs text-[var(--ds-text-muted)]">{METHOD_LABEL[p.payment_method]}</span>
                        </div>
                        {p.notes && <div className="text-xs text-[var(--ds-text-muted)] mt-0.5 truncate">{p.notes}</div>}
                        {p.created_by_user_name && (
                          <div className="text-[10px] text-[var(--ds-text-subtle)] mt-0.5">Registrato da {p.created_by_user_name}</div>
                        )}
                      </div>
                      <div className="text-base font-bold text-[var(--ds-text-primary)] flex-shrink-0">{formatEuro(p.amount)}</div>
                      <button
                        type="button"
                        onClick={() => handleDelete(p.id)}
                        className="p-1.5 rounded-md text-[var(--ds-text-subtle)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)] flex-shrink-0"
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
            <form onSubmit={handleSubmit} className="rounded-lg border border-[var(--ds-arriving-tint)] bg-[var(--ds-arriving-tint)] p-4 space-y-3">
              <div className="text-[13px] font-semibold text-[var(--ds-arriving-text)]">Nuovo pagamento</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--ds-text-secondary)] mb-1">Importo (€) *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={form.amount}
                    onChange={e => setForm({ ...form, amount: e.target.value })}
                    className="w-full rounded-md border border-[var(--ds-border-strong)] bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ds-text-secondary)] mb-1">Data *</label>
                  <input
                    type="date"
                    required
                    value={form.payment_date}
                    onChange={e => setForm({ ...form, payment_date: e.target.value })}
                    className="w-full rounded-md border border-[var(--ds-border-strong)] bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ds-text-secondary)] mb-1">Tipo</label>
                  <select
                    value={form.payment_type}
                    onChange={e => setForm({ ...form, payment_type: e.target.value as BanquetPaymentType })}
                    className="w-full rounded-md border border-[var(--ds-border-strong)] bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <option value={BanquetPaymentType.DEPOSIT}>Acconto</option>
                    <option value={BanquetPaymentType.BALANCE}>Saldo</option>
                    <option value={BanquetPaymentType.OTHER}>Altro</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ds-text-secondary)] mb-1">Metodo</label>
                  <select
                    value={form.payment_method}
                    onChange={e => setForm({ ...form, payment_method: e.target.value as BanquetPaymentMethod })}
                    className="w-full rounded-md border border-[var(--ds-border-strong)] bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <option value={BanquetPaymentMethod.CASH}>Contanti</option>
                    <option value={BanquetPaymentMethod.CARD}>Carta</option>
                    <option value={BanquetPaymentMethod.TRANSFER}>Bonifico</option>
                    <option value={BanquetPaymentMethod.OTHER}>Altro</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ds-text-secondary)] mb-1">Note (opzionale)</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Es. Riferimento bonifico, ricevuta n. ..."
                  className="w-full rounded-md border border-[var(--ds-border-strong)] bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                />
              </div>
              {formError && (
                <div className="text-xs text-[var(--ds-critical-text)] bg-[var(--ds-critical-tint)] border border-[var(--ds-critical-tint)] rounded-md px-2 py-1.5">
                  {formError}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => { setShowForm(false); setFormError(null); }}
                  className="rounded-full px-4 py-2 border border-[var(--ds-border-strong)] bg-white text-[var(--ds-text-primary)] text-sm font-medium hover:bg-[var(--ds-surface-row)]"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-full px-4 py-2 bg-[var(--ds-action-bg)] text-white dark:text-[var(--ds-action-fg)] text-sm font-medium hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
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
