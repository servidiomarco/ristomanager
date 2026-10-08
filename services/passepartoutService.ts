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
// Elenco preso dall'XSD del WSDL (xsd8, 25/08) — fa fede quello: le etichette
// del codice di esempio del supporto ("FatturaScontrino", "ResoNCScontrino")
// sono nomi da form, non valori dell'enum, e non deserializzano.
export type TipoDocumentoConto =
    | 'Scontrino'
    | 'FatturaRicevutaFiscale'
    | 'Proforma'
    | 'RicevutaFiscale'
    | 'ProformaHotel'
    | 'RicevutaHotel'
    | 'NotaCredito'
    | 'Fattura'
    | 'ScontrinoResoNC'
    | 'ScontrinoHotel';

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
    /** EnumStatoRigaComanda: Nuovo, InAttesa, InProduzione, Fatto,
     *  Cancellato, Preventivo. */
    statoEnum?: string | null;
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
    /** La prenotazione del planning da cui il tavolo è stato aperto, se c'è. */
    idPrenotazione?: number | null;
    dataCreazione?: string | null;
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
    isArray: (name) => name === 'PMBRigaComanda' || name === 'PMBRigaConto' || name === 'PMBTipoPagamento'
        || name === 'ContrattoArticolo' || name === 'ContrattoPrenotazioneMenu' || name === 'PMBTavolo'
        || name === 'ContrattoConto' || name === 'ContrattoComanda' || name === 'PMBRigaPagamento',
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
        statoEnum: asString(r.StatoEnum),
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
        idPrenotazione: asNumber(c.IdPrenotazione) || null,
        dataCreazione: asString(c.DataCreazioneSistema),
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

/** Articolo del menu di cassa, già ridotto ai campi che servono al CRM.
 *  NIENTE immagini: ImmagineBin/FotoBin pesano ~14MB sull'intero catalogo e
 *  sfonderebbero il buffer del socket verso il bridge — se un giorno servono,
 *  si aggiunge una op per-articolo. */
export interface PassepartoutArticolo {
    idGestionale: number;
    codice: string | null;
    descrizione: string | null;
    prezzo: number | null;
    /** Aliquota IVA in percento intero (es. 10), se determinabile. */
    ivaPercento: number | null;
    attivo: boolean;
    /** EnumTipoArticolo: "Semplice" | "Generico" | "Variante" | ... */
    tipo: string | null;
    categoria: string | null;
    categoriaPadre: string | null;
    /** false se la categoria (o la sua padre) è disattivata in cassa: in
     *  Passepartout le voci con storico non si eliminano, si spengono — e
     *  quelle non sono menu. Default true se il campo manca nel contratto. */
    categoriaAttiva: boolean;
    /** Codici delle varianti attaccate all'ARTICOLO (es. "Ghiaccio"): sono i
     *  Codice di altri articoli del catalogo di tipo Variante. */
    varianti: string[];
    /** Codici delle varianti della CATEGORIA dell'articolo (es. "In 2 piatti"):
     *  valgono per tutti gli articoli della categoria. */
    categoriaVarianti: string[];
}

/**
 * Catalogo articoli del gestionale (GetArticoli). `ultimaModifica` è il
 * filtro delta del WSDL; omesso = tutto il catalogo, che è anche il default
 * giusto per il sync del menu: solo la lista completa rivela gli articoli
 * spariti dalla cassa, da spegnere lato CRM.
 */
export async function getArticoliMenu(ultimaModifica?: string): Promise<PassepartoutArticolo[]> {
    const dal = ultimaModifica ?? '2000-01-01T00:00:00';
    const result = (await soapCall(
        'GetArticoli',
        `<ultimaModifica>${xmlEscape(dal)}</ultimaModifica>`,
        120_000, // 441 articoli con immagini incorporate = ~14MB di XML
    )) as Record<string, any> | null;
    if (!result || isNil(result)) return [];
    const entries: Record<string, any>[] = result.ContrattoArticolo ?? [];
    // Le liste Varianti sono ArrayOfstring del serializzatore WCF: dopo il
    // parser diventano { string: 'x' } oppure { string: ['x','y'] }.
    const codici = (v: unknown): string[] => {
        if (v == null || isNil(v)) return [];
        const raw = (v as Record<string, unknown>).string;
        if (raw == null) return [];
        return (Array.isArray(raw) ? raw : [raw]).map((s) => String(s).trim()).filter((s) => s !== '');
    };
    return entries
        .map((a) => {
            const id = asNumber(a.IdGestionale);
            if (id == null) return null;
            const cat = a.Categoria && !isNil(a.Categoria) ? a.Categoria : null;
            const padre = cat?.Padre && !isNil(cat.Padre) ? cat.Padre : null;
            // IsAttivo sulla categoria: presente solo su alcune installazioni,
            // e un campo assente NON significa categoria spenta — default true.
            const catAttiva = (c: Record<string, any> | null): boolean =>
                c == null || c.IsAttivo == null ? true : asBoolean(c.IsAttivo);
            // AliquotaIVA è un contratto ("10%" nel Codice, "10.00" in
            // Percentuale) ma su qualche installazione arriva come stringa:
            // si prova Percentuale, poi il numero dentro la stringa.
            const ivaRaw = a.AliquotaIVA && !isNil(a.AliquotaIVA)
                ? (typeof a.AliquotaIVA === 'object' ? a.AliquotaIVA.Percentuale ?? a.AliquotaIVA.Codice : a.AliquotaIVA)
                : null;
            const ivaNum = ivaRaw != null ? Number(String(ivaRaw).replace('%', '').replace(',', '.')) : NaN;
            return {
                idGestionale: id,
                codice: asString(a.Codice),
                descrizione: asString(a.Descrizione),
                prezzo: asNumber(a.Prezzo),
                ivaPercento: Number.isFinite(ivaNum) ? Math.round(ivaNum) : null,
                attivo: asBoolean(a.IsAttivo),
                tipo: asString(a.TipoEnum),
                categoria: cat ? asString(cat.Descrizione) : null,
                categoriaPadre: padre ? asString(padre.Descrizione) : null,
                varianti: codici(a.Varianti),
                categoriaVarianti: codici(cat?.Varianti),
                categoriaAttiva: catAttiva(cat) && catAttiva(padre),
            } satisfies PassepartoutArticolo;
        })
        .filter((a): a is PassepartoutArticolo => a != null);
}

/** Sale ristorante configurate e attive (es. "TETTOIA", "FIUME", "DENTRO"). */
export async function getSaleMenu(): Promise<string[]> {
    const result = (await soapCall('GetSaleMenu')) as Record<string, any> | null;
    if (!result) return [];
    const sale = result.string ?? [];
    return (Array.isArray(sale) ? sale : [sale]).map((s: unknown) => String(s));
}

/**
 * Invia in produzione le righe della comanda (l'equivalente del tasto Invio
 * in cassa). `inviaTutto` manda tutte le uscite; in alternativa `uscite`
 * elenca i numeri di uscita da mandare. Per le comande create via WS va
 * chiamata PRIMA di contoComanda: l'invio non deve mai essere contestuale
 * alla chiusura (vedi nota su contoComanda).
 */
export async function inviaProduzioneComanda(params: {
    idComanda: number;
    inviaTutto?: boolean;
    uscite?: number[];
}): Promise<void> {
    const uscite = params.uscite ?? [];
    // `uscite` è un ArrayOfint del serializzatore WCF; vuoto = nessun filtro.
    const usciteXml = uscite.length
        ? `<uscite xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${uscite
            .map((u) => `<a:int>${u}</a:int>`).join('')}</uscite>`
        : '<uscite/>';
    await soapCall(
        'InviaProduzioneComanda',
        `<idComanda>${params.idComanda}</idComanda>` +
        `<inviaTutto>${params.inviaTutto === false ? 'false' : 'true'}</inviaTutto>` +
        usciteXml,
    );
}

/**
 * Chiude la comanda in conto ("conto unico comanda").
 *
 * `noInvio` è SEMPRE true e non è più un parametro: se ContoComanda esegue
 * anche l'invio in produzione, l'invio aggiorna il timeStmp della comanda e
 * il passo pagamento della stessa chiamata muore sul lock ottimistico
 * ("modificate le informazioni da un altro utente" — i 6 tentativi falliti
 * del collaudo 10/08). È la ricetta del supporto Passepartout
 * (contoComanda.php del 25/08, `noInvio` forzato a true "per evitare il
 * reinvio in produzione che causa il conflitto di timeStmp"): l'invio, se
 * serve, si fa prima con inviaProduzioneComanda.
 *
 * - `importoPagato` OMESSO → il conto risulta interamente pagato: è la
 *   chiusura normale. Un importo inferiore al totale → conto a SOSPESO, il
 *   gancio per i pagamenti parziali. Mai passare il totale calcolato dal
 *   CRM per una chiusura piena: un centesimo di scarto lascia il conto
 *   sospeso e il tavolo occupato.
 * - `tipoDocumento` omesso → tipo documento di default della sala.
 * - `tipoPagamento` è la DESCRIZIONE del tipo configurato in cassa (vedi
 *   getTipiPagamento) — per il CRM va usato il tipo dedicato "esterno" così
 *   la cassa non conteggia l'incasso due volte.
 *
 * ATTENZIONE: con tipoDocumento "Scontrino" il gestionale pilota il documento
 * fiscale. La risposta può dire errore anche a scontrino emesso: il verdetto
 * affidabile è l'archivio (getContiGiorno) — usare chiudiComandaCompleta.
 */
