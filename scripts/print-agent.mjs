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
//   NODE_URL          facoltativa: il nodo di sala (stesso PC). Con la
//                     modalità ibrida in autorità le comande NASCONO sul
//                     nodo e i loro ticket stanno nella SUA coda: l'agente
//                     polla entrambe le fonti e conferma ciascun job alla
//                     fonte che gliel'ha dato. A cloud giù restano vive le
//                     stampe del nodo: la comanda battuta al buio ESCE.
//   PRINT_AGENT_TOKEN obbligatorio, deve combaciare con quello del backend
//   PRINTERS          mappa nome=ip[:porta] separata da virgole; ogni job
//                     porta il nome della sua stampante di destinazione
//   PRINTER_IP/PORT   legacy: se PRINTERS manca, diventa la voce 'preconti'
//   POLL_MS           default 2500
//   COMANDA_ICONE     'off' per stampare la scritta «Cameriere» al posto
//                     dell'icona (termiche che non conoscono ESC &)
import net from 'net';

const API_URL = process.env.API_URL || 'http://localhost:3005';
const NODE_URL = (process.env.NODE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = process.env.PRINT_AGENT_TOKEN;
const POLL_MS = Number(process.env.POLL_MS || 2500);

// Le fonti, in ordine di fiducia per la CONFIG (il cloud è il registro
// principale; il nodo ne ha una replica e vale da ripiego a linea giù).
const SOURCES = [
  { name: 'cloud', base: API_URL },
  ...(NODE_URL ? [{ name: 'nodo', base: NODE_URL }] : []),
];

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

// ---------------------------------------------------------------------------
// Comanda di partita
// ---------------------------------------------------------------------------
// Gerarchia pensata per chi la legge in piedi alla partita, col vapore in
// mezzo (il ticket di prima era tutto centrato, «1 x Acqua Piccola», e non
// diceva di chi era il tavolo):
//   1. che ticket è — la norma parla, l'eccezione urla: «CHIAMATA» in corpo
//      alto, «+ AGGIUNTA +» e «X ANNULLO CHIAMATA X» in grande;
//   2. il TAVOLO è l'elemento più grande: è ciò che va sul passe col piatto;
//   3. cameriere (icona) e coperti arretrano in corpo alto;
//   4. uscita e partita in una fascia sola, dentro il tratteggio;
//   5. i piatti in colonna: quantità allineate, aria fra un piatto e l'altro,
//      varianti sotto il nome, allergie «!» in maiuscolo e neretto;
//   6. il totale pezzi in fondo, per contare prima di strappare.

// Corpi di GS ! n. Il doppio largo occupa due colonne per carattere: le
// righe con blocchi a sinistra e a destra si contano in colonne di font A.
const NORMAL = 0x00, TALL = 0x01, BIG = 0x11;
const BIG_COLS = Math.floor(COLS / 2);

// La termica stampa in WPC1252 (ESC t 16) e il testo va giù in latin1: gli
// apostrofi e le virgolette tipografiche che la tastiera del telefono mette
// nei nomi dei piatti uscirebbero come caratteri di controllo.
const toLatin = s => String(s ?? '')
  .replace(/[‘’‛′]/g, "'")
  .replace(/[“”„″]/g, '"')
  .replace(/[–—−]/g, '-')
  .replace(/…/g, '...')
  .replace(/[^\x00-\xFF]/g, '?');
const upper = s => toLatin(s).toLocaleUpperCase('it-IT');

const colsOf = segs => segs.reduce((n, s) => n + s.text.length * (s.size === BIG ? 2 : 1), 0);
const gap = n => ({ text: ' '.repeat(Math.max(0, n)) });
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '.' : s);
const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Icona del cameriere al posto della scritta. Le termiche non hanno icone:
// è un carattere definito dall'utente (ESC &), due celle di font A da
// 12×24 punti che, stampate in doppio largo e alto, fanno un quadrato di 48
// punti — alto esattamente quanto la riga del nome in corpo alto, così icona
// e nome poggiano sulla stessa linea. Il disegno si rimanda a ogni ticket
// (dopo ESC @) e il set utente si accende solo per i due caratteri
// dell'icona (ESC % 1 … ESC % 0): il resto della riga è il font della
// stampante. COMANDA_ICONE=off torna alla scritta «Cameriere», per una
// termica che non conosce ESC & e stamperebbe i byte del disegno come testo.
const ICONS = (process.env.COMANDA_ICONE || '').toLowerCase() !== 'off';
const WAITER_ICON = [
  '........................',
  '.........######.........',
  '........########........',
  '.......##########.......',
  '.......##########.......',
  '.......##########.......',
  '.......##########.......',
  '........########........',
  '.........######.........',
  '........................',
  '...#####........#####...',
  '..######.##..##.######..',
  '.#######.######.#######.',
  '.#######.##..##.#######.',
  '#########......#########',
  '##########....##########',
  '###########..###########',
  '########################',
  '########################',
  '########################',
  '########################',
  '########################',
  '########################',
  '########################',
];
const WAITER_CODES = [0x7b, 0x7c];   // '{' '|': solo dentro ESC % 1
const WAITER_TEXT = String.fromCharCode(...WAITER_CODES);

