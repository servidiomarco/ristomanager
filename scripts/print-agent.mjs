// Agente di stampa — gira su una macchina della LAN del ristorante e fa da
// ponte fra la coda print_jobs del backend (che può stare in cloud) e la
// termica ESC/POS in sala (Ditron PRP-300, TCP 9100).
//
// Il flusso è pull, non push: l'agente interroga il backend ogni POLL_MS e
// conferma ogni job con un ack. Se la stampante è spenta o senza carta il job
// resta PENDING e esce al rientro; se il payload è rotto l'ack negativo lo fa
// arenare come FAILED dopo 20 tentativi invece di bloccare la coda.
//
// Uso:
//   PRINT_AGENT_TOKEN=... PRINTERS='preconti=192.168.1.50:9100,cucina=192.168.1.30:9100' \
//     node scripts/print-agent.mjs
// Env:
//   API_URL           default http://localhost:3005
//   PRINT_AGENT_TOKEN obbligatorio, deve combaciare con quello del backend
//   PRINTERS          mappa nome=ip[:porta] separata da virgole; ogni job
//                     porta il nome della sua stampante di destinazione
//   PRINTER_IP/PORT   legacy: se PRINTERS manca, diventa la voce 'preconti'
//   POLL_MS           default 2500
import net from 'net';

const API_URL = process.env.API_URL || 'http://localhost:3005';
const TOKEN = process.env.PRINT_AGENT_TOKEN;
const POLL_MS = Number(process.env.POLL_MS || 2500);