export async function contoComanda(params: {
    idComanda: number;
    tipoDocumento?: TipoDocumentoConto;
    tipoPagamento?: string;
    importoPagato?: number;
}): Promise<void> {
    const parts = [
        `<idComanda>${params.idComanda}</idComanda>`,
        `<noInvio>true</noInvio>`,
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

/**
 * Chiude un conto già in archivio via PutConto con ComandoEnum "Chiudi"
 * (NON "ChiudiEStampa": il documento è già stato emesso da ContoComanda e
 * non va ristampato). È il passo che ContoComanda via AdapterWS non
 * completa mai da sé: il suo passo pagamento muore sul lock ottimistico
 * ("modificate le informazioni da un altro utente" — collaudi 10/08 e
 * 25/08) e il conto resta Aperto, sospeso per l'intero importo.
 *
 * Con `pagamento` il conto viene saldato e chiude Pagato: verificato sul
 * campo il 25/08 (conto 80899 → StatoEnum Pagato, tavolo liberato, stesso
 * numero scontrino). SENZA `pagamento` chiude lasciando il sospeso — è la
 * chiusura proforma / "paga dopo", il conto resta da regolarizzare in
 * cassa. Restituisce il ContrattoConto aggiornato.
 */
export async function saldaConto(params: {
    idConto: number;
    idComanda: number;
    pagamento?: { importo: number; tipo: PassepartoutTipoPagamento };
    /** Il documento con cui chiudere un conto che non l'ha ancora emesso
     *  (il conto di un preconto). Assente: resta quello del conto. */
    tipoDocumento?: TipoDocumentoConto;
    /** «ChiudiEStampa» emette e stampa il documento: serve allo scontrino
     *  di un conto di preconto. Default «Chiudi», senza stampa. */
    comando?: 'Chiudi' | 'ChiudiEStampa';
}): Promise<Record<string, unknown> | null> {
    const NS_CONTO = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Conto';
    const NS_COMMON = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Common';
    // ContrattoConto è tutto minOccurs=0, ma l'ordine dei membri è quello
    // alfabetico del data contract WCF: ComandoEnum, IdComanda, IdGestionale,
    // Pagamenti, TipoDocumentoEnum. Dentro PMBRigaPagamento: Importo prima
    // di Tipo; dentro PMBTipoPagamento (namespace Common): Categoria prima
    // di Codice.
    const pagamentiXml = params.pagamento
        ? `<c:Pagamenti><c:PMBRigaPagamento>` +
          `<c:Importo>${params.pagamento.importo.toFixed(2)}</c:Importo>` +
          `<c:Tipo>` +
          (params.pagamento.tipo.categoria ? `<cm:Categoria>${xmlEscape(params.pagamento.tipo.categoria)}</cm:Categoria>` : '') +
          `<cm:Codice>${xmlEscape(params.pagamento.tipo.codice)}</cm:Codice>` +
          `</c:Tipo>` +
          `</c:PMBRigaPagamento></c:Pagamenti>`
        : '';
    const contoXml =
        `<conto xmlns:c="${NS_CONTO}" xmlns:cm="${NS_COMMON}">` +
        `<c:ComandoEnum>${params.comando ?? 'Chiudi'}</c:ComandoEnum>` +
        `<c:IdComanda>${params.idComanda}</c:IdComanda>` +
        `<c:IdGestionale>${params.idConto}</c:IdGestionale>` +
        pagamentiXml +
        (params.tipoDocumento ? `<c:TipoDocumentoEnum>${params.tipoDocumento}</c:TipoDocumentoEnum>` : '') +
        `</conto>`;
    const result = await soapCall('PutConto', contoXml);
    return result == null || isNil(result) ? null : (result as Record<string, unknown>);
}

export interface EsitoChiusuraComanda {
    /** true se il conto è comparso nell'archivio del giorno (fonte di verità). */
    chiuso: boolean;
    /** Importo residuo a sospeso (0 = interamente pagato). */
    importoSospeso: number;
    /** StatoEnum del conto: "Pagato" a chiusura completa, "Aperto" se sospeso. */
    stato: string | null;
    numeroScontrino: string | null;
    totalePagato: number | null;
    totaleDaPagare: number | null;
    /** Anomalie non bloccanti (es. errore di ContoComanda con conto in archivio). */
    avviso: string | null;
}

/**
 * Sequenza di chiusura completa, come emersa dai collaudi del 25/08:
 *
 * 1. eventuale invio in produzione (solo se ci sono righe mai inviate, cioè
 *    comanda creata via WS — quelle battute in cassa sono già in produzione);
 * 2. ContoComanda con noInvio=true — crea il conto ed emette il documento
 *    fiscale, ma il suo passo pagamento via AdapterWS fallisce SEMPRE
 *    ("modificate le informazioni da un altro utente") e il conto resta
 *    Aperto a sospeso;
 * 3. verdetto da GetContiGiorno (la risposta di ContoComanda non è
 *    affidabile: dice errore anche a scontrino emesso — collaudi 04/08);
 * 4. se il conto è a sospeso e la chiusura è piena (importoPagato omesso),
 *    saldaConto registra il pagamento e chiude senza ristampare. L'importo
 *    è il Sospeso letto dal conto stesso, mai un totale calcolato dal CRM.
 *
 * Con `importoPagato` esplicito inferiore al totale il sospeso è voluto
 * (pagamento parziale) e il passo 4 viene saltato.
 *
 * Con `proforma: true` il documento è la Proforma (non fiscale, nessuno
 * scontrino dall'RT): il pagamento si registra comunque, come per lo
 * scontrino. È la chiusura di routine della cassa del ristorante — decine
 * al giorno, tutte Pagato con pagamento registrato (verificato in archivio
 * il 25/08). Senza RT di mezzo il passo pagamento di ContoComanda riesce
 * al primo colpo: niente conflitto di timeStmp, saldaConto non interviene.
 * ATTENZIONE: senza tipoPagamento il gestionale registra l'incasso in
 * Contanti (default) — passare sempre il tipo dedicato (ESTERNO).
 *
 * Comanda col PRECONTO stampato (al Frantoio 111 comande su 122, e il
 * pagamento dal QR lo stampa da sé): il preconto lascia un conto Aperto con
 * il pagamento precompilato in contanti, e ContoComanda prova a cancellarlo
 * andando in errore dentro Passepartout (Comanda.CancellaConti →
 * PagamentoFBO.IsCancellabile, NullReferenceException — prove del 06/10).
 * Quel conto si chiude allora direttamente: vedi chiudiContoDelPreconto.
 */
export async function chiudiComandaCompleta(params: {
    idComanda: number;
    tipoDocumento?: TipoDocumentoConto;
    tipoPagamento?: string;
    importoPagato?: number;
    proforma?: boolean;
    /** Fase B5: è un nuovo tentativo (il precedente può essere riuscito con
     *  la risposta persa per strada). Prima di tutto si guarda nell'archivio
     *  del giorno: se il conto della comanda c'è già, nessun nuovo
     *  ContoComanda — solo il saldo del sospeso, se manca. Senza, un
     *  secondo tentativo rifarebbe lo scontrino. */
    riprendi?: boolean;
}): Promise<EsitoChiusuraComanda> {
    const contiPrima = await getContiGiorno();
    const preconto = contoDelPreconto(contiPrima, params.idComanda);
    if (params.riprendi && !preconto) {
        const esistente = contiPrima
            .filter((c) => asNumber(c.IdComanda ?? (c as any).idComanda) === params.idComanda).pop();
        if (esistente) return completaChiusura(params, esistente, 'Conto già presente in cassa: ripreso senza nuovo documento');
    }
    const comanda = await getComanda(params.idComanda);
    if (!comanda) {
        throw new PassepartoutError(`Comanda ${params.idComanda} non trovata sul gestionale`, 'ContoComanda');
    }
    if (preconto) return chiudiContoDelPreconto(params, preconto, comanda);
    const daInviare = comanda.stato === '0' || comanda.righe.some((r) => r.stato === '0');
    if (daInviare) {
        await inviaProduzioneComanda({ idComanda: params.idComanda, inviaTutto: true });
        // MenuSrv processa l'invio in asincrono e ritocca la comanda: un
        // respiro prima della chiusura evita di ricreare il conflitto di
        // timeStmp appena eliminato spostando l'invio fuori da ContoComanda.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    let avviso: string | null = null;
    try {
        await contoComanda({
            idComanda: params.idComanda,
            tipoDocumento: params.proforma ? 'Proforma' : params.tipoDocumento,
            tipoPagamento: params.tipoPagamento,
            importoPagato: params.importoPagato,
        });
    } catch (err) {
        if (!(err instanceof PassepartoutError)) throw err;
        avviso = err.message;
    }
    const conti = await getContiGiorno();
    const conto = conti.filter((c) => asNumber(c.IdComanda ?? (c as any).idComanda) === params.idComanda).pop();
    if (!conto) {
        throw new PassepartoutError(
            avviso ?? `Conto della comanda ${params.idComanda} non trovato in archivio dopo la chiusura`,
            'ContoComanda',
        );
    }
    return completaChiusura(params, conto, avviso);
}

/** Il conto che un preconto lascia sulla comanda: Aperto, già coperto dal
 *  pagamento precompilato (sospeso zero). Un conto Aperto CON sospeso è
 *  invece quello di una nostra chiusura a metà, che il saldo completa. */
function contoDelPreconto(conti: Record<string, unknown>[], idComanda: number): Record<string, unknown> | null {
    return conti.filter((c) =>
        asNumber(c.IdComanda ?? (c as any).idComanda) === idComanda
        && asString(c.StatoEnum) === 'Aperto'
        && (asNumber(c.Sospeso) ?? 0) === 0,
    ).pop() ?? null;
}

/**
 * Chiusura di una comanda col preconto, provata sulla cassa vera il 06/10
 * (conto 82583): PutConto sul conto del preconto, con il pagamento del tipo
 * dedicato per il totale del conto. Il pagamento precompilato in contanti
 * viene SOSTITUITO (stesso pagamento, nuovo tipo), non affiancato; con la
 * Proforma e «Chiudi» non si stampa niente e il tavolo si libera. Lo
 * scontrino vuole «ChiudiEStampa» (non ancora provato sulla cassa vera: se
 * la cassa rifiuta, l'errore torna su e la chiusura va fatta a mano).
 */
async function chiudiContoDelPreconto(
    params: { idComanda: number; tipoDocumento?: TipoDocumentoConto; tipoPagamento?: string; importoPagato?: number; proforma?: boolean },
    preconto: Record<string, unknown>,
    comanda: PassepartoutComanda,
): Promise<EsitoChiusuraComanda> {
    if (params.importoPagato != null) {
        throw new PassepartoutError('Comanda col preconto: un pagamento parziale va chiuso in cassa', 'PutConto');
    }
    const tipo = params.tipoPagamento
        ? (await getTipiPagamento()).find((t) => t.codice === params.tipoPagamento)
        : undefined;
    if (!tipo) {
        throw new PassepartoutError(
            `Tipo pagamento "${params.tipoPagamento ?? ''}" non trovato in cassa: comanda col preconto lasciata aperta`,
            'PutConto',
        );
    }
    const idConto = asNumber(preconto.IdGestionale ?? (preconto as any).idGestionale);
    const daPagare = asNumber(preconto.TotaleDaPagare) ?? 0;
    if (idConto == null || !(daPagare > 0)) {
        throw new PassepartoutError(`Conto del preconto della comanda ${params.idComanda} senza importo`, 'PutConto');
    }
    // Un piatto aggiunto dopo il preconto può non essere nel suo conto: lo
    // si segnala, il conto chiuso è comunque quello della cassa.
    const totaleRighe = Math.round(comanda.righe.reduce((s, r) => s + (r.totale ?? 0), 0) * 100) / 100;
    const avviso = Math.abs(totaleRighe - daPagare) > 0.005
        ? `Preconto da ${daPagare.toFixed(2)} su una comanda da ${totaleRighe.toFixed(2)}`
        : null;
    const proforma = params.proforma === true || params.tipoDocumento === 'Proforma';
    await saldaConto({
        idConto,
        idComanda: params.idComanda,
        pagamento: { importo: daPagare, tipo },
        tipoDocumento: proforma ? 'Proforma' : (params.tipoDocumento ?? 'Scontrino'),
        comando: proforma ? 'Chiudi' : 'ChiudiEStampa',
    });
    const conto = (await getContiGiorno())
        .filter((c) => asNumber(c.IdComanda ?? (c as any).idComanda) === params.idComanda).pop() as any;
    if (!conto || asString(conto.StatoEnum) !== 'Pagato') {
        throw new PassepartoutError(
            `Conto del preconto ${idConto} non chiuso dalla cassa (stato ${asString(conto?.StatoEnum) ?? 'sconosciuto'})`,
            'PutConto',
        );
    }
    return {
        chiuso: true,
        importoSospeso: asNumber(conto.Sospeso) ?? 0,
        stato: asString(conto.StatoEnum),
        numeroScontrino: asString(conto.NumeroScontrinoFiscale),
        totalePagato: asNumber(conto.TotalePagato),
        totaleDaPagare: asNumber(conto.TotaleDaPagare),
        avviso,
    };
}

/**
 * Il preconto della comanda, come lo stampa il cameriere: la cassa lo
 * stampa e il tavolo cambia colore in pianta (blu al Frantoio). È il
 * segnale nativo della cassa per «il tavolo vuole pagare».
 *
 * Non c'è un'operazione dell'AdapterWS per farlo: è un ComandoImmediato
 * «ComandoComanda / Preconto» sul bus della MessageBox (RiceviMessaggio
 * dell'interfaccia IAdapter, endpoint /Adapter dello stesso servizio), con
 * le credenziali dentro il messaggio. Le Put dell'AdapterWS passano dallo
 * stesso ingresso (lo dice il log della cassa). Provato sulla cassa vera
 * il 06/10 (comanda 78532): preconto stampato, tavolo blu, nessun invio in
 * produzione. Lascia sulla comanda il conto del preconto, che la chiusura
 * gestisce (chiudiContoDelPreconto). EventoCliente = «Conto» via PutComanda,
 * invece, la cassa lo ignora.
 */
export async function emettiPreconto(idComanda: number): Promise<void> {
    const config = getPassepartoutConfig();
    if (!config.url) throw new PassepartoutError('PASSEPARTOUT_WS_URL non configurato', 'RiceviMessaggio');
    const url = config.url.trim().replace(/\/$/, '').replace(/\/AdapterWS$/i, '') + '/Adapter';
    // Membri del data contract in ordine alfabetico, base Contract prima.
    const messaggio =
        `<messaggio xmlns:b="${NS_CONTRACT}" xmlns:c="http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Comanda" ` +
        `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
        `<b:ComandoEnum>ComandoImmediato</b:ComandoEnum>` +
        `<b:ComandoImmediato i:type="c:ComandoComanda">` +
        `<c:Comando>Preconto</c:Comando>` +
        `<c:IDGestionale>${idComanda}</c:IDGestionale>` +
        `</b:ComandoImmediato>` +
        `<b:ModalitaInvioEnum>Immediata</b:ModalitaInvioEnum>` +
        `<b:Password>${xmlEscape(config.password)}</b:Password>` +
        `<b:TipoEnum>Ingresso</b:TipoEnum>` +
        `<b:Utente>${xmlEscape(config.utente)}</b:Utente>` +
        `</messaggio>`;
    const envelope =
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<RiceviMessaggio xmlns="${TEMPURI}">${messaggio}</RiceviMessaggio>` +
        `</s:Body></s:Envelope>`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let text: string;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${TEMPURI}IAdapter/RiceviMessaggio"` },
            body: envelope,
            signal: controller.signal,
        });
        text = await response.text();
    } catch (err) {
        throw new PassepartoutError(`Gestionale non raggiungibile (${(err as Error).message})`, 'RiceviMessaggio');
    } finally {
        clearTimeout(timer);
    }
    const fault = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
    if (fault) throw new PassepartoutError(fault[1].replace(/\s+/g, ' ').trim().slice(0, 500), 'RiceviMessaggio');
    // La risposta è un Messaggio: gli errori stanno in Errori (ArrayOfstring).
    const errori = text.match(/<(?:\w+:)?Errori(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Errori>/);
    const elenco = errori ? [...errori[1].matchAll(/<(?:\w+:)?string>([\s\S]*?)<\/(?:\w+:)?string>/g)].map((m) => m[1].trim()) : [];
    if (elenco.length > 0) throw new PassepartoutError(elenco.join(' | ').slice(0, 500), 'RiceviMessaggio');
}

/** Il preconto, una volta sola: se la comanda ha già il conto di un
 *  preconto (stampato dal cameriere, o da un tocco precedente) non se ne
 *  stampa un altro. */
export async function precontoUnaVolta(idComanda: number): Promise<{ emesso: boolean }> {
    if (contoDelPreconto(await getContiGiorno(), idComanda)) return { emesso: false };
    await emettiPreconto(idComanda);
    return { emesso: true };
}

/** Lo sconto che la cassa ha messo sul conto aperto della comanda. */
export interface ScontoCassaComanda {
    idConto: number | null;
    totaleDocumento: number | null;
    totaleDaPagare: number | null;
    /** In euro, come lo scrive la cassa (ScontoEuro). 0 = nessuno sconto. */
    scontoEuro: number;
}

/**
 * In Passepartout lo sconto non sta sulla comanda ma sul suo CONTO (il
 * preconto, di solito): TotaleDocumento a prezzo pieno, ScontoEuro, e
 * TotaleDaPagare già scontato (conti del 06/10: comanda 78529, 221,50 −
 * 21,50 = 200,00). La comanda resta a prezzo pieno, e il CRM che importava
 * solo le righe mostrava al QR il conto intero. Il servizio non ha una
 * lettura «conto della comanda»: si prende dai conti del giorno l'ultimo
 * Aperto della comanda. null = nessun conto aperto, quindi nessuno sconto.
 */
export async function scontoComanda(idComanda: number): Promise<ScontoCassaComanda | null> {
    const conto = (await getContiGiorno())
        .filter((c) => asNumber(c.IdComanda ?? (c as any).idComanda) === idComanda && asString(c.StatoEnum) === 'Aperto')
        .pop();
    if (!conto) return null;
    return {
        idConto: asNumber(conto.IdGestionale ?? (conto as any).idGestionale),
        totaleDocumento: asNumber(conto.TotaleDocumento),
        totaleDaPagare: asNumber(conto.TotaleDaPagare),
        scontoEuro: Math.max(0, asNumber(conto.ScontoEuro) ?? 0),
    };
}

// ---------------------------------------------------------------------------
// Comanda specchio (fase 4): un conto chiuso nel CRM copiato in cassa
// ---------------------------------------------------------------------------
//
// Provato sulla cassa vera il 06/10 sera (comande 78531 e 78533 sul tavolo
// 88, 78532 sul 29):
// - PutComanda con Tool_EseguiInvio=false: niente stampato in cucina né al
//   bar, numeroInvii 0. Lo stato «Fatto» delle righe la cassa lo ignora (le
//   righe restano «Nuovo»), quindi la chiusura NON passa da
//   chiudiComandaCompleta, che le manderebbe in produzione;
// - con Coperti = n la cassa aggiunge da sé la riga coperto al suo prezzo,
//   a meno che non ci sia già la nostra (TipoEnum Coperto, articolo del
//   coperto): allora tiene quella, prezzo del CRM compreso;
// - ContoComanda Proforma col tipo esterno chiude in un colpo (Pagato,
//   nessun documento fiscale, tavolo libero) e stampa la proforma in cassa.

/** Una riga del conto del CRM per la cassa: prezzi in centesimi, già
 *  riproporzionati allo sconto del conto (la somma è il totale). */
export interface RigaSpecchio {
    /** Id dell'articolo nel catalogo della cassa (piatto importato dalla
     *  cassa); null = piatto del CRM o servizio, sull'articolo generico. */
    idArticolo: number | null;
    descrizione: string;
    pezzi: number;
    prezzoCents: number;
    /** La riga coperto: va con TipoEnum Coperto sull'articolo del coperto. */
    coperto?: boolean;
}

export interface ParametriSpecchio {
    /** «sympotia-conto:<id>»: in nota alla comanda, per ritrovarla. */
    tag: string;
    sala: string;
    tavolo: string;
    coperti: number;
    righe: RigaSpecchio[];
    idArticoloGenerico: number | null;
    tipoPagamento: string;
    totaleCents: number;
}

export interface EsitoSpecchio {
    idComanda: number;
    idConto: number | null;
    stato: string | null;
    totaleCassaCents: number;
    /** true se la comanda c'era già (nuovo tentativo dopo una risposta persa). */
    ripresa: boolean;
    avviso: string | null;
}

/** Errore che non è un guasto: il tavolo della comanda specchio ha una
 *  comanda vera aperta. Il server riprova più tardi, senza contarlo. */
export const SPECCHIO_TAVOLO_OCCUPATO = 'tavolo_specchio_occupato';

// Il catalogo articoli pesa (un minuto a leggerlo): una lettura l'ora basta
// per tradurre id → codice.
let catalogo: { letto: number; articoli: Map<number, PassepartoutArticolo> } | null = null;
async function articoliPerId(): Promise<Map<number, PassepartoutArticolo>> {
    if (!catalogo || Date.now() - catalogo.letto > 60 * 60_000) {
        catalogo = { letto: Date.now(), articoli: new Map((await getArticoliMenu()).map((a) => [a.idGestionale, a])) };
    }
    return catalogo.articoli;
}

const euro = (cents: number) => (cents / 100).toFixed(2);

export async function specchioComanda(p: ParametriSpecchio): Promise<EsitoSpecchio> {
    const oggi = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
    const ieri = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date(Date.now() - 86_400_000));
    const conTag = (c: PassepartoutComanda) => (c.note ?? '').includes(p.tag);

    // 1. Già scritta da un tentativo precedente?
    let comanda: PassepartoutComanda | null = null;
    for (const giorno of [oggi, ieri]) {
        comanda = (await getComandeGiorno(giorno)).find(conTag) ?? null;
        if (comanda) break;
    }
    const ripresa = comanda != null;
    if (comanda?.isPagato) {
        const conto = (await getContiGiorno()).filter((c) => asNumber(c.IdComanda) === comanda!.idGestionale).pop() as any;
        return {
            idComanda: comanda.idGestionale!,
            idConto: asNumber(conto?.IdGestionale),
            stato: asString(conto?.StatoEnum),
            totaleCassaCents: Math.round((asNumber(conto?.TotaleDaPagare) ?? 0) * 100),
            ripresa: true,
            avviso: null,
        };
    }

    // 2. Il tavolo: una comanda vera aperta lì non si tocca.
    if (!comanda) {
        const sulTavolo = await getComandaTavolo(p.tavolo);
        if (sulTavolo && !conTag(sulTavolo)) {
            throw new PassepartoutError(`${SPECCHIO_TAVOLO_OCCUPATO}: il tavolo ${p.tavolo} ha una comanda aperta in cassa`, 'PutComanda');
        }
        comanda = sulTavolo;
    }

    // 3. Scrittura, se non c'è.
    if (!comanda) {
        const articoli = await articoliPerId();
        const generico = p.idArticoloGenerico != null ? articoli.get(p.idArticoloGenerico) : undefined;
        const coperto = [...articoli.values()].find((a) => /^copert/i.test(a.codice ?? '') || /^copert/i.test(a.descrizione ?? ''));
        const righe: string[] = [];
        for (const r of p.righe) {
            const art = r.coperto ? coperto : (r.idArticolo != null ? articoli.get(r.idArticolo) : undefined) ?? generico;
            if (!art?.codice && !r.coperto) {
                throw new PassepartoutError(
                    `«${r.descrizione}» non ha un articolo in cassa: scegli l'articolo per i piatti del CRM nella sezione Passepartout`,
                    'PutComanda',
                );
            }
            righe.push(
                `<c:PMBRigaComanda>` +
                (art?.codice ? `<c:Articolo>${xmlEscape(art.codice)}</c:Articolo>` : '') +
                `<c:Descrizione>${xmlEscape(testoPerCassa(r.coperto ? 'Coperto' : r.descrizione, 60) || 'Voce')}</c:Descrizione>` +
                `<c:Pezzi>${Math.max(1, Math.round(r.pezzi))}</c:Pezzi>` +
                `<c:Prezzo>${euro(r.prezzoCents)}</c:Prezzo>` +
                (r.coperto ? `<c:TipoEnum>Coperto</c:TipoEnum>` : '') +
                `<c:Tool_EseguiInvio>false</c:Tool_EseguiInvio>` +
                `<c:Totale>${euro(r.prezzoCents * Math.max(1, Math.round(r.pezzi)))}</c:Totale>` +
                `</c:PMBRigaComanda>`,
            );
        }
        const xml =
            `<comanda xmlns:c="http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Comanda">` +
            `<c:Coperti>${Math.max(0, Math.round(p.coperti))}</c:Coperti>` +
            `<c:Note>${xmlEscape(`Conto Sympotia ${p.tag}`)}</c:Note>` +
            `<c:Righe>${righe.join('')}</c:Righe>` +
            `<c:Sala>${xmlEscape(p.sala)}</c:Sala>` +
            `<c:Tavolo>${xmlEscape(p.tavolo)}</c:Tavolo>` +
            `</comanda>`;
        const risposta = (await soapCall('PutComanda', xml, 30_000)) as Record<string, any> | null;
        const id = asNumber(risposta?.IdGestionale);
        comanda = id != null ? await getComanda(id) : await getComandaTavolo(p.tavolo);
        if (!comanda || !conTag(comanda)) {
            throw new PassepartoutError('Comanda specchio non ritrovata dopo la scrittura', 'PutComanda');
        }
    }

    // 4. Il totale della cassa contro quello del CRM: in statistiche si
    //    chiude lo stesso, la differenza resta come avviso.
    const totaleCassaCents = Math.round(comanda.righe.reduce((s, r) => s + (r.totale ?? 0), 0) * 100);
    let avviso = totaleCassaCents !== p.totaleCents
        ? `In cassa ${euro(totaleCassaCents)}, nel CRM ${euro(p.totaleCents)}`
        : null;

    // 5. Chiusura senza invio in produzione: ContoComanda (noInvio) come
    //    proforma col tipo esterno, poi il verdetto dall'archivio.
    try {
        await contoComanda({ idComanda: comanda.idGestionale!, tipoDocumento: 'Proforma', tipoPagamento: p.tipoPagamento });
    } catch (err) {
        if (!(err instanceof PassepartoutError)) throw err;
        avviso = [avviso, err.message].filter(Boolean).join(' | ');
    }
    const conto = (await getContiGiorno()).filter((c) => asNumber(c.IdComanda) === comanda!.idGestionale).pop();
    if (!conto) {
        throw new PassepartoutError(avviso ?? `Conto della comanda specchio ${comanda.idGestionale} non trovato in archivio`, 'ContoComanda');
    }
    const esito = await completaChiusura({ idComanda: comanda.idGestionale!, tipoPagamento: p.tipoPagamento }, conto, avviso);
    return {
        idComanda: comanda.idGestionale!,
        idConto: asNumber((conto as any).IdGestionale),
        stato: esito.stato,
        totaleCassaCents,
        ripresa,
        avviso: esito.avviso,
    };
}

