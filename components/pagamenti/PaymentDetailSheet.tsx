import React, { useEffect, useState } from 'react';
import {
  AlertCircle, Calendar, Check, Copy, ExternalLink, Loader2, RefreshCw, RotateCcw,
  Users as UsersIcon,
} from 'lucide-react';
import { billsApiService } from '../../services/billsApiService';
import {
  paymentsApiService, type PaymentMessage, type PaymentRequest,
} from '../../services/paymentsApiService';
import { useAuth } from '../../contexts/AuthContext';
import { toTitleCase } from '../../utils/text';
import { Callout, FormCard, Sheet, StatusPill } from '../ds';
import {
  channelView, formatDateTime, formatEuro, messageStatusView, paymentStatusView,
  providerName, reservationStatusView,
} from './paymentsView';

/* ── Dettaglio di un link di pagamento ────────────────────────────────────
   One row of the links list, opened as a sheet so the list stays visible
   behind it on a wide screen. Reads top to bottom the way the question does:
   how much and from whom, which booking it belongs to, the link itself, and
   what the customer has actually been sent. */

export const PaymentDetailSheet: React.FC<{
  payment: PaymentRequest;
  onClose: () => void;
  onUpdated?: (updated: PaymentRequest) => void;
}> = ({ payment: initialPayment, onClose, onUpdated }) => {
  const { hasPermission } = useAuth();
  const [payment, setPayment] = useState<PaymentRequest>(initialPayment);
  const [messages, setMessages] = useState<PaymentMessage[]>([]);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(initialPayment.checkout_url);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'info' | 'err'; text: string } | null>(null);
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
  const resStatus = reservationStatusView(payment.reservation_status);
  const provider = providerName(payment.provider);

  const copyLink = () => {
    if (!checkoutUrl) return;
    navigator.clipboard.writeText(checkoutUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  // Ask the server to poll the gateway for the authoritative order state — used
  // when a webhook was missed or never delivered (SumUp's status callback is
  // unsigned and best-effort).
  const canReconcile =
    hasPermission('payments:full') &&
    ['revolut', 'sumup'].includes(payment.provider) &&
    !!payment.provider_order_id;

  // Two refund paths, both two-tap: bill-split payments go through the split
  // endpoint, which also reopens the bill if the refund drops it below its
  // total; standalone payments refund the order directly.
  const isSplitPayment = payment.table_bill_split_id != null;
  const canRefund =
    hasPermission('payments:full') &&
    ['revolut', 'sumup'].includes(payment.provider) &&
    !!payment.provider_order_id &&
    ['COMPLETED', 'PAID'].includes((payment.status || '').toUpperCase());

  const refund = async () => {
    if (!refundArmed) { setRefundArmed(true); return; }
    setRefundArmed(false);
    setRefunding(true);
    setFeedback(null);
    try {
      if (isSplitPayment) {
        const result = await billsApiService.refundSplit(payment.table_bill_split_id as number);
        const updated = { ...payment, status: 'REFUNDED' } as PaymentRequest;
        setPayment(updated);
        onUpdated?.(updated);
        setFeedback({ kind: 'ok', text: result.reopened ? 'Rimborsato — conto riaperto per la parte mancante' : 'Rimborso eseguito' });
      } else {
        const result = await paymentsApiService.refund(payment.id);
        if (result.payment_request) {
          setPayment(result.payment_request);
          onUpdated?.(result.payment_request);
        }
        setFeedback({ kind: 'ok', text: `Rimborso eseguito su ${provider}` });
      }
    } catch (err) {
      setFeedback({ kind: 'err', text: (err as Error).message });
    } finally {
      setRefunding(false);
    }
  };

  const reconcile = async () => {
    if (reconciling) return;
    setReconciling(true);
    setFeedback(null);
    try {
      const result = await paymentsApiService.reconcile(payment.id);
      if (result.payment_request) {
        setPayment(result.payment_request);
        onUpdated?.(result.payment_request);
      }
      if (result.changed) {
        setFeedback({ kind: 'ok', text: `Stato aggiornato da ${provider}: ${result.provider_state ?? result.revolut_state ?? '—'}` });
      } else if (result.message) {
        setFeedback({ kind: 'info', text: result.message });
      } else {
        setFeedback({ kind: 'info', text: 'Nessun aggiornamento necessario' });
      }
    } catch (err) {
      setFeedback({ kind: 'err', text: (err as Error).message });
    } finally {
      setReconciling(false);
    }
  };

  const chip =
    'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <Sheet
      open
      onClose={onClose}
      ariaLabel="Dettaglio pagamento"
      title={formatEuro(payment.amount_cents, payment.currency)}
      subtitle={
        <>
          {payment.reservation_customer_name && (
            <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">
              {toTitleCase(payment.reservation_customer_name)}
            </div>
          )}
          <div className="tabular-nums">
            {[payment.reservation_phone, provider, `creato ${formatDateTime(payment.created_at)}`]
              .filter(Boolean).join(' · ')}
          </div>
        </>
      }
      meta={
        <>
          <StatusPill tone={status.tone}>
            <StatusIcon className="h-3 w-3" /> {status.label}
          </StatusPill>
          {canReconcile && (
            <button
              type="button"
              onClick={reconcile}
              disabled={reconciling}
              title={`Interroga ${provider} e aggiorna lo stato`}
              className={`${chip} bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]`}
            >
              {reconciling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {reconciling ? 'Riconcilio…' : 'Riconcilia'}
            </button>
          )}
          {canRefund && (
            <button
              type="button"
              onClick={refund}
              onBlur={() => setRefundArmed(false)}
              disabled={refunding}
              className={`${chip} ${
                refundArmed
                  ? 'bg-[var(--ds-critical-solid)] text-[#ffffff]'
                  : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] hover:opacity-80'
              }`}
            >
              {refunding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {refunding ? 'Rimborso…' : refundArmed ? 'Confermi il rimborso?' : 'Rimborsa'}
            </button>
          )}
        </>
      }
      // Every section is a FormCard on the canvas, the same composition the
      // modals use. Before this the sheet mixed raised blocks with bare
      // paragraphs, so "Descrizione" and "Prenotazione collegata" read as
      // different kinds of thing when they are both just facts about the row.
      bodyClassName="space-y-3 px-4 pb-5 pt-4 sm:px-5"
      footer={
        checkoutUrl && (
          <div className="flex gap-2">
            <button type="button" onClick={copyLink} className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ds-surface-row)] text-[15px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copiato' : 'Copia link'}
            </button>
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[15px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <ExternalLink className="h-4 w-4" /> Apri checkout
            </a>
          </div>
        )
      }
    >
      {feedback && (
        <Callout
          tone={feedback.kind === 'err' ? 'critical' : feedback.kind === 'ok' ? 'positive' : 'info'}
          icon={feedback.kind === 'err' ? AlertCircle : undefined}
        >
          {feedback.text}
        </Callout>
      )}

      {payment.table_bill_id != null && (
        <FormCard title="Conto al tavolo">
          <p className="text-[14px] text-[var(--ds-text-secondary)]">
            <span className="font-medium text-[var(--ds-text-primary)]">
              {payment.table_name ? `Tavolo ${payment.table_name}` : `Conto #${payment.table_bill_id}`}
            </span>
            {payment.claimant_label && <> · quota di {toTitleCase(payment.claimant_label)}</>}
            {payment.bill_total_cents != null && payment.bill_total_cents > 0 && (
              <span className="tabular-nums"> · conto {formatEuro(payment.bill_total_cents)}</span>
            )}
          </p>
        </FormCard>
      )}

      {payment.reservation_id != null && (
        <FormCard
          title="Prenotazione collegata"
          aside={
            <a
              href={`/?view=RESERVATIONS&reservationId=${payment.reservation_id}`}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--ds-text-primary)] underline underline-offset-2"
            >
              Apri <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          }
        >
          <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--ds-text-primary)]">
            <Calendar className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
            <span className="truncate">
              {payment.reservation_time
                ? formatDateTime(payment.reservation_time)
                : `Prenotazione #${payment.reservation_id}`}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
            {payment.reservation_guests != null && (
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="h-3 w-3" aria-hidden /> {payment.reservation_guests} coperti
              </span>
            )}
            {resStatus && <StatusPill tone={resStatus.tone}>{resStatus.label}</StatusPill>}
          </div>
        </FormCard>
      )}

      {payment.description && (
        <FormCard title="Descrizione">
          <p className="text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">{payment.description}</p>
        </FormCard>
      )}

      <FormCard
        title="Comunicazioni"
        aside={messages.length > 0 ? (
          <span className="text-[13px] text-[var(--ds-text-muted)] tabular-nums">{messages.length}</span>
        ) : undefined}
      >
        {/* How the link went out belongs with the messages it produced, not in
            a line of its own floating between two cards. */}
        {(payment.delivery_channel || payment.delivery_error) && (
          <p className="mb-3 text-[13px] text-[var(--ds-text-muted)]">
            {payment.delivery_channel && <>Inviato via {payment.delivery_channel}</>}
            {payment.delivery_error && (
              <span className="ml-1 text-[var(--ds-critical-text)]">· {payment.delivery_error}</span>
            )}
          </p>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carico i messaggi…
          </div>
        ) : error ? (
          <Callout tone="critical" icon={AlertCircle}>{error}</Callout>
        ) : messages.length === 0 ? (
          <p className="text-[13px] text-[var(--ds-text-muted)]">Nessuna comunicazione registrata.</p>
        ) : (
          <div className="space-y-2">
            {messages.map(msg => {
              const ch = channelView(msg.channel);
              const ChIcon = ch.Icon;
              const st = messageStatusView(msg.status);
              return (
                <article key={msg.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3.5">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <StatusPill tone={ch.tone}>
                      <ChIcon className="h-3 w-3" /> {ch.label}
                    </StatusPill>
                    <span className="text-[13px] text-[var(--ds-text-muted)] tabular-nums">
                      {formatDateTime(msg.sent_at)}
                    </span>
                    {msg.is_payment_link && <StatusPill tone="info">Link pagamento</StatusPill>}
                    <span className={`ml-auto text-[13px] font-medium ${
                      st.tone === 'critical' ? 'text-[var(--ds-critical-text)]'
                      : st.tone === 'positive' ? 'text-[var(--ds-seated-text)]'
                      : 'text-[var(--ds-text-muted)]'
                    }`}>
                      {st.label}
                    </span>
                  </div>
                  {msg.subject && (
                    <div className="mb-0.5 text-[13px] font-medium text-[var(--ds-text-primary)]">{msg.subject}</div>
                  )}
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">
                    {msg.body}
                  </p>
                  {msg.error_message && (
                    <p className="mt-1.5 text-[13px] text-[var(--ds-critical-text)]">
                      {msg.error_code ? `${msg.error_code}: ` : ''}{msg.error_message}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </FormCard>
    </Sheet>
  );
};
