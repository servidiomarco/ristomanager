import type { CourseStatus, Dish, OrderItem, OrderWithItems } from '../../types';
import type { PillTone } from '../ds';

// ---------------------------------------------------------------------------
// La comanda, letta. Nessuna chiamata di rete e nessun JSX: quello che sta qui
// è il modo in cui la sala legge un ordine — per uscita, per piatto, per
// quanto manca da mandare — e va bene identico sul palmare e sul desktop.
// ---------------------------------------------------------------------------

export const euro = (cents: number): string =>
  (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

/** Le uscite sono sei. Non è un limite tecnico: è quante ne regge un servizio
 *  prima che il passe smetta di leggerle. */
export const MAX_COURSES = 6;

const ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];
export const ordinal = (n: number): string => ORDINALS[n] ?? `${n}ª`;
export const courseLabel = (n: number): string => `${ordinal(n)} uscita`;

export interface CartLine {
  key: string;
  /** Chiave di idempotenza della riga, assegnata quando la riga nasce nel
   *  carrello e stabile attraverso merge, ritocchi di quantità e ritentativi.
   *  Generarla al momento dell'invio vanificherebbe la dedup del server: un
   *  retry dopo un timeout porterebbe una chiave nuova e duplicherebbe la
   *  riga in cucina. */
  idem: string;
  dish: Dish;
  qty: number;
  course_no: number;
  modifier_ids: number[];
  /** Varianti firmate alla Passepartout: n>0 aggiunge (n volte, addebito),
   *  n<0 toglie (sconto). Assente = battitura storica (tutto a +1). Le
   *  etichette e il delta qui sopra sono GIÀ cotti col verso e le
   *  ripetizioni: chi mostra la riga non deve sapere la regola. */
  modifiers?: { id: number; n: number }[];
  /** Ingredienti tolti da un piatto composto. Etichette («Senza X») e sconto
   *  sono GIÀ cotti in modifier_labels/delta come per le varianti: chi
   *  mostra la riga non deve sapere cosa sono. */
  removed_component_ids?: number[];
  modifier_labels: string[];
  modifier_delta_cents: number;
  note?: string;
  /** Vendita al peso: grammi del pezzo. Il prezzo del piatto è AL KG e la
   *  riga vale peso × prezzo/kg; qty resta 1 — ogni taglio pesa diverso. */
  weight_grams?: number;
}

/** La chiave che fa collassare due tocchi sullo stesso piatto in una riga da
 *  due. Stesso piatto ma varianti diverse restano righe distinte: in cucina
 *  «al sangue» e «ben cotta» sono due piatti. La variante libera entra in
 *  chiave per lo stesso motivo: due note diverse sono due piatti diversi. */
export const cartKey = (dishId: number, courseNo: number, modifierParts: (number | string)[], note?: string): string =>
  `${dishId}|${courseNo}|${[...modifierParts].map(String).sort().join(',')}|${(note ?? '').trim().toLowerCase()}`;

/** «550 g» sotto il chilo, «1,2 kg» sopra: il peso come lo dice la cucina. */
export const weightLabel = (grams: number): string =>
  grams >= 1000
    ? `${(grams / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 })} kg`
    : `${grams} g`;

export const cartUnitCents = (l: CartLine): number =>
  (l.weight_grams != null
    ? Math.round(Math.round(Number(l.dish.price) * 100) * l.weight_grams / 1000)
    : Math.round(Number(l.dish.price) * 100)) + l.modifier_delta_cents;

export const cartSum = (lines: CartLine[]): number =>
  lines.reduce((s, l) => s + cartUnitCents(l) * l.qty, 0);

export const cartForCourse = (lines: CartLine[], courseNo: number): CartLine[] =>
  lines.filter(l => l.course_no === courseNo);

/** Coperto e servizio pesano sul conto ma non sono piatti: non si mandano in
 *  cucina, non si stornano, non si ripetono. */
export const isSystemLine = (i: OrderItem): boolean =>
  i.line_kind === 'COVER' || i.line_kind === 'SERVICE';

/** Le righe di un'uscita già arrivate al server — bozze persistite comprese,
 *  che restano lì quando l'invio fallisce a metà. */
export const itemsForCourse = (order: OrderWithItems, courseNo: number): OrderItem[] =>
  order.items.filter(i => i.course_no === courseNo && !isSystemLine(i));

/** «3 righe» conta i piatti, non le linee: due Antipasto ELITE sono due righe,
 *  perché due arrivano al tavolo. */
