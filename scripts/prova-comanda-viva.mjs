#!/usr/bin/env node
// Prove della «comanda viva in cassa» (fase 0) sulla cassa Passepartout vera,
// da fare a LOCALE CHIUSO: scrivono comande, e `invia` stampa in cucina.
//
// Gira sul PC della cassa, accanto all'agente: le credenziali del web service
// arrivano dalle variabili PASSEPARTOUT_WS_* (le mette prova-comanda-viva.ps1
// leggendole dal .cmd dell'agente) e non si stampano mai. Il parser XML è
// quello del pacchetto installato (PP_PACCHETTO).
//
// Ogni comando rilegge la comanda e ne stampa le righe; tutto finisce anche
// in prova-comanda-viva.log (senza credenziali). La comanda di prova resta in
// prova-comanda-viva.json, così i passi si fanno uno alla volta.
//
// Lo schema viene dal WSDL della cassa (07/10): PMBRigaComanda non ha note
// per riga, ha DaCancellare, StatoEnum (Nuovo, InAttesa, InProduzione,
// Fatto, Cancellato, Preventivo), Uscita e Varianti (PMBRigaVariante:
// Descrizione, IdGestionale, InAggiunta, Prezzo, QuantitaUM, RigaComanda,
// Variante). ContrattoComanda eredita da Contratto (IDDati, IsParziale,
// UltimaModifica): i membri della base vanno PRIMA, poi gli altri in ordine
// alfabetico. Un campo fuori posto la cassa lo ignora in silenzio.
//
// Comandi:
//   articoli <testo>                      cerca nel catalogo (codice, tipo, prezzo, varianti)
//   leggi [idComanda]                     la comanda di prova (o quella indicata)
//   crea <articolo1> <articolo2>          comanda nuova: riga 1 uscita 1, riga 2 uscita 2, senza invio
//   adotta                                la comanda aperta sul tavolo diventa quella di prova
//   aggiungi <articolo> [--uscita n]      una riga in più (--modo tutte | nuove | parziale)
//   variante <articolo> <variante|-> [testo libero]   una riga con varianti
//   (articolo e variante col numero che stampa «articoli»: i codici hanno spazi)
//   invia <uscita>                        InviaProduzioneComanda di quella sola uscita
//   togli <idRiga>                        la riga con DaCancellare (--modo tutte | nuove | parziale)
//   pezzi <idRiga> <n>                    cambia la quantità della riga (--modo tutte | nuove)
//   sposta <tavolo> [--sala S]            la comanda su un altro tavolo
//   chiudi [tipoPagamento]                proforma pagata (default ESTERNO), senza invio
// Opzioni: --tavolo 88 --sala TETTOIA --prezzo 1.00 --modo tutte|nuove|parziale --prova (solo XML)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const PACCHETTO = process.env.PP_PACCHETTO || 'C:\\ristomanager-agents\\versions\\4389aa1';
const { XMLParser } = createRequire(path.join(PACCHETTO, 'package.json'))('fast-xml-parser');

const TEMPURI = 'http://tempuri.org/';
const NS_KERNEL = 'http://schemas.datacontract.org/2004/07/PMessageBox.Kernel';
const NS_CONTRACT = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract';
const NS_COMANDA = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract.Comanda';
const STATO = path.resolve('prova-comanda-viva.json');
const LOG = path.resolve('prova-comanda-viva.log');
const CACHE_ARTICOLI = path.resolve('prova-comanda-viva-articoli-v2.json');

// --- argomenti ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opzioni = {};
const posizionali = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
        const nome = argv[i].slice(2);
        const valore = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
        opzioni[nome] = valore;
    } else posizionali.push(argv[i]);
}
const [comando, ...args] = posizionali;
const soloXml = opzioni.prova === 'true';
const modo = ['parziale', 'nuove'].includes(opzioni.modo) ? opzioni.modo : 'tutte';

