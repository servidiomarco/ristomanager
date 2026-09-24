import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Loader2, QrCode, Send } from 'lucide-react';
import { chime } from '../../utils/chime';
import { billsApiService } from '../../services/billsApiService';
import type { BillPaymentInput, OpenBillRow } from '../../services/billsApiService';
import { Callout, SegmentedControl, StatusPill } from '../ds';
import { METHODS, methodLabel, nextAmountText, settleMath, settlePayments } from '../pagamenti/settleView';
import type { SettleOpts } from '../pagamenti/BillSheet';
import { euro } from './cassaView';
import { moneySymbol } from '../../utils/displayMoney';

/* ── Passo 4 · pagamento ──────────────────────────────────────────────────
   Prima l'importo, poi il metodo.

   Il pannello si divide per VERBO, non per metodo (docs/cassa-plan.md §10):

     - «Incassa» registra denaro adesso e chiude il conto;
     - «Chiedi al cliente» apre un canale — QR al tavolo, link di pagamento —
       e il conto resta aperto. Non si sceglie un importo lì: il residuo scende
       da solo quando arriva il webhook, che scrive lo specchio LINK_ONLINE.
       Registrarlo a mano sarebbe scriverlo due volte.

   Il già pagato si legge diviso nei tre tipi di denaro che il conto tiene
   separati: caparra, incassato in cassa, pagato online. */

type Doc = 'Scontrino' | 'Proforma' | 'Fattura';

interface PagamentoProps {
  bill: OpenBillRow;
  busy: boolean;
  error: string | null;
  /** Un provider fiscale è configurato: senza, lo scontrino è una
   *  dichiarazione d'intento e la proforma è la scelta onesta. */
  fiscalReady: boolean;
  /** Importo scelto in «Dividi conto»: precompila il campo. */
  quotaCents: number | null;
  /** Piatti spuntati per quella quota («per piatti»): viaggiano col
   *  movimento che la paga, in meta.item_units. */
  quotaItemUnits?: { order_item_id: number; units: number }[] | null;
  onBack: () => void;
  onSettle: (opts: SettleOpts, meta?: { invoiceIntent?: boolean }) => void;
  onSplit: () => void;
  onShowQr: () => void;
  /** Correzione del conto (storno righe contestate): se assente il verbo
   *  non compare — in CassaPage la via resta il tavolo attivo. */
  onEdit?: () => void;
  /** Sconto sul conto: la comanda qui è già chiusa, quindi passa da
   *  POST /bills/:id/discount, non dallo sconto di comanda. */
  onDiscount?: () => void;
  /** Dentro un modal (PagamentoSheet): niente testata propria — il guscio ha
   *  già titolo e chiusura — e terza colonna su schermo largo, così l'intero
   *  incasso sta in vista senza scroll. Default false: in CassaPage la resa
   *  resta identica byte per byte (regola additiva del piano). */
  embedded?: boolean;
  /** Contatore che avanza a ogni pagamento online/POS incassato mentre la
   *  schermata è aperta (dal socket bill:split-paid nel container). Il cambio
   *  fa lampeggiare il residuo, suona e vibra: l'operatore vede il pagamento
   *  arrivare senza fissare il numero. */
  paymentPulse?: number;
}

