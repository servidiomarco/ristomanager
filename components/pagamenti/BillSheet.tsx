import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, FileText, Loader2, Printer, QrCode, Search, X, Banknote } from 'lucide-react';
import { billsApiService, printBill, type BillPaymentInput, type OpenBillRow } from '../../services/billsApiService';
import { getCustomers } from '../../services/apiService';
import type { Customer } from '../../types';
import { FormCard, PaneHeader, Sheet, StatusPill } from '../ds';
import { formatEuro } from './paymentsView';
import { METHODS, methodLabel, eurToCents, settleMath, settlePayments, nextAmountText } from './settleView';
import { getRomeTimePart } from '../../utils/reservationTime';

/** Chiusura conto: i movimenti di incasso (metodo + importo) e la mancia.
 *  Passa dritto a POST /bills/:id/close come CloseBillPayload. */
export type SettleOpts = {
  payments?: BillPaymentInput[];
  cash_settled_cents?: number;
  tip_cents?: number;
  passepartout_documento?: 'Scontrino' | 'Proforma';
  /** Conti nativi: 'Proforma' = chiusura deliberata senza documento
   *  fiscale; 'Cassa' = scontrino battuto sull'RT esterno (periodo ponte),
   *  registrato come documento vero col numero del registratore. */
  documento?: 'Scontrino' | 'Proforma' | 'Cassa';
  /** Numero dello scontrino battuto sull'RT (facoltativo, con 'Cassa'). */
  rt_doc_number?: string;
  /** Codice lotteria del cliente (con 'Scontrino' via provider). */
  lottery_code?: string;
};

/* La scelta del documento si ricorda per dispositivo: durante il periodo
   ponte (scontrini dall'RT) il default diventa "Cassa" dopo il primo uso,
   e tornerà "Scontrino" quando la cassa smetterà di batterli. Si ricordano
   solo le due modalità di routine — Proforma e Fattura sono scelte del
   singolo conto, ricordarle sarebbe una trappola. */