// Mappa di partenza dall'env: serve solo finché il backend non risponde.
// La fonte di verità è il registro a DB (Impostazioni → Sala & Cucina),
// scaricato via /print-agent/config a ogni poll.
const PRINTERS = new Map();
for (const entry of (process.env.PRINTERS || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const m = entry.match(/^([a-z0-9_-]+)=([0-9.]+)(?::(\d+))?$/i);
  if (m) PRINTERS.set(m[1], { host: m[2], port: Number(m[3] || 9100) });
}
if (PRINTERS.size === 0 && process.env.PRINTER_IP) {
  PRINTERS.set('preconti', {
    host: process.env.PRINTER_IP,
    port: Number(process.env.PRINTER_PORT || 9100),
  });
}

// Sostituisce la mappa con quella del backend. Se il registro è vuoto si
// tiene l'env: un backend appena migrato senza stampanti censite non deve
// spegnere un agente che stava già stampando.
function applyConfig(cfg) {
  const list = Array.isArray(cfg?.printers) ? cfg.printers : [];
  if (list.length === 0) return;
  const next = new Map(list.map(p => [p.name, { host: p.host, port: Number(p.port || 9100), buzzer: p.buzzer === true }]));
  const changed = next.size !== PRINTERS.size
    || [...next.entries()].some(([n, d]) => {
      const cur = PRINTERS.get(n);
      return !cur || cur.host !== d.host || cur.port !== d.port || Boolean(cur.buzzer) !== d.buzzer;
    });
  if (changed) {
    PRINTERS.clear();
    for (const [n, d] of next) PRINTERS.set(n, d);
    warnedUnknown.clear();
    log(`mappa stampanti aggiornata dal backend: [${[...PRINTERS.entries()].map(([n, d]) => `${n}=${d.host}:${d.port}${d.buzzer ? '+cicalino' : ''}`).join(', ')}]`);
  }
}

if (!TOKEN) {
  console.error('PRINT_AGENT_TOKEN mancante');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// ESC/POS
// ---------------------------------------------------------------------------
const ESC = 0x1b, GS = 0x1d;
const COLS = 42; // font A su 80mm; se la carta mostra righe corte, portare a 48

// Cicalino ESC B n t: n beep da t*100ms circa. È il comando delle termiche
// di questa famiglia (PRP-300 comprese); si antepone al job SOLO per le
// stampanti col flag `buzzer` acceso nel registro — la cucina deve sentire
// la comanda che arriva, il banco dei preconti no. Se un modello non lo
// supporta al peggio ignora la sequenza: si spegne il flag e via.
const BEEP = Buffer.from([ESC, 0x42, 3, 2]);

const euro = cents => (cents / 100).toFixed(2).replace('.', ',');

// Riga "sinistra ... destra" su COLS colonne; il nome si tronca, il prezzo mai.
const row = (left, right) => {
  const space = COLS - right.length - 1;
  const l = left.length > space ? left.slice(0, space - 1) + '…' : left;
  return l + ' '.repeat(COLS - l.length - right.length) + right + '\n';
};

function renderPreconto(p) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(s.replace('…', '.'), 'latin1'));

  push(ESC, 0x40);           // init
  push(ESC, 0x74, 16);       // codepage WPC1252: accenti italiani corretti
  // Doppia battuta su tutto il documento: la PRP-300 di suo stampa slavato
  // (bande bianche orizzontali) e il preconto va letto in penombra al tavolo.
  push(ESC, 0x47, 1);
  push(ESC, 0x61, 1);        // center
  push(GS, 0x21, 0x11);      // double w+h
  // title: «PROFORMA» sulla ristampa del conto chiuso con proforma; assente
  // sui preconti normali (e sui job di backend più vecchi di questo campo).
  text(`${p.title ?? 'PRECONTO'}\n`);
  push(GS, 0x21, 0x00);
  text(`Tavolo ${p.table_name ?? '-'} - ${p.covers} coperti\n`);
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x61, 0);        // left

  // Righe a doppia altezza (larghezza invariata: le 42 colonne di row()
  // restano valide) — si legge senza occhiali sul tavolo in penombra.
  push(GS, 0x21, 0x01);      // double height
  for (const i of p.items ?? []) {
    text(row(`${i.qty}x ${i.name}`, euro(i.total_cents)));
  }
  push(GS, 0x21, 0x00);
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x45, 1);        // bold
  push(GS, 0x21, 0x01);      // il totale alla stessa altezza delle righe
  text(row('TOTALE EUR', euro(p.total_cents)));
  push(GS, 0x21, 0x00);
  push(ESC, 0x45, 0);
  // Acconto: importo PIENO versato dal cliente. Se supera il totale, si stampa
  // anche quanto va rimborsato al cliente.
  const depositShown = p.deposit_paid_cents ?? p.deposit_credit_cents ?? 0;
  if (depositShown > 0) {
    text(row('Acconto versato', '-' + euro(depositShown)));
    if ((p.refund_due_cents ?? 0) > 0) {
      push(ESC, 0x45, 1);
      text(row('DA RIMBORSARE EUR', euro(p.refund_due_cents)));
      push(ESC, 0x45, 0);
    }
    push(ESC, 0x45, 1);
    push(GS, 0x21, 0x01);
    text(row('DA PAGARE EUR', euro(p.residual_cents ?? Math.max(0, p.total_cents - depositShown))));
    push(GS, 0x21, 0x00);
    push(ESC, 0x45, 0);
  }
  text('\n');

  if (p.share_url) {
    push(ESC, 0x61, 1);
    const data = Buffer.from(p.share_url, 'latin1');
    // Correzione errore H (30%) obbligatoria: la testina perde righe di
    // punti. Modulo 8 e' il compromesso: piu' compatto del 10 originale ma
    // ancora sopra la soglia (a 6 la fotocamera non aggancia il codice).
    push(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0);   // QR model 2
    push(GS, 0x28, 0x6b, 3, 0, 49, 67, 8);       // module size 8
    push(GS, 0x28, 0x6b, 3, 0, 49, 69, 51);      // error correction H
    const len = data.length + 3;
    push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 49, 80, 48, ...data);
    push(GS, 0x28, 0x6b, 3, 0, 49, 81, 48);      // print
    text('\ninquadra per pagare il conto\n');
  }

  push(ESC, 0x61, 1);
  text('\ndocumento non fiscale\n\n\n');
  push(GS, 0x56, 0x42, 0x00); // taglio parziale
  return Buffer.from(bytes);
}

