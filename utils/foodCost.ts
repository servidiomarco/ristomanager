// ============================================
// Food cost — il conto, uguale su server e client
// ============================================
// Funzioni pure, senza import: le usano le rotte (services/foodCostRoutes.ts),
// la pagina Food cost e il riquadro del banchetto, che ricalcola mentre si
// compone il menu. Un numero diverso fra server e schermo sarebbe peggio di
// nessun numero.
//
// Unità: il costo di un ingrediente è in centesimi al kg, al litro o al
// pezzo; le quantità della scheda sono nette, in g, ml o pezzi. La resa
// trasforma il netto in lordo da comprare (100 g di filetto di branzino al
// 48% di resa = 208 g di pesce intero). I conti restano in decimale e si
// arrotondano solo a schermo: 3 g di sale a 0,30 €/kg valgono 0,09
// centesimi, e cento righe arrotondate una per una farebbero un altro piatto.

export const UNITA_COSTO = ['kg', 'l', 'pz'] as const;
export type UnitaCosto = (typeof UNITA_COSTO)[number];

/** In che unità si scrive la quantità di una riga, data l'unità di costo. */
export const UNITA_QUANTITA: Record<UnitaCosto, 'g' | 'ml' | 'pz'> = { kg: 'g', l: 'ml', pz: 'pz' };

export const isUnitaCosto = (v: unknown): v is UnitaCosto =>
  typeof v === 'string' && (UNITA_COSTO as readonly string[]).includes(v);

/** Un ingrediente come lo vede il conto. Per un semilavorato costoCents è
 *  ignorato: il costo viene dalle sue righe diviso resaQuantita. */
export interface IngredienteFc {
  id: number;
  costoCents: number | null;
  unitaCosto: UnitaCosto | null;
  /** 1–100; null = 100 (nessuno scarto). */
  resaPct: number | null;
  isPreparazione: boolean;
  /** Quanti g, ml o pezzi rende la ricetta del semilavorato. */
  resaQuantita: number | null;
}

export interface RigaFc {
  productId: number;
  /** Netta, in g / ml / pz secondo l'unità di costo dell'ingrediente. */
  quantita: number;
}

export interface EsitoCosto {
  /** Somma delle righe calcolabili, in centesimi (decimali). null = nessuna riga. */
  cents: number | null;
  /** Ingredienti che mancano al conto: senza prezzo, senza unità, o
   *  semilavorati senza resa. Il totale c'è, ma è per difetto. */
  mancanti: number[];
}

/** Più livelli di così sono quasi certamente un errore di chi compila. */
export const PROFONDITA_MASSIMA = 6;

export class CicloRicettaError extends Error {
  constructor(public readonly productId: number) {
    super(`Il semilavorato ${productId} contiene sé stesso`);
    this.name = 'CicloRicettaError';
  }
}

export class RicettaTroppoProfondaError extends Error {
  constructor() {
    super(`Semilavorati annidati oltre ${PROFONDITA_MASSIMA} livelli`);
    this.name = 'RicettaTroppoProfondaError';
  }
}

const unisci = (a: number[], b: number[]): number[] => {
  if (b.length === 0) return a;
  const s = new Set(a);
  for (const x of b) s.add(x);
  return [...s];
};

const fattoreResa = (resaPct: number | null): number => {
  const r = resaPct == null ? 100 : Number(resaPct);
  if (!Number.isFinite(r) || r <= 0) return 1;
  return Math.min(r, 100) / 100;
};

/** Da g/ml/pz all'unità di costo (kg/l/pz). */
const inUnitaCosto = (quantita: number, unita: UnitaCosto): number => (unita === 'pz' ? quantita : quantita / 1000);

export interface CalcolatoreFc {
  /** Costo di un'unità (kg/l/pz) dell'ingrediente, semilavorati compresi. */
  costoUnitario: (productId: number) => { cents: number | null; mancanti: number[] };
  /** Costo di un insieme di righe (una scheda). */
  costoRighe: (righe: RigaFc[]) => EsitoCosto;
  /** Costo di una riga sola, per la colonna dell'editor. null = non calcolabile. */
  costoRiga: (riga: RigaFc) => number | null;
}