const DOC_CHOICE_KEY = 'settle-doc-choice';
const rememberedDocChoice = (): 'Scontrino' | 'Cassa' => {
  try {
    const v = localStorage.getItem(DOC_CHOICE_KEY);
    return v === 'Cassa' ? 'Cassa' : 'Scontrino';
  } catch { return 'Scontrino'; }
};
const rememberDocChoice = (v: string) => {
  if (v !== 'Scontrino' && v !== 'Cassa') return;
  try { localStorage.setItem(DOC_CHOICE_KEY, v); } catch { /* storage pieno o negato: pazienza */ }
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
  & Partial<Pick<OpenBillRow, 'paid_cents' | 'residual_cents' | 'open_orders' | 'deposit_credit_cents' | 'deposit_paid_cents' | 'refund_due_cents' | 'cash_settled_cents' | 'status' | 'fiscal_status' | 'fiscal_doc_id' | 'fiscal_error' | 'fiscal_provider' | 'fiscal_ref' | 'fiscal_doc_type' | 'fiscal_doc_number' | 'fiscal_public_token' | 'fiscal_related_doc_id' | 'external_ref' | 'payments'>>;

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

/** Dialog di chiusura conto: registra i movimenti di incasso — metodo per
 *  metodo, il tavolo reale paga misto — e l'eventuale mancia. Il percorso a
 *  un tap resta: residuo preimpostato, metodo Contanti, "Chiudi conto". */
export const SettleDialog: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onCancel: () => void;
  /** meta.invoiceIntent: l'operatore ha scelto «Fattura» — il conto chiude
   *  con proforma (i due documenti non coesistono) e il chiamante apre
   *  SUBITO l'emissione, invece di lasciare l'utente a metà strada. */
  onConfirm: (opts: SettleOpts, meta?: { invoiceIntent?: boolean }) => void;
}> = ({ bill, busy, onCancel, onConfirm }) => {
  const residual = bill.residual_cents ?? bill.total_cents;
  const alreadyPaid = Math.max(0, bill.total_cents - residual);
  const [movements, setMovements] = useState<BillPaymentInput[]>([]);
  const [method, setMethod] = useState<BillPaymentInput['method']>('CONTANTI');
  // Conto del gestionale: la chiusura in cassa può emettere lo scontrino
  // oppure la proforma (la routine della cassa, nessun documento fiscale).
  const isPP = /^pp:comanda:/.test(String(bill.external_ref ?? ''));
  const [ppDoc, setPpDoc] = useState<'Scontrino' | 'Cassa' | 'Proforma' | 'Fattura'>(() => isPP ? 'Scontrino' : rememberedDocChoice());
  // Numero dello scontrino battuto sull'RT: testo libero corto, i formati
  // dei registratori variano.
  const [rtNumber, setRtNumber] = useState('');
  const rtNumberClean = rtNumber.trim();
  // Codice lotteria (solo scontrino via provider): 8 alfanumerici AdE.
  const [lottery, setLottery] = useState('');
  const lotteryClean = lottery.trim().toUpperCase();
  const lotteryValid = lotteryClean === '' || /^[A-Z0-9]{8}$/.test(lotteryClean);
  // Conti nativi: la scelta c'è SEMPRE. Con un provider fiscale attivo
  // "Scontrino" emette davvero; senza, resta la dichiarazione d'intento —
  // ma "Proforma" marca comunque il conto come chiuso senza documento DI
  // PROPOSITO, che in lista è tutt'altra cosa di "senza scontrino".
  const showDocChoice = true;
  const [amount, setAmount] = useState(residual > 0 ? (residual / 100).toFixed(2) : '0');
  const [tip, setTip] = useState('');
  const tipCents = eurToCents(tip);
  const { remaining, applied, change, shortfall, willSettle } = settleMath(residual, movements, method, amount);

  const addMovement = () => {
    if (applied <= 0) return;
    setMovements(prev => [...prev, { method, amount_cents: applied }]);
    setAmount(nextAmountText(Math.max(0, remaining - applied)));
  };

  const confirm = () => {
    onConfirm({
      // L'importo ancora nel campo è un movimento non ancora aggiunto: vale.
      payments: settlePayments(movements, method, applied),
      tip_cents: tipCents,
      // «Fattura» chiude comunque con proforma: il documento si emette poi
      // dal conto, dove ci sono i dati del cessionario (come nel pannello
      // cassa). «Cassa» registra lo scontrino battuto sull'RT, col numero se
      // riportato. Sui conti Passepartout la scelta resta Scontrino/Proforma.
      ...(isPP
        ? { passepartout_documento: ppDoc === 'Fattura' || ppDoc === 'Cassa' ? 'Proforma' : ppDoc }
        : ppDoc === 'Cassa'
          ? { documento: 'Cassa' as const, ...(rtNumberClean ? { rt_doc_number: rtNumberClean } : {}) }
          : { documento: ppDoc === 'Scontrino' ? 'Scontrino' as const : 'Proforma' as const,
              ...(ppDoc === 'Scontrino' && lotteryClean ? { lottery_code: lotteryClean } : {}) }),
    }, { invoiceIntent: !isPP && ppDoc === 'Fattura' });
    if (!isPP) rememberDocChoice(ppDoc);
  };

  const field =
    'h-12 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-right text-[17px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]';

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--ds-backdrop)] p-4" onClick={busy ? undefined : onCancel}>
      {/* max-w-lg e corpi pieni: questo dialogo si usa al banco col cliente
          davanti — a max-w-sm i numeri si leggevano da vicino e basta. */}
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)]" onClick={e => e.stopPropagation()}>
        <div className="border-b border-[var(--ds-border)] p-5">
          <h3 className="text-[18px] font-semibold text-[var(--ds-text-primary)]">Chiudi conto in cassa</h3>
          <p className="mt-1 text-[14px] text-[var(--ds-text-muted)]">Tavolo {bill.table_name ?? '—'} · totale {euro(bill.total_cents)}</p>
        </div>
        <div className="space-y-3 p-5">
          <dl className="space-y-1.5 text-[14px]">
            {alreadyPaid > 0 && (
              <div className="flex justify-between text-[var(--ds-text-muted)]">
                <dt>Già pagato</dt><dd className="tabular-nums">{euro(alreadyPaid)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between font-medium text-[var(--ds-text-primary)]">
              <dt className="text-[15px]">Residuo da incassare</dt>
              <dd className="text-[28px] font-semibold tabular-nums tracking-[-0.02em]">{euro(remaining)}</dd>
            </div>
          </dl>

          {movements.length > 0 && (
            <ul className="space-y-1">
              {movements.map((m, i) => (
                <li key={i} className="flex items-center justify-between rounded-lg bg-[var(--ds-surface-row)] px-3 py-1.5 text-[14px] text-[var(--ds-text-secondary)]">
                  <span>{methodLabel(m.method)}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{euro(m.amount_cents)}</span>
                    <button
                      type="button"
                      aria-label="Togli movimento"
                      onClick={() => setMovements(prev => prev.filter((_, j) => j !== i))}
                      disabled={busy}
                      className="rounded-full p-1 text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {remaining > 0 && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {METHODS.map(m => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMethod(m.value)}
                    disabled={busy}
                    className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium transition-colors disabled:opacity-40 ${
                      method === m.value
                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="flex items-end gap-2">
                <label className="block flex-1">
                  <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Importo</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
                    <input type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} className={`${field} pl-7`} />
                  </div>
                </label>
                <button
                  type="button"
                  onClick={addMovement}
                  disabled={busy || applied <= 0 || applied >= remaining}
                  className="h-12 rounded-xl bg-[var(--ds-surface-row)] px-4 text-[15px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] disabled:opacity-40"
                >
                  Aggiungi
                </button>
              </div>
              {change > 0 && (
                <p className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Resto <span className="tabular-nums">{euro(change)}</span></p>
              )}
            </>
          )}

          {showDocChoice && (
            <div>
              <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">{isPP ? 'Documento in cassa' : 'Documento fiscale'}</span>
              <div className="flex gap-1.5">
                {((isPP ? ['Scontrino', 'Proforma'] : ['Scontrino', 'Cassa', 'Proforma', 'Fattura']) as ('Scontrino' | 'Cassa' | 'Proforma' | 'Fattura')[]).map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setPpDoc(d)}
                    disabled={busy}
                    className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium transition-colors disabled:opacity-40 ${
                      ppDoc === d
                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              {ppDoc === 'Proforma' && (
                <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
                  {isPP
                    ? 'Niente scontrino: in cassa esce la proforma.'
                    : 'Nessun documento adesso: scontrino o fattura si emettono dopo, dal conto.'}
                </p>
              )}
              {!isPP && ppDoc === 'Scontrino' && (
                <label className="mt-2.5 block">
                  <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Codice lotteria <span className="font-normal text-[var(--ds-text-muted)]">(facoltativo)</span></span>
                  <input
                    type="text"
                    maxLength={8}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="8 caratteri"
                    value={lottery}
                    onChange={e => setLottery(e.target.value)}
                    disabled={busy}
                    className={`${field} !text-left uppercase tracking-widest`}
                  />
                  {!lotteryValid && (
                    <span className="mt-1 block text-[13px] text-[var(--ds-critical-text)]">Il codice sono 8 lettere o cifre</span>
                  )}
                </label>
              )}
              {!isPP && ppDoc === 'Cassa' && (
                <div className="mt-2.5 space-y-1.5">
                  <p className="text-[13px] text-[var(--ds-text-muted)]">
                    Batti lo scontrino sul registratore e riporta qui il numero.
                  </p>
                  <input
                    type="text"
                    maxLength={30}
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="Numero scontrino (facoltativo)"
                    value={rtNumber}
                    onChange={e => setRtNumber(e.target.value)}
                    disabled={busy}
                    className={`${field} !text-left !text-[15px]`}
                  />
                </div>
              )}
              {ppDoc === 'Fattura' && (
                <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
                  Il conto si chiude con proforma e la fattura si emette dal conto, dove
                  ci sono i dati del cessionario. Scontrino e fattura non coesistono.
                </p>
              )}
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Mancia <span className="font-normal text-[var(--ds-text-muted)]">(facoltativa)</span></span>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
              <input type="text" inputMode="decimal" placeholder="0,00" value={tip} onChange={e => setTip(e.target.value)} disabled={busy} className={`${field} pl-7`} />
            </div>
          </label>

          <p className={`text-[14px] ${willSettle ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
            {willSettle
              ? `Il conto risulterà saldato${tipCents > 0 ? ` · mancia ${euro(tipCents)}` : ''}.`
              : `Ammanco ${euro(shortfall)}: il conto resterà parziale.`}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-4 py-3">
          <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-hover)] disabled:opacity-40">Annulla</button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy || !lotteryValid}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-6 text-[15px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
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
  onSettle: (opts?: SettleOpts, meta?: { invoiceIntent?: boolean }) => void;
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
          onConfirm={(opts, meta) => { onSettle(opts, meta); setOpen(false); }}
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

      {/* Come è stato pagato: i movimenti del libro cassa, ora e importo.
          "Online" è lo specchio di una quota pagata dal QR/link. */}
      {bill.payments && bill.payments.length > 0 && (
        <FormCard title="Pagamenti">
          <ul>
            {bill.payments.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 py-2.5 text-[14px] [&+li]:border-t [&+li]:border-[var(--ds-border)]"
              >
                <span className="min-w-0 truncate text-[var(--ds-text-primary)]">{methodLabel(p.method)}</span>
                <span className="flex flex-shrink-0 items-baseline gap-3">
                  <span className="text-[13px] text-[var(--ds-text-muted)]">{getRomeTimePart(p.recorded_at)}</span>
                  <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(p.amount_cents)}</span>
                </span>
              </li>
            ))}
          </ul>
        </FormCard>
      )}
    </>
  );
};

/* ── Fattura elettronica ──────────────────────────────────────────────────
   Il cliente chiede fattura invece dello scontrino. Si parte dalla rubrica
   (i dati di fatturazione stanno sul cliente) e ogni campo resta
   correggibile al volo: quello che si digita qui vince, ma NON riscrive
   l'anagrafica — il tavolo aspetta, la rubrica si sistema dopo. */
export const InvoiceDialog: React.FC<{
  bill: BillLike;
  onCancel: () => void;
  onDone: () => void;
  /** Cliente della visita: precompila la ricerca e, se la rubrica risponde
   *  un solo nome, lo seleziona da sé coi suoi dati di fatturazione. */
  initialQuery?: string;
}> = ({ bill, onCancel, onDone, initialQuery }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [results, setResults] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<number | null>(null);
  // Auto-selezione solo sul prefill iniziale, mai mentre l'utente digita.
  const autoPickRef = useRef(Boolean(initialQuery));
  const [buyer, setBuyer] = useState({
    name: '', vat_number: '', tax_code: '', sdi_code: '', pec: '',
    street: '', zip: '', city: '', province: '',
  });
  // Lookup camerale: P.IVA → denominazione, sede, SDI, PEC. Riempie i campi
  // al tap esplicito; quello che il cameriere corregge dopo vince comunque.
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const lookup = async () => {
    const piva = buyer.vat_number.replace(/\s/g, '');
    if (!/^\d{11}$/.test(piva)) { setLookupError('La P.IVA sono 11 cifre'); return; }
    setLookupBusy(true);
    setLookupError(null);
    try {
      const c = await billsApiService.companyLookup(piva);
      setBuyer(prev => ({
        ...prev,
        name: c.name || prev.name,
        vat_number: c.vat_number || prev.vat_number,
        tax_code: c.tax_code || prev.tax_code,
        sdi_code: c.sdi_code || prev.sdi_code,
        pec: c.pec || prev.pec,
        street: c.address.street || prev.street,
        zip: c.address.zip || prev.zip,
        city: c.address.city || prev.city,
        province: c.address.province || prev.province,
      }));
    } catch (err: any) {
      setLookupError(err?.data?.message ?? err?.message ?? 'Ricerca non riuscita');
    } finally {
      setLookupBusy(false);
    }
  };

  // Ricerca in rubrica con debounce: il cameriere digita tre lettere, non
  // scorre cinquecento nomi.
  useEffect(() => {
    if (!query.trim() || customerId != null) { setResults([]); return; }
    const t = setTimeout(() => {
      getCustomers(query.trim())
        .then(rows => {
          const top = rows.slice(0, 5);
          if (autoPickRef.current) {
            autoPickRef.current = false;
            if (top.length === 1) { pick(top[0]); return; }
          }
          setResults(top);
        })
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, customerId]);

  const pick = (c: Customer) => {
    setCustomerId(c.id);
    setQuery(c.name);
    setResults([]);
    const b = c.billing ?? {};
    setBuyer({
      name: b.name ?? c.name,
      vat_number: b.vat_number ?? '',
      tax_code: b.tax_code ?? '',
      sdi_code: b.sdi_code ?? '',
      pec: b.pec ?? '',
      street: b.address?.street ?? c.address ?? '',
      zip: b.address?.zip ?? c.postal_code ?? '',
      city: b.address?.city ?? c.city ?? '',
      province: b.address?.province ?? '',
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await billsApiService.issueInvoice(bill.id, {
        ...(customerId != null ? { customer_id: customerId } : {}),
        buyer: {
          name: buyer.name, vat_number: buyer.vat_number, tax_code: buyer.tax_code,
          sdi_code: buyer.sdi_code, pec: buyer.pec,
          address: { street: buyer.street, zip: buyer.zip, city: buyer.city, province: buyer.province },
        },
      });
      onDone();
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Fattura non emessa');
    } finally {
      setBusy(false);
    }
  };

  const field =
    'h-11 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-[14px] text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]';
  const label = 'mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]';
  const set = (k: keyof typeof buyer) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setBuyer(prev => ({ ...prev, [k]: e.target.value }));

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--ds-backdrop)] p-4" onClick={busy ? undefined : onCancel}>
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)]" onClick={e => e.stopPropagation()}>
        <div className="border-b border-[var(--ds-border)] p-5">
          <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Fattura elettronica</h3>
          <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">Tavolo {bill.table_name ?? '—'} · {euro(bill.total_cents)} · sostituisce lo scontrino</p>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          <label className="relative block">
            <span className={label}>Cliente in rubrica</span>
            <input
              type="text"
              value={query}
              placeholder="Cerca per nome…"
              onChange={e => { setQuery(e.target.value); setCustomerId(null); }}
              disabled={busy}
              className={field}
            />
            {results.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                {results.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => pick(c)}
                      className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-[14px] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]"
                    >
                      <span className="min-w-0 truncate">{c.name}</span>
                      {c.billing?.vat_number && (
                        <span className="flex-shrink-0 text-[12px] tabular-nums text-[var(--ds-text-muted)]">P.IVA {c.billing.vat_number}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </label>

          <label className="block">
            <span className={label}>Denominazione</span>
            <input type="text" value={buyer.name} onChange={set('name')} disabled={busy} className={field} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>P.IVA</span>
              <div className="flex gap-1.5">
                <input type="text" inputMode="numeric" value={buyer.vat_number} onChange={set('vat_number')} disabled={busy} className={`${field} tabular-nums`} />
                {/* Lookup camerale: riempie denominazione, sede, SDI e PEC. */}
                <button
                  type="button"
                  onClick={lookup}
                  disabled={busy || lookupBusy}
                  aria-label="Cerca i dati aziendali dalla P.IVA"
                  className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {lookupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <label className="block">
              <span className={label}>Codice fiscale</span>
              <input type="text" value={buyer.tax_code} onChange={set('tax_code')} disabled={busy} className={field} />
            </label>
            <label className="block">
              <span className={label}>Codice SDI</span>
              <input type="text" value={buyer.sdi_code} onChange={set('sdi_code')} disabled={busy} className={field} />
            </label>
            <label className="block">
              <span className={label}>PEC</span>
              <input type="email" value={buyer.pec} onChange={set('pec')} disabled={busy} className={field} />
            </label>
          </div>
          {lookupError && <p className="text-[13px] text-[var(--ds-critical-text)]">{lookupError}</p>}
          <label className="block">
            <span className={label}>Indirizzo</span>
            <input type="text" value={buyer.street} onChange={set('street')} disabled={busy} className={field} />
          </label>
          <div className="grid grid-cols-4 gap-3">
            <label className="block">
              <span className={label}>CAP</span>
              <input type="text" inputMode="numeric" value={buyer.zip} onChange={set('zip')} disabled={busy} className={`${field} tabular-nums`} />
            </label>
            <label className="col-span-2 block">
              <span className={label}>Comune</span>
              <input type="text" value={buyer.city} onChange={set('city')} disabled={busy} className={field} />
            </label>
            <label className="block">
              <span className={label}>Prov.</span>
              <input type="text" maxLength={2} value={buyer.province} onChange={set('province')} disabled={busy} className={field} />
            </label>
          </div>
          {error && <p className="text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-4 py-3">
          <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-hover)] disabled:opacity-40">Annulla</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !buyer.name.trim()}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-6 text-[15px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Invia a SDI
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

/* ── Scontrino elettronico ────────────────────────────────────────────────
   Sul conto chiuso: lo stato del documento commerciale e le due azioni che
   servono davvero — emetti/riprova e annulla. L'emissione parte già da sola
   alla chiusura; questa card copre il resto: il fallito da ritentare, il
   conto vecchio senza documento, l'annullo. L'annullo è un atto fiscale e
   chiede un secondo tap di conferma, non un dialog. */
export const FiscalCard: React.FC<{
  bill: BillLike;
  onChanged?: () => void;
}> = ({ bill, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [rtArmed, setRtArmed] = useState(false);
  const [rtNumber, setRtNumber] = useState('');
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printedFlash, setPrintedFlash] = useState(false);

  // Solo un conto CLOSED (saldato per intero) emette; la card compare anche
  // quando un documento esiste già, qualunque sia lo stato del conto.
  if (bill.status !== 'CLOSED' && !bill.fiscal_status) return null;

  const st = bill.fiscal_status ?? null;
  // Conto nato da una comanda Passepartout: lo scontrino lo emette l'RT di
  // cassa alla chiusura del tavolo sul gestionale, non il provider cloud.
  const isPP = /^pp:comanda:/.test(String(bill.external_ref ?? ''));
  const viaPP = bill.fiscal_provider === 'passepartout';
  // Scontrino battuto a mano sull'RT esterno (periodo ponte): documento
  // vero, ma la carta e l'annullo vivono sul registratore.
  const viaRT = bill.fiscal_provider === 'external_rt';
  // Scontrino emesso DAL CRM attraverso il registratore in sala (driver
  // rt-local): copia e QR sono nostri, l'annullo resta sull'RT.
  const viaLocalRt = bill.fiscal_provider === 'rt-local';
  const proforma = bill.fiscal_doc_type === 'PROFORMA';
  const invoice = bill.fiscal_doc_type === 'INVOICE';
  const creditNote = bill.fiscal_doc_type === 'CREDIT_NOTE';
  // La proforma nativa è un segnaposto sostituibile: scontrino e fattura
  // restano emettibili e la superano da soli lato server.
  const nativeProforma = proforma && !viaPP && st === 'CONFIRMED';
  // Il posto del documento vivo è libero: si può (ri)emettere. La nota di
  // credito CONFIRMED non lo occupa (atto contabile, non documento vivo);
  // una nota FAILED invece lo blocca — la fattura sotto è ancora valida.
  const slotFree = bill.status === 'CLOSED' && (
    st == null || st === 'VOIDED' || nativeProforma
    || (st === 'FAILED' && !creditNote)
    || (st === 'CONFIRMED' && creditNote)
  );
  const pill =
    st === 'CONFIRMED' && creditNote ? { tone: 'neutral' as const, label: 'stornata con nota di credito' }
    : st === 'CONFIRMED' && proforma ? { tone: 'neutral' as const, label: 'proforma' }
    : st === 'CONFIRMED' && invoice ? { tone: 'positive' as const, label: 'fattura emessa' }
    : st === 'CONFIRMED' ? { tone: 'positive' as const, label: viaPP || viaRT ? 'emesso in cassa' : 'emesso' }
    : st === 'PENDING' ? { tone: 'pending' as const, label: 'in emissione' }
    : st === 'FAILED' ? { tone: 'critical' as const, label: creditNote ? 'errore nota di credito' : invoice ? 'errore fattura' : 'errore' }
    : st === 'VOIDED' ? { tone: 'neutral' as const, label: 'annullato' }
    : isPP ? { tone: 'pending' as const, label: 'da chiudere in cassa' }
    : { tone: 'neutral' as const, label: 'non emesso' };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setArmed(false);
      onChanged?.();
    } catch (err: any) {
      // 409 in_progress: l'altra emissione è in volo — il reload mostrerà
      // l'esito; non è un errore da urlare.
      if (err?.data?.reason === 'in_progress') onChanged?.();
      else setError(err?.data?.message ?? err?.data?.error ?? err?.message ?? 'Operazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  const quiet =
    'inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-4 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <FormCard title="Scontrino" aside={<StatusPill tone={pill.tone}>{pill.label}</StatusPill>}>
      <div className="space-y-2.5">
        {st === 'CONFIRMED' && proforma && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {viaPP
              ? 'Chiuso in cassa con proforma, senza scontrino.'
              : 'Chiuso con proforma, senza documento fiscale. Scontrino o fattura lo sostituiscono.'}
          </p>
        )}
        {st === 'CONFIRMED' && invoice && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            Fattura {bill.fiscal_doc_number ?? bill.fiscal_ref} inviata a SDI. Lo storno passa da una nota di credito.
          </p>
        )}
        {st === 'CONFIRMED' && creditNote && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            Nota di credito {bill.fiscal_doc_number ?? bill.fiscal_ref} a registro: la fattura è stornata. Scontrino e fattura restano emettibili.
          </p>
        )}
        {st === 'FAILED' && creditNote && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            La nota di credito non è partita: la fattura resta valida.
          </p>
        )}
        {st === 'CONFIRMED' && !proforma && !invoice && (bill.fiscal_doc_number || bill.fiscal_ref || viaRT) && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {viaRT
              ? `Scontrino di cassa${bill.fiscal_doc_number ? ` n. ${bill.fiscal_doc_number}` : ''} · battuto sul registratore`
              : <>Scontrino {bill.fiscal_doc_number ?? bill.fiscal_ref}{viaPP ? ' · emesso via Passepartout' : ''}</>}
          </p>
        )}
        {/* Il documento emesso si consegna: QR per l'ospite (pagina pubblica
            /scontrino/<token>, sopravvive alla serata) e copia di cortesia
            sulla termica. Solo per i nativi: quello Passepartout esce
            dall'RT di cassa, di carta ce n'è già una. */}
        {st === 'CONFIRMED' && !proforma && !invoice && !viaPP && bill.fiscal_public_token && (
          <div className="flex items-center gap-4 rounded-[14px] bg-[var(--ds-surface-row)] p-3">
            <div className="rounded-[10px] bg-white p-2" aria-hidden>
              <QRCodeSVG value={`${window.location.origin}/scontrino/${bill.fiscal_public_token}`} size={96} level="M" />
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-[13px] leading-snug text-[var(--ds-text-secondary)]">
                L'ospite lo inquadra e ha lo scontrino digitale sul telefono.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(async () => {
                  await printBill(bill.id, 'SCONTRINO');
                  setPrintedFlash(true);
                  setTimeout(() => setPrintedFlash(false), 4000);
                })}
                className={quiet}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                {printedFlash ? 'Copia in stampa' : 'Stampa copia'}
              </button>
            </div>
          </div>
        )}
        {st === 'FAILED' && bill.fiscal_error && (
          <p className="text-[13px] text-[var(--ds-critical-text)] break-words">{bill.fiscal_error}</p>
        )}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {isPP && st !== 'CONFIRMED' && st !== 'PENDING' && bill.status === 'CLOSED' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => billsApiService.passepartoutClose(bill.id))}
              className={quiet}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
              Chiudi in cassa
            </button>
          )}
          {!isPP && slotFree && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => billsApiService.emitFiscalDoc(bill.id))}
              className={quiet}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
              {st === 'FAILED' && !invoice ? 'Riprova emissione' : st === 'VOIDED' ? 'Emetti di nuovo' : 'Emetti scontrino'}
            </button>
          )}
          {/* Fattura al posto dello scontrino: stesso prerequisito (nessun
              documento fiscale vivo — la proforma nativa non conta e viene
              superata dal server). Il cameriere sceglie il cliente nel dialog. */}
          {!isPP && slotFree && (
            <button type="button" disabled={busy} onClick={() => setInvoiceOpen(true)} className={quiet}>
              <FileText className="h-4 w-4" />
              {st === 'FAILED' && invoice ? 'Riprova fattura' : 'Emetti fattura'}
            </button>
          )}
          {/* La nota fallita si ritenta sulla STESSA fattura (related_doc_id):
              i bottoni di emissione qui sopra tacciono perché il documento
              vivo, la fattura, c'è ancora. */}
          {!isPP && st === 'FAILED' && creditNote && bill.fiscal_related_doc_id != null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => billsApiService.issueCreditNote(bill.id, bill.fiscal_related_doc_id!))}
              className={quiet}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Riprova nota di credito
            </button>
          )}
          {/* Marcatura a posteriori: il conto chiuso "senza scontrino"
              diventa proforma — scelta deliberata, non dimenticanza. */}
          {!isPP && (st == null || st === 'VOIDED' || (st === 'CONFIRMED' && creditNote)) && bill.status === 'CLOSED' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => billsApiService.markProforma(bill.id))}
              className={quiet}
            >
              Segna proforma
            </button>
          )}
          {/* Scontrino battuto in cassa ma non registrato alla chiusura (o
              proforma da promuovere): si recupera da qui, col numero. */}
          {!isPP && (st == null || st === 'VOIDED' || nativeProforma || (st === 'CONFIRMED' && creditNote)) && bill.status === 'CLOSED' && (
            rtArmed ? (
              <span className="flex items-center gap-1.5">
                <input
                  type="text"
                  maxLength={30}
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Numero scontrino"
                  value={rtNumber}
                  onChange={e => setRtNumber(e.target.value)}
                  disabled={busy}
                  className="h-10 w-44 rounded-full border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3.5 text-[13px] text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(async () => { await billsApiService.markCassa(bill.id, rtNumber.trim() || undefined); setRtArmed(false); setRtNumber(''); })}
                  className={quiet}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Registra
                </button>
                <button type="button" disabled={busy} onClick={() => setRtArmed(false)} className={quiet}>
                  Annulla
                </button>
              </span>
            ) : (
              <button type="button" disabled={busy} onClick={() => setRtArmed(true)} className={quiet}>
                Scontrino di cassa
              </button>
            )
          )}
          {st === 'CONFIRMED' && !viaPP && !viaRT && !viaLocalRt && !invoice && !proforma && !creditNote && bill.fiscal_doc_id != null && (
            armed ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => billsApiService.voidFiscalDoc(bill.id, bill.fiscal_doc_id!))}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-[var(--ds-critical-solid)] px-4 text-[13px] font-semibold text-white transition-colors disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  Confermo l'annullo
                </button>
                <button type="button" disabled={busy} onClick={() => setArmed(false)} className={quiet}>
                  Lascia stare
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => setArmed(true)} className={quiet}>
                <X className="h-4 w-4" />
                Annulla scontrino
              </button>
            )
          )}
          {/* Lo storno della fattura: stesso doppio tap dell'annullo — è un
              atto fiscale che parte verso SDI, non un undo. */}
          {st === 'CONFIRMED' && !viaPP && invoice && bill.fiscal_doc_id != null && (
            armed ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => billsApiService.issueCreditNote(bill.id, bill.fiscal_doc_id!))}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-[var(--ds-critical-solid)] px-4 text-[13px] font-semibold text-white transition-colors disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  Confermo lo storno
                </button>
                <button type="button" disabled={busy} onClick={() => setArmed(false)} className={quiet}>
                  Lascia stare
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => setArmed(true)} className={quiet}>
                <FileText className="h-4 w-4" />
                Nota di credito
              </button>
            )
          )}
        </div>
        {armed && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {invoice
              ? 'La nota di credito viene trasmessa a SDI con lo stesso importo della fattura.'
              : "L'annullo viene trasmesso all'Agenzia delle Entrate."}
          </p>
        )}
      </div>
      {invoiceOpen && (
        <InvoiceDialog
          bill={bill}
          onCancel={() => setInvoiceOpen(false)}
          onDone={() => { setInvoiceOpen(false); onChanged?.(); }}
        />
      )}
    </FormCard>
  );
};

/** Pane form, for the Pagamenti detail column. The back button PaneHeader
 *  draws is mobile-only — there the pane is a full-screen sheet over the list,
 *  and on desktop the list is right there beside it. */
export const BillDetail: React.FC<{
  bill: BillLike;
  busy?: boolean;
  onClose: () => void;
  onSettle?: (opts?: SettleOpts, meta?: { invoiceIntent?: boolean }) => void;
  /** Ricarica la lista dopo emissione/annullo dello scontrino. */
  onFiscalChanged?: () => void;
}> = ({ bill, busy, onClose, onSettle, onFiscalChanged }) => (
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
      <FiscalCard bill={bill} onChanged={onFiscalChanged} />
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
  onSettle?: (opts?: SettleOpts, meta?: { invoiceIntent?: boolean }) => void;
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