// Copia di cortesia del documento commerciale gia' emesso via provider
// cloud: intestazione dell'esercizio, righe come le ha ricevute il provider,
// numero e data del documento, QR verso lo scontrino digitale. NON e' il
// documento fiscale (quello e' il corrispettivo telematico trasmesso): lo
// dice l'ultima riga, sempre.
function renderScontrino(p) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(s.replace(/…/g, '.'), 'latin1'));
  const euroStr = s => String(s ?? '0.00').replace('.', ',');

  push(ESC, 0x40);
  push(ESC, 0x74, 16);
  push(ESC, 0x47, 1);
  push(ESC, 0x61, 1);        // center
  push(ESC, 0x45, 1);
  text(`${(p.business_name ?? '').toUpperCase()}\n`);
  push(ESC, 0x45, 0);
  if (p.business_address) text(`${p.business_address}\n`);
  if (p.vat_number) text(`P.IVA ${p.vat_number}\n`);
  text('-'.repeat(COLS) + '\n');
  text('COPIA DOCUMENTO COMMERCIALE\n');
  text('di vendita o prestazione\n');
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x61, 0);        // left

  push(GS, 0x21, 0x01);      // double height come il preconto
  for (const i of p.items ?? []) {
    const qty = parseFloat(String(i.quantity ?? '1')) || 1;
    const unit = Math.round((parseFloat(String(i.unit_price ?? '0')) || 0) * 100);
    text(row(`${qty}x ${i.description ?? ''}`, euro(unit * qty)));
  }
  push(GS, 0x21, 0x00);
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x45, 1);
  push(GS, 0x21, 0x01);
  text(row('TOTALE EUR', euro(p.total_cents ?? 0)));
  push(GS, 0x21, 0x00);
  push(ESC, 0x45, 0);
  if (parseFloat(String(p.cash_payment_amount ?? '0')) > 0) text(row('Contanti', euroStr(p.cash_payment_amount)));
  if (parseFloat(String(p.electronic_payment_amount ?? '0')) > 0) text(row('Elettronico', euroStr(p.electronic_payment_amount)));
  if (parseFloat(String(p.ticket_restaurant_payment_amount ?? '0')) > 0) text(row('Buoni pasto', euroStr(p.ticket_restaurant_payment_amount)));
  text('\n');
  if (p.doc_number) text(`Documento n. ${p.doc_number}\n`);
  if (p.document_date) {
    const d = new Date(p.document_date);
    if (!Number.isNaN(d.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      text(`del ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}\n`);
    }
  }
  if (p.table_name) text(`Tavolo ${p.table_name}\n`);

  if (p.receipt_url) {
    push(ESC, 0x61, 1);
    text('\n');
    const data = Buffer.from(p.receipt_url, 'latin1');
    push(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0);   // QR model 2
    push(GS, 0x28, 0x6b, 3, 0, 49, 67, 8);       // module size 8 (v. preconto)
    push(GS, 0x28, 0x6b, 3, 0, 49, 69, 51);      // error correction H
    const len = data.length + 3;
    push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 49, 80, 48, ...data);
    push(GS, 0x28, 0x6b, 3, 0, 49, 81, 48);      // print
    text('\ninquadra per lo scontrino digitale\n');
  }

  push(ESC, 0x61, 1);
  text('\ncopia di cortesia - non fiscale\n\n\n');
  push(GS, 0x56, 0x42, 0x00); // taglio parziale
  return Buffer.from(bytes);
}

