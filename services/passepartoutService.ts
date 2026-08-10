// Passepartout Menù — client SOAP per il Tool di Sviluppo (Web Service "AdapterWS").
//
// Il gestionale in sala (POS Passepartout Menù, on-premise) espone il Web Service
// del modulo Replica Dati/MessageBox: WSDL su http://<host>:<porta>/?wsdl e
// endpoint SOAP su http://<host>:<porta>/AdapterWS (binding BasicHttpBinding,
// SOAPAction "http://tempuri.org/IAdapterWS/<Operazione>"). Ogni chiamata è
// autenticata da un blocco InfoLogin (utente/password del gestionale) e consuma
// un terminale della licenza per la sola durata della richiesta.
//
// Le operazioni mappate qui sono il sottoinsieme che serve al pay-at-table
// (Fase 2 dello split conto): lettura della comanda attiva su un tavolo con il
// dettaglio righe, elenco dei tipi di pagamento configurati in cassa e chiusura
// della comanda (ContoComanda) con tipo documento/pagamento e importo pagato —
// se l'importo è inferiore al totale il conto resta a sospeso, che è il gancio
// per i pagamenti parziali. StampaPrecontoComanda esiste solo nella DLL .NET,
// non nel Web Service, quindi non è mappabile da qui.
//
// Il server del gestionale è raggiungibile solo dalla LAN del ristorante: in
// produzione queste funzioni girano nell'agente locale/bridge, non su Railway.
// La configurazione è solo da env per questo motivo (niente riga in
// integration_settings: non c'è nulla da editare dalla UI, e le credenziali
// vivono dove gira l'agente).

import { XMLParser } from 'fast-xml-parser';

const TEMPURI = 'http://tempuri.org/';
const NS_KERNEL = 'http://schemas.datacontract.org/2004/07/PMessageBox.Kernel';

export interface PassepartoutConfig {
    /** Endpoint SOAP completo, es. http://192.168.1.10:7606/AdapterWS */
    url: string;
    utente: string;
    password: string;
    /** Campi opzionali di InfoLogin, normalmente vuoti su Menù. */
    azienda: string;
    bew: string;
}

export function getPassepartoutConfig(): PassepartoutConfig {
    return {
        url: (process.env.PASSEPARTOUT_WS_URL || '').trim().replace(/\/$/, ''),
        utente: process.env.PASSEPARTOUT_WS_USER || '',
        password: process.env.PASSEPARTOUT_WS_PASSWORD || '',
        azienda: process.env.PASSEPARTOUT_WS_AZIENDA || '',
        bew: process.env.PASSEPARTOUT_WS_BEW || '',
    };
}

export function isPassepartoutConfigured(): boolean {
    const c = getPassepartoutConfig();
    return Boolean(c.url && c.utente);
}

/** Errore applicativo restituito dal gestionale (SOAP Fault). */
export class PassepartoutError extends Error {
    constructor(message: string, public readonly operation: string, public readonly httpStatus?: number) {
        super(message);
        this.name = 'PassepartoutError';
    }
}

// EnumTipoDocumentoConto del gestionale — via SOAP l'enum viaggia come nome.
export type TipoDocumentoConto =
    | 'Scontrino'
    | 'FatturaRicevutaFiscale'
    | 'Proforma'
    | 'RicevutaFiscale'
    | 'NotaCredito'
    | 'Fattura';

export interface PassepartoutRigaComanda {
    idGestionale: number | null;
    articolo: string | null;
    descrizione: string | null;
    pezzi: number | null;
    prezzo: number | null;
    totale: number | null;
    iva: number | null;
    /** Posto a sedere che ha ordinato la riga (se il POS traccia i posti). */
    posto: number | null;
    uscita: number | null;
    isPagato: boolean;
    isOfferto: boolean;
    stato: string | null;
    tipo: string | null;
}

export interface PassepartoutComanda {
    idGestionale: number | null;
    tavolo: string | null;
    sala: string | null;
    coperti: number | null;
    stato: string | null;
    isPagato: boolean;
    isParziale: boolean;
    importoPrePagato: number | null;
    sconto: number | null;
    listino: number | null;
    note: string | null;
    righe: PassepartoutRigaComanda[];
}

export interface PassepartoutTipoPagamento {
    /** Nome del tipo pagamento in cassa (es. "Contanti", "POS", "BONIFICO") — è il valore da passare a contoComanda. */
    codice: string;
    /** Categoria interna del gestionale (es. "Contanti", "CartaCredito1", "Varie1"). */
    categoria: string | null;
}

// ---------------------------------------------------------------------------
// Trasporto SOAP
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// L'ordine dei figli di InfoLogin è fissato dallo schema (xs:sequence):
// Azienda, Bew, Password, Utente. I campi vuoti si omettono (minOccurs=0).
function infoLoginXml(c: PassepartoutConfig): string {
    const parts: string[] = [];
    if (c.azienda) parts.push(`<k:Azienda>${xmlEscape(c.azienda)}</k:Azienda>`);
    if (c.bew) parts.push(`<k:Bew>${xmlEscape(c.bew)}</k:Bew>`);
    parts.push(`<k:Password>${xmlEscape(c.password)}</k:Password>`);
    parts.push(`<k:Utente>${xmlEscape(c.utente)}</k:Utente>`);
    return `<datiLogin xmlns:k="${NS_KERNEL}">${parts.join('')}</datiLogin>`;
}