export const rowCount = (order: OrderWithItems, cart: CartLine[]): number =>
  order.items.reduce(
    (s, i) => s + (isSystemLine(i) || i.status === 'VOIDED' ? 0 : i.qty), 0
  ) + cart.reduce((s, l) => s + l.qty, 0);

export const rowCountLabel = (n: number): string =>
  n === 0 ? 'nessuna riga' : n === 1 ? '1 riga' : `${n} righe`;

// Etichetta parlante per lo stato dell'uscita. Il cameriere deve sapere a
// colpo d'occhio se la sua seconda uscita è partita o è ferma al passe:
// altrimenti la ripropone, e in cucina arriva doppia.
//
// I toni sono quelli del design system, e ci cascano dentro senza forzature:
// al passe qualcuno deve agire (pending), in cucina è informativo (arriving),
// pronta è servizio vivo (seated), servita non è più uno stato (neutral).
export const COURSE_BADGE: Record<CourseStatus, { text: string; tone: PillTone }> = {
  PENDING: { text: 'in bozza',  tone: 'neutral' },
  QUEUED:  { text: 'al passe',  tone: 'pending' },
  FIRED:   { text: 'in cucina', tone: 'info' },
  READY:   { text: 'pronta',    tone: 'positive' },
  SERVED:  { text: 'servita',   tone: 'neutral' },
};

/** Lo stato di un'uscita ai fini della lettura: `courses` arriva dal server e
 *  copre solo le uscite che esistono già. */
export const courseStatus = (order: OrderWithItems, courseNo: number): CourseStatus =>
  order.courses.find(c => c.course_no === courseNo)?.status ?? 'PENDING';

export const isSent = (status: CourseStatus): boolean => status !== 'PENDING';

/* ── Cosa ha ordinato il tavolo ───────────────────────────────────────────
   Le uscite dicono in che ordine escono i piatti; questa vista dice cosa il
   tavolo ha davvero chiesto, sommato attraverso le uscite. È la lettura che
   serve per ripetere un giro: «altri tre antipasti» non è un'uscita, è un
   piatto già ordinato due volte che ne vuole una terza. */
export interface RepeatLine {
  key: string;
  /** null se il piatto non è più a menu: la riga si legge ma non si ripete. */
  dish: Dish | null;
  name: string;
  category: string | null;
  /** Prezzo del singolo, varianti comprese. */
  unit_cents: number;
  qty: number;
  /** Le uscite in cui compare, in ordine. */
  courses: number[];
  modifier_ids: number[];
  /** Varianti firmate della riga d'origine: la ripetizione le riporta
   *  identiche («++ prosciutto» resta «++ prosciutto»). */
  modifiers: { id: number; n: number }[];
  /** Ingredienti tolti della riga d'origine («Senza X»): anche loro si
   *  ripetono identici. */
  removed_component_ids: number[];
  modifier_labels: string[];
  modifier_delta_cents: number;
}

export const repeatLines = (
  order: OrderWithItems, cart: CartLine[], dishes: Dish[],
): RepeatLine[] => {
  const byKey = new Map<string, RepeatLine>();

  const push = (
    dishId: number | null, name: string, unitCents: number, qty: number, courseNo: number,
    modifierEntries: { id: number; n: number }[], modifierLabels: string[], modifierDelta: number,
    removedIds: number[] = [],
  ) => {
    // Il verso e le ripetizioni entrano in chiave: «++ prosciutto» e
    // «- prosciutto» non collassano nella stessa riga. Gli ingredienti tolti
    // idem: «senza cipolla» e il piatto intero sono due righe.
    const key = `${dishId ?? name}|${modifierEntries.map(e => `${e.id}x${e.n}`).sort().join(',')}|${[...removedIds].sort().join(',')}`;
    const at = byKey.get(key);
    if (at) {
      at.qty += qty;
      if (!at.courses.includes(courseNo)) at.courses.push(courseNo);
      return;
    }
    const dish = dishId != null ? dishes.find(d => d.id === dishId) ?? null : null;
    byKey.set(key, {
      key, dish, name,
      category: dish?.category ?? null,
      unit_cents: unitCents + modifierDelta,
      qty, courses: [courseNo],
      modifier_ids: modifierEntries.map(e => e.id),
      modifiers: modifierEntries,
      removed_component_ids: removedIds,
      modifier_labels: modifierLabels,
      modifier_delta_cents: modifierDelta,
    });
  };

  for (const i of order.items) {
    if (isSystemLine(i) || i.status === 'VOIDED') continue;
    const mods = i.modifiers ?? [];
    push(
      i.dish_id, i.name_snapshot, i.unit_price_cents, i.qty, i.course_no,
      // Lo snapshot porta sempre l'id del modificatore (lo scrive il server
      // alla creazione della riga), quindi ripetere una variante la ripete
      // davvero invece di perderla per strada — verso e ripetizioni compresi.
      mods.filter(m => m.id != null).map(m => ({ id: m.id as number, n: m.n ?? 1 })),
      mods.map(m => m.name),
      mods.reduce((s, m) => s + m.price_delta_cents, 0),
      // I «Senza X» viaggiano nello snapshot con component_id: senza questo
      // la ripetizione perderebbe la rimozione per strada.
      mods.filter(m => m.component_id != null).map(m => m.component_id as number),
    );
  }
  for (const l of cart) {
    push(
      l.dish.id, l.dish.name, Math.round(Number(l.dish.price) * 100), l.qty, l.course_no,
      l.modifiers ?? l.modifier_ids.map(id => ({ id, n: 1 })),
      l.modifier_labels, l.modifier_delta_cents,
      l.removed_component_ids ?? [],
    );
  }

  const out = [...byKey.values()];
  for (const l of out) l.courses.sort((a, b) => a - b);
  return out;
};