// Foglietto solo-QR da appoggiare al tavolo: niente righe, niente prezzi di
// dettaglio — il codice grande, il totale e basta. Il preconto completo resta
// il documento da consegnare in mano.
function renderQr(p) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(s.replace('…', '.'), 'latin1'));

  push(ESC, 0x40);
  push(ESC, 0x74, 16);
  push(ESC, 0x47, 1);
  push(ESC, 0x61, 1);        // tutto centrato
  push(GS, 0x21, 0x11);      // double w+h
  text('PAGA IL CONTO\n');
  push(GS, 0x21, 0x00);
  text(`Tavolo ${p.table_name ?? '-'}\n\n`);

  if (p.share_url) {
    const data = Buffer.from(p.share_url, 'latin1');
    push(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0);   // QR model 2
    push(GS, 0x28, 0x6b, 3, 0, 49, 67, 10);      // module size 10
    push(GS, 0x28, 0x6b, 3, 0, 49, 69, 51);      // error correction H
    const len = data.length + 3;
    push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 49, 80, 48, ...data);
    push(GS, 0x28, 0x6b, 3, 0, 49, 81, 48);      // print
    text('\ninquadra per pagare il conto\n');
  } else {
    text('conto chiuso: QR non disponibile\n');
  }

  push(ESC, 0x45, 1);
  text(`\nTOTALE EUR ${euro(p.total_cents)}\n`);
  push(ESC, 0x45, 0);
  text('\ndocumento non fiscale\n\n\n');
  push(GS, 0x56, 0x42, 0x00);
  return Buffer.from(bytes);
}

// Comanda di partita: cosa preparare, niente prezzi. Caratteri grandi e
// quantità in evidenza — si legge da in piedi, col vapore in mezzo.
function renderComanda(p) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(s, 'latin1'));

  push(ESC, 0x40);
  push(ESC, 0x74, 16);
  push(ESC, 0x47, 1);        // doppia battuta
  push(ESC, 0x61, 1);        // center
  push(GS, 0x21, 0x11);      // double w+h
  text(`TAV ${p.table_name ?? '-'}\n`);
  push(GS, 0x21, 0x01);      // solo double height
  // course_label arriva dal server («Bar», «2a USCITA»): il fallback compone
  // il numero per i job accodati da un server più vecchio dell'agente.
  text(`${p.course_label ?? `${p.course_no}a USCITA`} - ${(p.station_name ?? '').toUpperCase()}\n`);
  // «AGGIUNTA»: righe entrate in un'uscita già partita — senza banner il
  // ticket si confonde con una ristampa del lancio.
  if (p.variation) {
    push(ESC, 0x45, 1);
    text(`*** ${p.variation} ***\n`);
    push(ESC, 0x45, 0);
  }
  push(GS, 0x21, 0x00);
  const now = new Date();
  text(`${p.covers ?? '-'} coperti - ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}\n`);
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x61, 0);        // left

  push(GS, 0x21, 0x01);      // righe piatto a doppia altezza
  for (const i of p.items ?? []) {
    text(`${i.qty} x ${i.name}\n`);
    push(GS, 0x21, 0x00);
    for (const m of i.modifiers ?? []) text(`    + ${m}\n`);
    if (i.note) text(`    ** ${i.note}\n`);
    push(GS, 0x21, 0x01);
  }
  push(GS, 0x21, 0x00);
  text('\n\n');
  push(GS, 0x56, 0x42, 0x00);
  return Buffer.from(bytes);
}

