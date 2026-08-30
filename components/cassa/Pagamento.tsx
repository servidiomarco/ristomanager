import React, { useMemo, useState } from 'react';
import { ArrowLeft, Loader2, QrCode } from 'lucide-react';
import type { BillPaymentInput, OpenBillRow } from '../../services/billsApiService';
import { Callout, SegmentedControl, StatusPill } from '../ds';
import { METHODS, methodLabel, nextAmountText, settleMath, settlePayments } from '../pagamenti/settleView';
import type { SettleOpts } from '../pagamenti/BillSheet';
import { euro } from './cassaView';

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
  onBack: () => void;
  onSettle: (opts: SettleOpts) => void;
  onSplit: () => void;
  onShowQr: () => void;
  /** Dentro un modal (PagamentoSheet): niente testata propria — il guscio ha
   *  già titolo e chiusura — e terza colonna su schermo largo, così l'intero
   *  incasso sta in vista senza scroll. Default false: in CassaPage la resa
   *  resta identica byte per byte (regola additiva del piano). */
  embedded?: boolean;
}

export const Pagamento: React.FC<PagamentoProps> = ({
  bill, busy, error, fiscalReady, quotaCents, onBack, onSettle, onSplit, onShowQr, embedded = false,
}) => {
  const residual = bill.residual_cents;
  const [movements, setMovements] = useState<BillPaymentInput[]>([]);
  const [method, setMethod] = useState<BillPaymentInput['method']>('CONTANTI');
  const [amount, setAmount] = useState(
    quotaCents != null && quotaCents > 0
      ? (quotaCents / 100).toFixed(2)
      : residual > 0 ? (residual / 100).toFixed(2) : '0'
  );
  const [tip, setTip] = useState('');
  const [doc, setDoc] = useState<Doc>('Scontrino');

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

  const addMovement = () => {
    if (math.applied <= 0) return;
    setMovements(prev => [...prev, { method, amount_cents: math.applied }]);
    setAmount(nextAmountText(Math.max(0, math.remaining - math.applied)));
  };

  const confirm = () => {
    onSettle({
      payments: settlePayments(movements, method, math.applied),
      tip_cents: tipCents,
      // «Fattura» chiude comunque senza scontrino: il documento si emette poi
      // dal conto, dove ci sono i dati del cessionario.
      documento: doc === 'Scontrino' ? 'Scontrino' : 'Proforma',
    });
  };

  const field = 'h-12 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-right text-[17px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]';

  // I due gruppi «canale» e «documento+conferma» vivono nella colonna destra
  // in pagina, in una terza colonna dentro il modal: stessi nodi, un solo
  // posto dove correggerli.
  const canaleEDocumento = (
    <>
      {/* Il secondo gruppo: apre un canale, non registra denaro. */}
      <h2 className={`${embedded ? '' : 'mt-5 '}text-[13px] font-semibold text-[var(--ds-text-muted)]`}>Chiedi al cliente</h2>
      <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">
        Il conto resta aperto: il residuo scende quando l'ospite paga.
      </p>
      <button
        type="button"
        onClick={onShowQr}
        disabled={busy || !bill.share_token}
        className="mt-2 inline-flex h-11 items-center gap-2 rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
      >
        <QrCode size={16} aria-hidden /> QR al tavolo
      </button>

      <div className="mt-5">
        <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
          Documento alla chiusura
        </span>
        <SegmentedControl<Doc>
          value={doc}
          onChange={setDoc}
          options={[
            { value: 'Scontrino', label: 'Scontrino' },
            { value: 'Proforma', label: 'Proforma' },
            { value: 'Fattura', label: 'Fattura' },
          ]}
          ariaLabel="Documento alla chiusura"
          equalWidth={false}
          size="sm"
        />
        {doc === 'Proforma' && (
          <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
            Il conto si chiude senza documento fiscale. Scontrino e fattura restano
            emettibili da questo conto, anche domani.
          </p>
        )}
        {doc === 'Fattura' && (
          <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
            Il conto si chiude con proforma e la fattura si emette dal conto, dove
            ci sono i dati del cessionario. Scontrino e fattura non coesistono.
          </p>
        )}
        {doc === 'Scontrino' && !fiscalReady && (
          <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
            Nessun provider fiscale configurato: lo scontrino non parte davvero.
          </p>
        )}
      </div>

      {error && <Callout tone="critical" className="mt-3">{error}</Callout>}

      <p className={`mt-3 text-[13px] ${math.willSettle ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}>
        {math.willSettle
          ? `Il conto risulterà saldato${tipCents > 0 ? ` · mancia ${euro(tipCents)}` : ''}.`
          : `Ammanco ${euro(math.shortfall)}: il conto resterà parziale.`}
      </p>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onSplit}
          disabled={busy || residual <= 0}
          className="inline-flex h-12 flex-shrink-0 items-center rounded-full bg-[var(--ds-surface)] px-5 text-[15px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
        >
          Dividi conto
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
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
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna alla comanda"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold text-[var(--ds-text-primary)]">Pagamento</h1>
            <p className="truncate text-[13px] text-[var(--ds-text-muted)]">
              Tavolo {bill.table_name ?? '—'} · {bill.covers} copert{bill.covers === 1 ? 'o' : 'i'}
            </p>
          </div>
          <StatusPill tone={residual > 0 ? 'pending' : 'positive'}>
            {residual > 0 ? `residuo ${euro(residual)}` : 'saldato'}
          </StatusPill>
        </div>
      </div>
      )}

      <div className={embedded
        ? 'grid w-full min-h-0 flex-1 gap-3 overflow-y-auto pb-1 lg:grid-cols-3'
        : 'mx-auto grid w-full min-h-0 max-w-[1200px] flex-1 gap-4 overflow-y-auto px-4 pb-6 lg:grid-cols-2 lg:px-8'}>
        {/* Riepilogo */}
        <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
          <h2 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Riepilogo</h2>
          <dl className="mt-3 space-y-1.5 text-[14px]">
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--ds-text-secondary)]">Totale conto</dt>
              <dd className="tabular-nums text-[var(--ds-text-primary)]">{euro(bill.total_cents)}</dd>
            </div>
          </dl>

          <div className="mt-3 space-y-1.5 rounded-[14px] bg-[var(--ds-surface-row)] p-3 text-[13px]">
            {deposit > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ds-text-secondary)]">Caparra prenotazione</span>
                <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(deposit)}</span>
              </div>
            )}
            {staffPaid > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ds-text-secondary)]">Incassato in cassa</span>
                <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(staffPaid)}</span>
              </div>
            )}
            {online > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ds-text-secondary)]">Pagato online</span>
                <span className="tabular-nums text-[var(--ds-text-secondary)]">{euro(online)}</span>
              </div>
            )}
            <div className="flex justify-between gap-2 border-t border-[var(--ds-border)] pt-1.5 font-semibold">
              <span className="text-[var(--ds-text-primary)]">Già pagato</span>
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

          <div className="mt-4">
            <div className="text-[13px] text-[var(--ds-pending-text)]">Residuo</div>
            <div className="text-[40px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-[var(--ds-text-primary)]">
              {euro(math.remaining)}
            </div>
          </div>
        </section>

        {/* Come si paga */}
        <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
          <h2 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Incassa</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
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
                  title={blocked ? 'Serve un cliente sulla visita' : undefined}
                  className={`inline-flex h-11 items-center rounded-full px-3.5 text-[14px] font-medium transition-colors disabled:opacity-40 ${
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
                <li key={i} className="flex items-center justify-between rounded-lg bg-[var(--ds-surface-row)] px-3 py-1.5 text-[14px] text-[var(--ds-text-secondary)]">
                  <span>{methodLabel(m.method)}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{euro(m.amount_cents)}</span>
                    <button
                      type="button"
                      aria-label="Togli movimento"
                      onClick={() => setMovements(prev => prev.filter((_, j) => j !== i))}
                      disabled={busy}
                      className="rounded-full px-2 text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] disabled:opacity-40"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {math.remaining > 0 && (
            <div className="mt-3 flex items-end gap-2">
              <label className="block flex-1">
                <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
                  {method === 'CONTANTI' ? 'Contanti ricevuti' : 'Importo'}
                </span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-[var(--ds-text-muted)]">€</span>
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
                className="h-12 rounded-xl bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] disabled:opacity-40"
              >
                Aggiungi
              </button>
            </div>
          )}

          {math.change > 0 && (
            <p className="mt-2 text-[15px] font-semibold text-[var(--ds-text-primary)]">
              Resto <span className="tabular-nums">{euro(math.change)}</span>
            </p>
          )}

          <label className="mt-3 block">
            <span className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">
              Mancia <span className="font-normal text-[var(--ds-text-muted)]">(facoltativa)</span>
            </span>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
              <input
                type="text" inputMode="decimal" placeholder="0,00" value={tip}
                onChange={e => setTip(e.target.value)} disabled={busy}
                className={`${field} h-11 pl-8 text-[15px]`}
              />
            </div>
          </label>

          {!embedded && canaleEDocumento}
        </section>

        {/* Terza colonna del modal: canale e documento accanto all'incasso,
            non sotto — l'intero pannello sta in vista senza scroll. */}
        {embedded && (
          <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
            {canaleEDocumento}
          </section>
        )}
      </div>
    </div>
  );
};