/** Passo 4 della chiusura (saldo del sospeso) e l'esito: in comune fra la
 *  chiusura piena e la ripresa di un conto già in archivio. */
async function completaChiusura(
    params: { idComanda: number; tipoPagamento?: string; importoPagato?: number },
    trovato: Record<string, unknown>,
    avvisoIniziale: string | null,
): Promise<EsitoChiusuraComanda> {
    let conto = trovato as any;
    let avviso = avvisoIniziale;
    const sospeso = asNumber(conto.Sospeso) ?? 0;
    const idConto = asNumber(conto.IdGestionale ?? (conto as any).idGestionale);
    if (sospeso > 0 && params.importoPagato == null) {
        const tipo = params.tipoPagamento
            ? (await getTipiPagamento()).find((t) => t.codice === params.tipoPagamento)
            : undefined;
        if (idConto != null && tipo) {
            const saldato = await saldaConto({
                idConto,
                idComanda: params.idComanda,
                pagamento: { importo: sospeso, tipo },
            });
            if (saldato) conto = saldato;
        } else if (!tipo) {
            avviso = [avviso, `Tipo pagamento "${params.tipoPagamento ?? ''}" non trovato in cassa: conto lasciato a sospeso`]
                .filter(Boolean).join(' | ');
        }
    }
    return {
        chiuso: true,
        importoSospeso: asNumber(conto.Sospeso) ?? 0,
        stato: asString(conto.StatoEnum),
        numeroScontrino: asString(conto.NumeroScontrinoFiscale),
        totalePagato: asNumber(conto.TotalePagato),
        totaleDaPagare: asNumber(conto.TotaleDaPagare),
        avviso,
    };
}