export const Pagamento: React.FC<PagamentoProps> = ({
  bill, busy, error, fiscalReady, quotaCents, quotaItemUnits = null, onBack, onSettle, onSplit, onShowQr, onEdit, onDiscount, embedded = false, paymentPulse = 0,
}) => {
  const { t } = useTranslation('cassa', { useSuspense: false });
  const residual = bill.residual_cents;
  // Feedback "pagamento ricevuto": lampeggio one-shot + suono + vibrazione al
  // salire del pulse (non al primo render — solo agli incassi successivi).
  const [flash, setFlash] = useState(false);
  const firstPulse = useRef(true);
  useEffect(() => {
    if (firstPulse.current) { firstPulse.current = false; return; }
    setFlash(true);
    chime();
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [paymentPulse]);
  const flashCls = flash ? 'animate-flash-row rounded-[var(--ds-radius)]' : '';
  const [movements, setMovements] = useState<BillPaymentInput[]>([]);
  const [method, setMethod] = useState<BillPaymentInput['method']>('CONTANTI');
  const [amount, setAmount] = useState(
    quotaCents != null && quotaCents > 0
      ? (quotaCents / 100).toFixed(2)
      : residual > 0 ? (residual / 100).toFixed(2) : '0'
  );
  const [tip, setTip] = useState('');
  const [doc, setDoc] = useState<Doc>('Scontrino');
  // Invio del link /pay al telefono dell'ordine d'asporto. Esito inline
  // sotto il bottone (niente toast: l'operatore sta guardando qui) e
  // reinvio sempre possibile — il server rimanda a ogni chiamata.
  const [linkSend, setLinkSend] = useState<{ state: 'idle' | 'sending' | 'sent' | 'error'; detail?: string }>({ state: 'idle' });
  useEffect(() => { setLinkSend({ state: 'idle' }); }, [bill.id]);
  const sendTakeawayLink = async () => {
    if (bill.takeaway_order_id == null) return;
    setLinkSend({ state: 'sending' });
    try {
      const r = await billsApiService.notifyTakeawayBillLink(bill.takeaway_order_id);
      setLinkSend({ state: 'sent', detail: r.channel === 'whatsapp' ? 'WhatsApp' : 'SMS' });
    } catch (err: any) {
      setLinkSend({ state: 'error', detail: err?.message });
    }
  };

  const math = useMemo(
    () => settleMath(residual, movements, method, amount),
    [residual, movements, method, amount]
  );
  const tipCents = useMemo(() => {
    const n = parseFloat(tip.replace(/[^\d.,]/g, '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
  }, [tip]);

  const deposit = bill.deposit_credit_cents ?? 0;
  const staffPaid = bill.staff_paid_cents ?? 0;
  const online = Math.max(0, bill.paid_cents - deposit - staffPaid);
  const alreadyPaid = deposit + staffPaid + online;

  // Sconto complessivo (di comanda e di conto): la somma delle righe meno il
  // totale. Si mostra perché il totale, da solo, non spiega la differenza.
  const itemsSum = (bill.items ?? []).reduce((s, i) => s + i.unit_price_cents * i.qty, 0);

  // Cosa è già pagato, riga per riga: le quote dal QR pagate e gli incassi
  // «per piatti» della cassa. «In pagamento» = quota QR presa ma non ancora
  // saldata. Letti in modo difensivo: il backend deployato può non mandarli.
  const paidUnits = useMemo(
    () => new Map((bill.item_paid_units ?? []).map(u => [u.order_item_id, u.units])),
    [bill.item_paid_units]
  );
  const takenUnits = useMemo(
    () => new Map((bill.item_taken_units ?? []).map(u => [u.order_item_id, u.units])),
    [bill.item_taken_units]
  );
  const discountShown = itemsSum > 0 ? Math.max(0, itemsSum - bill.total_cents) : 0;

  const addMovement = () => {
    if (math.applied <= 0) return;
    setMovements(prev => [...prev, { method, amount_cents: math.applied }]);
    setAmount(nextAmountText(Math.max(0, math.remaining - math.applied)));
  };

  const confirm = () => {
    // La spunta dei piatti segue il movimento che paga esattamente la quota
    // scelta in «per piatti»: se l'importo è stato ritoccato non si sa più
    // cosa copre, e non si marca niente.
    let payments = settlePayments(movements, method, math.applied);
    if (quotaItemUnits && quotaItemUnits.length > 0 && quotaCents != null) {
      const ix = payments.findIndex(p => p.amount_cents === quotaCents && !p.meta);
      if (ix >= 0) payments = payments.map((p, i) => i === ix ? { ...p, meta: { item_units: quotaItemUnits } } : p);
    }
    onSettle({
      payments,
      tip_cents: tipCents,
      // «Fattura» chiude comunque senza scontrino: il documento si emette poi
      // dal conto, dove ci sono i dati del cessionario.
      documento: doc === 'Scontrino' ? 'Scontrino' : 'Proforma',
    }, { invoiceIntent: doc === 'Fattura' });
  };

  const field = 'h-12 w-full rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-right text-[17px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]';

  // I due gruppi «canale» e «documento+conferma» vivono nella colonna destra
  // in pagina, in una terza colonna dentro il modal: stessi nodi, un solo
  // posto dove correggerli.
  const canaleEDocumento = (
    <>
      {/* Il secondo gruppo: apre un canale, non registra denaro. */}
      <h2 className="mt-5 border-t border-[var(--ds-border)] pt-4 text-[13px] font-semibold text-[var(--ds-text-muted)]">{t('askCustomer')}</h2>
      <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">
        {t('billStaysOpen')}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onShowQr}
          disabled={busy || !bill.share_token}
          className="inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
        >
          <QrCode size={16} aria-hidden /> {t(bill.takeaway_order_id != null ? 'qrOfBill' : 'qrAtTable')}
        </button>
        {bill.takeaway_order_id != null && (
          <button
            type="button"
            onClick={sendTakeawayLink}
            disabled={busy || linkSend.state === 'sending' || !bill.share_token}
            className="inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
          >
            {linkSend.state === 'sending'
              ? <Loader2 size={16} className="animate-spin" aria-hidden />
              : <Send size={16} aria-hidden />}
            {t(linkSend.state === 'sent' ? 'resendLink' : 'sendLink')}
          </button>
        )}
      </div>
      {linkSend.state === 'sent' && (
        <p className="mt-1 text-[12px] text-[var(--ds-seated-text)]">{t('sentVia', { canale: linkSend.detail })}</p>
      )}
      {linkSend.state === 'error' && (
        <p className="mt-1 text-[12px] text-[var(--ds-critical-text)]">{linkSend.detail || t('sendFailedRetry')}</p>
      )}

      <div className="mt-5 border-t border-[var(--ds-border)] pt-4">
        <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-muted)]">
          {t('docAtClose')}
        </span>
        <SegmentedControl<Doc>
          value={doc}
          onChange={setDoc}
          options={[
            { value: 'Scontrino', label: t('receipt') },
            { value: 'Proforma', label: t('proforma') },
            { value: 'Fattura', label: t('invoice') },
          ]}
          ariaLabel={t('docAtClose')}
          equalWidth={false}
          size="sm"
        />
        {doc === 'Proforma' && (
          <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
            {t('proformaHint')}
          </p>
        )}
        {doc === 'Fattura' && (
          <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
            {t('invoiceHint')}
          </p>
        )}
        {doc === 'Scontrino' && !fiscalReady && (
          <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
            {t('noFiscalProvider')}
          </p>
        )}
      </div>

      {error && <Callout tone="critical" className="mt-3">{error}</Callout>}

      {/* Il piede resta in vista: dentro il modal la colonna scorre, e la
          conferma — il gesto per cui si è aperta la schermata — non deve mai
          finire sotto la piega. Sticky dentro la sezione (p-4): i margini
          negativi lo portano a filo dei bordi, il fondo copre ciò che scorre.
          Nel modal il corpo che scorre ha il suo padding (p-4, sm:p-5): lo
          sticky si fermerebbe lì sopra lasciando intravedere il contenuto
          sotto, quindi scende fino al bordo e recupera lo spazio in basso. */}
      <div className={`sticky -mx-4 -mb-4 mt-5 rounded-b-[var(--ds-radius)] border-t border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 pt-3 ${
        embedded ? '-bottom-4 pb-8 sm:-bottom-5 sm:pb-9' : 'bottom-0 pb-4'
      }`}>
        <p className={`text-[13px] ${math.willSettle ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
          {math.willSettle
            ? (tipCents > 0 ? t('willSettleTip', { mancia: euro(tipCents) }) : t('willSettle'))
            : t('shortfall', { importo: euro(math.shortfall) })}
        </p>

        {/* Due file: i verbi secondari a parti uguali, poi la conferma da sola
            a tutta larghezza. In un'unica fila la conferma si comprimeva fino
            ad andare a capo su tre righe («Registra e / 44,50 e / chiudi»). */}
        <div className="mt-3 flex gap-2">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 text-[15px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
            >
              <span className="truncate">{t('fix')}</span>
            </button>
          )}
          {onDiscount && (
            <button
              type="button"
              onClick={onDiscount}
              disabled={busy}
              className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 text-[15px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
            >
              <span className="truncate">{t('discount')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onSplit}
            disabled={busy || residual <= 0}
            className="inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 text-[15px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
          >
            <span className="truncate">{t('splitBill')}</span>
          </button>
        </div>
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="mt-2 inline-flex h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] px-4 text-[17px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          Registra {euro(math.applied + math.recorded)} e chiudi
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!embedded && (
      <div className="mx-auto w-full max-w-[1200px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8">
        <div className="flex items-center gap-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <button
            type="button"
            onClick={onBack}
            aria-label={t('goBack')}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold text-[var(--ds-text-primary)]">{t('payment')}</h1>
            <p className="truncate text-[13px] text-[var(--ds-text-muted)]">
              {bill.takeaway_order_id != null
                ? t('takeawayHead', { ora: bill.takeaway_time ?? '', cliente: bill.customer_name ?? '' })
                : t('tableHead', { nome: bill.table_name ?? '—', coperti: t('coversCount', { count: bill.covers }) })}
            </p>
          </div>
          <StatusPill tone={residual > 0 ? 'pending' : 'positive'}>
            {residual > 0 ? `residuo ${euro(residual)}` : 'saldato'}
          </StatusPill>
        </div>
      </div>
      )}

      {/* Nel modal a scorrere è il corpo del ModalShell, non questa griglia:
          un overflow qui (senza altezza fissa non scorre mai) catturava lo
          sticky del piede di conferma, che restava sotto la piega. */}
      <div className={embedded
        ? 'grid w-full gap-3 pb-1 lg:grid-cols-2'
        : 'mx-auto grid w-full min-h-0 max-w-[1200px] flex-1 gap-4 overflow-y-auto px-4 pb-6 lg:grid-cols-2 lg:px-8'}>
        {/* Riepilogo */}
        <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
          <h2 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">{t('summary')}</h2>
          {/* Le righe del conto: cosa si sta incassando, non solo quanto.
              Tetto in altezza con scroll interno — un banchetto lungo non
              deve spingere il residuo fuori dallo schermo. */}
          {(bill.items?.length ?? 0) > 0 && (
            <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto border-b border-[var(--ds-border)] pb-3 pr-1 text-[13px]">
              {(bill.items ?? []).map((it, idx) => {
                const oid = it.order_item_id;
                const known = oid != null && bill.item_paid_units != null;
                const paid = known ? Math.min(it.qty, paidUnits.get(oid!) ?? 0) : 0;
                const paying = known ? Math.max(0, Math.min(it.qty - paid, (takenUnits.get(oid!) ?? 0) - paid)) : 0;
                const allPaid = paid >= it.qty;
                return (
                  <li key={idx} className="flex items-baseline gap-2">
                    <span className="shrink-0 tabular-nums text-[var(--ds-text-muted)]">{it.qty}×</span>
                    <span className={`min-w-0 flex-1 truncate ${allPaid ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-secondary)]'}`}>
                      {it.name}
                    </span>
                    {allPaid ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-[var(--ds-seated-text)]">
                        <Check size={12} aria-hidden />{t('itemPaid')}
                      </span>
                    ) : (paid > 0 || paying > 0) && (
                      <span className="shrink-0 text-[12px]">
                        {paid > 0 && <span className="font-medium text-[var(--ds-seated-text)]">{t('itemPaidUnits', { count: paid })}</span>}
                        {paid > 0 && paying > 0 && <span className="text-[var(--ds-text-muted)]"> · </span>}
                        {paying > 0 && <span className="text-[var(--ds-pending-text)]">{t('itemPaying', { count: paying })}</span>}
                      </span>
                    )}
                    <span className={`shrink-0 tabular-nums ${allPaid ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-secondary)]'}`}>{euro(it.unit_price_cents * it.qty)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <dl className="mt-3 space-y-1.5 text-[14px]">
            {discountShown > 0 && (
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--ds-critical-text)]">{t('discount')}</dt>
                <dd className="tabular-nums text-[var(--ds-critical-text)]">−{euro(discountShown)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--ds-text-secondary)]">{t('billTotal')}</dt>
              <dd className="tabular-nums text-[var(--ds-text-primary)]">{euro(bill.total_cents)}</dd>
            </div>
          </dl>

          <div className="mt-3 space-y-1.5 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3 text-[13px]">
            {deposit > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ds-text-secondary)]">{t('bookingDeposit')}</span>
                <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(deposit)}</span>
              </div>
            )}
            {staffPaid > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ds-text-secondary)]">{t('takenAtTill')}</span>
                <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(staffPaid)}</span>
              </div>
            )}
            {online > 0 && (
              <div className={`flex justify-between gap-2 ${flashCls}`}>
                <span className="text-[var(--ds-text-secondary)]">{t('paidOnline')}</span>
                <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(online)}</span>
              </div>
            )}
            <div className="flex justify-between gap-2 border-t border-[var(--ds-border)] pt-1.5 font-semibold">
              <span className="text-[var(--ds-text-primary)]">{t('alreadyPaid')}</span>
              <span className="tabular-nums text-[var(--ds-text-primary)]">{euro(alreadyPaid)}</span>
            </div>
          </div>

          {(bill.refund_due_cents ?? 0) > 0 && (
            // Si mostra, non si esegue: il rimborso è un'operazione di gateway
            // e vive in Pagamenti, non nel cassetto.
            <Callout tone="info" className="mt-3">
              Da rimborsare al cliente {euro(bill.refund_due_cents ?? 0)} — si fa da Pagamenti.
            </Callout>
          )}

          <div className={`mt-4 ${flash ? 'animate-flash-row rounded-[var(--ds-radius)] p-2 -m-2' : ''}`}>
            <div className="text-[13px] text-[var(--ds-pending-text)]">{t('remaining')}</div>
            <div className="text-[40px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-[var(--ds-text-primary)]">
              {euro(math.remaining)}
            </div>
          </div>
        </section>

        {/* Come si paga */}
        <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
          <h2 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">{t('collectHere')}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {METHODS.map(m => {
              // Un sospeso su un tavolo senza cliente è un credito che nessuno
              // può riscuotere: si abilita solo quando c'è un nome.
              const blocked = m.value === 'SOSPESO' && !bill.customer_name;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMethod(m.value)}
                  disabled={busy || blocked}
                  title={blocked ? t('needsCustomer') : undefined}
                  className={`inline-flex h-11 items-center rounded-[var(--ds-radius-control)] px-3.5 text-[14px] font-medium transition-colors disabled:opacity-40 ${
                    method === m.value
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {movements.length > 0 && (
            <ul className="mt-3 space-y-1">
              {movements.map((m, i) => (
                <li key={i} className="flex items-center justify-between rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-3 py-1.5 text-[14px] text-[var(--ds-text-secondary)]">
                  <span>{methodLabel(m.method)}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{euro(m.amount_cents)}</span>
                    <button
                      type="button"
                      aria-label={t('removeMovement')}
                      onClick={() => setMovements(prev => prev.filter((_, j) => j !== i))}
                      disabled={busy}
                      className="rounded-[var(--ds-radius-control)] px-2 text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] disabled:opacity-40"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {math.remaining > 0 && (
            <div className="mt-4 flex items-end gap-2">
              <label className="block flex-1">
                <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
                  {t(method === 'CONTANTI' ? 'cashReceived' : 'amount')}
                </span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
                  <input
                    type="text" inputMode="decimal" value={amount}
                    onChange={e => setAmount(e.target.value)} disabled={busy}
                    className={`${field} pl-8`}
                  />
                </div>
              </label>
              <button
                type="button"
                onClick={addMovement}
                disabled={busy || math.applied <= 0 || math.applied >= math.remaining}
                className="h-12 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] disabled:opacity-40"
              >
                {t('add')}
              </button>
            </div>
          )}

          {math.change > 0 && (
            <p className="mt-2 text-[15px] font-semibold text-[var(--ds-text-primary)]">
              Resto <span className="tabular-nums">{euro(math.change)}</span>
            </p>
          )}

          <label className="mt-4 block">
            <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
              Mancia <span className="font-normal text-[var(--ds-text-muted)]">(facoltativa)</span>
            </span>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
              <input
                type="text" inputMode="decimal" placeholder="0,00" value={tip}
                onChange={e => setTip(e.target.value)} disabled={busy}
                className={`${field} h-11 pl-8 text-[15px]`}
              />
            </div>
          </label>

          {canaleEDocumento}
        </section>
      </div>
    </div>
  );
};
