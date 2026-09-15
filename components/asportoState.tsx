import React from 'react';
import { TakeawayOrder, TakeawayStatus } from '../types';
import { PulseDot } from './reservationState';

/* ===========================================================================
   Stato asporto — fonte unica, sul calco di reservationState.

   Due strati, come per le prenotazioni:

   1. Stato enum — quello persistito (`getAsportoState`).
   2. Stato a orologio — l'enum arricchito dal tempo
      (`getTimedAsportoState`): un ordine confermato entra da solo in
      «Da produrre» quando ora di ritiro − minuti di preparazione è
      passata, un «Pronto» oltre l'ora di ritiro diventa «Ritiro in
      ritardo». Avanzano da soli durante il servizio; il banco muove solo
      gli stati veri (produzione, pronto, ritirato).

   Tutta la vita dell'ordine ruota attorno all'ora di ritiro: la cucina
   cucina a ritroso da lì, non da quando l'ordine è entrato.
   ========================================================================= */

export type AsportoStateKey =
  | 'requested'  // Da confermare (canali pubblici, fasi successive)
  | 'confirmed'  // Confermato, non ancora da produrre
  | 'due'        // Da produrre — derivato dal tempo, non impostabile a mano
  | 'preparing'  // In preparazione (comanda in cucina)
  | 'ready'      // Pronto al banco
  | 'late'       // Ritiro in ritardo — derivato dal tempo
  | 'picked'     // Ritirato
  | 'noshow'     // Non ritirato
  | 'cancelled';

/** Minuti oltre l'ora di ritiro dopo i quali un «Pronto» legge come
 *  «Ritiro in ritardo» — il momento di chiamare il cliente. */
export const LATE_PICKUP_MIN = 15;

const STATUS_TO_STATE: Record<TakeawayStatus, AsportoStateKey> = {
  REQUESTED: 'requested',
  CONFIRMED: 'confirmed',
  IN_PREPARATION: 'preparing',
  READY: 'ready',
  PICKED_UP: 'picked',
  NO_SHOW: 'noshow',
  CANCELLED: 'cancelled',
};

/** Stato enum, senza orologio. */
export const getAsportoState = (order: TakeawayOrder): AsportoStateKey =>
  STATUS_TO_STATE[order.status] ?? 'confirmed';

/** L'istante di ritiro. pickup_date + pickup_time sono ora di parete
 *  italiana e i dispositivi del ristorante stanno in Italia: il parse
 *  locale è quello giusto (niente conversioni UTC che sposterebbero
 *  l'orario). */
export const pickupInstant = (order: TakeawayOrder): number =>
  new Date(`${order.pickup_date}T${order.pickup_time}:00`).getTime();

/** Il momento in cui la produzione deve partire per arrivare puntuale. */
export const dueInstant = (order: TakeawayOrder, prepMinutes: number): number =>
  pickupInstant(order) - prepMinutes * 60_000;

/** Stato enum + orologio. `now` da `useNow()` così la board si ri-deriva
 *  da sola; `prepMinutes` da /takeaway/config. */
export const getTimedAsportoState = (order: TakeawayOrder, now: number, prepMinutes: number): AsportoStateKey => {
  const base = getAsportoState(order);
  const pickup = pickupInstant(order);
  if (!Number.isFinite(pickup)) return base;
  if (base === 'confirmed' && now >= pickup - prepMinutes * 60_000) return 'due';
  if (base === 'ready' && now >= pickup + LATE_PICKUP_MIN * 60_000) return 'late';
  return base;
};

/* ---------------------------------------------------------------------------
   Meta visiva — l'unico posto dove uno stato prende un colore.
   Stesse cinque famiglie del design system: pending = serve un'azione
   (confermare, produrre, chiamare chi non ritira), arriving = promesso e in
   regola, seated = in lavorazione o pronto (il verde «c'è»), critical =
   finito male, neutral = archivio. Dove due stati condividono la famiglia
   è l'etichetta a portare la differenza, come da §3.
   ------------------------------------------------------------------------- */

export interface AsportoStateMeta {
  label: string;
  /** Il pallino pulsa — riservato agli stati che chiedono un'azione ADESSO. */
  pulse?: boolean;
  /** Disegnato pieno invece che a tinta: il sacchetto sul banco pesa di
   *  più a colpo d'occhio (stessa eccezione di 'arriving' in Reception). */
  solid?: boolean;
}

