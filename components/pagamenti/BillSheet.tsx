import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Loader2, Printer, QrCode, X } from 'lucide-react';
import { printBill, type OpenBillRow } from '../../services/billsApiService';
import { FormCard, PaneHeader, Sheet, StatusPill } from '../ds';
import { formatEuro } from './paymentsView';

/* ── Il conto di un tavolo ────────────────────────────────────────────────
   The QR is the point of this panel: the guest frames it and pays their share.
   Everything else — the item breakdown, the totals, closing the bill — hangs
   off that.

   Two containers, one body. Pagamenti shows a bill in the detail column beside
   the list (BillDetail); OrderPad and the reservation detail open the same
   thing over what they were already showing (BillSheet), because there the
   bill is an interruption of another task rather than the task itself.

   The bill prop is a loose Pick rather than a full OpenBillRow because
   OrderPad opens this right after creating a bill, when the payment columns
   do not exist yet. */

const euro = (cents: number) => formatEuro(cents);

type BillLike =
  Pick<OpenBillRow, 'id' | 'table_name' | 'total_cents' | 'covers' | 'share_token' | 'items'>
  & Partial<Pick<OpenBillRow, 'paid_cents' | 'residual_cents' | 'open_orders'>>;

const isSettled = (bill: BillLike) => bill.residual_cents === 0;

const billTitle = (bill: BillLike) => euro(bill.total_cents);
const billSubtitle = (bill: BillLike) =>
  `Tavolo ${bill.table_name ?? '—'} · ${bill.covers} copert${bill.covers === 1 ? 'o' : 'i'}`;

/** The two standing facts about a bill: what is left on it, and whether the
 *  total can still move. Shown beside the title in both containers. */
const BillMeta: React.FC<{ bill: BillLike }> = ({ bill }) => (
  <>
    {bill.residual_cents != null && (
      <StatusPill tone={isSettled(bill) ? 'positive' : 'critical'}>
        {isSettled(bill) ? 'saldato' : `residuo ${euro(bill.residual_cents)}`}
      </StatusPill>
    )}
    {bill.open_orders != null && bill.open_orders > 0 && (
      <StatusPill tone="pending" title="Il totale può ancora cambiare">
        comanda aperta
      </StatusPill>
    )}
  </>
);

/** Two-tap, and the second tap names what it is about to do: closing a bill
 *  with a residual writes off money that was never collected. */
const SettleButton: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onSettle: () => void;
}> = ({ bill, busy, onSettle }) => {
  const [armed, setArmed] = useState(false);
  const settled = isSettled(bill);

  return (
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
  );
};

/** The QR, the items and the totals — identical in the pane and in the sheet. */
const BillBody: React.FC<{ bill: BillLike }> = ({ bill }) => {
  const [copied, setCopied] = useState(false);
  const [printState, setPrintState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [printingKind, setPrintingKind] = useState<'PRECONTO' | 'QR'>('PRECONTO');
  const url = bill.share_token ? `${window.location.origin}/pay/${bill.share_token}` : null;
  const settled = isSettled(bill);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard denied: the QR is the primary channel anyway */ }
  };

  const print = async (kind: 'PRECONTO' | 'QR' = 'PRECONTO') => {
    if (printState === 'sending') return;
    setPrintingKind(kind);
    setPrintState('sending');
    try {
      await printBill(bill.id, kind);
      // "queued", not "printed": the real confirmation is the thermal printer
      // making noise. If the agent is down the job waits and comes out later.
      setPrintState('sent');
      setTimeout(() => setPrintState('idle'), 3000);
    } catch {
      setPrintState('error');
      setTimeout(() => setPrintState('idle'), 4000);
    }
  };

  const quiet =
    'inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <>
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
              <button type="button" onClick={() => print('QR')} disabled={printState === 'sending'} className={quiet}>
                {printingKind === 'QR' && printState === 'sending' ? <><Loader2 className="h-4 w-4 animate-spin" /> Invio…</>
                  : printingKind === 'QR' && printState === 'sent' ? <><Check className="h-4 w-4" /> In stampa</>
                  : printingKind === 'QR' && printState === 'error' ? <><X className="h-4 w-4" /> Stampa fallita</>
                  : <><QrCode className="h-4 w-4" /> Stampa QR</>}
              </button>
              <button type="button" onClick={() => print('PRECONTO')} disabled={printState === 'sending'} className={quiet}>
                {printingKind === 'PRECONTO' && printState === 'sending' ? <><Loader2 className="h-4 w-4 animate-spin" /> Invio…</>
                  : printingKind === 'PRECONTO' && printState === 'sent' ? <><Check className="h-4 w-4" /> In stampa</>
                  : printingKind === 'PRECONTO' && printState === 'error' ? <><X className="h-4 w-4" /> Stampa fallita</>
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
    </>
  );
};

/** Pane form, for the Pagamenti detail column. The back button PaneHeader
 *  draws is mobile-only — there the pane is a full-screen sheet over the list,
 *  and on desktop the list is right there beside it. */
export const BillDetail: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onClose: () => void;
  onSettle?: () => void;
}> = ({ bill, busy, onClose, onSettle }) => (
  <>
    <PaneHeader
      onBack={onClose}
      backLabel="Torna ai conti"
      title={billTitle(bill)}
      subtitle={billSubtitle(bill)}
      badge={<BillMeta bill={bill} />}
    />
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-5 sm:px-6 lg:px-8">
      <BillBody bill={bill} />
    </div>
    {onSettle && (
      <div className="flex-shrink-0 px-4 pb-4 pt-1 sm:px-6 lg:px-8">
        <SettleButton bill={bill} busy={busy} onSettle={onSettle} />
      </div>
    )}
  </>
);

/** Overlay form, for the places that open a bill on top of another task. */
export const BillSheet: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onClose: () => void;
  onSettle?: () => void;
}> = ({ bill, busy, onClose, onSettle }) => (
  <Sheet
    open
    onClose={onClose}
    ariaLabel={`Conto tavolo ${bill.table_name ?? ''}`}
    title={billTitle(bill)}
    subtitle={billSubtitle(bill)}
    meta={<BillMeta bill={bill} />}
    bodyClassName="space-y-3 px-4 pb-5 pt-4 sm:px-5"
    footer={onSettle && <SettleButton bill={bill} busy={busy} onSettle={onSettle} />}
  >
    <BillBody bill={bill} />
  </Sheet>
);
