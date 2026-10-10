// ============================================
// FatturaPA — lettura delle fatture elettroniche dei fornitori
// ============================================
// Solo funzioni pure, niente database: dal file caricato (XML, p7m firmato o
// zip dello scarico in blocco) alle fatture con le loro righe, già pulite e
// classificate. Le rotte di services/fattureFornitoriRoutes.ts ci costruiscono
// sopra il carico del magazzino.
//
// Il tracciato è quello dell'Agenzia delle Entrate (FPR12/FPA12, v1.2). Ogni
// fornitore lo scrive a modo suo: prefissi dei namespace diversi (ns3:, b:,
// p:), numeri con 2 o 8 decimali, righe fatte solo di note, codici articolo
// con nomi inventati. Qui si assorbe tutto questo, una volta sola.

import { XMLParser } from 'fast-xml-parser';
import { inflateRawSync } from 'node:zlib';

export class FatturaPaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatturaPaError';
    }
}

export interface FpCodice {
    tipo: string;
    valore: string;
}

export interface FpSconto {
    tipo: 'SC' | 'MG';
    percentuale: number | null;
    importo: number | null;
}

export interface FpAltroDato {
    tipo: string;
    testo: string | null;
    numero: number | null;
    data: string | null;
}

/**
 * Cosa fa una riga per il magazzino:
 * - merce: si carica (anche a prezzo zero, l'omaggio);
 * - nota: solo testo (prezzo zero, senza quantità), si salta;
 * - sconto: sconti, premi, abbuoni e righe negative, non sono merce;
 * - spesa: spese accessorie (trasporto, imballo);
 * - servizio: un importo senza quantità.
 * Sconti, spese e servizi contano nella spesa, non nel magazzino.
 */
export type TipoRiga = 'merce' | 'nota' | 'sconto' | 'spesa' | 'servizio';

export interface FpRiga {
    numero: number;
    codici: FpCodice[];
    /** EAN/GTIN normalizzato a 13 cifre quando ne ha 14 con lo zero davanti. */
    ean: string | null;
    /** Il primo codice che non è un EAN (il codice interno del fornitore). */
    codice: string | null;
    descrizione: string;
    quantita: number | null;
    unitaMisura: string | null;
    prezzoUnitario: number;
    /** Già al netto degli sconti di riga, IVA esclusa. */
    prezzoTotale: number;
    aliquotaIva: number;
    natura: string | null;
    tipoCessione: string | null;
    sconti: FpSconto[];
    lotto: string | null;
    scadenza: string | null;
    altriDati: FpAltroDato[];
    /** Il numero del DDT che porta la riga, se la fattura lo dice. */
    ddt: string | null;
    tipo: TipoRiga;
}

export interface FpRiepilogoIva {
    aliquota: number;
    natura: string | null;
    imponibile: number;
    imposta: number;
}

export interface FpScadenza {
    modalita: string | null;
    data: string | null;
    importo: number | null;
    iban: string | null;
    istituto: string | null;
}

export interface FpAllegato {
    indice: number;
    nome: string;
    formato: string | null;
    descrizione: string | null;
    /** Dimensione del file decodificato, stimata dal base64. */
    bytes: number;
}

export interface FpSoggetto {
    piva: string | null;
    codiceFiscale: string | null;
    denominazione: string;
    indirizzo: string | null;
    email: string | null;
    telefono: string | null;
}

export interface FpDdt {
    numero: string;
    data: string | null;
    linee: number[];
}

export interface FpFattura {
    /** Posizione del FatturaElettronicaBody nel file (un file può portarne più d'uno). */
    indiceBody: number;
    cedente: FpSoggetto;
    cessionario: FpSoggetto;
    codiceDestinatario: string | null;
    tipoDocumento: string;
    /** TD04: nota di credito, non carica merce. */
    notaDiCredito: boolean;
    divisa: string;
    data: string;
    numero: string;
    importoTotale: number | null;
    imponibile: number;
    imposta: number;
    causale: string | null;
    ddt: FpDdt[];
    righe: FpRiga[];
    riepilogo: FpRiepilogoIva[];
    pagamenti: FpScadenza[];
    allegati: FpAllegato[];
}

// ---- Contenitori: zip, p7m, testo ----------------------------------------------

/** Un file pronto da leggere, col nome che aveva (dentro lo zip, se c'era). */
export interface FileFattura {
    nome: string;
    xml: string;
}