const stato = fs.existsSync(STATO) ? JSON.parse(fs.readFileSync(STATO, 'utf8')) : {};
const tavolo = opzioni.tavolo || stato.tavolo || '88';
const sala = opzioni.sala || stato.sala || 'TETTOIA';
const salvaStato = (s) => fs.writeFileSync(STATO, JSON.stringify({ ...stato, ...s }, null, 2));
const log = (voce) => fs.appendFileSync(LOG, JSON.stringify({ quando: new Date().toISOString(), comando, ...voce }) + '\n');

// --- trasporto ------------------------------------------------------------------
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cfg = {
    url: (process.env.PASSEPARTOUT_WS_URL || '').trim().replace(/\/$/, ''),
    utente: process.env.PASSEPARTOUT_WS_USER || '',
    password: process.env.PASSEPARTOUT_WS_PASSWORD || '',
    azienda: process.env.PASSEPARTOUT_WS_AZIENDA || '',
    bew: process.env.PASSEPARTOUT_WS_BEW || '',
};
const login = () => `<datiLogin xmlns:k="${NS_KERNEL}">` +
    (cfg.azienda ? `<k:Azienda>${esc(cfg.azienda)}</k:Azienda>` : '') +
    (cfg.bew ? `<k:Bew>${esc(cfg.bew)}</k:Bew>` : '') +
    `<k:Password>${esc(cfg.password)}</k:Password><k:Utente>${esc(cfg.utente)}</k:Utente></datiLogin>`;

const parser = new XMLParser({
    removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false,
    isArray: (n) => ['PMBRigaComanda', 'PMBRigaVariante', 'ContrattoArticolo', 'ContrattoConto', 'string'].includes(n),
});

async function soap(operazione, paramsXml = '', timeoutMs = 30_000) {
    if (soloXml) {
        console.log(`\n--- ${operazione} (non inviato) ---\n${paramsXml}\n`);
        return null;
    }
    if (!cfg.url || !cfg.utente) throw new Error('PASSEPARTOUT_WS_URL / PASSEPARTOUT_WS_USER mancanti');
    const envelope = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<${operazione} xmlns="${TEMPURI}">${login()}${paramsXml}</${operazione}></s:Body></s:Envelope>`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let testo;
    try {
        const r = await fetch(cfg.url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${TEMPURI}IAdapterWS/${operazione}"` },
            body: envelope,
            signal: controller.signal,
        });
        testo = await r.text();
    } finally {
        clearTimeout(timer);
    }
    const body = parser.parse(testo)?.Envelope?.Body;
    if (body?.Fault) {
        const msg = typeof body.Fault.faultstring === 'object' ? body.Fault.faultstring['#text'] : body.Fault.faultstring;
        log({ operazione, params: paramsXml, errore: String(msg) });
        throw new Error(`${operazione}: ${String(msg).replace(/\s+/g, ' ').trim()}`);
    }
    const risultato = body?.[`${operazione}Response`]?.[`${operazione}Result`] ?? null;
    log({ operazione, params: paramsXml, risposta: risultato });
    return risultato;
}

// --- lettura ----------------------------------------------------------------------
const nil = (v) => v == null || (typeof v === 'object' && (v['@_i:nil'] === 'true' || v['@_nil'] === 'true'));
const s = (v) => (nil(v) ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));
const n = (v) => { const x = Number(s(v)); return s(v) == null || !Number.isFinite(x) ? null : x; };

async function leggiComanda(id) {
    const c = await soap('GetComanda', `<idGestionale>${id}</idGestionale>`);
    return nil(c) ? null : c;
}

