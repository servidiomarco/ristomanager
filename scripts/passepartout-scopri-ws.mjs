// Scoperta delle operazioni dell'AdapterWS di Passepartout Menù, SENZA
// documentazione del concessionario: il servizio WCF si autodescrive.
//
// Obiettivo: capire se il Web Service permette di CREARE una comanda (la
// "comanda specchio" che automatizzerebbe lo scontrino dall'RT senza
// battitura manuale — vedi docs/serata-pilota-comande.md, sezione "Dopo").
//
// Va lanciato DALLA LAN del ristorante (la stessa macchina dell'agente
// Passepartout va benissimo — le env sono già lì):
//
//   PASSEPARTOUT_WS_URL=http://<host>:7606/AdapterWS \
//   PASSEPARTOUT_WS_USER=... PASSEPARTOUT_WS_PASSWORD=... \
//   node scripts/passepartout-scopri-ws.mjs wsdl
//
// Comandi:
//   wsdl               scarica ?wsdl / ?singleWsdl, elenca TUTTE le
//                      operazioni, evidenzia le candidate di scrittura e
//                      salva il contratto in adapterws.wsdl (da passare a
//                      Claude per progettare la comanda specchio).
//   probe [nomi...]    fallback se i metadati sono spenti: chiama i nomi
//                      candidati con i soli datiLogin e classifica il SOAP
//                      fault — "azione sconosciuta" = non esiste,
//                      "parametro mancante/deserializzazione" = ESISTE.
//
// Sicurezza del probe: si sondano SOLO operazioni che per semantica
// richiedono una comanda/righe come parametro — con corpo vuoto falliscono
// PRIMA di toccare i dati. Mai aggiungere alla lista nomi "parameterless"
// (es. Azzera*, Reset*): un'operazione senza parametri verrebbe ESEGUITA.

const URL_WS = (process.env.PASSEPARTOUT_WS_URL || '').trim().replace(/\/$/, '');
const UTENTE = process.env.PASSEPARTOUT_WS_USER || '';
const PASSWORD = process.env.PASSEPARTOUT_WS_PASSWORD || '';
const AZIENDA = process.env.PASSEPARTOUT_WS_AZIENDA || '';
const BEW = process.env.PASSEPARTOUT_WS_BEW || '';

if (!URL_WS || !UTENTE) {
    console.error('Servono PASSEPARTOUT_WS_URL e PASSEPARTOUT_WS_USER (più password) nell\'ambiente.');
    process.exit(1);
}

const TEMPURI = 'http://tempuri.org/';
const NS_KERNEL = 'http://schemas.datacontract.org/2004/07/Kernel';

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const infoLoginXml = () => {
    const parts = [];
    if (AZIENDA) parts.push(`<k:Azienda>${xmlEscape(AZIENDA)}</k:Azienda>`);
    if (BEW) parts.push(`<k:Bew>${xmlEscape(BEW)}</k:Bew>`);
    parts.push(`<k:Password>${xmlEscape(PASSWORD)}</k:Password>`);
    parts.push(`<k:Utente>${xmlEscape(UTENTE)}</k:Utente>`);
    return `<datiLogin xmlns:k="${NS_KERNEL}">${parts.join('')}</datiLogin>`;
};

// Nomi che nell'ecosistema WCF/gestionali indicano scrittura sul dominio
// che ci interessa. Usati per evidenziare nel wsdl e come lista di probe.
const WRITE_HINT = /^(Write|Set|Insert|Inserisci|Crea|Nuova?|Apri|Add|Aggiungi|Salva|Registra|Update|Modifica)/i;
const DOMAIN_HINT = /Comand|Cont[oi]|Tavol|Rig[ah]/i;
const PROBE_DEFAULTS = [
    'WriteComanda', 'InserisciComanda', 'CreaComanda', 'NuovaComanda', 'SetComanda',
    'ApriComanda', 'AddComanda', 'SalvaComanda', 'AggiungiComanda',
    'AggiungiRigheComanda', 'InserisciRigheComanda', 'WriteRigheComanda',
    'ApriTavolo', 'CreaConto', 'InserisciConto',
];

