import type { Reservation } from '../../../types';
import type { NotePresetRef } from '../types';
import { finiteOr } from './geometry';
import { peopleOf } from './presence';

/* Chi c'è in una comitiva: adulti, bambini, cani, seggiolone. Dai campi della
 * prenotazione e dalle note, puro.
 *
 * Il cane e il seggiolone si riconoscono dalle ETICHETTE dei preset delle note
 * (Impostazioni → Opzioni prenotazioni) con icona 'dog' e 'baby', non dai loro
 * id: gli id dei preset cambiano a ogni salvataggio della lista, e una scelta
 * fatta ieri porterebbe un id che oggi non esiste più. «Cane» e «Seggiolone»,
 * le etichette che il ristorante usa, valgono sempre, accanto a quelle dei
 * preset: le note e le scelte di una prenotazione portano l'etichetta di
 * quando è stata salvata, e un preset rinominato dopo («Cane al seguito») non
 * deve togliere il cane alle prenotazioni di prima. */

export const DOG_FALLBACK_LABELS: readonly string[] = ['Cane'];
export const BABY_FALLBACK_LABELS: readonly string[] = ['Seggiolone'];
/** Al più due cani per comitiva: «5× Cane» è un errore di battitura, non una
 *  muta da disegnare sotto il tavolo. */
export const MAX_DOGS = 2;

export interface PartyLabels {
  dog: string[];
  baby: string[];
}

// Un testo nella forma composta (NFC): una «è» scritta come «e» più l'accento
// staccato (NFD, come la incollano certi sistemi) è la stessa lettera, e
// l'accento da solo non deve fare da confine di parola.
const nfc = (s: string): string => s.normalize('NFC');

// Un'etichetta in forma confrontabile: composta, senza spazi in testa e in
// coda, gli spazi interni ridotti a uno, minuscola. «Cane », «cane» e «CANE»
// sono la stessa etichetta.
const normLabel = (s: string): string => nfc(s).trim().replace(/\s+/g, ' ').toLowerCase();

// Le etichette dei preset con quell'icona, nell'ordine dei preset, una volta
// sola, poi i ripieghi che mancano. Una riga senza etichetta, o che non è un
// oggetto, non conta.
const labelsWithIcon = (presets: readonly NotePresetRef[], icon: string, fallback: readonly string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const label = nfc(raw).trim();
    const key = normLabel(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };
  for (const p of presets) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.icon !== 'string' || p.icon.trim() !== icon) continue;
    if (typeof p.label === 'string') add(p.label);
  }
  for (const label of fallback) add(label);
  return out;
};

/** Le etichette che dicono cane e seggiolone: quelle dei preset delle note con
 *  l'icona, più «Cane» e «Seggiolone», che valgono sempre (anche prima che i
 *  preset arrivino, e dopo che uno è stato rinominato). */
export function partyLabels(presets: readonly NotePresetRef[] | null | undefined): PartyLabels {
  const list = Array.isArray(presets) ? presets : [];
  return {
    dog: labelsWithIcon(list, 'dog', DOG_FALLBACK_LABELS),
    baby: labelsWithIcon(list, 'baby', BABY_FALLBACK_LABELS),
  };
}

// I metacaratteri di una RegExp, presi alla lettera: un'etichetta come
// «Cane (taglia S)» o «C.ne» non deve diventare un'espressione. Sono
// esattamente i SyntaxCharacter, gli unici che il flag u lascia scappare con
// la barra (un «\-» lì sarebbe un errore di sintassi).
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// L'alternativa delle etichette per una RegExp, la più lunga prima: con
// «Cane piccolo» e «Cane», «2× Cane piccolo» deve fermarsi sulla prima e
// contare 2, non 2 + 2. Gli spazi interni valgono qualunque spazio.
const alternation = (labels: readonly string[]): string | null => {
  const alts = labels
    .map(l => (typeof l === 'string' ? nfc(l).trim() : ''))
    .filter(l => l.length > 0)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => b.l.length - a.l.length || a.i - b.i)
    .map(({ l }) => escapeRegExp(l).replace(/\s+/g, '\\s+'));
  return alts.length > 0 ? alts.join('|') : null;
};