// ---------------------------------------------------------------------------
// Comanda viva: le righe del CRM nella comanda in cassa del tavolo vero
// ---------------------------------------------------------------------------
//
// Provato sulla cassa vera il 07 e 08/10 (docs/passepartout-comanda-viva-prove.md):
// - PutComanda con l'IdGestionale della comanda e SOLO le righe da scrivere
//   (senza IsParziale, che la cassa ignora) aggiunge le righe nuove e
//   cambia quelle mandate col loro IdGestionale: le altre, comprese quelle
//   del palmare, restano come sono. Il palmare a sua volta aggiunge e non
//   riscrive: le righe del CRM scritte mentre è dentro il tavolo restano.
// - Pezzi e Prezzo si cambiano sul posto, sulla stessa riga.
// - DaCancellare toglie una riga mai mandata; su una mandata la segna
//   «Cancellato» e la cucina vede lo storno, senza un nuovo invio.
// - Le varianti a testo libero (Varianti, solo Descrizione) arrivano al
//   monitor della cucina; il prezzo delle varianti il CRM lo tiene nel
//   prezzo della riga, così il totale della cassa è quello del CRM.
// - La risposta di PutComanda è la comanda intera: le righe nuove sono
//   quelle con un id che prima non c'era. La cassa non ha una nota per
//   riga, quindi la chiave del CRM la tiene il server (passepartout_righe_vive)
//   e l'agente se la ricorda fra un tentativo e l'altro (`memoria`).
// - Il cambio di tavolo (Tavolo su una comanda esistente) la cassa lo
//   ignora: non si scrive mai.