// Annullo chiamata o storno di righe già in cucina: il ticket dice di NON
// fare (o buttare) i piatti elencati — kind apposta, così un agente vecchio
// che non lo conosce si arena invece di stamparli come piatti da cucinare.
function renderComandaAnnullo(p) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(s, 'latin1'));

  push(ESC, 0x40);
  push(ESC, 0x74, 16);
  push(ESC, 0x47, 1);        // doppia battuta
  push(ESC, 0x61, 1);        // center
  push(GS, 0x21, 0x11);      // double w+h
  push(ESC, 0x45, 1);
  text(`${p.variation ?? 'ANNULLO'}\n`);
  push(ESC, 0x45, 0);
  text(`TAV ${p.table_name ?? '-'}\n`);
  push(GS, 0x21, 0x01);      // solo double height
  text(`${p.course_label ?? `${p.course_no}a USCITA`} - ${(p.station_name ?? '').toUpperCase()}\n`);
  push(GS, 0x21, 0x00);
  const now = new Date();
  text(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}\n`);
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x61, 0);        // left

  push(GS, 0x21, 0x01);
  for (const i of p.items ?? []) {
    // Il «barrato» delle termiche: l'ESC/POS non sa sovrastampare un tratto
    // sul testo, quindi la riga annullata si attraversa col tratteggio —
    // «-- 1 x ACQUA GAS ----»: si legge cosa era, e si legge che non vale.
    const label = `-- ${i.qty} x ${i.name} `;
    const cut = label.length > COLS - 2 ? label.slice(0, COLS - 3) + ' ' : label;
    text(cut + '-'.repeat(Math.max(2, COLS - cut.length)) + '\n');
    push(GS, 0x21, 0x00);
    for (const m of i.modifiers ?? []) text(`    + ${m}\n`);
    if (i.note) text(`    ** ${i.note}\n`);
    push(GS, 0x21, 0x01);
  }
  push(GS, 0x21, 0x00);
  if (p.reason) text(`\nmotivo: ${p.reason}\n`);
  text('\n\n');
  push(GS, 0x56, 0x42, 0x00);
  return Buffer.from(bytes);
}

// Pagina di prova dal bottone "Stampa prova" in Impostazioni.
function renderTest(p) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(s, 'latin1'));
  push(ESC, 0x40);
  push(ESC, 0x74, 16);
  push(ESC, 0x47, 1);
  push(ESC, 0x61, 1);
  push(GS, 0x21, 0x11);
  text('PROVA STAMPA\n');
  push(GS, 0x21, 0x00);
  text(`stampante: ${p.printer_name ?? '-'}\n${p.host ?? ''}:${p.port ?? ''}\n`);
  const now = new Date();
  text(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} - RistoManager\n`);
  text('\nse leggi questo, la configurazione\ne\' corretta.\n\n\n');
  push(GS, 0x56, 0x42, 0x00);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Stampante e API
// ---------------------------------------------------------------------------
const sendToPrinter = ({ host, port }, payload) => new Promise((resolve, reject) => {
  const sock = net.createConnection({ host, port, timeout: 5000 }, () => {
    sock.write(payload, err => (err ? reject(err) : sock.end()));
  });
  sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout stampante')); });
  sock.on('error', reject);
  sock.on('close', () => resolve());
});