/** Un file dello zip che non è una fattura: si dice perché, non si ferma il resto. */
export interface FileScartato {
    nome: string;
    motivo: string;
}

const ZIP_VOCI_MASSIME = 2000;
const ZIP_BYTES_MASSIMI = 200 * 1024 * 1024;
const FILE_BYTES_MASSIMI = 20 * 1024 * 1024;

const isZip = (buf: Buffer): boolean => buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;

/** Primo byte significativo: salta BOM UTF-8 e spazi. */
const inizio = (buf: Buffer): number => {
    let i = 0;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
    return i;
};

const sembraXml = (buf: Buffer): boolean => {
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
    const i = inizio(buf);
    return i < buf.length && buf[i] === 0x3c; // '<'
};

const BASE64_RE = /^[A-Za-z0-9+/=\s-]+$/;

/** Un p7m spedito in base64 (capita con alcuni intermediari): torna DER. */
const daBase64 = (buf: Buffer): Buffer | null => {
    if (buf.length < 64) return null;
    const testo = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    if (!BASE64_RE.test(testo.replace(/-----[A-Z0-9 ]+-----/g, ''))) return null;
    const pulito = buf.toString('latin1').replace(/-----[A-Z0-9 ]+-----/g, '').replace(/\s+/g, '');
    const der = Buffer.from(pulito, 'base64');
    return der.length > 0 && der[0] === 0x30 ? der : null;
};

// ---- ASN.1 minimo per il p7m (CAdES) ---------------------------------------------
// Il p7m è un SignedData PKCS#7 con l'XML dentro come OCTET STRING. Non si
// verifica la firma (la fattura l'ha già controllata lo SDI): si cerca solo il
// contenuto. Con la codifica BER «a lunghezza indefinita» l'OCTET STRING può
// arrivare spezzato in tanti pezzi da 1000 byte: vanno riattaccati, o l'XML
// esce con dei byte di intestazione in mezzo.

interface Tlv {
    classe: number;
    costruito: boolean;
    tag: number;
    inizioContenuto: number;
    fineContenuto: number;
    fine: number;
}

const PROFONDITA_ASN1 = 40;

function leggiTlv(buf: Buffer, pos: number, limite: number, profondita: number): Tlv {
    if (profondita > PROFONDITA_ASN1) throw new FatturaPaError('Firma p7m troppo annidata');
    if (pos + 2 > limite) throw new FatturaPaError('Firma p7m troncata');
    const b0 = buf[pos];
    const classe = b0 >> 6;
    const costruito = (b0 & 0x20) !== 0;
    let tag = b0 & 0x1f;
    let p = pos + 1;
    if (tag === 0x1f) {
        tag = 0;
        let byte: number;
        let n = 0;
        do {
            if (p >= limite || ++n > 4) throw new FatturaPaError('Firma p7m non leggibile');
            byte = buf[p++];
            tag = (tag << 7) | (byte & 0x7f);
        } while (byte & 0x80);
    }
    if (p >= limite) throw new FatturaPaError('Firma p7m troncata');
    const l0 = buf[p++];
    if (l0 === 0x80) {
        if (!costruito) throw new FatturaPaError('Firma p7m non leggibile');
        // Lunghezza indefinita: i figli finiscono con 00 00.
        let q = p;
        for (;;) {
            if (q + 2 > limite) throw new FatturaPaError('Firma p7m troncata');
            if (buf[q] === 0 && buf[q + 1] === 0) {
                return { classe, costruito, tag, inizioContenuto: p, fineContenuto: q, fine: q + 2 };
            }
            q = leggiTlv(buf, q, limite, profondita + 1).fine;
        }
    }
    let lunghezza = l0;
    if (l0 & 0x80) {
        const n = l0 & 0x7f;
        if (n > 4 || p + n > limite) throw new FatturaPaError('Firma p7m non leggibile');
        lunghezza = 0;
        for (let i = 0; i < n; i++) lunghezza = lunghezza * 256 + buf[p++];
    }
    const fine = p + lunghezza;
    if (fine > limite) throw new FatturaPaError('Firma p7m troncata');
    return { classe, costruito, tag, inizioContenuto: p, fineContenuto: fine, fine };
}