async function wsdl() {
    for (const suffix of ['?singleWsdl', '?wsdl']) {
        const url = URL_WS + suffix;
        let text;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) { console.log(`${suffix}: HTTP ${res.status}`); continue; }
            text = await res.text();
        } catch (err) {
            console.log(`${suffix}: ${err?.message}`);
            continue;
        }
        // Le operazioni stanno nel portType/binding: name="<Operazione>".
        const ops = [...new Set([...text.matchAll(/<wsdl:operation name="([^"]+)"/g)].map(m => m[1]))].sort();
        if (ops.length === 0) { console.log(`${suffix}: nessuna operazione trovata (metadati spenti?)`); continue; }

        const { writeFileSync } = await import('node:fs');
        writeFileSync('adapterws.wsdl', text);
        console.log(`\nContratto salvato in adapterws.wsdl (${text.length} byte) da ${suffix}`);
        console.log(`\nOperazioni (${ops.length}):`);
        for (const op of ops) {
            const hot = WRITE_HINT.test(op) && DOMAIN_HINT.test(op);
            console.log(`  ${hot ? '→ ' : '  '}${op}${hot ? '   ← CANDIDATA SCRITTURA' : ''}`);
        }
        const hot = ops.filter(op => WRITE_HINT.test(op) && DOMAIN_HINT.test(op));
        console.log(hot.length
            ? `\nCandidate per la comanda specchio: ${hot.join(', ')}\nPassa adapterws.wsdl a Claude per il passo successivo.`
            : '\nNessuna candidata di scrittura sul dominio comande: la comanda specchio via WS non è percorribile con questo contratto.');
        return;
    }
    console.log('\nMetadati non esposti: usa il comando "probe".');
}

async function probeOne(operation) {
    const envelope =
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<${operation} xmlns="${TEMPURI}">${infoLoginXml()}</${operation}>` +
        `</s:Body></s:Envelope>`;
    try {
        const res = await fetch(URL_WS, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${TEMPURI}IAdapterWS/${operation}"` },
            body: envelope,
            signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        // WCF: azione ignota → fault ActionNotSupported ("cannot be processed
        // at the receiver..."). Tutto il resto (fault applicativo, errore di
        // deserializzazione, perfino un 200) significa che l'operazione ESISTE.
        if (/ActionNotSupported|cannot be processed at the receiver|non può essere elaborato/i.test(text)) {
            return { exists: false, detail: 'azione sconosciuta' };
        }
        const fault = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i)?.[1]?.slice(0, 160);
        return { exists: true, detail: res.ok && !fault ? `HTTP 200 — ATTENZIONE: potrebbe aver eseguito qualcosa` : (fault ?? `HTTP ${res.status}`) };
    } catch (err) {
        return { exists: null, detail: err?.message ?? 'errore di rete' };
    }
}

async function probe(names) {
    const list = names.length ? names : PROBE_DEFAULTS;
    console.log(`Sondaggio di ${list.length} operazioni su ${URL_WS} (solo datiLogin, nessun dato scritto):\n`);
    for (const op of list) {
        const r = await probeOne(op);
        const mark = r.exists === true ? 'ESISTE  ' : r.exists === false ? 'no      ' : 'rete?   ';
        console.log(`  ${mark}${op}  ${r.exists ? `(${r.detail})` : ''}`);
    }
    console.log('\n"ESISTE" con fault di parametri = l\'operazione c\'è: si progetta la comanda specchio su quella.');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'wsdl') await wsdl();
else if (cmd === 'probe') await probe(rest);
else { console.log('Comandi: wsdl | probe [NomeOperazione...]'); process.exit(1); }