const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false, // i numeri li convertiamo noi, campo per campo
    isArray: (name) => name === 'PMBRigaComanda' || name === 'PMBRigaConto' || name === 'PMBTipoPagamento',
});

/**
 * Esegue una chiamata SOAP all'AdapterWS. `paramsXml` sono gli elementi dopo
 * datiLogin, già serializzati nell'ordine dello schema (namespace tempuri).
 */
async function soapCall(operation: string, paramsXml = '', timeoutMs = 20_000): Promise<unknown> {
    const config = getPassepartoutConfig();
    if (!config.url) {
        throw new PassepartoutError('PASSEPARTOUT_WS_URL non configurato', operation);
    }
    const envelope =
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<${operation} xmlns="${TEMPURI}">${infoLoginXml(config)}${paramsXml}</${operation}>` +
        `</s:Body></s:Envelope>`;

    // Il signal deve coprire anche il download del body (response.text()),
    // non solo l'handshake: il gestionale sotto carico può restare muto a lungo.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
        response = await fetch(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: `"${TEMPURI}IAdapterWS/${operation}"`,
            },
            body: envelope,
            signal: controller.signal,
        });
        text = await response.text();
    } catch (err) {
        throw new PassepartoutError(
            `Gestionale non raggiungibile (${(err as Error).message})`,
            operation,
        );
    } finally {
        clearTimeout(timer);
    }
    const doc = parser.parse(text) as Record<string, any>;
    const body = doc?.Envelope?.Body;

    const fault = body?.Fault;
    if (fault) {
        const faultstring = typeof fault.faultstring === 'object'
            ? fault.faultstring['#text']
            : fault.faultstring;
        // Il fault WCF arriva con i CR codificati come charref numerici, che il
        // parser non espande: normalizziamo in un messaggio a riga singola.
        const message = String(faultstring || 'SOAP Fault senza messaggio')
            .replace(/&#x?[0-9a-fA-F]+;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        throw new PassepartoutError(message, operation, response.status);
    }
    if (!response.ok) {
        throw new PassepartoutError(`HTTP ${response.status}`, operation, response.status);
    }
    return body?.[`${operation}Response`]?.[`${operation}Result`] ?? null;
}

// ---------------------------------------------------------------------------
// Helper di mapping (il serializzatore WCF marca i null con i:nil="true")
// ---------------------------------------------------------------------------

function isNil(v: unknown): boolean {
    return v == null || (typeof v === 'object' && (v as Record<string, unknown>)['@_i:nil'] === 'true')
        || (typeof v === 'object' && (v as Record<string, unknown>)['@_nil'] === 'true');
}

function asString(v: unknown): string | null {
    if (isNil(v)) return null;
    if (typeof v === 'object') return String((v as Record<string, unknown>)['#text'] ?? '') || null;
    return String(v);
}

function asNumber(v: unknown): number | null {
    const s = asString(v);
    if (s == null || s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function asBoolean(v: unknown): boolean {
    return asString(v) === 'true';
}

function mapRigaComanda(r: Record<string, unknown>): PassepartoutRigaComanda {
    return {
        idGestionale: asNumber(r.IdGestionale),
        articolo: asString(r.Articolo),
        descrizione: asString(r.Descrizione),
        pezzi: asNumber(r.Pezzi),
        prezzo: asNumber(r.Prezzo),
        totale: asNumber(r.Totale),
        iva: asNumber(r.IVA),
        posto: asNumber(r.Posto),
        uscita: asNumber(r.Uscita),
        isPagato: asBoolean(r.IsPagato),
        isOfferto: asBoolean(r.IsOfferto),
        stato: asString(r.Stato),
        tipo: asString(r.Tipo),
    };
}

function mapComanda(c: Record<string, any>): PassepartoutComanda {
    const righeRaw: Record<string, unknown>[] = c?.Righe?.PMBRigaComanda ?? [];
    return {
        idGestionale: asNumber(c.IdGestionale),
        tavolo: asString(c.Tavolo),
        sala: asString(c.Sala),
        coperti: asNumber(c.Coperti),
        stato: asString(c.Stato),
        isPagato: asBoolean(c.IsPagato),
        isParziale: asBoolean(c.IsParziale),
        importoPrePagato: asNumber(c.ImportoPrePagato),
        sconto: asNumber(c.Sconto),
        listino: asNumber(c.Listino),
        note: asString(c.Note),
        righe: righeRaw.map(mapRigaComanda),
    };
}

// ---------------------------------------------------------------------------
// Operazioni
// ---------------------------------------------------------------------------

/** Versione commerciale del gestionale — usata come ping/verifica credenziali. */
export async function getVersioneGestionale(): Promise<string | null> {
    return asString(await soapCall('GetVersioneGestionale'));
}

/**
 * Comanda attiva sul tavolo indicato (nome tavolo così come configurato in
 * sala, es. "12"). Restituisce null se il gestionale non ha comande aperte
 * sul tavolo.
 */
export async function getComandaTavolo(tavolo: string): Promise<PassepartoutComanda | null> {
    const result = await soapCall('GetComandaTavolo', `<tavolo>${xmlEscape(tavolo)}</tavolo>`);
    if (result == null || isNil(result)) return null;
    return mapComanda(result as Record<string, unknown>);
}

/** Comanda per id gestionale. */
export async function getComanda(idGestionale: number): Promise<PassepartoutComanda | null> {
    const result = await soapCall('GetComanda', `<idGestionale>${idGestionale}</idGestionale>`);
    if (result == null || isNil(result)) return null;
    return mapComanda(result as Record<string, unknown>);
}

/** Tipi di pagamento configurati in cassa. */
export async function getTipiPagamento(): Promise<PassepartoutTipoPagamento[]> {
    const result = (await soapCall('GetTipiPagamento')) as Record<string, any> | null;
    if (!result) return [];
    const entries: Record<string, unknown>[] = result.PMBTipoPagamento ?? [];
    return entries
        .map((e) => ({ codice: asString(e.Codice) ?? '', categoria: asString(e.Categoria) }))
        .filter((e) => e.codice !== '');
}

/** Sale ristorante configurate e attive (es. "TETTOIA", "FIUME", "DENTRO"). */
export async function getSaleMenu(): Promise<string[]> {
    const result = (await soapCall('GetSaleMenu')) as Record<string, any> | null;
    if (!result) return [];
    const sale = result.string ?? [];
    return (Array.isArray(sale) ? sale : [sale]).map((s: unknown) => String(s));
}

/**
 * Chiude la comanda in conto ("conto unico comanda").
 *
 * - `importoPagato` inferiore al totale → il conto va a SOSPESO (pagamento
 *   parziale); omesso → il conto risulta interamente pagato.
 * - `tipoDocumento` omesso → tipo documento di default della sala.
 * - `tipoPagamento` è la DESCRIZIONE del tipo configurato in cassa (vedi
 *   getTipiPagamento) — per il CRM va usato il tipo dedicato "esterno" così
 *   la cassa non conteggia l'incasso due volte.
 * - `noInvio` disabilita l'invio in produzione delle righe non ancora inviate.
 *
 * ATTENZIONE: con tipoDocumento "Scontrino" il gestionale pilota il documento
 * fiscale. Da collaudare su un conto di prova prima di qualsiasi uso reale.
 */
export async function contoComanda(params: {
    idComanda: number;
    noInvio?: boolean;
    tipoDocumento?: TipoDocumentoConto;
    tipoPagamento?: string;
    importoPagato?: number;
}): Promise<void> {
    const parts = [
        `<idComanda>${params.idComanda}</idComanda>`,
        `<noInvio>${params.noInvio ? 'true' : 'false'}</noInvio>`,
    ];
    if (params.tipoDocumento) parts.push(`<tipoDoc>${params.tipoDocumento}</tipoDoc>`);
    if (params.tipoPagamento) parts.push(`<tipoPag>${xmlEscape(params.tipoPagamento)}</tipoPag>`);
    if (params.importoPagato != null) parts.push(`<importoPag>${params.importoPagato.toFixed(2)}</importoPag>`);
    await soapCall('ContoComanda', parts.join(''));
}

/**
 * Conto chiuso per id. Restituisce il payload grezzo (già senza namespace):
 * i campi utili al CRM sono NumeroScontrinoFiscale, IsScontrinoTelematico,
 * TotalePagato, TotaleDaPagare, Sospeso, IdComanda.
 */
export async function getConto(idGestionale: number): Promise<Record<string, unknown> | null> {
    const result = await soapCall('GetConto', `<idGestionale>${idGestionale}</idGestionale>`);
    if (result == null || isNil(result)) return null;
    return result as Record<string, unknown>;
}

/**
 * Conti del giorno (archivio). È la FONTE DI VERITÀ dell'esito di una
 * chiusura: la risposta di ContoComanda può dire errore anche a scontrino
 * emesso — l'unico verdetto affidabile è la presenza del conto in archivio
 * con NumeroScontrinoFiscale (lezione dei collaudi 04/08). `data` in formato
 * YYYY-MM-DD; omessa = oggi.
 */
export async function getContiGiorno(data?: string): Promise<Record<string, unknown>[]> {
    const giorno = data ?? new Date().toISOString().slice(0, 10);
    // Il parametro WSDL si chiama `giorno` (xs:dateTime).
    const result = (await soapCall('GetContiGiorno', `<giorno>${giorno}T00:00:00</giorno>`)) as Record<string, any> | null;
    if (!result || isNil(result)) return [];
    const entries = result.ContrattoConto ?? [];
    return Array.isArray(entries) ? entries : [entries];
}
