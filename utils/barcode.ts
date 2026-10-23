// Codici a barre dei prodotti di magazzino: una forma sola per lo stesso
// codice, letto dalla fotocamera, scritto a mano o arrivato da una fattura.
//
// - spazi tolti (chi lo copia dall'etichetta li mette fra i gruppi di cifre);
// - UPC-A a 12 cifre → EAN-13 con lo zero davanti: il lettore del telefono
//   restituisce l'uno o l'altro a seconda del formato che riconosce per primo;
// - GTIN-14 con lo zero davanti → EAN-13, come fa utils/fatturaPa.ts. Un
//   GTIN-14 con un'altra cifra davanti è il codice del cartone, e resta suo.
// - lettere e simboli (Code 128, Code 39 delle etichette interne) restano
//   com'erano: lì maiuscole e minuscole sono codici diversi.
//
// Usato da server (salvataggio e ricerca) e pagina (ricerca nella lista).

export const BARCODE_MAX_LENGTH = 64;

export const normalizeBarcode = (raw: unknown): string | null => {
    if (raw == null) return null;
    const s = String(raw).trim().replace(/\s+/g, '');
    if (!s || s.length > BARCODE_MAX_LENGTH) return null;
    // Gli a-capo del lettore USB (che manda anche l'Invio) sono già andati
    // con gli spazi; un altro carattere di controllo non è un codice.
    if (/[\u0000-\u001f\u007f]/.test(s)) return null;
    if (/^\d+$/.test(s)) {
        if (s.length === 12) return `0${s}`;
        if (s.length === 14 && s.startsWith('0')) return s.slice(1);
    }
    return s;
};