/** I pezzi di un OCTET STRING costruito, riattaccati. */
function ottetti(buf: Buffer, t: Tlv, profondita: number): Buffer {
    if (!t.costruito) return buf.subarray(t.inizioContenuto, t.fineContenuto);
    const pezzi: Buffer[] = [];
    let p = t.inizioContenuto;
    while (p < t.fineContenuto) {
        const figlio = leggiTlv(buf, p, t.fineContenuto, profondita + 1);
        pezzi.push(ottetti(buf, figlio, profondita + 1));
        p = figlio.fine;
    }
    return Buffer.concat(pezzi);
}

function cercaContenuto(buf: Buffer, da: number, a: number, profondita: number): Buffer | null {
    let p = da;
    while (p < a) {
        if (buf[p] === 0 && p + 1 < a && buf[p + 1] === 0) break;
        const t = leggiTlv(buf, p, a, profondita);
        if (t.classe === 0 && t.tag === 4) {
            const dati = ottetti(buf, t, profondita);
            if (sembraXml(dati)) return dati;
            // Firma doppia: dentro c'è un altro p7m.
            if (dati.length > 64 && dati[0] === 0x30) {
                try {
                    const dentro = cercaContenuto(dati, 0, dati.length, profondita + 1);
                    if (dentro) return dentro;
                } catch {
                    // non era un p7m: si va avanti
                }
            }
        } else if (t.costruito) {
            const trovato = cercaContenuto(buf, t.inizioContenuto, t.fineContenuto, profondita + 1);
            if (trovato) return trovato;
        }
        p = t.fine;
    }
    return null;
}

/** L'XML firmato dentro un p7m (DER o base64). */
export function estraiDaP7m(buf: Buffer): Buffer {
    let der = buf;
    if (der.length === 0 || der[0] !== 0x30) {
        const decodificato = daBase64(buf);
        if (!decodificato) throw new FatturaPaError('Il file p7m non è leggibile');
        der = decodificato;
    }
    const xml = cercaContenuto(der, 0, der.length, 0);
    if (!xml) throw new FatturaPaError('Nel p7m non c\'è una fattura');
    return xml;
}

// ---- Zip ---------------------------------------------------------------------
// Solo quello che serve agli scarichi in blocco (portale del commercialista,
// «Fatture e Corrispettivi»): voci memorizzate o compresse con deflate, niente
// zip64 né cifratura. Con i limiti contro gli zip-bomba.

export interface VoceZip {
    nome: string;
    dati: Buffer;
}

export function leggiZip(buf: Buffer): VoceZip[] {
    // La «fine della directory» sta negli ultimi 22 byte più un commento di al
    // massimo 65535: si cerca all'indietro.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new FatturaPaError('Lo zip non è leggibile');
    const voci = buf.readUInt16LE(eocd + 10);
    const inizioDirectory = buf.readUInt32LE(eocd + 16);
    if (voci === 0xffff || inizioDirectory === 0xffffffff) throw new FatturaPaError('Zip troppo grande: dividilo in più file');
    if (voci > ZIP_VOCI_MASSIME) throw new FatturaPaError(`Lo zip ha più di ${ZIP_VOCI_MASSIME} file: dividilo`);

    const fuori: VoceZip[] = [];
    let totale = 0;
    let p = inizioDirectory;
    for (let n = 0; n < voci; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FatturaPaError('Lo zip non è leggibile');
        const flag = buf.readUInt16LE(p + 8);
        const metodo = buf.readUInt16LE(p + 10);
        const compresso = buf.readUInt32LE(p + 20);
        const pieno = buf.readUInt32LE(p + 24);
        const lungNome = buf.readUInt16LE(p + 28);
        const lungExtra = buf.readUInt16LE(p + 30);
        const lungCommento = buf.readUInt16LE(p + 32);
        const locale = buf.readUInt32LE(p + 42);
        // Bit 11: nome in UTF-8; altrimenti CP437, che per i nomi delle
        // fatture (lettere, cifre, _ e .) coincide col latin1.
        const nome = buf.subarray(p + 46, p + 46 + lungNome).toString(flag & 0x800 ? 'utf8' : 'latin1');
        p += 46 + lungNome + lungExtra + lungCommento;

        const base = nome.split('/').pop() ?? '';
        if (!base || nome.endsWith('/') || nome.startsWith('__MACOSX/') || base.startsWith('.')) continue;
        if (flag & 0x1) throw new FatturaPaError(`«${base}» nello zip è protetto da password`);
        if (pieno > FILE_BYTES_MASSIMI) throw new FatturaPaError(`«${base}» nello zip è troppo grande`);
        totale += pieno;
        if (totale > ZIP_BYTES_MASSIMI) throw new FatturaPaError('Lo zip è troppo grande: dividilo in più file');

        if (locale + 30 > buf.length || buf.readUInt32LE(locale) !== 0x04034b50) throw new FatturaPaError('Lo zip non è leggibile');
        const inizioDati = locale + 30 + buf.readUInt16LE(locale + 26) + buf.readUInt16LE(locale + 28);
        if (inizioDati + compresso > buf.length) throw new FatturaPaError('Lo zip è troncato');
        const grezzo = buf.subarray(inizioDati, inizioDati + compresso);
        let dati: Buffer;
        if (metodo === 0) dati = Buffer.from(grezzo);
        else if (metodo === 8) dati = inflateRawSync(grezzo, { maxOutputLength: FILE_BYTES_MASSIMI });
        else throw new FatturaPaError(`«${base}» nello zip usa una compressione non supportata`);
        fuori.push({ nome: base, dati });
    }
    return fuori;
}