function stampa(c, titolo) {
    if (!c) { console.log(`${titolo}: nessuna comanda`); return; }
    console.log(`\n${titolo}: comanda ${s(c.IdGestionale)} · tavolo ${s(c.Tavolo)} ${s(c.Sala) ?? ''} · coperti ${s(c.Coperti)}` +
        ` · stato ${s(c.StatoEnum) ?? s(c.Stato)} · ultima uscita inviata ${s(c.UltimaPortataInviata)} · pagata ${s(c.IsPagato)}`);
    console.log(`  note: ${s(c.Note) ?? ''}`);
    for (const r of c?.Righe?.PMBRigaComanda ?? []) {
        const varianti = (r?.Varianti?.PMBRigaVariante ?? [])
            .map((v) => `${s(v.InAggiunta) === 'true' ? '+' : '-'}${s(v.Variante) ?? ''} ${s(v.Descrizione) ?? ''} ${s(v.Prezzo) ?? ''}`.trim());
        console.log(`  riga ${s(r.IdGestionale)} · ${s(r.Articolo)} «${s(r.Descrizione)}» × ${s(r.Pezzi)} a ${s(r.Prezzo)} = ${s(r.Totale)}` +
            ` · uscita ${s(r.Uscita)} · stato ${s(r.StatoEnum) ?? s(r.Stato)} · tipo ${s(r.TipoEnum) ?? s(r.Tipo)}` +
            ` · inviata ${s(r.DataInvio) ?? '-'}${s(r.DaCancellare) === 'true' ? ' · DA CANCELLARE' : ''}` +
            (varianti.length ? ` · varianti: ${varianti.join(' | ')}` : ''));
    }
}

// --- scrittura ----------------------------------------------------------------------
// Campi di PMBRigaComanda nell'ordine dello schema; si scrivono solo quelli dati.
const ORDINE_RIGA = ['Articolo', 'DaCancellare', 'Descrizione', 'IdGestionale', 'Pezzi', 'Prezzo', 'TipoEnum',
    'Tool_EseguiInvio', 'Totale', 'Uscita', 'Varianti'];
function rigaXml(r) {
    return '<c:PMBRigaComanda>' + ORDINE_RIGA.map((k) => {
        if (r[k] == null) return '';
        if (k === 'Varianti') {
            return '<c:Varianti>' + r.Varianti.map((v) => '<c:PMBRigaVariante>' +
                (v.Descrizione != null ? `<c:Descrizione>${esc(v.Descrizione)}</c:Descrizione>` : '') +
                `<c:InAggiunta>${v.InAggiunta ? 'true' : 'false'}</c:InAggiunta>` +
                (v.Prezzo != null ? `<c:Prezzo>${Number(v.Prezzo).toFixed(2)}</c:Prezzo>` : '') +
                (v.Variante != null ? `<c:Variante>${esc(v.Variante)}</c:Variante>` : '') +
                '</c:PMBRigaVariante>').join('') + '</c:Varianti>';
        }
        const valore = ['Prezzo', 'Totale'].includes(k) ? Number(r[k]).toFixed(2) : r[k];
        return `<c:${k}>${esc(valore)}</c:${k}>`;
    }).join('') + '</c:PMBRigaComanda>';
}
function comandaXml({ idDati, parziale, coperti, id, note, righe, sala: salaC, tavolo: tavoloC }) {
    return `<comanda xmlns:b="${NS_CONTRACT}" xmlns:c="${NS_COMANDA}">` +
        (idDati ? `<b:IDDati>${esc(idDati)}</b:IDDati>` : '') +
        (parziale ? '<b:IsParziale>true</b:IsParziale>' : '') +
        (coperti != null ? `<c:Coperti>${coperti}</c:Coperti>` : '') +
        (id != null ? `<c:IdGestionale>${id}</c:IdGestionale>` : '') +
        (note != null ? `<c:Note>${esc(note)}</c:Note>` : '') +
        `<c:Righe>${righe.map(rigaXml).join('')}</c:Righe>` +
        (salaC ? `<c:Sala>${esc(salaC)}</c:Sala>` : '') +
        (tavoloC ? `<c:Tavolo>${esc(tavoloC)}</c:Tavolo>` : '') +
        '</comanda>';
}
/** Le righe già in comanda, rimandate com'erano (modo «tutte»). */
const righeEsistenti = (c) => (c?.Righe?.PMBRigaComanda ?? []).map((r) => ({
    Articolo: s(r.Articolo), Descrizione: s(r.Descrizione), IdGestionale: s(r.IdGestionale), Pezzi: s(r.Pezzi),
    Prezzo: s(r.Prezzo), Tool_EseguiInvio: 'false', Totale: s(r.Totale), Uscita: s(r.Uscita),
}));
const rigaNuova = (codice, uscita, extra = {}) => ({
    Articolo: codice, Pezzi: 1, Tool_EseguiInvio: 'false', Uscita: uscita,
    ...(opzioni.prezzo ? { Prezzo: Number(opzioni.prezzo), Totale: Number(opzioni.prezzo) } : {}),
    ...extra,
});

