import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CreditCard, Search, X, Loader2, Calendar, Clock, AlertCircle, Filter,
  ExternalLink, MessageSquare, MessageCircle, Mail, Users as UsersIcon,
  CheckCircle2, XCircle, Hourglass, Ban, Copy, Check, RefreshCw, Armchair, Receipt, RotateCcw,
} from 'lucide-react';
import { socketClient } from '../services/socketClient';
import { billsApiService } from '../services/billsApiService';
import { CookingPotLoader } from './CookingPotLoader';
import { SkeletonPaymentList } from './SkeletonCards';
import {
  paymentsApiService,
  PaymentRequest,
  PaymentsListParams,
  PaymentMessage,
} from '../services/paymentsApiService';
import { useAuth } from '../contexts/AuthContext';
import { toTitleCase } from '../utils/text';

const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const formatEuro = (cents: number, currency: string = 'EUR'): string => {
  const symbol = currency === 'EUR' ? '€' : currency;
  return `${symbol} ${(cents / 100).toFixed(2).replace('.', ',')}`;
};

// Map raw payment status → { label, badge classes, icon }. COMPLETED/PAID
// collapse into the same "Pagato" bucket; AUTHORISED behaves like PENDING
// visually (money not moved yet from the customer's account).
type StatusView = { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> };
const paymentStatusView = (status: string | null | undefined): StatusView => {
  const s = (status || '').toUpperCase();
  switch (s) {
    case 'COMPLETED':
    case 'PAID':
      return { label: 'Pagato', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', Icon: CheckCircle2 };
    case 'PENDING':
      return { label: 'In attesa', cls: 'bg-amber-50 text-amber-700 ring-amber-200', Icon: Hourglass };
    case 'AUTHORISED':
      return { label: 'Autorizzato', cls: 'bg-sky-50 text-sky-700 ring-sky-200', Icon: Hourglass };
    case 'FAILED':
      return { label: 'Fallito', cls: 'bg-rose-50 text-rose-700 ring-rose-200', Icon: XCircle };
    case 'CANCELLED':
      return { label: 'Annullato', cls: 'bg-slate-100 text-slate-700 ring-slate-200', Icon: Ban };
    case 'EXPIRED':
      return { label: 'Scaduto', cls: 'bg-slate-100 text-slate-600 ring-slate-200', Icon: Ban };
    case 'REFUNDED':
      return { label: 'Rimborsato', cls: 'bg-violet-50 text-violet-700 ring-violet-200', Icon: RotateCcw };
    default:
      return { label: s || 'Sconosciuto', cls: 'bg-slate-100 text-slate-700 ring-slate-200', Icon: AlertCircle };
  }
};

// Rendering primitives for the message channels. WhatsApp isn't shipped as
// a lucide icon; MessageCircle is the closest generic and gets a green tint
// so it reads as WA in the timeline.
type ChannelView = { label: string; Icon: React.ComponentType<{ className?: string }>; cls: string };
const channelView = (channel: string): ChannelView => {
  const c = (channel || '').toLowerCase();
  if (c === 'sms') return { label: 'SMS', Icon: MessageSquare, cls: 'bg-sky-50 text-sky-700 ring-sky-200' };
  if (c === 'whatsapp') return { label: 'WhatsApp', Icon: MessageCircle, cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
  if (c === 'email') return { label: 'Email', Icon: Mail, cls: 'bg-violet-50 text-violet-700 ring-violet-200' };
  return { label: channel || 'Altro', Icon: MessageSquare, cls: 'bg-slate-50 text-slate-700 ring-slate-200' };
};

const messageStatusBadge = (status: string | null | undefined): { label: string; cls: string } => {
  const s = (status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return { label: 'Consegnato', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
  if (s === 'sent' || s === 'queued' || s === 'accepted' || s === 'sending') return { label: 'Inviato', cls: 'bg-sky-50 text-sky-700 ring-sky-200' };
  if (s === 'failed' || s === 'undelivered') return { label: 'Fallito', cls: 'bg-rose-50 text-rose-700 ring-rose-200' };
  return { label: s || 'In coda', cls: 'bg-slate-50 text-slate-700 ring-slate-200' };
};

const reservationStatusBadge = (status: string | null | undefined): { label: string; cls: string } | null => {
  if (!status) return null;
  switch (status) {
    case 'CONFIRMED': return { label: 'Confermata', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
    case 'CANCELLED': return { label: 'Annullata', cls: 'bg-rose-50 text-rose-700 ring-rose-200' };
    case 'PENDING': return { label: 'In attesa', cls: 'bg-amber-50 text-amber-700 ring-amber-200' };
    default: return { label: status, cls: 'bg-slate-50 text-slate-700 ring-slate-200' };
  }
};

interface DetailModalProps {
  payment: PaymentRequest;
  onClose: () => void;
  onReconciled?: (updated: PaymentRequest) => void;
}

const DetailModal: React.FC<DetailModalProps> = ({ payment: initialPayment, onClose, onReconciled }) => {
  const { hasPermission } = useAuth();
  const [payment, setPayment] = useState<PaymentRequest>(initialPayment);
  const [messages, setMessages] = useState<PaymentMessage[]>([]);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(initialPayment.checkout_url);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileFeedback, setReconcileFeedback] = useState<{ kind: 'ok' | 'info' | 'err'; text: string } | null>(null);
  const [refundArmed, setRefundArmed] = useState(false);
  const [refunding, setRefunding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    paymentsApiService.listMessages(payment.id)
      .then(r => {
        if (cancelled) return;
        setMessages(r.items);
        if (r.checkout_url) setCheckoutUrl(r.checkout_url);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [payment.id]);

  const status = paymentStatusView(payment.status);
  const StatusIcon = status.Icon;
  const resBadge = reservationStatusBadge(payment.reservation_status);

  const copyLink = () => {
    if (!checkoutUrl) return;
    navigator.clipboard.writeText(checkoutUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  // Ask the server to poll Revolut for the authoritative order state and
  // apply the transition — used when a webhook was missed (e.g. this order
  // was created before the webhook endpoint existed).
  const canReconcile =
    hasPermission('payments:full') &&
    payment.provider === 'revolut' &&
    !!payment.provider_order_id;

  // Refund of a bill-split payment (PR 6). Two-tap confirm, then the server
  // refunds via Revolut and reopens the bill if it was settled. Covers the
  // overpayment case too (payment completed after the claim was abandoned).
  const canRefund =
    hasPermission('payments:full') &&
    payment.table_bill_split_id != null &&
    ['COMPLETED', 'PAID'].includes((payment.status || '').toUpperCase());

  const refund = async () => {
    if (!refundArmed) { setRefundArmed(true); return; }
    setRefundArmed(false);
    setRefunding(true);
    setReconcileFeedback(null);
    try {
      const result = await billsApiService.refundSplit(payment.table_bill_split_id as number);
      const updated = { ...payment, status: 'REFUNDED' };
      setPayment(updated);
      onReconciled?.(updated);
      setReconcileFeedback({ kind: 'ok', text: result.reopened ? 'Rimborsato — conto riaperto per la parte mancante' : 'Rimborso eseguito' });
    } catch (err) {
      setReconcileFeedback({ kind: 'err', text: (err as Error).message });
    } finally {
      setRefunding(false);
    }
  };

  const reconcile = async () => {
    if (reconciling) return;
    setReconciling(true);
    setReconcileFeedback(null);
    try {
      const result = await paymentsApiService.reconcile(payment.id);
      if (result.payment_request) {
        setPayment(result.payment_request);
        onReconciled?.(result.payment_request);
      }
      if (result.changed) {
        setReconcileFeedback({ kind: 'ok', text: `Stato aggiornato da Revolut: ${result.revolut_state ?? '—'}` });
      } else if (result.message) {
        setReconcileFeedback({ kind: 'info', text: result.message });
      } else {
        setReconcileFeedback({ kind: 'info', text: 'Nessun aggiornamento necessario' });
      }
    } catch (err) {
      setReconcileFeedback({ kind: 'err', text: (err as Error).message });
    } finally {
      setReconciling(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-line)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <CreditCard className="h-4 w-4 text-[var(--color-fg-muted)] shrink-0" />
            <div className="flex flex-col min-w-0">
              <h2 className="text-[15px] font-semibold text-[var(--color-fg)] truncate">
                {formatEuro(payment.amount_cents, payment.currency)}
                {payment.reservation_customer_name && (
                  <span className="text-[var(--color-fg-muted)] font-normal"> · {toTitleCase(payment.reservation_customer_name)}</span>
                )}
              </h2>
              <span className="text-[12px] text-[var(--color-fg-muted)] tabular truncate">
                Ordine {payment.provider_order_id || '—'}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium">Stato</div>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset ${status.cls}`}>
                  <StatusIcon className="h-3 w-3" />
                  {status.label}
                </span>
                {canReconcile && (
                  <button
                    onClick={reconcile}
                    disabled={reconciling}
                    className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] disabled:opacity-60 disabled:cursor-not-allowed"
                    title="Interroga Revolut e aggiorna lo stato"
                  >
                    {reconciling
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />}
                    {reconciling ? 'Riconcilio…' : 'Riconcilia'}
                  </button>
                )}
                {canRefund && (
                  <button
                    onClick={refund}
                    onBlur={() => setRefundArmed(false)}
                    disabled={refunding}
                    className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                      refundArmed
                        ? 'bg-rose-600 text-white hover:bg-rose-700'
                        : 'border border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:hover:bg-rose-500/10'
                    }`}
                    title={refundArmed ? 'Clicca di nuovo per confermare' : 'Rimborsa la quota via Revolut'}
                  >
                    {refunding
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RotateCcw className="h-3 w-3" />}
                    {refunding ? 'Rimborso…' : refundArmed ? 'Confermi il rimborso?' : 'Rimborsa'}
                  </button>
                )}
              </div>
              {reconcileFeedback && (
                <div className={`mt-1.5 text-[11px] ${
                  reconcileFeedback.kind === 'ok' ? 'text-emerald-700'
                  : reconcileFeedback.kind === 'err' ? 'text-rose-700'
                  : 'text-[var(--color-fg-muted)]'
                }`}>
                  {reconcileFeedback.text}
                </div>
              )}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium">Creato</div>
              <div className="text-[var(--color-fg)] mt-0.5">{formatDateTime(payment.created_at)}</div>
            </div>
            {payment.completed_at && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium">Completato</div>
                <div className="text-[var(--color-fg)] mt-0.5">{formatDateTime(payment.completed_at)}</div>
              </div>
            )}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium">Provider</div>
              <div className="text-[var(--color-fg)] mt-0.5 capitalize">{payment.provider}</div>
            </div>
          </div>

          {payment.table_bill_id != null && (
            <div className="rounded-xl border border-sky-200 dark:border-sky-500/30 bg-sky-50/60 dark:bg-sky-500/10 p-3">
              <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg)] min-w-0 flex-wrap">
                <Armchair className="h-4 w-4 text-sky-600 shrink-0" />
                <span className="font-medium">
                  {payment.table_name ? `Tavolo ${payment.table_name}` : `Conto #${payment.table_bill_id}`}
                </span>
                {payment.claimant_label && (
                  <span className="text-[var(--color-fg-muted)]">· quota di {toTitleCase(payment.claimant_label)}</span>
                )}
                {payment.bill_total_cents != null && payment.bill_total_cents > 0 && (
                  <span className="text-[12px] text-[var(--color-fg-muted)] tabular ml-auto">
                    conto {formatEuro(payment.bill_total_cents)}
                  </span>
                )}
              </div>
            </div>
          )}

          {payment.reservation_id != null && (
            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg)] min-w-0">
                  <Calendar className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span className="font-medium truncate">
                    {toTitleCase(payment.reservation_customer_name) || `Prenotazione #${payment.reservation_id}`}
                  </span>
                  {resBadge && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${resBadge.cls}`}>
                      {resBadge.label}
                    </span>
                  )}
                </div>
                <a
                  href={`/?view=RESERVATIONS&reservationId=${payment.reservation_id}`}
                  className="text-[12px] text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 shrink-0"
                >
                  Apri <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="text-[12px] text-[var(--color-fg-muted)] mt-1 flex items-center gap-3 flex-wrap">
                {payment.reservation_time && <span>{formatDateTime(payment.reservation_time)}</span>}
                {payment.reservation_guests != null && (
                  <span className="inline-flex items-center gap-1"><UsersIcon className="h-3 w-3" /> {payment.reservation_guests}</span>
                )}
                {payment.reservation_phone && <span className="tabular">{payment.reservation_phone}</span>}
              </div>
            </div>
          )}

          {payment.description && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-1">Descrizione</div>
              <p className="text-[13px] text-[var(--color-fg)] leading-relaxed">{payment.description}</p>
            </div>
          )}

          <div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-2">Link di pagamento</div>
            {checkoutUrl ? (
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={checkoutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-700"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Apri checkout
                </a>
                <button
                  onClick={copyLink}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-fg)] text-[13px] font-medium hover:bg-[var(--color-surface-hover)]"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copiato' : 'Copia link'}
                </button>
              </div>
            ) : (
              <p className="text-[12px] text-[var(--color-fg-subtle)] italic">Link non disponibile.</p>
            )}
            {(payment.delivery_channel || payment.delivery_error) && (
              <div className="mt-2 text-[12px] text-[var(--color-fg-muted)] flex items-start gap-2">
                {payment.delivery_channel && (
                  <span className="inline-flex items-center gap-1">
                    Inviato via <strong className="text-[var(--color-fg)] capitalize">{payment.delivery_channel}</strong>
                  </span>
                )}
                {payment.delivery_error && (
                  <span className="text-rose-600 inline-flex items-start gap-1">
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    {payment.delivery_error}
                  </span>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-2 flex items-center gap-1.5">
              Comunicazioni con il cliente
              {messages.length > 0 && (
                <span className="text-[var(--color-fg-muted)] font-normal">· {messages.length}</span>
              )}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Carico messaggi…</span>
              </div>
            ) : error ? (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-[12px]">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : messages.length === 0 ? (
              <p className="text-[12px] text-[var(--color-fg-subtle)] italic">Nessuna comunicazione registrata.</p>
            ) : (
              <div className="space-y-2">
                {messages.map(msg => {
                  const ch = channelView(msg.channel);
                  const ChIcon = ch.Icon;
                  const sBadge = messageStatusBadge(msg.status);
                  return (
                    <div
                      key={msg.id}
                      className={`rounded-xl border p-3 ${
                        msg.is_payment_link
                          ? 'border-indigo-200 bg-indigo-50/40 dark:border-indigo-500/30 dark:bg-indigo-500/5'
                          : 'border-[var(--color-line)] bg-[var(--color-bg)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                        <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset ${ch.cls}`}>
                            <ChIcon className="h-3 w-3" />
                            {ch.label}
                          </span>
                          <span className="tabular">{formatDateTime(msg.sent_at)}</span>
                          {msg.is_payment_link && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset bg-indigo-50 text-indigo-700 ring-indigo-200">
                              Link pagamento
                            </span>
                          )}
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${sBadge.cls}`}>
                          {sBadge.label}
                        </span>
                      </div>
                      {msg.subject && (
                        <div className="text-[12px] font-medium text-[var(--color-fg)] mb-0.5">{msg.subject}</div>
                      )}
                      <p className="text-[13px] text-[var(--color-fg)] whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                      {msg.error_message && (
                        <div className="mt-1.5 text-[11px] text-rose-600 flex items-start gap-1">
                          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span>{msg.error_code ? `${msg.error_code}: ` : ''}{msg.error_message}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const PagamentiPage: React.FC = () => {
  const [items, setItems] = useState<PaymentRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Groups multiple raw Revolut statuses under one chip to keep the filter
  // vocabulary simple (Pagati includes both COMPLETED and PAID; Falliti
  // groups FAILED + CANCELLED — both terminal, both money-not-received).
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'paid' | 'failed' | 'expired'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [selected, setSelected] = useState<PaymentRequest | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: PaymentsListParams = { limit: 200 };
      if (searchDebounced.trim()) params.q = searchDebounced.trim();
      if (statusFilter === 'pending') params.status = 'PENDING,AUTHORISED';
      else if (statusFilter === 'paid') params.status = 'COMPLETED,PAID';
      else if (statusFilter === 'failed') params.status = 'FAILED,CANCELLED';
      else if (statusFilter === 'expired') params.status = 'EXPIRED';
      if (from) params.from = from;
      if (to) params.to = to;
      const result = await paymentsApiService.list(params);
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [searchDebounced, statusFilter, from, to]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // The operator is looking at the list: clear the sidebar badge. Re-marked
  // after every live refresh so payments landing while the page is open
  // don't pile up as "unseen".
  useEffect(() => {
    if (!loading) paymentsApiService.markSeen().catch(() => {});
  }, [loading, items]);

  // Live refresh: any payment created/updated (webhook, reconcile, altro
  // dispositivo) refetches the list. Debounced so a burst of split payments
  // triggers one request.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => { fetchItems(); }, 400);
    };
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('paymentRequest:created', onEvent);
        attached.off('paymentRequest:updated', onEvent);
      }
      attached = s;
      if (attached) {
        attached.on('paymentRequest:created', onEvent);
        attached.on('paymentRequest:updated', onEvent);
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      unsub();
      attach(null);
    };
  }, [fetchItems]);

  const hasActiveFilters = statusFilter !== 'all' || !!from || !!to || !!searchDebounced.trim();
  const resetAll = () => {
    setStatusFilter('all');
    setFrom('');
    setTo('');
    setSearch('');
  };

  const totalsByStatus = useMemo(() => {
    const acc = { paid: 0, pending: 0 };
    for (const p of items) {
      const s = (p.status || '').toUpperCase();
      if (s === 'COMPLETED' || s === 'PAID') acc.paid += p.amount_cents;
      else if (s === 'PENDING' || s === 'AUTHORISED') acc.pending += p.amount_cents;
    }
    return acc;
  }, [items]);

  const statusChips = [
    { v: 'all', l: 'Tutti', dot: null },
    { v: 'pending', l: 'In attesa', dot: 'bg-amber-500' },
    { v: 'paid', l: 'Pagati', dot: 'bg-emerald-500' },
    { v: 'failed', l: 'Falliti', dot: 'bg-rose-500' },
    { v: 'expired', l: 'Scaduti', dot: 'bg-slate-400' },
  ] as const;

  // Split payments of the same table bill render as one visual group: the
  // group takes the list position of its most recent payment (list is
  // created_at DESC), standalone payments flow through untouched.
  const grouped = useMemo(() => {
    const byBill = new Map<number, PaymentRequest[]>();
    const order: Array<{ billId: number | null; items: PaymentRequest[] }> = [];
    for (const p of items) {
      if (p.table_bill_id != null) {
        const existing = byBill.get(p.table_bill_id);
        if (existing) { existing.push(p); continue; }
        const arr = [p];
        byBill.set(p.table_bill_id, arr);
        order.push({ billId: p.table_bill_id, items: arr });
      } else {
        order.push({ billId: null, items: [p] });
      }
    }
    return order;
  }, [items]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold text-[var(--color-fg)]">Pagamenti</h1>
            <p className="text-[13px] text-[var(--color-fg-muted)] mt-0.5">
              Link Revolut inviati ai clienti · stato aggiornato via webhook
            </p>
          </div>
          <div className="flex items-center gap-3 text-[12px] text-[var(--color-fg-muted)]">
            <span>
              Pagato: <strong className="text-emerald-700">{formatEuro(totalsByStatus.paid)}</strong>
            </span>
            <span>
              In attesa: <strong className="text-amber-700">{formatEuro(totalsByStatus.pending)}</strong>
            </span>
          </div>
        </div>

        <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-3 md:p-4 space-y-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--color-fg-subtle)] pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca cliente, telefono, ordine, descrizione…"
              className="w-full pl-8 pr-8 py-2 text-[13px] rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-full text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                aria-label="Svuota ricerca"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Status chips — scroll horizontally on narrow screens */}
          <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {statusChips.map(({ v, l, dot }) => {
              const active = statusFilter === v;
              return (
                <button
                  key={v}
                  onClick={() => setStatusFilter(v)}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)]'
                  }`}
                >
                  {dot && (
                    <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-white/90' : dot}`} />
                  )}
                  {l}
                </button>
              );
            })}
          </div>

          {/* Period + count + reset */}
          <div className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--color-fg-muted)] pt-1 border-t border-[var(--color-line)]">
            <div className="flex items-center gap-2 flex-wrap pt-2">
              <Filter className="h-3.5 w-3.5" />
              <span>Periodo:</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] text-[12px] tabular min-w-[120px]"
              />
              <span>→</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] text-[12px] tabular min-w-[120px]"
              />
              {(from || to) && (
                <button
                  onClick={() => { setFrom(''); setTo(''); }}
                  className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                  aria-label="Svuota periodo"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2 pt-2">
              {hasActiveFilters && (
                <button
                  onClick={resetAll}
                  className="text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Reimposta filtri
                </button>
              )}
              <span className="tabular">{total} pagament{total === 1 ? 'o' : 'i'}</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 text-rose-700 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <SkeletonPaymentList count={5} />
        ) : items.length === 0 ? (
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-10 text-center">
            <CreditCard className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              Nessun pagamento{statusFilter !== 'all' ? ' per questo filtro' : ''}.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {grouped.map(group => {
              const renderRow = (item: PaymentRequest, inGroup: boolean) => {
                const status = paymentStatusView(item.status);
                const StatusIcon = status.Icon;
                const resBadge = reservationStatusBadge(item.reservation_status);
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelected(item)}
                    className={`w-full text-left p-3 md:p-4 transition-all ${
                      inGroup
                        ? 'bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                        : 'bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] hover:border-[var(--color-line-strong)] hover:shadow-sm'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <CreditCard className="h-4 w-4 text-[var(--color-fg-muted)] shrink-0" />
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium text-[14px] text-[var(--color-fg)] truncate">
                            {formatEuro(item.amount_cents, item.currency)}
                            {inGroup && item.claimant_label ? (
                              <span className="text-[var(--color-fg-muted)] font-normal"> · {toTitleCase(item.claimant_label)}</span>
                            ) : item.reservation_customer_name && (
                              <span className="text-[var(--color-fg-muted)] font-normal"> · {toTitleCase(item.reservation_customer_name)}</span>
                            )}
                          </span>
                          {item.reservation_phone && !inGroup && (
                            <span className="text-[11px] text-[var(--color-fg-muted)] tabular truncate">
                              {item.reservation_phone}
                            </span>
                          )}
                        </div>
                        <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${status.cls}`}>
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </span>
                        {!inGroup && item.table_name && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 bg-sky-50 text-sky-700 ring-sky-200">
                            <Armchair className="h-3 w-3" /> Tavolo {item.table_name}
                          </span>
                        )}
                        {resBadge && !inGroup && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${resBadge.cls}`}>
                            Prenotaz.: {resBadge.label}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[12px] text-[var(--color-fg-muted)] shrink-0">
                        {item.delivery_channel && (
                          <span className="inline-flex items-center gap-1 capitalize">
                            {(() => {
                              const ch = channelView(item.delivery_channel);
                              const ChIcon = ch.Icon;
                              return <ChIcon className="h-3 w-3" />;
                            })()}
                            {item.delivery_channel}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 tabular">
                          <Clock className="h-3 w-3" />
                          {formatDateTime(item.created_at)}
                        </span>
                      </div>
                    </div>
                    {item.description && !inGroup && (
                      <p className="text-[13px] text-[var(--color-fg-muted)] mt-2 line-clamp-1">
                        {item.description}
                      </p>
                    )}
                    {item.delivery_error && (
                      <p className="text-[12px] text-rose-600 mt-1 inline-flex items-start gap-1">
                        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        Consegna fallita: {item.delivery_error}
                      </p>
                    )}
                  </button>
                );
              };

              if (group.billId == null) return renderRow(group.items[0], false);

              // Grouped bill: header with table + progress, rows separated by
              // hairlines inside one bordered container.
              const first = group.items[0];
              const paidCents = group.items.reduce((s, p) => {
                const st = (p.status || '').toUpperCase();
                return s + ((st === 'COMPLETED' || st === 'PAID') ? p.amount_cents : 0);
              }, 0);
              const billTotal = first.bill_total_cents || 0;
              const pct = billTotal > 0 ? Math.min(100, Math.round(paidCents / billTotal * 100)) : 0;
              return (
                <div key={`bill-${group.billId}`} className="bg-[var(--color-surface)] rounded-xl border border-sky-200 dark:border-sky-500/30 overflow-hidden">
                  <div className="px-3 md:px-4 py-2.5 bg-sky-50/60 dark:bg-sky-500/10 border-b border-sky-100 dark:border-sky-500/20">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0 text-[13px]">
                        <Receipt className="h-4 w-4 text-sky-600 shrink-0" />
                        <span className="font-semibold text-[var(--color-fg)]">
                          {first.table_name ? `Tavolo ${first.table_name}` : `Conto #${group.billId}`}
                        </span>
                        {first.reservation_customer_name && (
                          <span className="text-[var(--color-fg-muted)] truncate">· {toTitleCase(first.reservation_customer_name)}</span>
                        )}
                        <span className="text-[11px] text-[var(--color-fg-muted)]">
                          · {group.items.length} pagament{group.items.length === 1 ? 'o' : 'i'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[12px] shrink-0">
                        <span className="tabular text-[var(--color-fg-muted)]">
                          <strong className="text-emerald-700 dark:text-emerald-400">{formatEuro(paidCents)}</strong>
                          {billTotal > 0 && <> / {formatEuro(billTotal)}</>}
                        </span>
                        {billTotal > 0 && (
                          <div className="w-20 h-1.5 rounded-full bg-[var(--color-line)] overflow-hidden">
                            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="divide-y divide-[var(--color-line)]">
                    {group.items.map(p => renderRow(p, true))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected && (
        <DetailModal
          payment={selected}
          onClose={() => setSelected(null)}
          onReconciled={(updated) => {
            setItems(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
            setSelected(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev);
          }}
        />
      )}
    </div>
  );
};

export default PagamentiPage;