/**
 * Il calcolatore di un ristorante: tutti gli ingredienti e le righe di tutti
 * i semilavorati, una volta sola. I semilavorati si risolvono a richiesta e
 * restano in memoria per la durata del calcolatore.
 *
 * Lancia CicloRicettaError se un semilavorato finisce per contenere sé
 * stesso: il salvataggio lo impedisce, ma un dato sporco non deve mandare
 * in loop una pagina.
 */
export function creaCalcolatore(
  ingredienti: Map<number, IngredienteFc>,
  righePreparazioni: Map<number, RigaFc[]>,
): CalcolatoreFc {
  const memo = new Map<number, { cents: number | null; mancanti: number[] }>();

  const unitario = (productId: number, pila: number[]): { cents: number | null; mancanti: number[] } => {
    const cached = memo.get(productId);
    if (cached) return cached;
    const ing = ingredienti.get(productId);
    if (!ing || !ing.unitaCosto) return { cents: null, mancanti: [productId] };
    if (!ing.isPreparazione) {
      const esito = ing.costoCents == null
        ? { cents: null, mancanti: [productId] }
        : { cents: Number(ing.costoCents), mancanti: [] };
      memo.set(productId, esito);
      return esito;
    }
    if (pila.includes(productId)) throw new CicloRicettaError(productId);
    if (pila.length >= PROFONDITA_MASSIMA) throw new RicettaTroppoProfondaError();
    const righe = righePreparazioni.get(productId) ?? [];
    const somma = righeConPila(righe, [...pila, productId]);
    const resa = ing.resaQuantita == null ? 0 : Number(ing.resaQuantita);
    let esito: { cents: number | null; mancanti: number[] };
    if (somma.cents == null || !(resa > 0)) {
      // Senza righe o senza resa non c'è un costo al kg: il semilavorato
      // stesso è il pezzo mancante, insieme a quelli delle sue righe.
      esito = { cents: null, mancanti: unisci([productId], somma.mancanti) };
    } else {
      // resaQuantita è in g/ml/pz: il costo per kg/l/pz è somma ÷ resa × 1000.
      esito = { cents: somma.cents / inUnitaCosto(resa, ing.unitaCosto), mancanti: somma.mancanti };
    }
    memo.set(productId, esito);
    return esito;
  };

  const rigaConPila = (riga: RigaFc, pila: number[]): { cents: number | null; mancanti: number[] } => {
    const ing = ingredienti.get(riga.productId);
    const q = Number(riga.quantita);
    if (!ing || !ing.unitaCosto || !Number.isFinite(q) || q <= 0) return { cents: null, mancanti: [riga.productId] };
    const u = unitario(riga.productId, pila);
    if (u.cents == null) return u;
    const lordo = inUnitaCosto(q, ing.unitaCosto) / fattoreResa(ing.resaPct);
    return { cents: lordo * u.cents, mancanti: u.mancanti };
  };

  const righeConPila = (righe: RigaFc[], pila: number[]): EsitoCosto => {
    if (righe.length === 0) return { cents: null, mancanti: [] };
    let cents = 0;
    let mancanti: number[] = [];
    for (const r of righe) {
      const c = rigaConPila(r, pila);
      if (c.cents != null) cents += c.cents;
      mancanti = unisci(mancanti, c.mancanti);
    }
    return { cents, mancanti };
  };

  return {
    costoUnitario: (productId) => unitario(productId, []),
    costoRighe: (righe) => righeConPila(righe, []),
    costoRiga: (riga) => rigaConPila(riga, []).cents,
  };
}

/** I semilavorati che il semilavorato `productId` raggiunge con le righe
 *  date: se fra questi c'è lui stesso, salvare creerebbe un ciclo. */
export function creaCiclo(
  productId: number,
  nuoveRighe: RigaFc[],
  righePreparazioni: Map<number, RigaFc[]>,
): boolean {
  const visti = new Set<number>();
  const coda = nuoveRighe.map(r => r.productId);
  while (coda.length > 0) {
    const id = coda.pop()!;
    if (id === productId) return true;
    if (visti.has(id)) continue;
    visti.add(id);
    for (const r of righePreparazioni.get(id) ?? []) coda.push(r.productId);
  }
  return false;
}