// ---- Testo -------------------------------------------------------------------

/** Dai byte al testo, con la codifica che dichiara il prologo. */
export function decodificaXml(buf: Buffer): string {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    const prologo = buf.subarray(0, Math.min(buf.length, 200)).toString('latin1');
    const m = /encoding\s*=\s*["']([^"']+)["']/i.exec(prologo);
    const enc = (m?.[1] ?? 'utf-8').toLowerCase();
    if (enc === 'iso-8859-1' || enc === 'latin1' || enc === 'windows-1252' || enc === 'cp1252' || enc === 'iso-8859-15') {
        return new TextDecoder('windows-1252').decode(buf);
    }
    const testo = new TextDecoder('utf-8').decode(buf);
    return testo.charCodeAt(0) === 0xfeff ? testo.slice(1) : testo;
}

/**
 * Da un file caricato ai testi XML delle fatture che contiene. Lo zip si apre
 * (anche uno zip dentro lo zip); dentro, i file che non sono fatture (i
 * metadati dello SDI, un PDF) si scartano dicendo perché.
 */
export function apriFile(buf: Buffer, nome: string, profondita = 0): { fatture: FileFattura[]; scartati: FileScartato[] } {
    const fatture: FileFattura[] = [];
    const scartati: FileScartato[] = [];
    if (isZip(buf)) {
        if (profondita > 1) return { fatture, scartati: [{ nome, motivo: 'Zip dentro lo zip dentro lo zip' }] };
        for (const voce of leggiZip(buf)) {
            const dentro = apriFile(voce.dati, voce.nome, profondita + 1);
            fatture.push(...dentro.fatture);
            scartati.push(...dentro.scartati);
        }
        return { fatture, scartati };
    }
    const pdf = buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF';
    if (pdf) return { fatture, scartati: [{ nome, motivo: 'È un PDF, serve l\'XML' }] };
    // Né XML né firma (DER o base64): un file qualsiasi, non un p7m rotto.
    if (!sembraXml(buf) && buf[0] !== 0x30 && !/\.p7m$/i.test(nome) && !daBase64(buf)) {
        return { fatture, scartati: [{ nome, motivo: 'Non è una fattura elettronica: serve l\'XML, il p7m o lo zip' }] };
    }
    try {
        let xml = buf;
        if (!sembraXml(buf)) xml = estraiDaP7m(buf);
        const testo = decodificaXml(xml);
        if (!/<(\w+:)?FatturaElettronica[\s>]/.test(testo)) {
            scartati.push({ nome, motivo: /FileMetadati/.test(testo) ? 'Metadati dello SDI' : 'Non è una fattura elettronica' });
        } else {
            fatture.push({ nome, xml: testo });
        }
    } catch (err) {
        if (!(err instanceof FatturaPaError)) throw err;
        scartati.push({ nome, motivo: err.message });
    }
    return { fatture, scartati };
}

// ---- Lettura del tracciato ---------------------------------------------------

const ARRAY = new Set([
    'FatturaElettronicaBody', 'DettaglioLinee', 'DatiRiepilogo', 'CodiceArticolo', 'AltriDatiGestionali',
    'ScontoMaggiorazione', 'DatiDDT', 'RiferimentoNumeroLinea', 'DatiPagamento', 'DettaglioPagamento',
    'Allegati', 'Causale',
]);

