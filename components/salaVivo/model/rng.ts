/* Il caso del regista, ripetibile.
 *
 * Ogni scelta «a caso» della Sala dal vivo (quanto un cameriere resta al
 * pass, quale tavolo va a servire, il passo di una comitiva) viene da qui, mai
 * da Math.random: con lo stesso seme la stessa sequenza, su ogni dispositivo.
 * Così il tablet all'ingresso e la TV in sala mettono in scena la stessa
 * coreografia, e i test possono fissare le posizioni dopo N passi.
 *
 * Solo aritmetica intera a 32 bit (Math.imul, shift): nessuna dipendenza dal
 * motore JS né dalla precisione dei float. */

const UINT32 = 4294967296;

/** Il generatore del regista: mulberry32, 32 bit, stesso seme stessa
 *  sequenza su ogni dispositivo. Restituisce numeri in [0, 1).
 *
 *  Lo stato si tiene a 32 bit (`| 0`) a ogni passo: la versione che lo lascia
 *  crescere come float smette di essere esatta dopo qualche milione di
 *  chiamate, e un servizio intero di camerieri ci arriva. Un seme che non è
 *  un numero vale 0. */
export function mulberry32(seed: number): () => number {
  let a = (Number.isFinite(seed) ? seed : 0) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** Un hash a 32 bit senza segno di una stringa: FNV-1a sui code unit UTF-16,
 *  poi il mescolamento finale di MurmurHash3 (fmix32). FNV da solo lascia i
 *  bit alti quasi uguali per chiavi che differiscono nell'ultima cifra
 *  («…:41», «…:42»), e mulberry32 partirebbe da semi vicini. */
export function hashString(s: string): number {
  const str = typeof s === 'string' ? s : String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Il caso di una comitiva: mulberry32(hashString(serviceKey + ':' + id)).
 *  Dipende solo dal servizio e dalla prenotazione, non dall'ordine in cui il
 *  regista incontra le comitive: due schermi accesi in momenti diversi danno
 *  alla stessa famiglia lo stesso passo. */
export function partyRng(serviceKey: string, partyId: number): () => number {
  return mulberry32(hashString(`${serviceKey}:${partyId}`));
}

/** Il caso di un cameriere: mulberry32((seed ^ hashString(key)) >>> 0). Il
 *  seme del regista entra qui perché i camerieri non hanno un servizio da
 *  cui nascere: è il seme a renderli uguali su ogni schermo. */
export function staffRng(seed: number, key: string): () => number {
  return mulberry32(((Number.isFinite(seed) ? seed : 0) ^ hashString(key)) >>> 0);
}

/** Un numero in [min, max) dal generatore dato. */
export function uniform(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}