const api = async (path, options = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-print-agent-token': TOKEN, ...options.headers },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
let apiDown = false;
const warnedUnknown = new Set();

// Lavora la coda di UNA stampante: si ferma al primo errore di connessione
// (i job restano in coda e si ritenta al giro dopo), ma non tocca le code
// delle altre stampanti.
async function drainPrinter(name, dest, jobs) {
  for (const job of jobs) {
    let rendered;
    try {
      rendered = job.kind === 'PRECONTO' ? renderPreconto(job.payload)
               : job.kind === 'SCONTRINO' ? renderScontrino(job.payload)
               : job.kind === 'QR' ? renderQr(job.payload)
               : job.kind === 'COMANDA' ? renderComanda(job.payload)
               : job.kind === 'COMANDA_ANNULLO' ? renderComandaAnnullo(job.payload)
               : job.kind === 'TEST' ? renderTest(job.payload)
               : null;
      if (!rendered) throw new Error(`kind sconosciuto: ${job.kind}`);
    } catch (err) {
      log(`job ${job.id} [${name}]: payload non stampabile (${err.message})`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: err.message }) }).catch(() => {});
      continue;
    }
    try {
      // Cicalino prima dei byte di stampa: il suono parte col job, non a
      // taglio avvenuto.
      const payload = dest.buzzer ? Buffer.concat([BEEP, rendered]) : rendered;
      await sendToPrinter(dest, payload);
      log(`job ${job.id} [${name}]: stampato (${rendered.length} byte${dest.buzzer ? ', con cicalino' : ''})`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: true }) });
    } catch (err) {
      log(`job ${job.id} [${name}]: stampante non raggiungibile (${err.message}), ritento`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Registratore telematico Epson (FP-81II) — Fiscal ePOS-Print, XML su HTTP
// ---------------------------------------------------------------------------
// Il job RT_FISCALE non è ESC/POS: si POSTa un documento fiscale XML a
// fpmate.cgi sull'IP del registratore e si riporta al backend il numero che
// l'RT assegna (zRep-progressivo). Env:
//   RT_FISCAL_HOST      IP del registratore (obbligatoria per abilitare)
//   RT_FISCAL_DEVID     device id ePOS (default local_printer)
//   RT_FISCAL_REPARTI   mappa aliquota→reparto, es. "10=1,22=2,4=3":
//                       i reparti dell'RT portano l'IVA configurata dal
//                       tecnico — la mappa DEVE rispecchiarla, o l'aliquota
//                       stampata sarà sbagliata. Nessun default: senza
//                       mappa il job fallisce con errore chiaro.
const RT_HOST = (process.env.RT_FISCAL_HOST || '').trim();
const RT_DEVID = process.env.RT_FISCAL_DEVID || 'local_printer';
const RT_REPARTI = new Map((process.env.RT_FISCAL_REPARTI || '').split(',').map(s => s.trim()).filter(Boolean).map(kv => {
  const [vat, rep] = kv.split('=');
  return [String(parseFloat(vat)), String(parseInt(rep, 10))];
}));

const xmlAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Dal payload del documento (lo stesso trasmesso al provider cloud) all'XML
// fiscale Epson. Importi con punto decimale, quantità a 2 decimali.
function buildRtXml(p) {
  const lines = [];
  for (const i of p.items ?? []) {
    const code = String(i.vat_rate_code ?? '');
    if (!/^\d/.test(code)) throw new Error(`aliquota '${code}': le nature IVA non sono mappabili sui reparti RT`);
    const rep = RT_REPARTI.get(String(parseFloat(code)));
    if (!rep) throw new Error(`aliquota ${code} senza reparto in RT_FISCAL_REPARTI`);
    lines.push(`<printRecItem description="${xmlAttr(String(i.description).slice(0, 38))}" quantity="${xmlAttr(Number(i.quantity).toFixed(2))}" unitPrice="${xmlAttr(Number(i.unit_price).toFixed(2))}" department="${rep}" justification="1" />`);
  }
  const discount = parseFloat(p.discount || '0');
  if (discount > 0) {
    lines.push('<printRecSubtotal option="0" />');
    lines.push(`<printRecSubtotalAdjustment adjustmentType="1" description="Sconto" amount="${discount.toFixed(2)}" justification="2" />`);
  }
  const uncollected = parseFloat(p.services_uncollected_amount || '0');
  if (uncollected > 0) throw new Error('sospeso/non riscosso non supportato sul binario RT (v1): incassare o fatturare');
  const pay = (amount, type, desc) => {
    const a = parseFloat(amount || '0');
    if (a > 0) lines.push(`<printRecTotal payment="${a.toFixed(2)}" paymentType="${type}" index="1" description="${desc}" justification="1" />`);
  };
  pay(p.cash_payment_amount, 0, 'Contanti');
  pay(p.electronic_payment_amount, 2, 'Elettronico');
  pay(p.ticket_restaurant_payment_amount, 3, 'Buoni pasto');
  if (p.lottery_code) {
    // Codice lotteria: va dichiarato PRIMA delle righe secondo le specifiche
    // ePOS più recenti — il collaudo sul firmware reale dirà se questo tag
    // è supportato; in caso contrario l'RT risponde errore e il documento
    // si riemette senza codice.
    lines.unshift(`<printRecLotteryID code="${xmlAttr(p.lottery_code)}" />`);
  }
  return `<printerFiscalReceipt><beginFiscalReceipt />${lines.join('')}<endFiscalReceipt /></printerFiscalReceipt>`;
}

async function handleRtFiscale(job) {
  if (!RT_HOST) {
    // Senza registratore configurato il job resta in coda (niente ack):
    // uscirà appena l'operatore imposta RT_FISCAL_HOST. Avvisa una volta.
    if (!warnedUnknown.has('rt')) { warnedUnknown.add('rt'); log('RT_FISCAL_HOST non configurato: job RT in attesa'); }
    return;
  }
  // Claim atomico PRIMA di toccare il registratore: un documento fiscale non
  // si emette due volte. Se un altro poll/agente ha già preso il job, esce.
  try {
    const c = await api(`/print-agent/jobs/${job.id}/claim`, { method: 'POST' });
    if (!c?.claimed) return;
  } catch (err) {
    log(`job ${job.id} [rt]: claim fallito (${err.message}), ritento`);
    return;
  }
  let xml;
  try {
    xml = buildRtXml(job.payload?.payload ?? {});
  } catch (err) {
    log(`job ${job.id} [rt]: documento non componibile (${err.message})`);
    await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: err.message }) }).catch(() => {});
    return;
  }
  try {
    const res = await fetch(`http://${RT_HOST}/cgi-bin/fpmate.cgi?devid=${encodeURIComponent(RT_DEVID)}&timeout=10000`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${xml}</s:Body></s:Envelope>`,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const success = /success\s*=\s*"(?:true|1)"/i.test(text);
    if (!success) {
      const code = text.match(/code\s*=\s*"([^"]*)"/i)?.[1] ?? `HTTP ${res.status}`;
      const status = text.match(/status\s*=\s*"([^"]*)"/i)?.[1] ?? '';
      log(`job ${job.id} [rt]: il registratore ha rifiutato (${code} ${status})`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: `RT: ${code} ${status}`.trim() }) });
      return;
    }
    // addInfo: zRepNumber + fiscalReceiptNumber compongono il numero del
    // documento commerciale come lo stampa l'RT (es. 0933-0045). L'FP-81II
    // li restituisce come tag diretti, non incapsulati in <info>.
    const tag = (name) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim() ?? '';
    const zrep = tag('zRepNumber');
    const num = tag('fiscalReceiptNumber');
    const docNumber = zrep && num ? `${zrep.padStart(4, '0')}-${num.padStart(4, '0')}` : (num || null);
    log(`job ${job.id} [rt]: documento ${docNumber ?? '(numero non letto)'} emesso`);
    await api(`/print-agent/jobs/${job.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ ok: true, result: { doc_number: docNumber, zrep_number: zrep || null, receipt_number: num || null, receipt_date: tag('fiscalReceiptDate') || null, receipt_time: tag('fiscalReceiptTime') || null, receipt_amount: tag('fiscalReceiptAmount') || null } }),
    });
  } catch (err) {
    // Registratore spento o irraggiungibile: NIENTE ack — il job resta in
    // coda e il documento PENDING, si ritenta al giro dopo.
    log(`job ${job.id} [rt]: registratore non raggiungibile (${err.message}), ritento`);
  }
}

