import type { StaffOnShift } from '../types';

/* I camerieri della Sala dal vivo: chi sono, in quale sala stanno, quale
 * tavolo vanno a servire. Solo le regole, pure: il regista (director.ts) li
 * fa camminare, e qui non si sa niente di percorsi e frame.
 *
 * Sono le persone di turno della pagina Personale (GET /staff/presence, la
 * lista sala del servizio): chi ha un ruolo da accoglienza dà il nome
 * all'hostess della sala principale, gli altri girano fra il pass e i tavoli.
 * Il caso (quale tavolo fra quelli già visitati) arriva da fuori, col seme
 * del cameriere: due schermi dello stesso ristorante girano uguali. */

/** Il ruolo di chi accoglie («Hostess», «Accoglienza», «Maître»): il primo
 *  di turno con questo ruolo dà il nome all'hostess della sala principale e
 *  non gira coi vassoi. */
export const HOSTESS_ROLE = /host|accoglien|ma[iî]tre/i;

/** Un cameriere da mettere in sala: la chiave della figura e il nome sopra
 *  la testa (null per i camerieri di ripiego, senza nome). */
export interface WaiterSeed {
  /** waiter:<id del personale>, o waiter:anon<n> senza nomi. */
  key: string;
  label: string | null;
}

/** Il giro di un cameriere: fermo al pass, verso un tavolo, al tavolo col
 *  vassoio, di nuovo al pass, la posa del vassoio; e le dissolvenze di chi
 *  cambia sala o finisce il turno. */
export type WaiterState = 'AT_PASS' | 'TO_TABLE' | 'SERVE' | 'TO_PASS' | 'PAUSE' | 'FADE_OUT' | 'FADE_IN';

/** Il candidato a una visita: una comitiva a tavola nella sala del cameriere. */
export interface VisitCandidate {
  partyId: number;
  /** Quante volte un cameriere ci è già passato: 0 = appena seduta. */
  visits: number;
  /** Quando si è seduta, sul tempo del regista (ms). */
  seatedAt: number;
  /** L'ultima visita, sul tempo del regista (ms). */
  lastVisitAt: number;
}

// Un nome sopra una figura alta 1,7 m resta leggibile fino a una quindicina
// di lettere: oltre copre il cameriere accanto.
const LABEL_MAX = 16;
// Quanti camerieri di ripiego, senza nomi: due se c'è qualcuno a tavola (una
// sala piena con un cameriere solo sembra abbandonata), se no uno.
const FALLBACK_BUSY = 2;
const FALLBACK_IDLE = 1;
// Il peso minimo di un tavolo appena visitato nell'estrazione: senza, un
// tavolo visitato un attimo fa avrebbe peso zero, e due soli tavoli
// alternerebbero sempre uguale.
const MIN_WEIGHT_MS = 1000;

/** Il nome sopra la figura: name così com'è (è già il nome di battesimo, il
 *  cognome sta a parte), spazi compressi, al più 16 code point. Un nome
 *  composto («Anna Maria») resta intero se ci sta: tagliarlo al primo spazio
 *  lo cambierebbe. */
export function staffLabel(name: string): string {
  const s = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  // Per code point e non per unità UTF-16: una lettera fuori dal piano base
  // non va spezzata a metà.
  const points = Array.from(s);
  return points.length > LABEL_MAX ? points.slice(0, LABEL_MAX).join('').trimEnd() : s;
}

// L'id di una riga del personale come stringa, '' se non si legge: la riga
// arriva da un hook che legge in difesa, ma il tipo non basta a fidarsi.
const idOf = (row: StaffOnShift): string => {
  const raw: unknown = row?.id;
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
};

const isHostessRole = (role: unknown): boolean => typeof role === 'string' && HOSTESS_ROLE.test(role);

/** Il nome dell'hostess della sala principale: il primo di turno con un
 *  ruolo da accoglienza e un nome leggibile. null: nessuno (o il personale
 *  non è ancora letto), e l'hostess resta senza nome. */
export function hostessName(staff: readonly StaffOnShift[] | null | undefined): string | null {
  if (!Array.isArray(staff)) return null;
  for (const row of staff) {
    if (!row || typeof row !== 'object' || !isHostessRole(row.role)) continue;
    if (!idOf(row)) continue;
    const label = staffLabel(row.name);
    if (label) return label;
  }
  return null;
}

/** L'hostess (il primo con un ruolo da accoglienza, il suo nome) e i
 *  camerieri (gli altri, nell'ordine dato: waiter:<id>, il nome). staff
 *  undefined → { hostess: null, waiters: [] }: ancora da leggere, e un
 *  cameriere senza nome che poi ne prende uno sembrerebbe un altro. staff
 *  null, o nessun cameriere → ripiego senza nome: 2 se c'è qualcuno a
 *  tavola, altrimenti 1 (waiter:anon0, waiter:anon1). */
export function splitStaff(
  staff: readonly StaffOnShift[] | null | undefined,
  anyPresent: boolean,
): { hostess: string | null; waiters: WaiterSeed[] } {
  if (staff === undefined) return { hostess: null, waiters: [] };
  const hostess = hostessName(staff);
  const waiters: WaiterSeed[] = [];
  const seen = new Set<string>();
  let hostessTaken = false;
  for (const row of Array.isArray(staff) ? staff : []) {
    if (!row || typeof row !== 'object') continue;
    const id = idOf(row);
    const label = staffLabel(row.name);
    // Una riga senza id o senza nome non è nessuno da disegnare; un id
    // ripetuto (due righe della stessa persona) è una persona sola.
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    if (!hostessTaken && hostess !== null && isHostessRole(row.role)) {
      hostessTaken = true;
      continue;
    }
    waiters.push({ key: `waiter:${id}`, label });
  }
  if (waiters.length === 0) {
    const n = anyPresent ? FALLBACK_BUSY : FALLBACK_IDLE;
    for (let i = 0; i < n; i++) waiters.push({ key: `waiter:anon${i}`, label: null });
  }
  return { hostess, waiters };
}