export const ASPORTO_STATE_META: Record<AsportoStateKey, AsportoStateMeta> = {
  requested: { label: 'Da confermare' },
  confirmed: { label: 'Confermato' },
  due:       { label: 'Da produrre', pulse: true },
  preparing: { label: 'In preparazione' },
  ready:     { label: 'Pronto', solid: true },
  late:      { label: 'Ritiro in ritardo', pulse: true },
  picked:    { label: 'Ritirato' },
  noshow:    { label: 'Non ritirato' },
  cancelled: { label: 'Annullato' },
};

export type AsportoStateFamily = 'pending' | 'arriving' | 'seated' | 'critical' | 'neutral';

export const ASPORTO_STATE_FAMILY: Record<AsportoStateKey, AsportoStateFamily> = {
  requested: 'pending',
  confirmed: 'arriving',
  due:       'pending',
  preparing: 'seated',
  ready:     'seated',
  late:      'pending',
  picked:    'neutral',
  noshow:    'critical',
  cancelled: 'critical',
};

interface FamilyClasses {
  tint: string;
  text: string;
  solid: string;
  /** Testo provato sul riempimento pieno (per gli stati `solid`). */
  fg: string;
  /** Il pallino sul riempimento pieno — letterale per branch, mai
   *  costruito: Tailwind estrae le classi staticamente. */
  dotOnSolid: string;
}

const FAMILY_CLASSES: Record<AsportoStateFamily, FamilyClasses> = {
  pending:  { tint: 'bg-[var(--ds-pending-tint)]',  text: 'text-[var(--ds-pending-text)]',   solid: 'bg-[var(--ds-pending-solid)]',  fg: 'text-[var(--ds-pending-fg)]',  dotOnSolid: 'bg-[var(--ds-pending-fg)]' },
  arriving: { tint: 'bg-[var(--ds-arriving-tint)]', text: 'text-[var(--ds-arriving-text)]',  solid: 'bg-[var(--ds-arriving-solid)]', fg: 'text-[var(--ds-arriving-fg)]', dotOnSolid: 'bg-[var(--ds-arriving-fg)]' },
  seated:   { tint: 'bg-[var(--ds-seated-tint)]',   text: 'text-[var(--ds-seated-text)]',    solid: 'bg-[var(--ds-seated-solid)]',   fg: 'text-[var(--ds-seated-fg)]',   dotOnSolid: 'bg-[var(--ds-seated-fg)]' },
  critical: { tint: 'bg-[var(--ds-critical-tint)]', text: 'text-[var(--ds-critical-text)]',  solid: 'bg-[var(--ds-critical-solid)]', fg: 'text-[var(--ds-critical-fg)]', dotOnSolid: 'bg-[var(--ds-critical-fg)]' },
  neutral:  { tint: 'bg-[var(--ds-surface-row)]',   text: 'text-[var(--ds-text-secondary)]', solid: 'bg-[var(--ds-text-muted)]',     fg: 'text-white',                   dotOnSolid: 'bg-white' },
};

/** Classi tint/text/solid di uno stato, in token del design system. */
export const asportoStateDs = (state: AsportoStateKey): FamilyClasses =>
  FAMILY_CLASSES[ASPORTO_STATE_FAMILY[state]];

/** La pillola di stato di un ordine d'asporto — stessa grammatica del
 *  DsStatusChip delle prenotazioni. */
export const AsportoStatusChip: React.FC<{
  state: AsportoStateKey;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  trailing?: React.ReactNode;
  className?: string;
}> = ({ state, onClick, title, trailing, className = '' }) => {
  const meta = ASPORTO_STATE_META[state];
  const ds = asportoStateDs(state);
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={`inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium ${
        meta.solid ? `${ds.solid} ${ds.fg}` : `${ds.tint} ${ds.text}`
      } ${
        onClick ? 'transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]' : ''
      } ${className}`}
    >
      <PulseDot dotClass={meta.solid ? ds.dotOnSolid : ds.solid} pulse={meta.pulse} />
      {meta.label}
      {trailing}
    </Tag>
  );
};

/** Gli stati che il banco imposta a mano ('due' e 'late' sono a orologio). */
export const SETTABLE_ASPORTO_STATES: AsportoStateKey[] =
  ['requested', 'confirmed', 'preparing', 'ready', 'picked', 'noshow', 'cancelled'];

/** Lo status persistito che porta un ordine nello stato `state`. */
export const asportoStatusFor = (state: Exclude<AsportoStateKey, 'due' | 'late'>): TakeawayStatus => {
  switch (state) {
    case 'requested': return 'REQUESTED';
    case 'confirmed': return 'CONFIRMED';
    case 'preparing': return 'IN_PREPARATION';
    case 'ready':     return 'READY';
    case 'picked':    return 'PICKED_UP';
    case 'noshow':    return 'NO_SHOW';
    case 'cancelled': return 'CANCELLED';
  }
};
