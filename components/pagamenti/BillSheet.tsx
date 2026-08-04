import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Loader2, Printer, QrCode, X } from 'lucide-react';
import { printBill, type OpenBillRow } from '../../services/billsApiService';
import { FormCard, Sheet, StatusPill } from '../ds';
import { formatEuro } from './paymentsView';

/* ── Il conto di un tavolo ────────────────────────────────────────────────
   The QR is the point of this panel: the guest frames it and pays their share.
   Everything else — the item breakdown, the totals, closing the bill — hangs
   off that.

   Also opened from OrderPad right after a bill is created, which is why the
   bill prop is a loose Pick rather than a full OpenBillRow: at that moment the
   payment columns do not exist yet. */

const euro = (cents: number) => formatEuro(cents);

type BillLike =
  Pick<OpenBillRow, 'id' | 'table_name' | 'total_cents' | 'covers' | 'share_token' | 'items'>
  & Partial<Pick<OpenBillRow, 'paid_cents' | 'residual_cents' | 'open_orders'>>;

export const BillSheet: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onClose: () => void;
  onSettle?: () => void;
}> = ({ bill, busy, onClose, onSettle }) => {
  const [copied, setCopied] = useState(false);
  const [printState, setPrintState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [armed, setArmed] = useState(false);
  const url = bill.share_token ? `${window.location.origin}/pay/${bill.share_token}` : null;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard denied: the QR is the primary channel anyway */ }
  };

  const print = async () => {
    if (printState === 'sending') return;
    setPrintState('sending');
    try {
      await printBill(bill.id);
      // "queued", not "printed": the real confirmation is the thermal printer
      // making noise. If the agent is down the job waits and comes out later.
      setPrintState('sent');
      setTimeout(() => setPrintState('idle'), 3000);
    } catch {
      setPrintState('error');
      setTimeout(() => setPrintState('idle'), 4000);
    }
  };

  const settled = bill.residual_cents === 0;
  const quiet =
    'inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <Sheet
      open
      onClose={onClose}
      ariaLabel={`Conto tavolo ${bill.table_name ?? ''}`}
      title={euro(bill.total_cents)}
      subtitle={`Tavolo ${bill.table_name ?? '—'} · ${bill.covers} copert${bill.covers === 1 ? 'o' : 'i'}`}
      meta={
        <>
          {bill.residual_cents != null && (
            <StatusPill tone={settled ? 'positive' : 'critical'}>
              {settled ? 'saldato' : `residuo ${euro(bill.residual_cents)}`}
            </StatusPill>
          )}
          {bill.open_orders != null && bill.open_orders > 0 && (
            <StatusPill tone="pending" title="Il totale può ancora cambiare">
              comanda aperta
            </StatusPill>
          )}
        </>
      }
      bodyClassName="space-y-3 px-4 pb-5 pt-4 sm:px-5"
      footer={
        onSettle && (
          <button
            type="button"
            onClick={() => { if (armed) { onSettle(); setArmed(false); } else setArmed(true); }}
            onBlur={() => setArmed(false)}
            disabled={busy}
            className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              armed
                ? 'bg-[var(--ds-critical-solid)] text-[#ffffff]'
                : 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]'
            }`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? 'Chiusura…'
              : armed ? (settled ? 'Confermi la chiusura?' : `Confermi? Restano ${euro(bill.residual_cents ?? 0)}`)
              : 'Chiudi conto'}
          </button>
        )
      }
    >
      <FormCard>
        {url ? (
          <div className="flex flex-col items-center gap-3">
            {/* Fixed white plate: in dark mode a QR on a dark ground will not
                scan. This is the one place a hardcoded #ffffff is correct. */}
            <div className="rounded-[16px] bg-[#ffffff] p-3">
              <QRCodeSVG value={url} size={168} level="M" />
            </div>
            <p className="text-center text-[13px] text-[var(--ds-text-muted)]">
              L'ospite inquadra e paga la sua parte.
            </p>
            <div className="flex w-full items-center gap-2">
              <button type="button" onClick={copy} className={quiet}>
                {copied ? <><Check className="h-4 w-4" /> Link copiato</> : <><Copy className="h-4 w-4" /> Copia link</>}
              </button>
              <button type="button" onClick={print} disabled={printState === 'sending'} className={quiet}>
                {printState === 'sending' ? <><Loader2 className="h-4 w-4 animate-spin" /> Invio…</>
                  : printState === 'sent' ? <><Check className="h-4 w-4" /> In stampa</>
                  : printState === 'error' ? <><X className="h-4 w-4" /> Stampa fallita</>
                  : <><Printer className="h-4 w-4" /> Stampa preconto</>}
              </button>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
            <QrCode className="h-4 w-4 flex-shrink-0" aria-hidden />
            Conto chiuso: il codice non è più valido.
          </p>
        )}
      </FormCard>

      {bill.items && bill.items.length > 0 && (
        <FormCard title="Dettaglio">
          <ul>
            {bill.items.map((i, idx) => (
              <li
                key={idx}
                className="flex justify-between gap-3 py-2.5 text-[14px] text-[var(--ds-text-secondary)] [&+li]:border-t [&+li]:border-[var(--ds-border)]"
              >
                <span className="min-w-0 truncate">{i.qty}× {i.name}</span>
                <span className="flex-shrink-0 tabular-nums">{euro(i.unit_price_cents * i.qty)}</span>
              </li>
            ))}
          </ul>
        </FormCard>
      )}

      <FormCard>
        <dl className="space-y-1.5 text-[14px]">
          <div className="flex justify-between font-semibold text-[var(--ds-text-primary)]">
            <dt>Totale</dt>
            <dd className="tabular-nums">{euro(bill.total_cents)}</dd>
          </div>
          {bill.paid_cents != null && (
            <div className="flex justify-between text-[var(--ds-text-muted)]">
              <dt>Incassato</dt>
              <dd className="tabular-nums">{euro(bill.paid_cents)}</dd>
            </div>
          )}
          {bill.residual_cents != null && (
            <div className={`flex justify-between font-medium ${settled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
              <dt>Residuo</dt>
              <dd className="tabular-nums">{euro(bill.residual_cents)}</dd>
            </div>
          )}
        </dl>
        {bill.open_orders != null && bill.open_orders > 0 && (
          <p className="mt-3 text-[13px] text-[var(--ds-pending-text)]">
            Il tavolo ha ancora una comanda aperta: il totale può cambiare.
          </p>
        )}
      </FormCard>
    </Sheet>
  );
};