// Chiusura giornaliera (rapporto Z): stesso trasporto dei documenti, un
// comando diverso. La Z stampa il riepilogo, azzera i totalizzatori e
// trasmette i corrispettivi — è lenta, quindi timeout suo. ATTENZIONE al
// caso limite (identico all'emissione documento): se il fetch scade ma l'RT
// aveva già eseguito, il retry comanderebbe una seconda Z, che esce a zero
// — rumorosa ma non dannosa. Il timeout generoso serve a non arrivarci.
async function handleRtChiusura(job) {
  if (!RT_HOST) {
    if (!warnedUnknown.has('rt')) { warnedUnknown.add('rt'); log('RT_FISCAL_HOST non configurato: job RT in attesa'); }
    return;
  }
  try {
    const c = await api(`/print-agent/jobs/${job.id}/claim`, { method: 'POST' });
    if (!c?.claimed) return;
  } catch (err) {
    log(`job ${job.id} [rt-z]: claim fallito (${err.message}), ritento`);
    return;
  }
  try {
    const xml = '<printerFiscalReport><printZReport operator="1" /></printerFiscalReport>';
    const res = await fetch(`http://${RT_HOST}/cgi-bin/fpmate.cgi?devid=${encodeURIComponent(RT_DEVID)}&timeout=60000`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${xml}</s:Body></s:Envelope>`,
      signal: AbortSignal.timeout(70_000),
    });
    const text = await res.text();
    const success = /success\s*=\s*"(?:true|1)"/i.test(text);
    if (!success) {
      const code = text.match(/code\s*=\s*"([^"]*)"/i)?.[1] ?? `HTTP ${res.status}`;
      const status = text.match(/status\s*=\s*"([^"]*)"/i)?.[1] ?? '';
      log(`job ${job.id} [rt-z]: il registratore ha rifiutato la chiusura (${code} ${status})`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: `RT: ${code} ${status}`.trim() }) });
      return;
    }
    // Il numero della Z appena eseguita: il collaudo sul firmware reale dirà
    // se l'FP-81II lo riporta qui — in assenza la chiusura si conferma senza
    // numero, che resta sul tagliando.
    const tag = (name) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim() ?? '';
    const zrep = tag('zRepNumber');
    log(`job ${job.id} [rt-z]: chiusura giornaliera eseguita${zrep ? ` (Z ${zrep})` : ''}`);
    await api(`/print-agent/jobs/${job.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ ok: true, result: { zrep_number: zrep || null } }),
    });
  } catch (err) {
    log(`job ${job.id} [rt-z]: registratore non raggiungibile (${err.message}), ritento`);
  }
}