// ---- Il piatto -----------------------------------------------------------------

export type StatoCosto = 'completo' | 'incompleto' | 'senza_scheda';

export interface CostoPiatto {
  /** Costo di una porzione (per i piatti al peso: di un kg venduto). */
  cents: number | null;
  stato: StatoCosto;
  mancanti: number[];
  /** Il costo viene dal campo a mano, non da una ricetta. */
  manuale: boolean;
}

export function costoPiatto(
  calc: CalcolatoreFc,
  righe: RigaFc[],
  porzioni: number | null,
  costoManualeCents: number | null,
): CostoPiatto {
  if (righe.length > 0) {
    const esito = calc.costoRighe(righe);
    const p = porzioni != null && Number(porzioni) >= 1 ? Number(porzioni) : 1;
    return {
      cents: esito.cents == null ? null : esito.cents / p,
      stato: esito.mancanti.length > 0 ? 'incompleto' : 'completo',
      mancanti: esito.mancanti,
      manuale: false,
    };
  }
  if (costoManualeCents != null && Number.isFinite(Number(costoManualeCents))) {
    return { cents: Number(costoManualeCents), stato: 'completo', mancanti: [], manuale: true };
  }
  return { cents: null, stato: 'senza_scheda', mancanti: [], manuale: false };
}

/** Prezzo di carta (IVA compresa, in euro) → netto in centesimi. Il food
 *  cost si misura sul netto: l'IVA non è un ricavo del ristorante. */
export const prezzoNettoCents = (prezzoLordoEuro: number, ivaPct: number): number =>
  (Number(prezzoLordoEuro) * 100) / (1 + (Number(ivaPct) || 0) / 100);

export function foodCostPct(costoCents: number | null, prezzoLordoEuro: number, ivaPct: number): number | null {
  if (costoCents == null) return null;
  const netto = prezzoNettoCents(prezzoLordoEuro, ivaPct);
  if (!(netto > 0)) return null;
  return (costoCents / netto) * 100;
}

export function margineCents(costoCents: number | null, prezzoLordoEuro: number, ivaPct: number): number | null {
  if (costoCents == null) return null;
  return prezzoNettoCents(prezzoLordoEuro, ivaPct) - costoCents;
}

/** Il prezzo di carta (IVA compresa, euro) che porta il food cost al target. */
export function prezzoConsigliatoEuro(costoCents: number | null, targetPct: number, ivaPct: number): number | null {
  if (costoCents == null || !(targetPct > 0)) return null;
  const nettoCents = costoCents / (targetPct / 100);
  return (nettoCents / 100) * (1 + (Number(ivaPct) || 0) / 100);
}

export type Semaforo = 'ok' | 'attenzione' | 'alto';

/** Entro il target va bene; fino a cinque punti sopra è da guardare. */
export function semaforo(pct: number | null, targetPct: number): Semaforo | null {
  if (pct == null) return null;
  if (pct <= targetPct) return 'ok';
  if (pct <= targetPct + 5) return 'attenzione';
  return 'alto';
}

// ---- Il banchetto --------------------------------------------------------------

export interface CorsoFc {
  dish_ids: number[];
  /** Quota di porzione per piatto (chiave = id del piatto): 1 = porzione
   *  intera, 0,5 = mezza (i piatti condivisi degli antipasti misti). */
  quote?: Record<string, number>;
}

/** La quota di un piatto in un'uscita: assente = 1, sempre fra 0 e 5. */
export const quotaPorzione = (corso: CorsoFc, dishId: number): number => {
  const q = corso.quote?.[String(dishId)];
  if (q == null || !Number.isFinite(Number(q))) return 1;
  return Math.min(5, Math.max(0, Number(q)));
};

export interface BanchettoFcInput {
  courses: CorsoFc[];
  costoPiatto: (dishId: number) => CostoPiatto | undefined;
  /** Ospiti totali, bambini compresi (come nel banchetto). */
  guests: number;
  children: number;
  pricePerPerson: number;
  /** null = i bambini pagano come gli adulti. */
  childrenPrice: number | null;
  discountType: 'PERCENT' | 'AMOUNT' | null;
  discountValue: number | null;
  ivaPct: number;
  /** Quanto costa il piatto di un bambino rispetto a quello di un adulto. */
  quotaBambiniPct: number;
  targetPct: number;
}