const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false, // i numeri li convertiamo noi, campo per campo
    trimValues: true,
    isArray: (name) => ARRAY.has(name),
});

type Nodo = Record<string, unknown>;

const nodo = (v: unknown): Nodo => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Nodo) : {});
const lista = (v: unknown): Nodo[] => (Array.isArray(v) ? v.map(nodo) : v == null ? [] : [nodo(v)]);

const testo = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object' && '#text' in (v as Nodo)) return testo((v as Nodo)['#text']);
    return null;
};

const numero = (v: unknown): number | null => {
    const s = testo(v);
    if (s == null) return null;
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};

/** Gli spazi doppi e quelli in coda dei gestionali, tolti. */
const pulisci = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();

const data = (v: unknown): string | null => {
    const s = testo(v);
    return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

function soggetto(v: unknown): FpSoggetto {
    const n = nodo(v);
    const ana = nodo(n.DatiAnagrafici);
    const iva = nodo(ana.IdFiscaleIVA);
    const anagrafica = nodo(ana.Anagrafica);
    const sede = nodo(n.Sede);
    const contatti = nodo(n.Contatti);
    const paese = testo(iva.IdPaese);
    const codice = testo(iva.IdCodice);
    const denominazione = pulisci(testo(anagrafica.Denominazione))
        || pulisci(`${testo(anagrafica.Nome) ?? ''} ${testo(anagrafica.Cognome) ?? ''}`);
    const indirizzo = [testo(sede.Indirizzo), testo(sede.NumeroCivico), testo(sede.CAP), testo(sede.Comune),
        testo(sede.Provincia) ? `(${testo(sede.Provincia)})` : null]
        .filter(Boolean).join(' ');
    return {
        piva: codice ? `${paese && paese !== 'IT' ? paese : ''}${codice.replace(/\s+/g, '')}` : null,
        codiceFiscale: testo(ana.CodiceFiscale),
        denominazione: denominazione || 'Senza nome',
        indirizzo: indirizzo || null,
        email: testo(contatti.Email),
        telefono: testo(contatti.Telefono),
    };
}

const EAN_TIPO_RE = /EAN|GTIN|UPC|BAR\s*CODE|BARCODE|COD.*BARRE/i;

/** EAN/GTIN: solo cifre, e il GTIN-14 con lo zero davanti torna EAN-13. */
export function normalizzaEan(valore: string): string | null {
    const cifre = valore.replace(/\s+/g, '');
    if (!/^\d{8}$|^\d{12,14}$/.test(cifre)) return null;
    return cifre.length === 14 && cifre.startsWith('0') ? cifre.slice(1) : cifre;
}

const LOTTO_RE = /LOTT|^LOT\.?$|^N\.?\s*LOT/i;
const SCADENZA_RE = /SCAD|EXPIR|TMC|^DATA\s*SCAD/i;

function classifica(r: Pick<FpRiga, 'tipoCessione' | 'quantita' | 'prezzoTotale'>): TipoRiga {
    if (r.tipoCessione === 'SC' || r.tipoCessione === 'PR' || r.tipoCessione === 'AB') return 'sconto';
    if (r.tipoCessione === 'AC') return 'spesa';
    if (r.quantita == null || r.quantita === 0) return r.prezzoTotale === 0 ? 'nota' : 'servizio';
    if (r.prezzoTotale < 0) return 'sconto';
    return 'merce';
}

function riga(v: Nodo, ddtPerLinea: Map<number, string>, ddtPerTutte: string | null): FpRiga {
    const codici = lista(v.CodiceArticolo)
        .map(c => ({ tipo: pulisci(testo(c.CodiceTipo)), valore: pulisci(testo(c.CodiceValore)) }))
        .filter(c => c.valore);
    let ean: string | null = null;
    let codice: string | null = null;
    for (const c of codici) {
        const comeEan = EAN_TIPO_RE.test(c.tipo) ? normalizzaEan(c.valore) : null;
        if (comeEan && !ean) ean = comeEan;
        else if (!comeEan && !codice) codice = c.valore;
    }
    const altriDati = lista(v.AltriDatiGestionali).map(a => ({
        tipo: pulisci(testo(a.TipoDato)),
        testo: testo(a.RiferimentoTesto),
        numero: numero(a.RiferimentoNumero),
        data: data(a.RiferimentoData),
    }));
    const lottoDato = altriDati.find(a => LOTTO_RE.test(a.tipo) && (a.testo || a.numero != null));
    const scadenzaDato = altriDati.find(a => SCADENZA_RE.test(a.tipo) && (a.data || a.testo));
    const sconti = lista(v.ScontoMaggiorazione).map(s => ({
        tipo: (testo(s.Tipo) === 'MG' ? 'MG' : 'SC') as 'SC' | 'MG',
        percentuale: numero(s.Percentuale),
        importo: numero(s.Importo),
    }));
    const numeroLinea = numero(v.NumeroLinea) ?? 0;
    const quantita = numero(v.Quantita);
    const prezzoTotale = numero(v.PrezzoTotale) ?? 0;
    const tipoCessione = testo(v.TipoCessionePrestazione);
    const descrizione = pulisci(testo(v.Descrizione));
    const parziale = {
        numero: numeroLinea,
        codici,
        ean,
        codice,
        descrizione: descrizione === '-' || descrizione === '.' ? '' : descrizione,
        quantita,
        unitaMisura: pulisci(testo(v.UnitaMisura)) || null,
        prezzoUnitario: numero(v.PrezzoUnitario) ?? 0,
        prezzoTotale,
        aliquotaIva: numero(v.AliquotaIVA) ?? 0,
        natura: testo(v.Natura),
        tipoCessione,
        sconti,
        lotto: lottoDato ? (lottoDato.testo ?? String(lottoDato.numero)) : null,
        scadenza: scadenzaDato ? (scadenzaDato.data ?? scadenzaDato.testo) : null,
        altriDati,
        ddt: ddtPerLinea.get(numeroLinea) ?? ddtPerTutte,
    };
    return { ...parziale, tipo: classifica(parziale) };
}

function corpo(header: Nodo, body: Nodo, indiceBody: number): FpFattura {
    const generali = nodo(nodo(body.DatiGenerali).DatiGeneraliDocumento);
    const datiGenerali = nodo(body.DatiGenerali);
    const beni = nodo(body.DatiBeniServizi);

    const ddt: FpDdt[] = lista(datiGenerali.DatiDDT).map(d => ({
        numero: pulisci(testo(d.NumeroDDT)),
        data: data(d.DataDDT),
        linee: Array.isArray(d.RiferimentoNumeroLinea)
            ? d.RiferimentoNumeroLinea.map(n => numero(n) ?? 0).filter(n => n > 0)
            : [],
    })).filter(d => d.numero);
    const ddtPerLinea = new Map<number, string>();
    let ddtPerTutte: string | null = null;
    for (const d of ddt) {
        if (d.linee.length === 0) ddtPerTutte = ddtPerTutte ?? d.numero;
        for (const n of d.linee) if (!ddtPerLinea.has(n)) ddtPerLinea.set(n, d.numero);
    }

    const righe = lista(beni.DettaglioLinee).map(r => riga(r, ddtPerLinea, ddtPerTutte));
    const riepilogo = lista(beni.DatiRiepilogo).map(r => ({
        aliquota: numero(r.AliquotaIVA) ?? 0,
        natura: testo(r.Natura),
        imponibile: numero(r.ImponibileImporto) ?? 0,
        imposta: numero(r.Imposta) ?? 0,
    }));
    const pagamenti: FpScadenza[] = [];
    for (const p of lista(body.DatiPagamento)) {
        for (const d of lista(p.DettaglioPagamento)) {
            pagamenti.push({
                modalita: testo(d.ModalitaPagamento),
                data: data(d.DataScadenzaPagamento),
                importo: numero(d.ImportoPagamento),
                iban: testo(d.IBAN),
                istituto: testo(d.IstitutoFinanziario),
            });
        }
    }
    const allegati = lista(body.Allegati).map((a, indice) => {
        const b64 = testo(a.Attachment) ?? '';
        return {
            indice,
            nome: pulisci(testo(a.NomeAttachment)) || `allegato-${indice + 1}`,
            formato: testo(a.FormatoAttachment),
            descrizione: testo(a.DescrizioneAttachment),
            bytes: Math.floor((b64.replace(/\s+/g, '').length * 3) / 4),
        };
    });

    const tipoDocumento = testo(generali.TipoDocumento) ?? 'TD01';
    const numeroDoc = pulisci(testo(generali.Numero));
    const dataDoc = data(generali.Data);
    if (!numeroDoc || !dataDoc) throw new FatturaPaError('La fattura non ha numero o data');
    const causali = Array.isArray(generali.Causale)
        ? generali.Causale.map(c => pulisci(testo(c))).filter(Boolean).join(' ')
        : '';

    const arrotonda = (n: number) => Math.round(n * 100) / 100;
    return {
        indiceBody,
        cedente: soggetto(header.CedentePrestatore),
        cessionario: soggetto(header.CessionarioCommittente),
        codiceDestinatario: testo(nodo(header.DatiTrasmissione).CodiceDestinatario),
        tipoDocumento,
        notaDiCredito: tipoDocumento === 'TD04',
        divisa: testo(generali.Divisa) ?? 'EUR',
        data: dataDoc,
        numero: numeroDoc,
        importoTotale: numero(generali.ImportoTotaleDocumento),
        imponibile: arrotonda(riepilogo.reduce((s, r) => s + r.imponibile, 0)),
        imposta: arrotonda(riepilogo.reduce((s, r) => s + r.imposta, 0)),
        causale: causali || null,
        ddt,
        righe,
        riepilogo,
        pagamenti,
        allegati,
    };
}

function radice(xml: string): Nodo {
    // Le fatture non hanno mai una DOCTYPE: se c'è, è un tentativo di
    // espandere entità (o di leggere file) e si rifiuta prima di parsare.
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FatturaPaError('Il file contiene una DOCTYPE: non è una fattura valida');
    let parsed: Nodo;
    try {
        parsed = nodo(parser.parse(xml));
    } catch {
        throw new FatturaPaError('L\'XML non è leggibile');
    }
    if (parsed.FatturaElettronicaSemplificata) throw new FatturaPaError('Le fatture semplificate non sono supportate');
    const root = parsed.FatturaElettronica;
    if (!root) throw new FatturaPaError('Non è una fattura elettronica');
    return nodo(root);
}

/** Tutte le fatture di un file (di solito una; un «lotto» ne porta di più). */
export function leggiFatture(xml: string): FpFattura[] {
    const root = radice(xml);
    const header = nodo(root.FatturaElettronicaHeader);
    const bodies = lista(root.FatturaElettronicaBody);
    if (bodies.length === 0) throw new FatturaPaError('La fattura non ha corpo');
    return bodies.map((b, i) => corpo(header, b, i));
}

/** Il file allegato (di solito il PDF di cortesia), decodificato. */
export function estraiAllegato(xml: string, indiceBody: number, indice: number): { nome: string; formato: string | null; dati: Buffer } | null {
    const root = radice(xml);
    const body = lista(root.FatturaElettronicaBody)[indiceBody];
    if (!body) return null;
    const a = lista(body.Allegati)[indice];
    if (!a) return null;
    const b64 = (testo(a.Attachment) ?? '').replace(/\s+/g, '');
    if (!b64) return null;
    return {
        nome: pulisci(testo(a.NomeAttachment)) || `allegato-${indice + 1}`,
        formato: testo(a.FormatoAttachment),
        dati: Buffer.from(b64, 'base64'),
    };
}

// ---- Chiavi per la memoria degli abbinamenti -----------------------------------

export type TipoChiave = 'ean' | 'codice' | 'descrizione';

/** La descrizione come chiave: maiuscole, spazi singoli, senza punteggiatura in coda. */
export function normalizzaDescrizione(s: string): string {
    return s
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/[\s.,;:\-*]+$/, '')
        .trim()
        .slice(0, 200);
}

/**
 * Come si riconosce la stessa merce alla fattura dopo, a parità di
 * fornitore: l'EAN se c'è, poi il codice del fornitore, poi la descrizione.
 */
export function chiaveArticolo(r: Pick<FpRiga, 'ean' | 'codice' | 'descrizione'>): { tipo: TipoChiave; valore: string } | null {
    if (r.ean) return { tipo: 'ean', valore: r.ean };
    if (r.codice) return { tipo: 'codice', valore: r.codice.toUpperCase().slice(0, 100) };
    const d = normalizzaDescrizione(r.descrizione);
    return d ? { tipo: 'descrizione', valore: d } : null;
}
