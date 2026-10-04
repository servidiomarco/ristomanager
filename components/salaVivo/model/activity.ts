import type { TFunction } from 'i18next';
import type { DirectorEvent, PartyRef, PartyState, TableRef } from '../types';

/* La striscia delle attività della Sala dal vivo, come conti puri: quali
 * righe nascono da un evento del regista, quali restano vere dopo un
 * annullamento, come si sommano i riallineamenti, e che cosa si legge e che
 * cosa si sente. La pagina tiene lo stato e i timer, ActivityStrip disegna;
 * qui niente React né DOM, così i test le provano in node.
 *
 * Una riga si fotografa quando il regista la racconta (PartyRef e TableRef
 * restano anche dopo che la comitiva è uscita dal modello). Il testo no: si
 * compone a ogni render, così spegnendo i nomi spariscono anche dalle righe
 * già a video. */

/** Le 4 righe più recenti, ognuna per 90 s da quando si vede. */
export const STRIP_MAX = 4;
export const STRIP_TTL_MS = 90_000;

/** Una cosa successa. `until`: quando esce (Infinity finché la scheda è
 *  nascosta: i 90 s partono quando la si può leggere). */
export type StripItem =
  | { id: number; until: number; kind: 'escort' | 'leaving' | 'large'; party: PartyRef; table: TableRef }
  | { id: number; until: number; kind: 'lobby'; party: PartyRef }
  | { id: number; until: number; kind: 'moved'; party: PartyRef; from: TableRef; to: TableRef }
  | { id: number; until: number; kind: 'bulk'; count: number };

/** Una riga come si disegna e come si sente. */
export interface ActivityLine {
  /** Stabile per riga: una riga nuova entra con la sua animazione, le altre
   *  restano ferme. */
  id: number;
  /** Chi (o tutta la riga, se non dice di un tavolo): si accorcia coi
   *  puntini quando non ci sta. */
  lead: string;
  /** Dove: «→ tavolo 40», «· tavolo 40 → 41». Non si accorcia mai: è la
   *  parte che dice che cosa è successo, e stava in fondo, dove i puntini
   *  la tagliavano per prima. */
  tail: string;
  /** La frase per lo screen reader: niente frecce, punti in mezzo e «più»,
   *  che si leggerebbero lettera per lettera. */
  spoken: string;
}

/** Le righe di un evento. La fine di un accompagnamento o di un cambio di
 *  tavolo non ne fa: basta quella dell'inizio («→ tavolo 40», «· tavolo 40 →
 *  41»), e una seconda riga per lo stesso tavolo, quando l'ultimo si siede,
 *  spingerebbe fuori dalle quattro una cosa successa davvero. Chi compare già
 *  seduto (comitiva grande, banchetto, coda troppo lunga) fa una riga per
 *  comitiva. */
export function stripItemsOf(event: DirectorEvent, nextId: () => number, until: number): StripItem[] {
  switch (event.kind) {
    case 'escort-start':
      return [{ id: nextId(), until, kind: 'escort', party: event.party, table: event.table }];
    case 'escort-end':
    case 'moved-end':
      return [];
    case 'lobby':
      return [{ id: nextId(), until, kind: 'lobby', party: event.party }];
    case 'moved':
      return [{ id: nextId(), until, kind: 'moved', party: event.party, from: event.from, to: event.to }];
    case 'leaving':
      return [{ id: nextId(), until, kind: 'leaving', party: event.party, table: event.table }];
    case 'bulk':
      return event.count > 0 ? [{ id: nextId(), until, kind: 'bulk', count: event.count }] : [];
    case 'snapped':
      return (Array.isArray(event.parties) ? event.parties : [])
        .map(p => ({ id: nextId(), until, kind: 'large' as const, party: p.party, table: p.table }));
    default:
      return [];
  }
}

/** Le righe nuove in cima, al più STRIP_MAX. Un riallineamento subito dopo
 *  un altro ancora a video si somma a quello: a scheda nascosta ogni
 *  aggiornamento ne porta uno, e tornando si leggevano quattro «1 tavolo
 *  aggiornato» invece di «4 tavoli aggiornati». */
export function addStripItems(prev: readonly StripItem[], items: readonly StripItem[]): StripItem[] {
  let out = prev.slice();
  for (const item of items) {
    const top = out[0];
    if (item.kind === 'bulk' && top && top.kind === 'bulk') {
      out[0] = { ...top, count: top.count + item.count, until: Math.max(top.until, item.until) };
    } else {
      out = [item, ...out];
    }
  }
  return out.slice(0, STRIP_MAX);
}

/** Un accompagnamento finito senza sedersi (l'«Arrivato» annullato, o
 *  spostato in un'altra sala, che ne apre un altro con la sua riga): le sue
 *  righe «→ tavolo …» se ne vanno con lui, come le figure. Per comitiva e non
 *  per tavolo: cambiato tavolo a metà strada, la fine dice il tavolo nuovo e
 *  la riga quello vecchio. */