// ESC & 3 c1 c2, poi per ogni carattere la larghezza (12) e le colonne da
// sinistra a destra, tre byte ciascuna dall'alto in basso (bit alto = punto
// più in alto).
function defineChars(rows, first) {
  const cells = rows[0].length / 12;
  const out = [ESC, 0x26, 3, first, first + cells - 1];
  for (let c = 0; c < cells; c++) {
    out.push(12);
    for (let x = c * 12; x < c * 12 + 12; x++) {
      for (let k = 0; k < 3; k++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) if (rows[k * 8 + bit][x] === '#') byte |= 0x80 >> bit;
        out.push(byte);
      }
    }
  }
  return out;
}
const WAITER_DEF = defineChars(WAITER_ICON, WAITER_CODES[0]);

// Blocchi su una riga: sinistra al margine, destra al margine, l'eventuale
// centro a metà dello spazio che avanza. null se non ci stanno.
function spread(left, middle, right) {
  const free = COLS - colsOf(left) - colsOf(middle) - colsOf(right);
  if (free < (middle.length ? 2 : left.length && right.length ? 1 : 0)) return null;
  if (!middle.length) return [...left, gap(free), ...right];
  const a = Math.floor(free / 2);
  return [...left, gap(a), ...middle, gap(free - a), ...right];
}