export const repeatTotal = (lines: RepeatLine[]): number =>
  lines.reduce((s, l) => s + l.unit_cents * l.qty, 0);

export const repeatQty = (lines: RepeatLine[]): number =>
  lines.reduce((s, l) => s + l.qty, 0);

/** Raggruppa per categoria nell'ordine del menu, non alfabetico: il cameriere
 *  cerca gli antipasti dove stanno gli antipasti. */
export const groupByCategory = (
  lines: RepeatLine[], categories: string[],
): { category: string; lines: RepeatLine[] }[] => {
  const order = new Map(categories.map((c, i) => [c, i]));
  const buckets = new Map<string, RepeatLine[]>();
  for (const l of lines) {
    const c = l.category ?? 'Altro';
    const at = buckets.get(c);
    if (at) at.push(l); else buckets.set(c, [l]);
  }
  return [...buckets.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
    .map(([category, ls]) => ({ category, lines: ls }));
};

/* ── Bozza locale del carrello ────────────────────────────────────────────
   Le righe non inviate vivono solo sul palmare (il modello è «una sola
   trasmissione»): uscire dal tavolo le buttava via. La bozza le parcheggia
   in localStorage per comanda e la riapertura le ripresenta; si svuota da
   sola con l'invio (il carrello si riduce e la si riscrive) e si scarta
   alla chiusura della comanda. Il piatto si risolve di nuovo dall'anagrafica
   al ripristino: una riga di un piatto disattivato nel frattempo cade. */

const CART_DRAFT_PREFIX = 'comande.bozza.';
const CART_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type CartDraftLine = Omit<CartLine, 'dish'> & { dish_id: number };

export const saveCartDraft = (orderId: number, cart: CartLine[]): void => {
  try {
    const key = CART_DRAFT_PREFIX + orderId;
    if (cart.length === 0) { localStorage.removeItem(key); return; }
    const lines: CartDraftLine[] = cart.map(({ dish, ...rest }) => ({ ...rest, dish_id: dish.id }));
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), lines }));
  } catch { /* storage pieno o negato: la bozza è un di più */ }
};

export const restoreCartDraft = (orderId: number, dishes: Dish[]): CartLine[] => {
  try {
    // Pulizia contestuale: le bozze di comande di ieri non servono a nessuno.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CART_DRAFT_PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? '');
        if (!parsed?.savedAt || Date.now() - parsed.savedAt > CART_DRAFT_TTL_MS) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
    const raw = localStorage.getItem(CART_DRAFT_PREFIX + orderId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.lines)) return [];
    const byId = new Map(dishes.map(d => [d.id, d]));
    return parsed.lines.flatMap((l: CartDraftLine) => {
      const dish = byId.get(l.dish_id);
      if (!dish) return [];
      const { dish_id, ...rest } = l;
      return [{ ...rest, dish }];
    });
  } catch {
    return [];
  }
};

export const dropCartDraft = (orderId: number): void => {
  try { localStorage.removeItem(CART_DRAFT_PREFIX + orderId); } catch { /* niente */ }
};