export interface BanchettoFc {
  costoAdultoCents: number;
  costoBambinoCents: number;
  /** Piatti senza scheda né costo a mano: il costo per coperto è per difetto. */
  piattiSenzaCosto: number[];
  /** Piatti con la scheda ma qualche ingrediente senza prezzo. */
  piattiIncompleti: number[];
  costoTotaleCents: number;
  /** Ricavo dopo lo sconto, IVA esclusa. */
  ricavoNettoCents: number;
  foodCostPct: number | null;
  margineTotaleCents: number;
  /** Prezzo adulto netto (sconto spalmato) meno il costo adulto. */
  margineAdultoCents: number | null;
  /** Prezzo adulto, IVA compresa, che porta il food cost al target. */
  prezzoConsigliatoAdulto: number | null;
}

/** Lo sconto del banchetto, con la stessa regola del form (MenuManager):
 *  percentuale o importo, mai oltre il lordo. */
export function scontoBanchetto(lordo: number, tipo: 'PERCENT' | 'AMOUNT' | null, valore: number | null): number {
  if (!tipo || valore == null) return 0;
  const v = Number(valore);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (tipo === 'PERCENT') return Math.min(lordo, lordo * (v / 100));
  return Math.min(lordo, v);
}

export function calcolaBanchetto(input: BanchettoFcInput): BanchettoFc {
  let costoAdulto = 0;
  const senza = new Set<number>();
  const incompleti = new Set<number>();
  for (const corso of input.courses) {
    for (const dishId of corso.dish_ids ?? []) {
      const c = input.costoPiatto(dishId);
      if (!c || c.cents == null) {
        senza.add(dishId);
        continue;
      }
      if (c.stato === 'incompleto') incompleti.add(dishId);
      costoAdulto += c.cents * quotaPorzione(corso, dishId);
    }
  }
  const quotaBambini = Math.min(100, Math.max(0, Number(input.quotaBambiniPct) || 0)) / 100;
  const costoBambino = costoAdulto * quotaBambini;

  const guests = Math.max(0, Number(input.guests) || 0);
  const children = Math.min(guests, Math.max(0, Number(input.children) || 0));
  const adults = guests - children;
  const prezzoAdulto = Number(input.pricePerPerson) || 0;
  const prezzoBambino = input.childrenPrice != null ? Number(input.childrenPrice) || 0 : prezzoAdulto;

  const lordo = adults * prezzoAdulto + children * prezzoBambino;
  const sconto = scontoBanchetto(lordo, input.discountType, input.discountValue);
  const divisoreIva = 1 + (Number(input.ivaPct) || 0) / 100;
  const ricavoNettoCents = ((lordo - sconto) * 100) / divisoreIva;
  const costoTotaleCents = adults * costoAdulto + children * costoBambino;

  // Lo sconto si spalma sul prezzo per coperto: il margine di un adulto è
  // quello che il banchetto incassa davvero per lui.
  const quotaPagata = lordo > 0 ? (lordo - sconto) / lordo : 1;
  const adultoNettoCents = (prezzoAdulto * quotaPagata * 100) / divisoreIva;

  return {
    costoAdultoCents: costoAdulto,
    costoBambinoCents: costoBambino,
    piattiSenzaCosto: [...senza],
    piattiIncompleti: [...incompleti],
    costoTotaleCents,
    ricavoNettoCents,
    foodCostPct: ricavoNettoCents > 0 ? (costoTotaleCents / ricavoNettoCents) * 100 : null,
    margineTotaleCents: ricavoNettoCents - costoTotaleCents,
    margineAdultoCents: prezzoAdulto > 0 ? adultoNettoCents - costoAdulto : null,
    prezzoConsigliatoAdulto: costoAdulto > 0 ? prezzoConsigliatoEuro(costoAdulto, input.targetPct, input.ivaPct) : null,
  };
}

// ---- A schermo -----------------------------------------------------------------

export const formatPct = (pct: number | null | undefined): string => {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${pct.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`;
};