export interface VarianteViva {
    descrizione: string;
    /** «+» in cassa; false per le tolte («Senza cipolla»): «-». */
    inAggiunta: boolean;
}

export interface RigaViva {
    /** La chiave del CRM: 'oi:<order_item_id>', 'coperto', 'servizio'. */
    chiave: string;
    /** IdGestionale della riga in cassa, se il CRM l'ha già scritta. */
    idRiga: number | null;
    /** Articolo del catalogo della cassa; null = articolo generico. */
    idArticolo: number | null;
    descrizione: string;
    pezzi: number;
    prezzoCents: number;
    uscita: number;
    varianti: VarianteViva[];
    /** La riga coperto: TipoEnum Coperto sull'articolo del coperto. */
    coperto?: boolean;
    /** Coperto e servizio del CRM: solo su una comanda nata dal CRM. Sul
     *  tavolo aperto dal palmare coperti e servizio sono quelli della cassa. */
    soloComandaNostra?: boolean;
    /** Da togliere: sparisce se mai mandata, diventa uno storno se mandata. */
    cancella?: boolean;
}

export interface ParametriComandaViva {
    /** «sympotia-ordine:<id>»: in nota alla comanda che il CRM crea. */
    tag: string;
    /** La comanda in cassa dell'ordine, se il server la conosce già. */
    idComanda: number | null;
    sala: string;
    tavolo: string;
    coperti: number;
    righe: RigaViva[];
    idArticoloGenerico: number | null;
    /** Le uscite della cassa da mandare in produzione dopo la scrittura
     *  (fase 3, «stampa: la cassa»): quelle lanciate nel CRM. */
    inviaUscite?: number[];
}

export interface EsitoRigaViva {
    chiave: string;
    idRiga: number | null;
    statoEnum: string | null;
    /** Tolta, o mai scritta e non più da scrivere. */
    cancellata?: boolean;
    /** Tolta in cassa da qualcuno: il CRM non la rimette. */
    sparita?: boolean;
    /** Coperto o servizio non scritti su una comanda del palmare. */
    saltata?: boolean;
}

export interface EsitoComandaViva {
    idComanda: number | null;
    /** La comanda c'era già in cassa, aperta dal palmare o dalla cassa. */
    palmare: boolean;
    /** La comanda è chiusa in cassa: non si scrive più. */
    chiusa: boolean;
    righe: EsitoRigaViva[];
    /** Somma delle righe non cancellate della comanda, tutte. */
    totaleCassaCents: number;
    /** Le uscite mandate in produzione dalla cassa con questa chiamata. */
    inviate?: number[];
}

/** Quello che l'agente ricorda di un ordine fra un tentativo e l'altro:
 *  se la risposta va persa (timeout del server, linea che cade) il
 *  tentativo dopo non riscrive le stesse righe una seconda volta. */
export interface MemoriaComandaViva {
    idComanda: number | null;
    righe: Record<string, number>;
}

const CANCELLATA = 'Cancellato';

/** I campi di PMBRigaComanda nell'ordine dello schema (un campo fuori posto
 *  la cassa lo ignora senza errore). */
function rigaVivaXml(f: {
    articolo?: string | null;
    daCancellare?: boolean;
    descrizione?: string | null;
    idRiga?: number | null;
    pezzi: number;
    prezzoCents: number;
    coperto?: boolean;
    uscita?: number | null;
    varianti?: VarianteViva[];
}): string {
    const varianti = (f.varianti ?? [])
        .map((v) => ({ ...v, descrizione: testoPerCassa(v.descrizione, 60) }))
        .filter((v) => v.descrizione !== '');
    return '<c:PMBRigaComanda>' +
        (f.articolo ? `<c:Articolo>${xmlEscape(f.articolo)}</c:Articolo>` : '') +
        (f.daCancellare ? '<c:DaCancellare>true</c:DaCancellare>' : '') +
        (f.descrizione ? `<c:Descrizione>${xmlEscape(f.descrizione)}</c:Descrizione>` : '') +
        (f.idRiga != null ? `<c:IdGestionale>${f.idRiga}</c:IdGestionale>` : '') +
        `<c:Pezzi>${f.pezzi}</c:Pezzi>` +
        `<c:Prezzo>${euro(f.prezzoCents)}</c:Prezzo>` +
        (f.coperto ? '<c:TipoEnum>Coperto</c:TipoEnum>' : '') +
        '<c:Tool_EseguiInvio>false</c:Tool_EseguiInvio>' +
        `<c:Totale>${euro(f.prezzoCents * f.pezzi)}</c:Totale>` +
        (f.uscita != null ? `<c:Uscita>${f.uscita}</c:Uscita>` : '') +
        (varianti.length
            ? '<c:Varianti>' + varianti.map((v) => '<c:PMBRigaVariante>' +
                `<c:Descrizione>${xmlEscape(v.descrizione)}</c:Descrizione>` +
                `<c:InAggiunta>${v.inAggiunta ? 'true' : 'false'}</c:InAggiunta>` +
                '<c:Prezzo>0.00</c:Prezzo>' +
                '</c:PMBRigaVariante>').join('') + '</c:Varianti>'
            : '') +
        '</c:PMBRigaComanda>';
}

/** La riga com'è in cassa, rimandata col suo IdGestionale e i campi da
 *  cambiare (come nelle prove 5a e 5c). */
function rigaEsistenteXml(r: PassepartoutRigaComanda, cambia: { pezzi?: number; prezzoCents?: number; daCancellare?: boolean }): string {
    return rigaVivaXml({
        articolo: r.articolo,
        daCancellare: cambia.daCancellare,
        descrizione: r.descrizione,
        idRiga: r.idGestionale,
        pezzi: cambia.pezzi ?? Math.round(r.pezzi ?? 1),
        prezzoCents: cambia.prezzoCents ?? Math.round((r.prezzo ?? 0) * 100),
        uscita: r.uscita,
    });
}

