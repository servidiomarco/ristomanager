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
  const next = new Map(list.map(p => [p.name, { host: p.host, port: Number(p.port || 9100) }]));
  const changed = next.size !== PRINTERS.size
    || [...next.entries()].some(([n, d]) => {
      const cur = PRINTERS.get(n);
      return !cur || cur.host !== d.host || cur.port !== d.port;
    });
  if (changed) {
    PRINTERS.clear();
    for (const [n, d] of next) PRINTERS.set(n, d);
    warnedUnknown.clear();
    log(`mappa stampanti aggiornata dal backend: [${[...PRINTERS.entries()].map(([n, d]) => `${n}=${d.host}:${d.port}`).join(', ')}]`);
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
  text('PRECONTO\n');
  push(GS, 0x21, 0x00);
  text(`Tavolo ${p.table_name ?? '-'} - ${p.covers} coperti\n`);
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x61, 0);        // left

  for (const i of p.items ?? []) {
    text(row(`${i.qty}x ${i.name}`, euro(i.total_cents)));
  }
  text('-'.repeat(COLS) + '\n');
  push(ESC, 0x45, 1);        // bold
  text(row('TOTALE EUR', euro(p.total_cents)));
  push(ESC, 0x45, 0);
  text('\n');

  if (p.share_url) {
    push(ESC, 0x61, 1);
    const data = Buffer.from(p.share_url, 'latin1');
    // Moduli grandi + correzione errore H (30%): con la testina che perde
    // righe di punti, un modulo da 10 dot sopravvive dove uno da 6 sparisce,
    // e la ridondanza H ricostruisce quello che manca. Senza, la fotocamera
    // non aggancia il codice.
    push(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0);   // QR model 2
    push(GS, 0x28, 0x6b, 3, 0, 49, 67, 10);      // module size 10
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
  text(`${p.course_no}a USCITA - ${(p.station_name ?? '').toUpperCase()}\n`);
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
               : job.kind === 'QR' ? renderQr(job.payload)
               : job.kind === 'COMANDA' ? renderComanda(job.payload)
               : job.kind === 'TEST' ? renderTest(job.payload)
               : null;
      if (!rendered) throw new Error(`kind sconosciuto: ${job.kind}`);
    } catch (err) {
      log(`job ${job.id} [${name}]: payload non stampabile (${err.message})`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: err.message }) }).catch(() => {});
      continue;
    }
    try {
      await sendToPrinter(dest, rendered);
      log(`job ${job.id} [${name}]: stampato (${rendered.length} byte)`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: true }) });
    } catch (err) {
      log(`job ${job.id} [${name}]: stampante non raggiungibile (${err.message}), ritento`);
      return;
    }
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

log(`print-agent avviato: backend ${API_URL}, stampanti [${[...PRINTERS.entries()].map(([n, d]) => `${n}=${d.host}:${d.port}`).join(', ')}], poll ${POLL_MS}ms`);
setInterval(tick, POLL_MS);
tick();