// Né una lettera, né un segno che le si attacca (un accento staccato), né una
// cifra, in qualunque alfabeto: il confine di parola di \b conosce solo
// [A-Za-z0-9_], e «caneè» o «2×Canè» lo attraverserebbero.
const NOT_WORD = '[^\\p{L}\\p{M}\\p{N}]';

/** Quante volte le note di una prenotazione nominano una di quelle etichette.
 *  Vince la prima regola che dà più di zero, perché le note riportano anche
 *  le scelte strutturate in chiaro («2× Cane», ReservationList salva così) e
 *  una scelta contata due volte darebbe due cani invece di uno:
 *  1. note_selections con la stessa etichetta: la somma delle quantità (almeno
 *     1 a riga);
 *  2. nelle note, «N× Etichetta» o «N x Etichetta»: la somma degli N;
 *  3. nelle note, l'etichetta come parola intera: 1. «canederli» non è
 *     «cane». Il confine a sinistra si prende col carattere, non con un
 *     lookbehind: iPadOS prima della 16.4 non lo conosce e la RegExp non
 *     compilerebbe nemmeno. */
export function countMentions(
  r: Pick<Reservation, 'notes' | 'note_selections'>,
  labels: readonly string[],
): number {
  const list = Array.isArray(labels) ? labels : [];
  const wanted = new Set(list.filter((l): l is string => typeof l === 'string').map(normLabel).filter(Boolean));
  if (wanted.size === 0) return 0;

  const selections: unknown = r?.note_selections;
  if (Array.isArray(selections)) {
    let total = 0;
    for (const s of selections) {
      if (!s || typeof s !== 'object') continue;
      const label: unknown = (s as { label?: unknown }).label;
      if (typeof label !== 'string' || !wanted.has(normLabel(label))) continue;
      total += Math.max(1, Math.floor(finiteOr((s as { quantity?: unknown }).quantity, 1)));
    }
    if (total > 0) return total;
  }

  const raw: unknown = r?.notes;
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  const notes = nfc(raw);
  const alts = alternation(list);
  if (alts === null) return 0;

  let counted = 0;
  const times = new RegExp(`(\\d+)\\s*[×x]\\s*(?:${alts})(?=${NOT_WORD}|$)`, 'giu');
  for (const m of notes.matchAll(times)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n)) counted += n;
  }
  if (counted > 0) return counted;

  const word = new RegExp(`(?:^|${NOT_WORD})(?:${alts})(?=${NOT_WORD}|$)`, 'iu');
  return word.test(notes) ? 1 : 0;
}

export interface PartyComposition {
  adults: number;
  kids: number;
  /** 0 … MAX_DOGS. */
  dogs: number;
  /** Le note chiedono il seggiolone. */
  highChair: boolean;
}

/** La comitiva da disegnare. I bambini sono una parte degli ospiti (come li
 *  salva il server), quindi adulti = ospiti − bambini, e adulti + bambini =
 *  peopleOf(r): le figure sono esattamente le persone che il riassunto conta.
 *  Con il seggiolone e nessun bambino segnato, uno degli adulti è il bambino:
 *  chi chiede un seggiolone ha un bambino al tavolo, anche se non l'ha
 *  scritto nel campo bambini (con un adulto solo resta l'adulto). */
export function composeParty(r: Reservation, labels: PartyLabels): PartyComposition {
  const guests = Math.max(1, peopleOf(r));
  let kids = Math.min(guests, Math.max(0, Math.floor(finiteOr(r?.children, 0))));
  let adults = guests - kids;
  const dogs = Math.min(MAX_DOGS, countMentions(r, labels?.dog ?? DOG_FALLBACK_LABELS));
  const highChair = countMentions(r, labels?.baby ?? BABY_FALLBACK_LABELS) > 0;
  if (highChair && kids === 0 && adults >= 2) {
    kids = 1;
    adults -= 1;
  }
  return { adults, kids, dogs, highChair };
}