async function tick() {
  let jobs;
  try {
    applyConfig(await api('/print-agent/config').catch(() => null));
    ({ jobs } = await api('/print-agent/jobs'));
    if (apiDown) { apiDown = false; log('backend di nuovo raggiungibile'); }
  } catch (err) {
    if (!apiDown) { apiDown = true; log('backend non raggiungibile:', err.message); }
    return;
  }

  // I documenti fiscali del registratore viaggiano su un canale proprio,
  // in serie (l'RT è transazionale: un documento alla volta).
  for (const job of jobs.filter(j => j.kind === 'RT_FISCALE')) {
    await handleRtFiscale(job);
  }
  // La chiusura Z dopo i documenti: se nello stesso giro c'è ancora uno
  // scontrino da emettere, deve entrare nella giornata che si sta chiudendo.
  for (const job of jobs.filter(j => j.kind === 'RT_CHIUSURA')) {
    await handleRtChiusura(job);
  }
  jobs = jobs.filter(j => j.kind !== 'RT_FISCALE' && j.kind !== 'RT_CHIUSURA');

  // Raggruppa per stampante: ogni destinazione ha la sua coda indipendente,
  // una termica spenta in cucina non blocca i preconti al banco.
  const byPrinter = new Map();
  for (const job of jobs) {
    const name = job.printer || 'preconti';
    if (!PRINTERS.has(name)) {
      // Mappatura assente: il job resta in coda (niente ack) e uscirà appena
      // l'operatore aggiunge la voce a PRINTERS. Avvisa una volta sola.
      if (!warnedUnknown.has(name)) {
        warnedUnknown.add(name);
        log(`stampante '${name}' non in PRINTERS: job in attesa di mappatura`);
      }
      continue;
    }
    if (!byPrinter.has(name)) byPrinter.set(name, []);
    byPrinter.get(name).push(job);
  }
  await Promise.all([...byPrinter.entries()].map(([name, list]) => drainPrinter(name, PRINTERS.get(name), list)));
}

// I tick non si sovrappongono: un'emissione RT lenta (fetch fino a 15s) non
// deve far partire un secondo tick che ripesca gli stessi job.
let ticking = false;
async function safeTick() {
  if (ticking) return;
  ticking = true;
  try { await tick(); } finally { ticking = false; }
}

log(`print-agent avviato: backend ${API_URL}, stampanti [${[...PRINTERS.entries()].map(([n, d]) => `${n}=${d.host}:${d.port}`).join(', ')}], poll ${POLL_MS}ms`);
setInterval(safeTick, POLL_MS);
safeTick();