export async function scriviComandaViva(
    p: ParametriComandaViva,
    memoria: MemoriaComandaViva = { idComanda: null, righe: {} },
): Promise<EsitoComandaViva> {
    const conTag = (c: PassepartoutComanda) => (c.note ?? '').includes(p.tag);
    const totaleDi = (c: PassepartoutComanda | null) => Math.round((c?.righe ?? [])
        .filter((r) => r.statoEnum !== CANCELLATA)
        .reduce((s, r) => s + (r.totale ?? 0), 0) * 100);

    // 1. La comanda: quella già nota, o quella aperta sul tavolo, o nessuna
    //    (la crea la scrittura).
    let idComanda = p.idComanda ?? memoria.idComanda ?? null;
    let comanda = idComanda != null ? await getComanda(idComanda) : null;
    if (idComanda != null && (!comanda || comanda.isPagato)) {
        return {
            idComanda,
            palmare: comanda != null && !conTag(comanda),
            chiusa: true,
            righe: p.righe.map((r) => ({ chiave: r.chiave, idRiga: r.idRiga, statoEnum: null })),
            totaleCassaCents: totaleDi(comanda),
        };
    }
    if (!comanda) {
        comanda = await getComandaTavolo(p.tavolo);
        if (comanda && comanda.isPagato) comanda = null;
    }
    const palmare = comanda != null && !conTag(comanda);
    const prima = new Map((comanda?.righe ?? []).filter((r) => r.idGestionale != null).map((r) => [r.idGestionale!, r]));

    // 2. Cosa scrivere.
    const articoli = await articoliPerId();
    const generico = p.idArticoloGenerico != null ? articoli.get(p.idArticoloGenerico) : undefined;
    const articoloCoperto = [...articoli.values()].find((a) => /^copert/i.test(a.codice ?? '') || /^copert/i.test(a.descrizione ?? ''));
    const xmlRighe: string[] = [];
    const esiti = new Map<string, EsitoRigaViva>();
    const aggiunte: Array<{ chiave: string; codice: string | null; descrizione: string | null; pezzi: number; uscita: number | null }> = [];
    for (const r of p.righe) {
        if (r.soloComandaNostra && palmare) {
            esiti.set(r.chiave, { chiave: r.chiave, idRiga: null, statoEnum: null, saltata: true });
            continue;
        }
        const pezzi = Math.max(1, Math.round(r.pezzi));
        const idNoto = r.idRiga ?? memoria.righe[r.chiave] ?? null;
        if (idNoto != null) {
            const inCassa = prima.get(idNoto);
            if (!inCassa || (inCassa.statoEnum === CANCELLATA && !r.cancella)) {
                // Tolta in cassa: la cassa conserva, il CRM non la rimette.
                esiti.set(r.chiave, { chiave: r.chiave, idRiga: idNoto, statoEnum: inCassa?.statoEnum ?? null, ...(r.cancella ? { cancellata: true } : { sparita: true }) });
                continue;
            }
            if (r.cancella) {
                if (inCassa.statoEnum !== CANCELLATA) xmlRighe.push(rigaEsistenteXml(inCassa, { daCancellare: true }));
                esiti.set(r.chiave, { chiave: r.chiave, idRiga: idNoto, statoEnum: CANCELLATA, cancellata: true });
                continue;
            }
            const cambiaPezzi = Math.round(inCassa.pezzi ?? 0) !== pezzi;
            const cambiaPrezzo = Math.round((inCassa.prezzo ?? 0) * 100) !== r.prezzoCents;
            if (cambiaPezzi || cambiaPrezzo) xmlRighe.push(rigaEsistenteXml(inCassa, { pezzi, prezzoCents: r.prezzoCents }));
            esiti.set(r.chiave, { chiave: r.chiave, idRiga: idNoto, statoEnum: inCassa.statoEnum ?? null });
            continue;
        }
        if (r.cancella) {
            esiti.set(r.chiave, { chiave: r.chiave, idRiga: null, statoEnum: null, cancellata: true });
            continue;
        }
        const art = r.coperto ? articoloCoperto : (r.idArticolo != null ? articoli.get(r.idArticolo) : undefined) ?? generico;
        if (!art?.codice && !r.coperto) {
            throw new PassepartoutError(
                `«${r.descrizione}» non ha un articolo in cassa: scegli l'articolo per i piatti del CRM nella sezione Passepartout`,
                'PutComanda',
            );
        }
        // Sull'articolo generico il nome è quello del CRM; sugli articoli
        // della cassa la descrizione la completa la cassa dal catalogo.
        const descrizione = r.coperto || art === generico || art?.codice == null
            ? testoPerCassa(r.coperto ? 'Coperto' : r.descrizione, 60) || 'Voce'
            : null;
        // Il coperto senza uscita: in cassa sta sull'uscita 0 (prova 1).
        const uscita = r.coperto ? null : r.uscita;
        xmlRighe.push(rigaVivaXml({
            articolo: art?.codice ?? null,
            descrizione,
            pezzi,
            prezzoCents: r.prezzoCents,
            coperto: r.coperto,
            uscita,
            varianti: r.varianti,
        }));
        aggiunte.push({ chiave: r.chiave, codice: art?.codice ?? null, descrizione, pezzi, uscita });
    }

    // 3. Una scrittura sola: la comanda nuova con le sue righe, o le sole
    //    righe da aggiungere, cambiare o togliere sulla comanda che c'è.
    let dopo = comanda;
    if (xmlRighe.length > 0) {
        const xml =
            `<comanda xmlns:c="http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Comanda">` +
            (comanda
                ? `<c:IdGestionale>${comanda.idGestionale}</c:IdGestionale>` +
                  `<c:Righe>${xmlRighe.join('')}</c:Righe>`
                : `<c:Coperti>${Math.max(0, Math.round(p.coperti))}</c:Coperti>` +
                  `<c:Note>${xmlEscape(`Ordine Sympotia ${p.tag}`)}</c:Note>` +
                  `<c:Righe>${xmlRighe.join('')}</c:Righe>` +
                  `<c:Sala>${xmlEscape(p.sala)}</c:Sala>` +
                  `<c:Tavolo>${xmlEscape(p.tavolo)}</c:Tavolo>`) +
            `</comanda>`;
        const risposta = (await soapCall('PutComanda', xml, 30_000)) as Record<string, any> | null;
        const letta = risposta && !isNil(risposta) && asNumber(risposta.IdGestionale) != null ? mapComanda(risposta) : null;
        dopo = letta && letta.righe.length > 0
            ? letta
            : (letta?.idGestionale != null ? await getComanda(letta.idGestionale) : comanda
                ? await getComanda(comanda.idGestionale!)
                : await getComandaTavolo(p.tavolo));
        if (!dopo || (!comanda && !conTag(dopo))) {
            throw new PassepartoutError('Comanda non ritrovata dopo la scrittura', 'PutComanda');
        }
        idComanda = dopo.idGestionale;
    } else if (comanda) {
        idComanda = comanda.idGestionale;
    }

    // 4. Gli id delle righe nuove: quelle che prima non c'erano, abbinate a
    //    quelle chieste per articolo, pezzi e uscita (anche il palmare può
    //    aver aggiunto una riga nello stesso momento).
    const nuove = (dopo?.righe ?? [])
        .filter((r) => r.idGestionale != null && !prima.has(r.idGestionale))
        .sort((a, b) => a.idGestionale! - b.idGestionale!);
    const stessa = (n: PassepartoutRigaComanda, a: typeof aggiunte[number], conDescrizione: boolean) =>
        Math.round(n.pezzi ?? 0) === a.pezzi
        && (a.uscita == null || (n.uscita ?? 0) === a.uscita)
        && (a.codice == null || n.articolo === a.codice)
        && (!conDescrizione || a.descrizione == null || n.descrizione === a.descrizione);
    for (const a of aggiunte) {
        // Prima con la descrizione (righe diverse sull'articolo generico),
        // poi senza, se la cassa l'ha riscritta.
        let i = nuove.findIndex((n) => stessa(n, a, true));
        if (i < 0) i = nuove.findIndex((n) => stessa(n, a, false));
        const trovata = i >= 0 ? nuove.splice(i, 1)[0] : null;
        esiti.set(a.chiave, { chiave: a.chiave, idRiga: trovata?.idGestionale ?? null, statoEnum: trovata?.statoEnum ?? null });
    }
    const aggiornaStati = (c: PassepartoutComanda | null) => {
        for (const r of c?.righe ?? []) {
            for (const e of esiti.values()) {
                if (e.idRiga === r.idGestionale && !e.sparita) e.statoEnum = r.statoEnum ?? e.statoEnum;
            }
        }
    };
    aggiornaStati(dopo);

    // 5. Le uscite lanciate nel CRM, mandate in produzione dalla cassa (fase
    //    3, «stampa: la cassa»). La cassa manda l'uscita intera: anche le
    //    righe di palmare e cassa di quell'uscita non ancora mandate, come il
    //    suo «Invia uscita» (prova 4: le uscite dopo restano in attesa).
    const uscite = [...new Set((p.inviaUscite ?? []).filter((u) => Number.isInteger(u) && u > 0))].sort((a, b) => a - b);
    let inviate: number[] = [];
    if (uscite.length > 0 && idComanda != null) {
        await inviaProduzioneComanda({ idComanda, inviaTutto: false, uscite });
        inviate = uscite;
        const riletta = await getComanda(idComanda);
        if (riletta) {
            dopo = riletta;
            aggiornaStati(dopo);
        }
    }

    return {
        idComanda,
        palmare,
        chiusa: false,
        righe: p.righe.map((r) => esiti.get(r.chiave) ?? { chiave: r.chiave, idRiga: null, statoEnum: null }),
        totaleCassaCents: totaleDi(dopo),
        ...(inviate.length > 0 ? { inviate } : {}),
    };
}

// ---------------------------------------------------------------------------
// Prenotazioni (modulo «Planning prenotazioni» di Menù)
// ---------------------------------------------------------------------------
//
// Contratto letto dal WSDL il 06/10 (ContrattoPrenotazioneMenu) e provato
// sulla cassa vera lo stesso giorno, prenotazione 94 sul tavolo 40 di DENTRO:
// - la Put accetta la prenotazione anche con la sala in modalità
//   «Disabilitata», e in cassa compare nel planning come «Nome X coperti
//   [inizio-fine]», col telefono e la nota nel riquadro;
// - la RISPOSTA della Put porta solo IdGestionale (il resto è «!--NP--!»):
//   quello che il gestionale ha salvato si rilegge con GetPrenotazioneMenu;
// - la Put con lo stesso IdGestionale (e IDDati) aggiorna la stessa
//   prenotazione, niente duplicati;
// - non esiste un'operazione per cancellare: lo stato «Mancata» libera il
//   tavolo, ed è l'annullo che abbiamo;
// - aprendo il tavolo dalla prenotazione la cassa crea la comanda già
//   intestata e coi coperti, e la prenotazione passa a «Chiusa»: è l'arrivo.

const NS_CONTRACT = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract';
const NS_PRENOTAZIONE = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract.PrenotazioneMenu';
const NS_ARRAYS = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays';

/** EnumStatoPrenotazione del gestionale. */
export type StatoPrenotazioneCassa = 'Confermata' | 'Mancata' | 'Chiusa' | 'Preventivo' | 'ListaAttesa';

export interface PassepartoutPrenotazione {
    idGestionale: number;
    /** Chiave del contratto («ContrattoPrenotazioneMenu|<guid>»): torna nella Put di aggiornamento. */
    idDati: string | null;
    /** Così come la rende il gestionale, con l'offset (es. 2026-10-06T15:30:00+02:00). */
    dataOra: string | null;
    durata: number | null;
    sala: string | null;
    tavoli: string[];
    intestazione: string | null;
    telefono: string | null;
    note: string | null;
    numeroPersone: number | null;
    adulti: number | null;
    bambini: number | null;
    stato: string | null;
    tag: string | null;
}