// A capo per parole, non a metà parola come farebbe la termica da sola.
function wrapWords(s, width) {
  const lines = [];
  let cur = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const w = word.length > width ? word.slice(0, width) : word;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function ticketWriter() {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const text = s => push(...Buffer.from(toLatin(s), 'latin1'));
  // Una riga di segmenti {text, size, bold, icon}: ogni segmento si porta il
  // suo corpo; a fine riga si torna al normale, così la riga dopo parte pulita.
  const line = (segs = []) => {
    for (const s of segs) {
      push(GS, 0x21, s.size ?? NORMAL, ESC, 0x45, s.bold ? 1 : 0);
      if (s.icon) push(ESC, 0x25, 1);
      text(s.text);
      if (s.icon) push(ESC, 0x25, 0);
    }
    push(GS, 0x21, NORMAL, ESC, 0x45, 0);
    text('\n');
  };
  const rule = (ch = '-') => line([{ text: ch.repeat(COLS) }]);
  return { bytes, push, text, line, rule };
}

// Intestazione comune a comanda e annullo.
function comandaHeader(w, p, title, loud) {
  w.push(ESC, 0x40);
  w.push(ESC, 0x74, 16);
  w.push(ESC, 0x47, 1);      // doppia battuta
  if (ICONS) w.push(...WAITER_DEF);
  w.push(ESC, 0x61, 1);      // center
  w.line([{ text: title, size: loud ? BIG : TALL, bold: true }]);
  w.push(ESC, 0x61, 0);      // left
  w.rule('=');

  // L'asporto non ha tavolo: il «nome» è «Asporto 20:30 #12». order_type
  // manca nei job di un server più vecchio dell'agente: lì si riconosce dal
  // nome che il server compone.
  const name = String(p.table_name ?? '-');
  const takeaway = p.order_type ? p.order_type === 'TAKEAWAY' : /^Asporto\b/.test(name);
  const tav = takeaway ? upper(name) : `TAV ${toLatin(name)}`;
  const ora = [{ text: hhmm(), size: TALL, bold: true }];
  w.line(spread([{ text: tav, size: BIG, bold: true }], [], ora)
      ?? spread([{ text: clip(tav, COLS - 6), size: TALL, bold: true }], [], ora));

  // Cameriere (chi ha aperto il tavolo: la partita cerca lui quando il
  // piatto è pronto) e coperti, tutto in corpo alto: numero e parola alti
  // uguale, icona alta quanto il nome — stanno sulla stessa linea.
  const waiter = p.waiter_name ? toLatin(String(p.waiter_name).trim()) : '';
  const cop = p.covers != null
    ? [{ text: String(p.covers), size: TALL, bold: true }, { text: Number(p.covers) === 1 ? ' coperto' : ' coperti', size: TALL }]
    : [];
  if (waiter || cop.length) {
    const who = ICONS ? [{ text: WAITER_TEXT, size: BIG, icon: true }, { text: ' ' }] : [{ text: 'Cameriere ', size: TALL }];
    const room = COLS - colsOf(who) - colsOf(cop) - (cop.length ? 1 : 0);
    w.line(spread(waiter ? [...who, { text: clip(waiter, room), size: TALL }] : [], [], cop));
  }

  // Fascia dell'uscita: «USCITA 1 · ANTIPASTI»; per il Bar l'uscita ha il
  // nome della partita e basta una parola. I job di un server vecchio
  // dicono «1a USCITA».
  const course = String(p.course_label ?? `${p.course_no}a USCITA`).replace(/^(\d+)a USCITA$/i, 'Uscita $1');
  const station = String(p.station_name ?? '');
  const band = upper(station && course.toLowerCase() !== station.toLowerCase() ? `${course} · ${station}` : course || station);
  const mid = ` ${band} `;
  const side = Math.max(4, COLS - mid.length);
  const a = Math.floor(side / 2);
  w.line([{ text: '-'.repeat(a) }, { text: mid, size: TALL, bold: true }, { text: '-'.repeat(side - a) }]);
}

// I piatti in colonna: quantità in neretto e allineate, nome in grande e in
// maiuscolo (niente «x»: «1 ACQUA GAS»), a capo per parole rientrato sotto
// il nome. `strike` è la parola che dice cosa fare di un piatto annullato.
function comandaItems(w, list, strike) {
  const qw = Math.max(1, ...list.map(i => String(i.qty).length));
  const pad = ' '.repeat((qw + 1) * 2);      // sotto il nome, non sotto la quantità
  for (const i of list) {
    w.line();                                // aria fra un piatto e l'altro
    const qty = String(i.qty).padStart(qw);
    const name = upper(i.name);
    if (strike) {
      // Il «barrato» delle termiche: l'ESC/POS non sovrastampa un tratto sul
      // testo, quindi la riga annullata si attraversa col tratteggio.
      const lbl = clip(`${qty} ${name}`, BIG_COLS - 4);
      w.line([{ text: `${lbl} ${'-'.repeat(Math.max(2, BIG_COLS - lbl.length - 1))}`, size: BIG }]);
      w.line([{ text: `${pad}${strike}`, size: TALL, bold: true }]);
    } else {
      const lines = wrapWords(name, BIG_COLS - qw - 1);
      w.line([{ text: `${qty} `, size: BIG, bold: true }, { text: lines[0], size: BIG }]);
      for (const l of lines.slice(1)) w.line([{ text: `${' '.repeat(qw + 1)}${l}`, size: BIG }]);
    }
    for (const m of i.modifiers ?? []) w.line([{ text: `${pad}+ ${m}`, size: TALL }]);
    // La nota è dove stanno le allergie: maiuscolo, neretto, «!» davanti.
    if (i.note) w.line([{ text: `${pad}! ${upper(i.note)}`, size: TALL, bold: true }]);
  }
}

function comandaFooter(w, list, others) {
  w.line();
  const pz = list.reduce((n, i) => n + Number(i.qty || 0), 0);
  if (list.length > 1 || pz > 1) w.line(spread([], [], [{ text: `totale ${pz} pz`, bold: true }]));
  // «Uscita intera» della partita: cosa fanno le altre partite nella stessa
  // uscita, in corpo normale — contesto per chi impiatta guardando cosa
  // esce insieme, non piatti da fare qui.
  if (Array.isArray(others) && others.length > 0) {
    w.rule();
    w.line([{ text: 'Nella stessa uscita:' }]);
    for (const o of others) {
      const lbl = `${upper(o.station_name ?? '')}: `;
      const its = (o.items ?? []).map(i => `${i.qty} ${toLatin(i.name)}`).join(', ');
      wrapWords(its, COLS - lbl.length).forEach((l, k) =>
        w.line([{ text: k === 0 ? lbl : ' '.repeat(lbl.length), bold: k === 0 }, { text: l }]));
    }
  }
  w.rule('=');
  w.text('\n\n');
  w.push(GS, 0x56, 0x42, 0x00);
}

// Comanda di partita: cosa preparare, niente prezzi. «CHIAMATA» come la
// chiama il CRM («Uscita chiamata in cucina»); «AGGIUNTA» per righe entrate
// in un'uscita già partita — senza, il ticket si confonde con una ristampa.
function renderComanda(p) {
  const w = ticketWriter();
  const items = p.items ?? [];
  comandaHeader(w, p, p.variation === 'AGGIUNTA' ? '+ AGGIUNTA +' : (p.variation ?? 'CHIAMATA'), Boolean(p.variation));
  comandaItems(w, items, null);
  comandaFooter(w, items, p.others);
  return Buffer.from(w.bytes);
}

// Annullo chiamata o storno di righe già in cucina: il ticket dice di NON
// fare (o che è stornato) — kind apposta, così un agente vecchio che non lo
// conosce si arena invece di stamparli come piatti da cucinare.
function renderComandaAnnullo(p) {
  const w = ticketWriter();
  comandaHeader(w, p, `X ${p.variation ?? 'ANNULLO'} X`, true);
  comandaItems(w, p.items ?? [], p.variation === 'STORNO' ? 'STORNATO' : 'NON FARE');
  if (p.reason) { w.line(); w.line([{ text: `Motivo: ${p.reason}`, size: TALL }]); }
  comandaFooter(w, [], null);
  return Buffer.from(w.bytes);
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
  text('\nse leggi questo, la configurazione\ne\' corretta.\n');
  // L'icona del cameriere delle comande: la prova dice subito se questa
  // termica conosce i caratteri utente (ESC &), prima che lo scopra la
  // cucina in servizio.
  if (ICONS) {
    push(...WAITER_DEF);
    text('\nicona cameriere delle comande:\n');
    push(GS, 0x21, BIG, ESC, 0x25, 1);
    text(WAITER_TEXT);
    push(ESC, 0x25, 0, GS, 0x21, NORMAL);
    text('\nse al posto dell\'omino col papillon\nvedi simboli strani, avviare l\'agente\ncon COMANDA_ICONE=off\n');
  }
  text('\n\n');
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

const api = async (base, path, options = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-print-agent-token': TOKEN, ...options.headers },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
// Stato «giù» per fonte, per non allagare il log durante un outage.
const sourceDown = new Map();
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
      await api(job.__base, `/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: err.message }) }).catch(() => {});
      continue;
    }
    try {
      // Cicalino prima dei byte di stampa: il suono parte col job, non a
      // taglio avvenuto.
      const payload = dest.buzzer ? Buffer.concat([BEEP, rendered]) : rendered;
      await sendToPrinter(dest, payload);
      log(`job ${job.id} [${name}/${job.__source}]: stampato (${rendered.length} byte${dest.buzzer ? ', con cicalino' : ''})`);
      await api(job.__base, `/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: true }) });
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
    const c = await api(job.__base, `/print-agent/jobs/${job.id}/claim`, { method: 'POST' });
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
    await api(job.__base, `/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: err.message }) }).catch(() => {});
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
      await api(job.__base, `/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: `RT: ${code} ${status}`.trim() }) });
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
    await api(job.__base, `/print-agent/jobs/${job.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ ok: true, result: { doc_number: docNumber, zrep_number: zrep || null, receipt_number: num || null, receipt_date: tag('fiscalReceiptDate') || null, receipt_time: tag('fiscalReceiptTime') || null, receipt_amount: tag('fiscalReceiptAmount') || null } }),
    });
  } catch (err) {
    // Registratore spento o irraggiungibile: NIENTE ack — il job resta in
    // coda e il documento PENDING, si ritenta al giro dopo.
    log(`job ${job.id} [rt]: registratore non raggiungibile (${err.message}), ritento`);
  }
}

async function tick() {
  // La coda si raccoglie da OGNI fonte raggiungibile; ogni job si ricorda
  // da dove viene (__base) e lì tornerà il suo ack. La config si prende
  // dalla prima fonte che risponde, in ordine di fiducia (cloud, poi nodo).
  const jobs = [];
  let configApplied = false;
  for (const source of SOURCES) {
    try {
      if (!configApplied) {
        const cfg = await api(source.base, '/print-agent/config').catch(() => null);
        if (cfg) { applyConfig(cfg); configApplied = true; }
      }
      const batch = await api(source.base, '/print-agent/jobs');
      for (const job of (batch.jobs || [])) {
        jobs.push({ ...job, __base: source.base, __source: source.name });
      }
      if (sourceDown.get(source.name)) { sourceDown.set(source.name, false); log(`${source.name} di nuovo raggiungibile`); }
    } catch (err) {
      if (!sourceDown.get(source.name)) { sourceDown.set(source.name, true); log(`${source.name} non raggiungibile:`, err.message); }
    }
  }
  if (jobs.length === 0) return;

  // I documenti fiscali del registratore viaggiano su un canale proprio,
  // in serie (l'RT è transazionale: un documento alla volta).
  for (const job of jobs.filter(j => j.kind === 'RT_FISCALE')) {
    await handleRtFiscale(job);
  }

  // Raggruppa per stampante: ogni destinazione ha la sua coda indipendente,
  // una termica spenta in cucina non blocca i preconti al banco.
  const byPrinter = new Map();
  for (const job of jobs.filter(j => j.kind !== 'RT_FISCALE')) {
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

log(`print-agent avviato: fonti [${SOURCES.map(s => `${s.name}=${s.base}`).join(', ')}], stampanti [${[...PRINTERS.entries()].map(([n, d]) => `${n}=${d.host}:${d.port}`).join(', ')}], poll ${POLL_MS}ms`);
setInterval(safeTick, POLL_MS);
safeTick();