export function withoutEscort(items: readonly StripItem[], partyId: number): StripItem[] {
  const kept = items.filter(item => !(item.kind === 'escort' && item.party.id === partyId));
  return kept.length === items.length ? (items as StripItem[]) : kept;
}

/** Le righe che il modello di adesso non smentisce. Un annullamento non
 *  manda sempre un evento (un «Arrivato» tolto dopo che si erano seduti, o
 *  col movimento ridotto; un «Tavolo liberato» tolto mentre uscivano): senza,
 *  la striscia direbbe per un minuto e mezzo una cosa che non c'è.
 *
 *  - Un arrivo, un'attesa all'ingresso, un cambio di tavolo, chi è comparso
 *    già seduto: annullati se la comitiva è tornata in attesa o non c'è più.
 *  - Un'uscita: annullata se la comitiva è di nuovo al tavolo che lasciava. */
export function stillTrue(items: readonly StripItem[], states: readonly PartyState[] | null | undefined): StripItem[] {
  const byId = new Map<number, PartyState>();
  for (const s of Array.isArray(states) ? states : []) if (s && !byId.has(s.id)) byId.set(s.id, s);
  const kept = items.filter(item => {
    if (item.kind === 'bulk') return true;
    const s = byId.get(item.party.id);
    if (item.kind === 'leaving') {
      return !(s && (s.phase === 'seated' || s.phase === 'standing') && s.tableId === item.table.id);
    }
    return !!s && s.phase !== 'waiting';
  });
  return kept.length === items.length ? (items as StripItem[]) : kept;
}

/** Le righe nascoste che si possono leggere da adesso: i loro 90 s partono. */
export function revealStripItems(items: readonly StripItem[], until: number): StripItem[] {
  if (!items.some(item => item.until === Infinity)) return items as StripItem[];
  return items.map(item => (item.until === Infinity ? { ...item, until } : item));
}

const countOf = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** «4 (2 bambini) + cane»: le persone, poi i bambini e i cani se ci sono.
 *  Lo stesso pezzo per la striscia e per l'etichetta della comitiva
 *  accompagnata. */
export function peopleText(t: TFunction, p: { adults: number; kids: number; dogs: number }): string {
  const kids = countOf(p.kids);
  const dogs = countOf(p.dogs);
  let text = String(countOf(p.adults) + kids);
  if (kids > 0) text += ` ${t('strip.kids', { count: kids })}`;
  if (dogs > 0) text += ` ${t('strip.dog', { count: dogs })}`;
  return text;
}

/** La stessa comitiva detta a voce: «4 persone, 2 bambini, un cane». */
function peopleSpoken(t: TFunction, p: { adults: number; kids: number; dogs: number }): string[] {
  const kids = countOf(p.kids);
  const dogs = countOf(p.dogs);
  const out = [t('strip.sr.people', { count: countOf(p.adults) + kids })];
  if (kids > 0) out.push(t('strip.sr.kids', { count: kids }));
  if (dogs > 0) out.push(t('strip.sr.dog', { count: dogs }));
  return out;
}

/** Il testo di una riga. A nomi spenti la comitiva è il suo conto
 *  («4 (2 bambini) + cane → tavolo 40»); a nomi accesi anche il nome. */
export function stripLine(item: StripItem, showNames: boolean, t: TFunction): ActivityLine {
  if (item.kind === 'bulk') {
    const text = t('strip.updatedMany', { count: item.count });
    return { id: item.id, lead: text, tail: '', spoken: text };
  }
  const name = showNames ? item.party.name : null;
  if (item.kind === 'large') {
    const who = name ?? t('strip.anonymous', { table: item.table.name });
    const seated = t('strip.seatedCount', { count: countOf(item.party.adults) + countOf(item.party.kids) });
    return { id: item.id, lead: who, tail: `· ${seated}`, spoken: [who, seated].join(', ') };
  }
  const people = peopleText(t, item.party);
  const lead = name ? t('strip.party', { name, people }) : people;
  const said = [...(name ? [name] : []), ...peopleSpoken(t, item.party)];
  switch (item.kind) {
    case 'escort':
      return {
        id: item.id,
        lead,
        tail: t('strip.toTable', { table: item.table.name }),
        spoken: [...said, t('strip.sr.toTable', { table: item.table.name })].join(', '),
      };
    case 'lobby':
      return { id: item.id, lead, tail: t('strip.atEntrance'), spoken: [...said, t('strip.atEntrance')].join(', ') };
    case 'moved':
      return {
        id: item.id,
        lead,
        tail: `· ${t('strip.moved', { from: item.from.name, to: item.to.name })}`,
        spoken: [...said, t('strip.sr.moved', { from: item.from.name, to: item.to.name })].join(', '),
      };
    case 'leaving':
      return {
        id: item.id,
        lead,
        tail: `· ${t('strip.leaving', { table: item.table.name })}`,
        spoken: [...said, t('strip.sr.leaving', { table: item.table.name })].join(', '),
      };
  }
}