/** Quello che il CRM scrive. `dataOra` è l'ora LOCALE del locale, senza
 *  offset (YYYY-MM-DDTHH:mm:ss): il gestionale la legge come ora di sala. */
export interface PrenotazioneCassaInput {
    idGestionale?: number | null;
    idDati?: string | null;
    dataOra: string;
    durata: number;
    sala: string;
    tavoli: string[];
    intestazione: string;
    telefono?: string | null;
    note?: string | null;
    numeroPersone: number;
    adulti: number;
    bambini: number;
    stato: StatoPrenotazioneCassa;
    /** «sympotia:<id prenotazione>»: ritrova la prenotazione anche se la
     *  risposta della Put è andata persa. */
    tag: string;
}

/** Il gestionale è un programma Windows: i caratteri oltre Latin-1 (emoji,
 *  alfabeti non latini) non hanno dove stare. Si tengono le lettere
 *  accentate, si tolgono i segni che non hanno corrispondenza. */
export function testoPerCassa(value: string | null | undefined, max: number): string {
    return String(value ?? '')
        .normalize('NFC')
        .replace(/[^\u0000-ÿ]/g, (ch) => ch.normalize('NFD').replace(/[^\u0000-ÿ]/g, ''))
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function stringhe(v: unknown): string[] {
    if (v == null || isNil(v)) return [];
    const raw = (v as Record<string, unknown>).string;
    if (raw == null) return [];
    return (Array.isArray(raw) ? raw : [raw]).map((s) => asString(s) ?? '').filter((s) => s !== '');
}

function mapPrenotazione(p: Record<string, any>): PassepartoutPrenotazione | null {
    const id = asNumber(p?.IdGestionale);
    if (id == null || id <= 0) return null;
    return {
        idGestionale: id,
        idDati: asString(p.IDDati),
        dataOra: asString(p.DataOra),
        durata: asNumber(p.Durata),
        sala: asString(p.Sala),
        tavoli: stringhe(p.Tavoli),
        intestazione: asString(p.Intestazione),
        telefono: asString(p.Telefono),
        note: asString(p.Note),
        numeroPersone: asNumber(p.NumeroPersone),
        adulti: asNumber(p.Adulti),
        bambini: asNumber(p.Bambini),
        stato: asString(p.StatoEnum),
        tag: asString(p.Tag),
    };
}

export async function getPrenotazioneMenu(idGestionale: number): Promise<PassepartoutPrenotazione | null> {
    const result = await soapCall('GetPrenotazioneMenu', `<idGestionale>${idGestionale}</idGestionale>`);
    if (result == null || isNil(result)) return null;
    return mapPrenotazione(result as Record<string, any>);
}

/** Prenotazioni del giorno (YYYY-MM-DD), di qualunque stato. */
export async function getPrenotazioniMenuGiorno(giorno: string): Promise<PassepartoutPrenotazione[]> {
    const result = (await soapCall(
        'GetPrenotazioniMenuGiorno',
        `<giorno>${xmlEscape(giorno)}T00:00:00</giorno><ultimaModifica>2000-01-01T00:00:00</ultimaModifica>`,
    )) as Record<string, any> | null;
    if (!result || isNil(result)) return [];
    const entries: Record<string, any>[] = result.ContrattoPrenotazioneMenu ?? [];
    return entries.map(mapPrenotazione).filter((p): p is PassepartoutPrenotazione => p != null);
}

/**
 * Scrive la prenotazione (nuova senza idGestionale, aggiornamento con) e
 * restituisce l'IdGestionale. L'ordine dei campi è quello dello schema
 * (DataContract WCF: prima i membri della base Contratto, poi gli altri in
 * ordine alfabetico); un campo fuori posto viene ignorato in silenzio.
 */
async function putPrenotazioneMenu(p: PrenotazioneCassaInput): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2})?$/.test(p.dataOra)) {
        throw new PassepartoutError(`Data e ora non valide: ${p.dataOra}`, 'PutPrenotazioneMenu');
    }
    const campo = (nome: string, valore: string | number | null | undefined) =>
        valore == null || valore === '' ? '' : `<p:${nome}>${xmlEscape(String(valore))}</p:${nome}>`;
    const xml =
        `<prenotazione xmlns:b="${NS_CONTRACT}" xmlns:p="${NS_PRENOTAZIONE}" xmlns:a="${NS_ARRAYS}">` +
        (p.idDati ? `<b:IDDati>${xmlEscape(p.idDati)}</b:IDDati>` : '') +
        campo('Adulti', Math.max(0, Math.round(p.adulti))) +
        campo('Bambini', Math.max(0, Math.round(p.bambini))) +
        campo('DataOra', p.dataOra) +
        campo('Durata', Math.max(15, Math.round(p.durata))) +
        campo('IdGestionale', p.idGestionale ?? null) +
        campo('Intestazione', testoPerCassa(p.intestazione, 60) || 'Prenotazione') +
        campo('Note', testoPerCassa(p.note, 500)) +
        campo('NumeroPersone', Math.max(1, Math.round(p.numeroPersone))) +
        campo('OrigineEnum', 'WebBooking') +
        campo('Sala', p.sala) +
        campo('StatoEnum', p.stato) +
        campo('Tag', p.tag) +
        `<p:Tavoli>${p.tavoli.map((t) => `<a:string>${xmlEscape(t)}</a:string>`).join('')}</p:Tavoli>` +
        campo('Telefono', testoPerCassa(p.telefono, 30)) +
        `</prenotazione>`;
    const result = (await soapCall('PutPrenotazioneMenu', xml)) as Record<string, any> | null;
    const id = asNumber(result?.IdGestionale);
    if (id == null || id <= 0) {
        throw new PassepartoutError('Il gestionale non ha restituito il numero della prenotazione', 'PutPrenotazioneMenu');
    }
    return id;
}

export interface EsitoPrenotazioneCassa {
    /** scritta = il gestionale ha la versione del CRM; cambiata_in_cassa =
     *  lo stato non è più quello che il CRM aveva scritto (la cassa l'ha
     *  aperta, segnata mancata, …) e non si è toccato niente; mancante = la
     *  prenotazione non c'è più sul gestionale. */
    esito: 'scritta' | 'cambiata_in_cassa' | 'mancante';
    prenotazione: PassepartoutPrenotazione | null;
}

/**
 * Scrive la prenotazione del CRM senza calpestare la cassa: se esiste già
 * e il suo stato non è `statoAtteso` (l'ultimo che il CRM ha scritto), la
 * cassa l'ha presa in mano e si lascia com'è. Senza idGestionale cerca
 * prima il tag nel giorno: una Put la cui risposta è andata persa ha già
 * creato la prenotazione, e rifarla la duplicherebbe.
 */
export async function sincronizzaPrenotazione(
    input: PrenotazioneCassaInput & { statoAtteso?: string | null },
): Promise<EsitoPrenotazioneCassa> {
    let id = input.idGestionale ?? null;
    let statoAtteso = input.statoAtteso ?? null;
    if (id == null) {
        const gia = (await getPrenotazioniMenuGiorno(input.dataOra.slice(0, 10))).find((p) => p.tag === input.tag);
        if (gia) {
            id = gia.idGestionale;
            statoAtteso = 'Confermata';
        }
    }
    let idDati = input.idDati ?? null;
    if (id != null) {
        const attuale = await getPrenotazioneMenu(id);
        if (!attuale) return { esito: 'mancante', prenotazione: null };
        if (statoAtteso && attuale.stato !== statoAtteso) return { esito: 'cambiata_in_cassa', prenotazione: attuale };
        idDati = attuale.idDati ?? idDati;
    }
    const scritta = await putPrenotazioneMenu({ ...input, idGestionale: id, idDati });
    const salvata = await getPrenotazioneMenu(scritta);
    if (!salvata) {
        throw new PassepartoutError(`Prenotazione ${scritta} non rileggibile dopo la scrittura`, 'PutPrenotazioneMenu');
    }
    return { esito: 'scritta', prenotazione: salvata };
}

/**
 * Annulla una prenotazione scritta dal CRM portandola a «Mancata», l'unico
 * stato che libera il tavolo (il WS non cancella). Si riscrive il record
 * com'è sul gestionale, cambiando solo lo stato. Senza idGestionale la si
 * cerca per tag nel giorno (risposta persa alla creazione).
 */
export async function annullaPrenotazione(params: {
    idGestionale?: number | null;
    tag: string;
    giorno: string;
    statoAtteso?: string | null;
}): Promise<EsitoPrenotazioneCassa> {
    let attuale: PassepartoutPrenotazione | null = null;
    let statoAtteso = params.statoAtteso ?? null;
    if (params.idGestionale != null) {
        attuale = await getPrenotazioneMenu(params.idGestionale);
    } else {
        attuale = (await getPrenotazioniMenuGiorno(params.giorno)).find((p) => p.tag === params.tag) ?? null;
        statoAtteso = 'Confermata';
    }
    if (!attuale) return { esito: 'mancante', prenotazione: null };
    if (attuale.stato === 'Mancata') return { esito: 'scritta', prenotazione: attuale };
    if (statoAtteso && attuale.stato !== statoAtteso) return { esito: 'cambiata_in_cassa', prenotazione: attuale };
    await putPrenotazioneMenu({
        idGestionale: attuale.idGestionale,
        idDati: attuale.idDati,
        dataOra: attuale.dataOra ?? `${params.giorno}T00:00:00`,
        durata: attuale.durata ?? 60,
        sala: attuale.sala ?? '',
        tavoli: attuale.tavoli,
        intestazione: attuale.intestazione ?? '',
        telefono: attuale.telefono,
        note: attuale.note,
        numeroPersone: attuale.numeroPersone ?? 1,
        adulti: attuale.adulti ?? attuale.numeroPersone ?? 1,
        bambini: attuale.bambini ?? 0,
        stato: 'Mancata',
        tag: attuale.tag ?? params.tag,
    });
    return { esito: 'scritta', prenotazione: await getPrenotazioneMenu(attuale.idGestionale) };
}