// Le persone a tavola di una sala come intero non negativo.
const coversOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Quanti camerieri per sala e chi. rooms nell'ordine di sortRooms, covers =
 *  persone a tavola (summary.seated). Nessuna sala con persone → solo
 *  waiters[0], al pass di activeRoomId (o della prima sala). Altrimenti, R =
 *  sale con persone: con ≤ R camerieri, uno a testa alle sale con più persone
 *  (pari: ordine delle sale); con più di R, uno a testa e il resto a resto
 *  maggiore sulle persone (pari: ordine delle sale). I nomi in giro,
 *  nell'ordine delle sale: a ogni giro ogni sala ancora sotto il suo numero
 *  prende il prossimo. Nella mappa solo le sale con almeno un cameriere. */
export function allocateWaiters(
  waiters: readonly WaiterSeed[],
  rooms: readonly { id: number; covers: number }[],
  activeRoomId: number | null,
): Map<number, WaiterSeed[]> {
  const out = new Map<number, WaiterSeed[]>();
  const list = (Array.isArray(waiters) ? waiters : []).filter(w => !!w && typeof w.key === 'string');
  const seenRooms = new Set<number>();
  const roomList: { id: number; covers: number }[] = [];
  for (const r of Array.isArray(rooms) ? rooms : []) {
    if (!r || typeof r.id !== 'number' || seenRooms.has(r.id)) continue;
    seenRooms.add(r.id);
    roomList.push({ id: r.id, covers: coversOf(r.covers) });
  }
  if (list.length === 0 || roomList.length === 0) return out;

  const busy = roomList.filter(r => r.covers > 0);
  if (busy.length === 0) {
    // A ristorante vuoto un cameriere solo, al pass della sala sullo
    // schermo: gli altri girerebbero fra tavoli vuoti.
    const home = roomList.find(r => r.id === activeRoomId) ?? roomList[0];
    out.set(home.id, [list[0]]);
    return out;
  }

  const wanted = new Map<number, number>();
  if (list.length <= busy.length) {
    const ranked = busy
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.covers - a.r.covers || a.i - b.i)
      .slice(0, list.length);
    for (const { r } of ranked) wanted.set(r.id, 1);
  } else {
    // Resto maggiore in interi (persone × camerieri in più, diviso il
    // totale): un quoziente in virgola mobile come 2,9999999 farebbe perdere
    // un cameriere alla sala che lo merita.
    const extra = list.length - busy.length;
    const total = busy.reduce((s, r) => s + r.covers, 0);
    const quotas = busy.map((r, i) => {
      const scaled = extra * r.covers;
      return { r, i, base: Math.floor(scaled / total), rem: scaled % total };
    });
    let left = extra - quotas.reduce((s, q) => s + q.base, 0);
    for (const q of [...quotas].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
      if (left <= 0) break;
      q.base += 1;
      left -= 1;
    }
    for (const q of quotas) wanted.set(q.r.id, 1 + q.base);
  }

  // I nomi in giro, una sala alla volta nell'ordine delle sale: con 3
  // camerieri e due sale (2 + 1) la prima prende il primo e il terzo. Così
  // quando i numeri cambiano si sposta l'ultimo arrivato, non tutti.
  let next = 0;
  while (next < list.length) {
    let given = false;
    for (const r of roomList) {
      const want = wanted.get(r.id) ?? 0;
      const have = out.get(r.id);
      if ((have?.length ?? 0) >= want || next >= list.length) continue;
      if (have) have.push(list[next++]);
      else out.set(r.id, [list[next++]]);
      given = true;
    }
    if (!given) break;
  }
  return out;
}

/** Il prossimo tavolo: p1 = mai visitati e non presi, il più recente
 *  (seatedAt più alto, poi id più alto); p2 = estrazione pesata da
 *  max(1000, now − lastVisitAt) fra i non presi; null se nessuno. Una sola
 *  chiamata a rng, e solo per p2: lo stesso seme dà la stessa scelta. */
export function pickVisit(
  candidates: readonly VisitCandidate[],
  taken: ReadonlySet<number>,
  nowMs: number,
  rng: () => number,
): number | null {
  const list = Array.isArray(candidates) ? candidates : [];
  let best: VisitCandidate | null = null;
  for (const c of list) {
    if (!c || taken.has(c.partyId) || c.visits > 0) continue;
    if (best === null
      || c.seatedAt > best.seatedAt
      || (c.seatedAt === best.seatedAt && c.partyId > best.partyId)) best = c;
  }
  if (best !== null) return best.partyId;

  // Il peso: da quanto non ci passa nessuno, con un minimo; un tempo che non
  // si legge vale il minimo invece di avvelenare la somma con un NaN.
  const weight = (c: VisitCandidate): number => {
    const since = nowMs - c.lastVisitAt;
    return Number.isFinite(since) ? Math.max(MIN_WEIGHT_MS, since) : MIN_WEIGHT_MS;
  };
  let total = 0;
  let last: VisitCandidate | null = null;
  for (const c of list) {
    if (!c || taken.has(c.partyId)) continue;
    total += weight(c);
    last = c;
  }
  if (last === null || !(total > 0)) return null;
  const roll = rng();
  let x = (Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1) : 0) * total;
  for (const c of list) {
    if (!c || taken.has(c.partyId)) continue;
    const w = weight(c);
    if (x < w) return c.partyId;
    x -= w;
  }
  return last.partyId;
}
