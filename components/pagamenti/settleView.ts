import type { BillPaymentInput } from '../../services/billsApiService';

/* ── L'aritmetica della chiusura conto ────────────────────────────────────
   Estratta da BillSheet perché Cassa la usa su una pagina intera invece che
   in un dialog (docs/cassa-plan.md §8): il tavolo reale paga misto, e come si
   compone il misto è la stessa cosa in tutti e due i posti. Qui non c'è
   niente di React — sono numeri, e i numeri di una cassa vanno guardati da
   soli.

   SettleDialog continua a importare tutto da qui: il comportamento del dialog
   di Pagamenti non cambia di una virgola. */

/** Metodi registrabili in cassa, nell'ordine in cui si usano davvero. */
export const METHODS: { value: BillPaymentInput['method']; label: string }[] = [
  { value: 'CONTANTI', label: 'Contanti' },
  { value: 'POS_FISICO', label: 'POS' },
  { value: 'SATISPAY', label: 'Satispay' },
  { value: 'BUONO_PASTO', label: 'Buoni pasto' },
  { value: 'GIFT_CARD', label: 'Gift card' },
  { value: 'SOSPESO', label: 'Sospeso' },
  { value: 'OMAGGIO', label: 'Omaggio' },
];

export const methodLabel = (m: string): string =>
  m === 'LINK_ONLINE' ? 'Online' : METHODS.find(x => x.value === m)?.label ?? m;

/** Parsing tollerante dell'importo digitato: "12,50" / "12.50" / "12" → cents. */
export const eurToCents = (s: string): number => {
  const n = parseFloat(String(s).replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

export interface SettleMath {
  /** Somma dei movimenti già aggiunti. */
  recorded: number;
  /** Quanto manca dopo i movimenti aggiunti. */
  remaining: number;
  /** L'importo nel campo, in centesimi. */
  amountCents: number;
  /** Quanto di quell'importo va davvero a libro: il di più non è un incasso. */
  applied: number;
  /** Contanti sopra il dovuto = resto da rendere. Solo per i contanti: su un
   *  POS non si batte più del dovuto, e su un buono pasto il resto non esiste. */
  change: number;
  /** Quanto resterebbe scoperto chiudendo adesso. */
  shortfall: number;
  /** Il conto risulterà saldato. */
  willSettle: boolean;
}

/** Lo stato aritmetico della chiusura, dato il residuo, i movimenti già
 *  aggiunti e cosa c'è nel campo in questo momento. */
export const settleMath = (
  residualCents: number,
  movements: BillPaymentInput[],
  method: BillPaymentInput['method'],
  amountText: string,
): SettleMath => {
  const recorded = movements.reduce((n, m) => n + m.amount_cents, 0);
  const remaining = Math.max(0, residualCents - recorded);
  const amountCents = eurToCents(amountText);
  const applied = Math.min(amountCents, remaining);
  const change = method === 'CONTANTI' ? Math.max(0, amountCents - remaining) : 0;
  const shortfall = Math.max(0, remaining - applied);
  return { recorded, remaining, amountCents, applied, change, shortfall, willSettle: shortfall === 0 };
};

/** I movimenti da mandare al server: quelli aggiunti più l'importo ancora nel
 *  campo, che è un movimento non ancora confermato ma vale. */
export const settlePayments = (
  movements: BillPaymentInput[],
  method: BillPaymentInput['method'],
  applied: number,
): BillPaymentInput[] =>
  applied > 0 ? [...movements, { method, amount_cents: applied }] : [...movements];

/** Il campo importo dopo aver aggiunto un movimento: si precompila con quello
 *  che manca, così il percorso a un tap resta un tap. */
export const nextAmountText = (remainingAfter: number): string =>
  remainingAfter > 0 ? (remainingAfter / 100).toFixed(2) : '0';