export interface PassepartoutSalaPianta {
    sala: string;
    tavoli: Array<{ nome: string; coperti: number | null }>;
}

export interface DiagnosiCassa {
    raggiungibile: boolean;
    /** Messaggio della cassa (o della rete) quando non risponde. */
    errore: string | null;
    versione: string | null;
    tempo_ms: number;
    tipi_pagamento: PassepartoutTipoPagamento[] | null;
    sale: Array<{ sala: string; tavoli: number }> | null;
    comande_aperte: number | null;
}

/** La verifica della cassa per la sezione Passepartout, in sola lettura:
 *  risponde? con che versione? quali tipi di pagamento, sale e tavoli, e
 *  le comande aperte si leggono? Un errore su una voce non ferma le altre. */
export async function diagnosiCassa(): Promise<DiagnosiCassa> {
    const inizio = Date.now();
    let versione: string | null = null;
    try {
        versione = await getVersioneGestionale();
    } catch (err) {
        return {
            raggiungibile: false, errore: (err as Error).message, versione: null, tempo_ms: Date.now() - inizio,
            tipi_pagamento: null, sale: null, comande_aperte: null,
        };
    }
    const tempo_ms = Date.now() - inizio;
    const [tipi, pianta, aperte] = await Promise.all([
        getTipiPagamento().catch(() => null),
        getPiantaSale().catch(() => null),
        getComandeAperte().catch(() => null),
    ]);
    return {
        raggiungibile: true,
        errore: null,
        versione,
        tempo_ms,
        tipi_pagamento: tipi,
        sale: pianta ? pianta.map((sl) => ({ sala: sl.sala, tavoli: sl.tavoli.length })) : null,
        comande_aperte: aperte ? aperte.length : null,
    };
}

/** Le sale coi loro tavoli, così come li chiama la cassa: serve ad
 *  abbinare i tavoli del CRM. Senza l'immagine della piantina, e senza gli
 *  ingombri (pareti, piante: tipo Ingombro*, spesso senza nome). */
export async function getPiantaSale(): Promise<PassepartoutSalaPianta[]> {
    const sale = await getSaleMenu();
    // Una data qualunque basta per i nomi; oggi è quella già provata sulla
    // cassa vera (06/10).
    const oggi = new Date().toISOString().slice(0, 10);
    const out: PassepartoutSalaPianta[] = [];
    for (const sala of sale) {
        const result = (await soapCall(
            'GetDisponibilitaTavoliMenu',
            `<sala>${xmlEscape(sala)}</sala><inizioPrenotazione>${oggi}T12:00:00</inizioPrenotazione>`,
            60_000,
        )) as Record<string, any> | null;
        const tavoliRaw: Record<string, any>[] = result?.Tavoli?.PMBTavolo ?? [];
        const tavoli = tavoliRaw
            .filter((t) => !/^Ingombro/i.test(asString(t.Tipo) ?? ''))
            .map((t) => ({ nome: (asString(t.Nome) ?? '').trim(), coperti: asNumber(t.Coperti) }))
            .filter((t) => t.nome !== '' && t.nome.toLowerCase() !== 'null');
        out.push({ sala, tavoli });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Conti del giorno, per il CRM (report, spesa per cliente, riscontro)
// ---------------------------------------------------------------------------

/** Comande del giorno (YYYY-MM-DD), aperte e chiuse: tavolo, sala, coperti e
 *  la prenotazione da cui il tavolo è nato. Le righe ci sono ma qui servono
 *  solo per i tavoli aperti. */
export async function getComandeGiorno(giorno: string, asporto = false): Promise<PassepartoutComanda[]> {
    const result = (await soapCall(
        'GetComandeGiorno',
        `<asporto>${asporto ? 'true' : 'false'}</asporto><giorno>${xmlEscape(giorno)}T00:00:00</giorno>` +
        `<ultimaModifica>2000-01-01T00:00:00</ultimaModifica>`,
        60_000,
    )) as Record<string, any> | null;
    if (!result || isNil(result)) return [];
    const entries: Record<string, any>[] = result.ContrattoComanda ?? [];
    return entries.map(mapComanda);
}

export interface PassepartoutContoCassa {
    idConto: number;
    idComanda: number | null;
    /** Come la rende il gestionale (ora di sala, a volte con l'offset). */
    chiusoAt: string | null;
    coperti: number | null;
    totaleDocumento: number | null;
    totalePagato: number | null;
    sospeso: number | null;
    /** EnumStatoConto: Aperto, Pagato, Sospeso, Annullato, Emesso… */
    stato: string | null;
    /** EnumTipoConto: Unico, Reso, Annullo, Acconto… */
    tipoConto: string | null;
    /** EnumTipoDocumentoConto: Scontrino, Proforma, Fattura… */
    tipoDocumento: string | null;
    numeroScontrino: string | null;
    pagamenti: Array<{ codice: string | null; categoria: string | null; importo: number | null }>;
    tavolo: string | null;
    sala: string | null;
    idPrenotazione: number | null;
}

/** Tetto alle letture comanda per comanda: un giorno con l'elenco comande
 *  vuoto non deve diventare cento chiamate alla cassa. */
const COMANDE_SINGOLE_MAX = 40;

/**
 * I conti chiusi del giorno con tavolo, sala e prenotazione della loro
 * comanda. Due letture (conti + comande del giorno); le comande che non
 * compaiono nell'elenco si leggono una per una, fino al tetto.
 */
export async function getContiCassaGiorno(giorno: string): Promise<PassepartoutContoCassa[]> {
    const conti = await getContiGiorno(giorno);
    let comande: PassepartoutComanda[] = [];
    try {
        comande = await getComandeGiorno(giorno);
    } catch (err) {
        if (!(err instanceof PassepartoutError)) throw err;
    }
    const perId = new Map<number, PassepartoutComanda>();
    for (const c of comande) if (c.idGestionale != null) perId.set(c.idGestionale, c);
    const mancanti = [...new Set(conti
        .map((c) => asNumber(c.IdComanda))
        .filter((id): id is number => id != null && id > 0 && !perId.has(id)))].slice(0, COMANDE_SINGOLE_MAX);
    for (const id of mancanti) {
        try {
            const c = await getComanda(id);
            if (c) perId.set(id, c);
        } catch (err) {
            if (!(err instanceof PassepartoutError)) throw err;
        }
    }
    return conti
        .map((c: Record<string, any>) => {
            const idConto = asNumber(c.IdGestionale);
            if (idConto == null) return null;
            const idComanda = asNumber(c.IdComanda) || null;
            const comanda = idComanda != null ? perId.get(idComanda) : undefined;
            const pagRaw = c.Pagamenti?.PMBRigaPagamento ?? [];
            const pagamenti = (Array.isArray(pagRaw) ? pagRaw : [pagRaw]).map((p: Record<string, any>) => ({
                codice: asString(p?.Tipo?.Codice),
                categoria: asString(p?.Tipo?.Categoria),
                importo: asNumber(p?.Importo),
            }));
            return {
                idConto,
                idComanda,
                chiusoAt: asString(c.DataChiusura),
                coperti: asNumber(c.NumeroCoperti) ?? comanda?.coperti ?? null,
                totaleDocumento: asNumber(c.TotaleDocumento),
                totalePagato: asNumber(c.TotalePagato),
                sospeso: asNumber(c.Sospeso),
                stato: asString(c.StatoEnum),
                tipoConto: asString(c.TipoContoEnum),
                tipoDocumento: asString(c.TipoDocumentoEnum),
                numeroScontrino: asString(c.NumeroScontrinoFiscale),
                pagamenti,
                tavolo: comanda?.tavolo ?? null,
                sala: comanda?.sala ?? null,
                idPrenotazione: comanda?.idPrenotazione ?? null,
            } satisfies PassepartoutContoCassa;
        })
        .filter((c): c is PassepartoutContoCassa => c != null);
}

// ---------------------------------------------------------------------------
// Tavoli aperti adesso (per sala e disponibilità del CRM)
// ---------------------------------------------------------------------------

export interface PassepartoutComandaAperta {
    idComanda: number;
    tavolo: string;
    sala: string | null;
    coperti: number | null;
    idPrenotazione: number | null;
    /** Apertura, come la rende il gestionale (ora di sala). */
    aperta: string | null;
    /** Somma delle righe battute finora. */
    totale: number;
}

/** Le comande ancora aperte sui tavoli (asporto escluso). Fino alle 5 si
 *  guarda anche il giorno prima: i tavoli aperti prima di mezzanotte
 *  restano sul giorno di gestione precedente. */
export async function getComandeAperte(): Promise<PassepartoutComandaAperta[]> {
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' });
    const ora = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(new Date());
    const oggi = fmt.format(new Date());
    const giorni = Number(ora) < 5 ? [fmt.format(new Date(Date.now() - 86_400_000)), oggi] : [oggi];
    const viste = new Map<number, PassepartoutComandaAperta>();
    for (const giorno of giorni) {
        for (const c of await getComandeGiorno(giorno)) {
            if (c.idGestionale == null || c.isPagato || !c.tavolo) continue;
            viste.set(c.idGestionale, {
                idComanda: c.idGestionale,
                tavolo: c.tavolo,
                sala: c.sala,
                coperti: c.coperti,
                idPrenotazione: c.idPrenotazione ?? null,
                aperta: c.dataCreazione ?? null,
                totale: c.righe.reduce((s, r) => s + (r.totale ?? 0), 0),
            });
        }
    }
    return [...viste.values()];
}
