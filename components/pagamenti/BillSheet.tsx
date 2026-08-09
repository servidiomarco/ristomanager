import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Loader2, Printer, QrCode, X, Banknote } from 'lucide-react';
import { printBill, type OpenBillRow } from '../../services/billsApiService';
import { FormCard, PaneHeader, Sheet, StatusPill } from '../ds';
import { formatEuro } from './paymentsView';

/** Chiusura conto: quanto incassato in contanti (totale sul conto) e mancia. */
export type SettleOpts = { cash_settled_cents?: number; tip_cents?: number };

// Parsing tollerante dell'importo digitato: "12,50" / "12.50" / "12" → cents.
const eurToCents = (s: string): number => {
  const n = parseFloat(String(s).replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

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
  & Partial<Pick<OpenBillRow, 'paid_cents' | 'residual_cents' | 'open_orders' | 'deposit_credit_cents' | 'deposit_paid_cents' | 'refund_due_cents' | 'cash_settled_cents'>>;

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

/** Dialog di chiusura conto: registra quanto incassato in contanti (il resto
 *  non pagato via QR/carta) e l'eventuale mancia. Sostituisce la vecchia
 *  chiusura a due tap, che scriveva il residuo come ammanco senza chiedere
 *  nulla — l'unico modo di pagare era la carta. */
const SettleDialog: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (opts: SettleOpts) => void;
}> = ({ bill, busy, onCancel, onConfirm }) => {
  const residual = bill.residual_cents ?? bill.total_cents;
  const existingCash = bill.cash_settled_cents ?? 0;
  // Pagato via QR/carta = tutto il pagato meno i contanti già registrati.
  const paidCard = Math.max(0, (bill.paid_cents ?? 0) - existingCash);
  // Default: il residuo tutto in contanti → conto saldato in un tap.
  const [cash, setCash] = useState(residual > 0 ? (residual / 100).toFixed(2) : '0');
  const [tip, setTip] = useState('');
  const cashNow = eurToCents(cash);
  const tipCents = eurToCents(tip);
  const shortfall = Math.max(0, residual - cashNow);
  const willSettle = shortfall === 0;

  const field =
    'h-11 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-right text-[15px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]';

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onCancel}>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-[var(--ds-surface)] shadow-[var(--shadow-xl)]" onClick={e => e.stopPropagation()}>
        <div className="border-b border-[var(--ds-border)] p-5">
          <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Chiudi conto in cassa</h3>
          <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">Tavolo {bill.table_name ?? '—'} · totale {euro(bill.total_cents)}</p>
        </div>
        <div className="space-y-3 p-5">
          <dl className="space-y-1.5 text-[14px]">
            {paidCard > 0 && (
              <div className="flex justify-between text-[var(--ds-text-muted)]">
                <dt>Già pagato (QR/carta)</dt><dd className="tabular-nums">{euro(paidCard)}</dd>
              </div>
            )}
            {existingCash > 0 && (
              <div className="flex justify-between text-[var(--ds-text-muted)]">
                <dt>Contanti già registrati</dt><dd className="tabular-nums">{euro(existingCash)}</dd>
              </div>
            )}
            <div className="flex justify-between font-medium text-[var(--ds-text-primary)]">
              <dt>Residuo da incassare</dt><dd className="tabular-nums">{euro(residual)}</dd>
            </div>
          </dl>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Incasso in contanti</span>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
              <input type="text" inputMode="decimal" value={cash} onChange={e => setCash(e.target.value)} disabled={busy} className={`${field} pl-7`} />
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Mancia <span className="font-normal text-[var(--ds-text-muted)]">(facoltativa)</span></span>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
              <input type="text" inputMode="decimal" placeholder="0,00" value={tip} onChange={e => setTip(e.target.value)} disabled={busy} className={`${field} pl-7`} />
            </div>
          </label>

          <p className={`text-[13px] ${willSettle ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
            {willSettle
              ? `Il conto risulterà saldato${tipCents > 0 ? ` · mancia ${euro(tipCents)}` : ''}.`
              : `Ammanco ${euro(shortfall)}: il conto resterà parziale.`}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-4 py-3">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-full px-4 py-2 text-[14px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-hover)] disabled:opacity-40">Annulla</button>
          <button
            type="button"
            onClick={() => onConfirm({ cash_settled_cents: existingCash + cashNow, tip_cents: tipCents })}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-5 py-2 text-[14px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Chiudi conto
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

/** Bottone chiusura → apre il dialog di incasso (contanti + mancia). */
const SettleButton: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onSettle: (opts?: SettleOpts) => void;
}> = ({ bill, busy, onSettle }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[15px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
        Chiudi conto
      </button>
      {open && (
        <SettleDialog
          bill={bill}
          busy={busy}
          onCancel={() => setOpen(false)}
          onConfirm={(opts) => { onSettle(opts); setOpen(false); }}
        />
      )}
    </>
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
            {(bill.residual_cents ?? 0) > 0
              ? 'QR non più attivo: incassa il resto in cassa e chiudi il conto.'
              : 'Conto saldato: il codice non è più attivo.'}
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
          {/* Acconto: si mostra l'importo PIENO versato dal cliente, non solo
              la parte assorbita dal conto. Fallback al valore applicato per i
              conti vecchi che non riportano ancora deposit_paid_cents. */}
          {(() => {
            const depositShown = bill.deposit_paid_cents ?? bill.deposit_credit_cents ?? 0;
            return depositShown > 0 ? (
              <div className="flex justify-between text-[var(--ds-seated-text)]">
                <dt>Acconto già versato</dt>
                <dd className="tabular-nums">−{euro(depositShown)}</dd>
              </div>
            ) : null;
          })()}
          {bill.paid_cents != null && (bill.paid_cents - (bill.deposit_credit_cents ?? 0)) > 0 && (
            <div className="flex justify-between text-[var(--ds-text-muted)]">
              <dt>Incassato dai clienti</dt>
              <dd className="tabular-nums">−{euro(bill.paid_cents - (bill.deposit_credit_cents ?? 0))}</dd>
            </div>
          )}
          {bill.refund_due_cents != null && bill.refund_due_cents > 0 && (
            <div className="flex justify-between font-semibold text-[var(--ds-seated-text)]">
              <dt>Da rimborsare al cliente</dt>
              <dd className="tabular-nums">{euro(bill.refund_due_cents)}</dd>
            </div>
          )}
          {bill.residual_cents != null && (
            <div className={`flex justify-between font-medium ${settled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
              <dt>Da pagare</dt>
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
  onSettle?: (opts?: SettleOpts) => void;
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
  onSettle?: (opts?: SettleOpts) => void;
  /** Azione aggiuntiva in coda al footer (es. "nuova comanda" dal palmare). */
  footerExtra?: React.ReactNode;
}> = ({ bill, busy, onClose, onSettle, footerExtra }) => (
  <Sheet
    open
    onClose={onClose}
    ariaLabel={`Conto tavolo ${bill.table_name ?? ''}`}
    title={billTitle(bill)}
    subtitle={billSubtitle(bill)}
    meta={<BillMeta bill={bill} />}
    bodyClassName="space-y-3 px-4 pb-5 pt-4 sm:px-5"
    footer={(onSettle || footerExtra) && (
      <div className="space-y-2">
        {onSettle && <SettleButton bill={bill} busy={busy} onSettle={onSettle} />}
        {footerExtra}
      </div>
    )}
  >
    <BillBody bill={bill} />
  </Sheet>
);
