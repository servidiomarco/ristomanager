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
}): Promise<Record<string, unknown> | null> {
    const NS_CONTO = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Conto';
    const NS_COMMON = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Common';
    // ContrattoConto è tutto minOccurs=0, ma l'ordine dei membri è quello
    // alfabetico del data contract WCF: ComandoEnum, IdComanda, IdGestionale,
    // Pagamenti. Dentro PMBRigaPagamento: Importo prima di Tipo; dentro
    // PMBTipoPagamento (namespace Common): Categoria prima di Codice.
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
        `<c:ComandoEnum>Chiudi</c:ComandoEnum>` +
        `<c:IdComanda>${params.idComanda}</c:IdComanda>` +
        `<c:IdGestionale>${params.idConto}</c:IdGestionale>` +
        pagamentiXml +
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
 */
export async function chiudiComandaCompleta(params: {
    idComanda: number;
    tipoDocumento?: TipoDocumentoConto;
    tipoPagamento?: string;
    importoPagato?: number;
    proforma?: boolean;
}): Promise<EsitoChiusuraComanda> {
    const comanda = await getComanda(params.idComanda);
    if (!comanda) {
        throw new PassepartoutError(`Comanda ${params.idComanda} non trovata sul gestionale`, 'ContoComanda');
    }
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
    let conto = conti.filter((c) => asNumber(c.IdComanda ?? (c as any).idComanda) === params.idComanda).pop();
    if (!conto) {
        throw new PassepartoutError(
            avviso ?? `Conto della comanda ${params.idComanda} non trovato in archivio dopo la chiusura`,
            'ContoComanda',
        );
    }
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