function comandaDiProva() {
    if (!stato.idComanda) throw new Error('Nessuna comanda di prova: prima «crea» o «adotta»');
    return Number(stato.idComanda);
}

/** Scrive sulla comanda di prova nel modo scelto: «tutte» le righe
 *  (esistenti più quelle nuove), solo le «nuove» con l'IdGestionale della
 *  comanda, o solo le nuove con IsParziale («parziale», ignorato dalla cassa
 *  il 07/10). */
async function scriviSullaComanda(righeNuove, extra = {}) {
    const id = comandaDiProva();
    const prima = await leggiComanda(id);
    stampa(prima, 'Prima');
    const righe = modo === 'tutte' ? [...righeEsistenti(prima), ...righeNuove] : righeNuove;
    const xml = comandaXml({
        idDati: modo === 'parziale' ? `ContrattoComanda|${id}` : null,
        parziale: modo === 'parziale',
        id,
        righe,
        ...extra,
    });
    console.log(`\nPutComanda in modo «${modo}» con ${righe.length} righe`);
    const r = await soap('PutComanda', xml);
    console.log(`Risposta: comanda ${s(r?.IdGestionale)}`);
    stampa(await leggiComanda(id), 'Dopo');
}

// --- catalogo ---------------------------------------------------------------------------
// I codici della cassa hanno spazi («Tagliatelle Silana», «In 2 piatti»), che
// fra ssh e PowerShell spezzerebbero gli argomenti: nei comandi un articolo
// o una variante si indica col suo numero (367), il primo campo che stampa
// «articoli»; un codice senza spazi va bene anche così. Niente «#» davanti:
// nella riga di comando inizia un commento.
async function catalogo() {
    if (fs.existsSync(CACHE_ARTICOLI)) return JSON.parse(fs.readFileSync(CACHE_ARTICOLI, 'utf8'));
    console.log('Leggo il catalogo (fino a 2 minuti)…');
    const r = await soap('GetArticoli', '<ultimaModifica>2000-01-01T00:00:00</ultimaModifica>', 180_000);
    const articoli = (r?.ContrattoArticolo ?? []).map((a) => ({
        id: n(a.IdGestionale), codice: s(a.Codice), descrizione: s(a.Descrizione), prezzo: n(a.Prezzo), tipo: s(a.TipoEnum),
        attivo: s(a.IsAttivo), categoria: s(a?.Categoria?.Descrizione),
        varianti: (a?.Varianti?.string ?? []).map(String),
        variantiCategoria: (a?.Categoria?.Varianti?.string ?? []).map(String),
    }));
    fs.writeFileSync(CACHE_ARTICOLI, JSON.stringify(articoli));
    return articoli;
}
async function codiceDi(arg) {
    const m = /^#?(\d+)$/.exec(String(arg ?? ''));
    if (!m) return arg;
    if (soloXml) return `ART${m[1]}`;
    const a = (await catalogo()).find((x) => x.id === Number(m[1]));
    if (!a?.codice) throw new Error(`Nessun articolo #${m[1]} nel catalogo: cercalo con «articoli»`);
    return a.codice;
}

