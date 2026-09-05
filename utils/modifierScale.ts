// ---------------------------------------------------------------------------
// Scala di intensità delle varianti firmate (tasti −/+ del foglio varianti),
// condivisa fra client e server come utils/text.ts: quattro gradini al posto
// delle ripetizioni moltiplicative ±5 (cambio del 2026-09-05, per non tenere
// a listino varianti-doppione tipo «Poca nduja»/«Senza nduja»):
//
//   +1  «+ Nduja»      addebita il prezzo della variante
//   +2  «Molta Nduja»  stesso addebito di +1: è abbondanza, non due porzioni
//   −1  «Senza Nduja»  sconta il prezzo della variante
//   −2  «Poca Nduja»   gratis: il piatto è intero, solo con meno
//
// Etichetta e delta si CUOCIONO nello snapshot alla battitura (server) e
// nelle bozze locali (palmare e cassa): comanda, monitor, preconto e
// scontrino leggono nome e centesimi senza sapere nulla della regola.
// Le percentuali NON passano di qui: si risolvono in centesimi prima (sul
// prezzo battuto lato server, su quello di anagrafica nell'anteprima client)
// e gli helper ricevono il delta già in cents.
// ---------------------------------------------------------------------------

export const MODIFIER_N_MIN = -2;
export const MODIFIER_N_MAX = 2;

/** Snapshot e bozze precedenti al cambio portano n fino a ±5: si riconducono
 *  al gradino più vicino invece di perdere la variante per strada (un
 *  «ripeti giro» su una riga vecchia deve continuare a funzionare). */
export const clampModifierN = (n: number): number =>
    Math.max(MODIFIER_N_MIN, Math.min(MODIFIER_N_MAX, Math.trunc(n)));

/** Genere di Molta/Poca: euristica sull'ultima lettera del nome — finisce in
 *  «a» (o «à») → femminile. Azzecca i nomi da cucina (Nduja, Burrata /
 *  Prosciutto, Guanciale); sbaglia rarità come «carne»: accettato, la
 *  variante si chiama come a listino. */
const femminile = (name: string): boolean => /[aà]$/i.test(name.trim());

/** Etichetta col verso cotto dentro. `single` = gruppo a scelta singola
 *  (chip senza ±): il nome resta nudo, com'è sempre stato per le cotture. */
export const signedModifierLabel = (name: string, n: number, single = false): string => {
    if (single) return name;
    switch (clampModifierN(n)) {
        case 2: return `${femminile(name) ? 'Molta' : 'Molto'} ${name}`;
        case 1: return `+ ${name}`;
        case -1: return `Senza ${name}`;
        case -2: return `${femminile(name) ? 'Poca' : 'Poco'} ${name}`;
        default: return name; // n=0: solo lo stato di riposo del foglio
    }
};

/** Delta in centesimi col verso cotto dentro; `baseDelta` è GIÀ risolto. */
export const signedModifierDelta = (baseDelta: number, n: number): number => {
    switch (clampModifierN(n)) {
        case -1: return -baseDelta;
        case -2: return 0;
        default: return baseDelta; // +1 e +2: un solo addebito
    }
};
