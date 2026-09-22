import type { OpenBillRow } from '../../services/billsApiService';
import type { Table } from '../../types';
import { toTitleCase } from '../../utils/text';
import { timePart } from '../../utils/displayTime';
import { formatEuro } from '../pagamenti/paymentsView';
import type { PillTone } from '../ds';

/* ── Il vocabolario della Cassa ───────────────────────────────────────────
   Come si legge un conto dalla parte di chi incassa. Niente React qui: sono
   le regole di lettura della coda, e si guardano meglio da sole.

   Una regola sola, applicata ovunque (docs/cassa-plan.md §10): l'occupazione
   si conta in TAVOLI, il lavoro si conta in CONTI. Un'unione di due tavoli è
   2 nel «9/18» e 1 nella riga «2 conti da incassare». */

export const euro = (cents: number) => formatEuro(cents);

/** Lo stato di un conto dal punto di vista della cassa. */
export type QueueState =
  | 'partial'   // qualcosa è già entrato, manca il resto
  | 'due'       // ancora nessun incasso
  | 'past';     // rimasto aperto in un servizio precedente

export const queueState = (bill: OpenBillRow): QueueState => {
  if (!bill.is_current_service) return 'past';
  // paid_cents arriva dal server già comprensivo degli incassi staff.
  return bill.paid_cents > 0 ? 'partial' : 'due';
};

/* Le parole di questo modulo arrivano con `t` come parametro: è una vista
   senza hook, lo stesso contratto di tablesView.ts e utils/courses.ts. Senza
   `t` resta l'italiano, così un chiamante dimenticato si legge. */
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const QUEUE_PILL: Record<QueueState, { key: string; label: string; tone: PillTone }> = {
  partial: { key: 'pill.partial', label: 'Parziale', tone: 'pending' },
  due: { key: 'pill.due', label: 'Da incassare', tone: 'pending' },
  past: { key: 'pill.past', label: 'Servizio passato', tone: 'neutral' },
};

export const queuePill = (state: QueueState, t?: TFunc): { label: string; tone: PillTone } => {
  const p = QUEUE_PILL[state];
  return { label: t ? t(p.key, p.label) : p.label, tone: p.tone };
};

/** L'etichetta sotto l'importo. Mai «credito»: nel modello il credito è
 *  l'acconto portato nel conto, che è tutt'altra cosa dal residuo. */
export const residualLabel = (bill: OpenBillRow, t?: TFunc): string =>
  queueState(bill) === 'partial'
    ? (t ? t('remainder', 'residuo') : 'residuo')
    : (t ? t('toSettle', 'da saldare') : 'da saldare');

/** Chi c'è al tavolo. Un conto senza prenotazione è un walk-in — non «nessun
 *  cliente», che suonerebbe come un errore invece che come il caso normale. */
export const guestLabel = (bill: OpenBillRow, t?: TFunc): string =>
  bill.customer_name ? toTitleCase(bill.customer_name) : (t ? t('walkIn', 'Walk-in') : 'Walk-in');

/** La riga di dettaglio: chi, quanti, da quando, e cosa è già entrato. */
export const queueSubtitle = (bill: OpenBillRow, t?: TFunc): string => {
  const parts = [guestLabel(bill, t)];
  // I coperti sono un dato di sala: sull'asporto «1 coperto» direbbe una
  // cosa falsa.
  if (bill.takeaway_order_id == null) {
    parts.push(t ? t('coversCount', `${bill.covers} coperti`, { count: bill.covers })
                 : `${bill.covers} copert${bill.covers === 1 ? 'o' : 'i'}`);
  }
  if (bill.opened_at) parts.push(t ? t('openedAt', `aperto ${timePart(bill.opened_at)}`, { ora: timePart(bill.opened_at) }) : `aperto ${timePart(bill.opened_at)}`);
  if (bill.paid_cents > 0) parts.push(t ? t('alreadyPaidAmount', `${euro(bill.paid_cents)} già pagati`, { importo: euro(bill.paid_cents) }) : `${euro(bill.paid_cents)} già pagati`);
  return parts.join(' · ');
};

/** Solo i conti su cui c'è ancora qualcosa da incassare: la coda è una lista
 *  di lavoro, non un archivio. */
export const isCollectable = (bill: OpenBillRow): boolean => bill.residual_cents > 0;

export interface Queue {
  /** Conti del servizio in corso. */
  current: OpenBillRow[];
  /** Conti rimasti aperti in un servizio passato: si incassano da qui. */
  past: OpenBillRow[];
  /** Quanto c'è ancora da incassare, solo sul servizio in corso — è la cifra
   *  che la chiusura di cassa segnala come rimasta indietro. */
  dueCents: number;
}

export const buildQueue = (bills: OpenBillRow[]): Queue => {
  const collectable = bills.filter(isCollectable);
  const current = collectable.filter(b => b.is_current_service);
  const past = collectable.filter(b => !b.is_current_service);
  return {
    current,
    past,
    dueCents: current.reduce((n, b) => n + b.residual_cents, 0),
  };
};

/** «9/18»: quanti tavoli hanno qualcosa addosso su quanti ne esistono.
 *  Conta TAVOLI, non conti — un'unione di due tavoli pesa 2. */
export const tablesInService = (
  tables: Table[],
  bills: OpenBillRow[],
  openOrderTableIds: Set<number>,
): { busy: number; total: number } => {
  const busy = new Set<number>(openOrderTableIds);
  for (const b of bills) {
    if (b.table_id != null && isCollectable(b)) busy.add(b.table_id);
  }
  return { busy: busy.size, total: tables.length };
};