// --- comandi --------------------------------------------------------------------------
async function main() {
    switch (comando) {
        case 'articoli': {
            const articoli = await catalogo();
            const cerca = (args.join(' ') || '').toLowerCase();
            for (const a of articoli.filter((x) => `${x.codice} ${x.descrizione} ${x.categoria}`.toLowerCase().includes(cerca)).slice(0, 40)) {
                console.log(`${a.id} · ${a.codice} · «${a.descrizione}» · ${a.tipo} · ${a.prezzo ?? '-'} € · ${a.categoria ?? ''}` +
                    (a.attivo === 'false' ? ' · SPENTO' : '') +
                    (a.varianti.length || a.variantiCategoria.length ? ` · varianti: ${[...a.varianti, ...a.variantiCategoria].join(', ')}` : ''));
            }
            return;
        }
        case 'leggi': {
            stampa(await leggiComanda(Number(args[0] ?? comandaDiProva())), 'Comanda');
            return;
        }
        case 'crea': {
            if (args.length < 2) throw new Error('crea <codice1> <codice2>');
            const sulTavolo = soloXml ? null : await soap('GetComandaTavolo', `<tavolo>${esc(tavolo)}</tavolo>`);
            if (!nil(sulTavolo) && sulTavolo) throw new Error(`Il tavolo ${tavolo} ha già la comanda ${s(sulTavolo.IdGestionale)}: usa «adotta» o un altro tavolo`);
            const xml = comandaXml({
                coperti: 0,
                note: 'PROVA Sympotia comanda viva',
                righe: [rigaNuova(await codiceDi(args[0]), 1), rigaNuova(await codiceDi(args[1]), 2)],
                sala, tavolo,
            });
            const r = await soap('PutComanda', xml);
            const id = n(r?.IdGestionale);
            console.log(`Comanda creata: ${id}`);
            if (id) salvaStato({ idComanda: id, tavolo, sala });
            if (id) stampa(await leggiComanda(id), 'Dopo');
            return;
        }
        case 'adotta': {
            const c = await soap('GetComandaTavolo', `<tavolo>${esc(tavolo)}</tavolo>`);
            if (nil(c) || !c) throw new Error(`Nessuna comanda aperta sul tavolo ${tavolo}`);
            salvaStato({ idComanda: n(c.IdGestionale), tavolo, sala: s(c.Sala) ?? sala });
            stampa(c, 'Adottata');
            return;
        }
        case 'aggiungi': {
            if (!args[0]) throw new Error('aggiungi <codice> [--uscita n]');
            await scriviSullaComanda([rigaNuova(await codiceDi(args[0]), Number(opzioni.uscita ?? 1))]);
            return;
        }
        case 'variante': {
            if (!args[0] || !args[1]) throw new Error('variante <codice> <codVariante|-> [testo libero]');
            const varianti = [];
            if (args[1] !== '-') varianti.push({ Variante: await codiceDi(args[1]), InAggiunta: true });
            const libero = args.slice(2).join(' ');
            if (libero) varianti.push({ Descrizione: libero, InAggiunta: false, Prezzo: 0 });
            await scriviSullaComanda([rigaNuova(await codiceDi(args[0]), Number(opzioni.uscita ?? 1), { Varianti: varianti })]);
            return;
        }
        case 'invia': {
            const id = comandaDiProva();
            const uscita = Number(args[0]);
            if (!Number.isInteger(uscita)) throw new Error('invia <uscita>');
            await soap('InviaProduzioneComanda',
                `<idComanda>${id}</idComanda><inviaTutto>false</inviaTutto>` +
                `<uscite xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><a:int>${uscita}</a:int></uscite>`);
            console.log(`Uscita ${uscita} mandata in produzione: guarda le stampanti`);
            stampa(await leggiComanda(id), 'Dopo');
            return;
        }
        case 'togli': {
            const idRiga = args[0];
            if (!idRiga) throw new Error('togli <idRiga>');
            const id = comandaDiProva();
            const prima = await leggiComanda(id);
            const riga = (prima?.Righe?.PMBRigaComanda ?? []).find((r) => s(r.IdGestionale) === String(idRiga));
            if (!riga && !soloXml) throw new Error(`La riga ${idRiga} non è nella comanda ${id}`);
            const daTogliere = { ...(riga ? righeEsistenti({ Righe: { PMBRigaComanda: [riga] } })[0] : { IdGestionale: idRiga }), DaCancellare: 'true' };
            if (modo !== 'tutte') {
                await scriviSullaComanda([daTogliere]);
            } else {
                stampa(prima, 'Prima');
                const righe = righeEsistenti(prima).map((r) => (r.IdGestionale === String(idRiga) ? daTogliere : r));
                await soap('PutComanda', comandaXml({ id, righe }));
                stampa(await leggiComanda(id), 'Dopo');
            }
            return;
        }
        case 'pezzi': {
            const [idRiga, quanti] = args;
            if (!idRiga || !Number.isInteger(Number(quanti))) throw new Error('pezzi <idRiga> <n>');
            const prima = soloXml ? null : await leggiComanda(comandaDiProva());
            const riga = (prima?.Righe?.PMBRigaComanda ?? []).find((r) => s(r.IdGestionale) === String(idRiga));
            if (!riga && !soloXml) throw new Error(`La riga ${idRiga} non è nella comanda ${comandaDiProva()}`);
            const base = riga ? righeEsistenti({ Righe: { PMBRigaComanda: [riga] } })[0] : { IdGestionale: idRiga };
            const prezzo = Number(base.Prezzo ?? 0);
            await scriviSullaComanda([{ ...base, Pezzi: Number(quanti), Totale: prezzo * Number(quanti) }]);
            return;
        }
        case 'sposta': {
            if (!args[0]) throw new Error('sposta <tavolo> [--sala S]');
            const id = comandaDiProva();
            const prima = await leggiComanda(id);
            stampa(prima, 'Prima');
            await soap('PutComanda', comandaXml({ id, righe: righeEsistenti(prima), sala: opzioni.sala || s(prima?.Sala), tavolo: args[0] }));
            const dopo = await leggiComanda(id);
            stampa(dopo, 'Dopo');
            if (dopo) salvaStato({ tavolo: s(dopo.Tavolo), sala: s(dopo.Sala) });
            return;
        }
        case 'chiudi': {
            const id = comandaDiProva();
            const tipo = args[0] || process.env.PASSEPARTOUT_TIPO_PAGAMENTO || 'ESTERNO';
            await soap('ContoComanda',
                `<idComanda>${id}</idComanda><noInvio>true</noInvio><tipoDoc>Proforma</tipoDoc><tipoPag>${esc(tipo)}</tipoPag>`, 60_000);
            const conti = await soap('GetContiGiorno', `<giorno>${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date())}T00:00:00</giorno>`, 60_000);
            const conto = (conti?.ContrattoConto ?? []).filter((c) => n(c.IdComanda) === id).pop();
            console.log(conto
                ? `Conto ${s(conto.IdGestionale)}: ${s(conto.StatoEnum)} · ${s(conto.TipoDocumentoEnum) ?? ''} · da pagare ${s(conto.TotaleDaPagare)} · pagato ${s(conto.TotalePagato)}`
                : 'Conto non trovato nell\'archivio di oggi');
            return;
        }
        default: {
            const testo = fs.readFileSync(new URL(import.meta.url), 'utf8');
            console.log(testo.slice(testo.indexOf('// Comandi:'), testo.indexOf('\nimport ')).replace(/^\/\/ ?/gm, ''));
        }
    }
}

main().catch((err) => {
    console.error(`ERRORE: ${err.message}`);
    log({ errore: err.message });
    process.exitCode = 1;
});
