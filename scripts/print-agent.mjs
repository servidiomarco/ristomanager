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
//   PRINT_AGENT_TOKEN=... node scripts/print-agent.mjs
// Env:
//   API_URL           default http://localhost:3005
//   PRINT_AGENT_TOKEN obbligatorio, deve combaciare con quello del backend
//   PRINTER_IP        default 192.168.1.50
//   PRINTER_PORT      default 9100
//   POLL_MS           default 2500
import net from 'net';

const API_URL = process.env.API_URL || 'http://localhost:3005';
const TOKEN = process.env.PRINT_AGENT_TOKEN;
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.50';
const PRINTER_PORT = Number(process.env.PRINTER_PORT || 9100);
const POLL_MS = Number(process.env.POLL_MS || 2500);

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

// ---------------------------------------------------------------------------
// Stampante e API
// ---------------------------------------------------------------------------
const sendToPrinter = payload => new Promise((resolve, reject) => {
  const sock = net.createConnection({ host: PRINTER_IP, port: PRINTER_PORT, timeout: 5000 }, () => {
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
async function tick() {
  let jobs;
  try {
    ({ jobs } = await api('/print-agent/jobs'));
    if (apiDown) { apiDown = false; log('backend di nuovo raggiungibile'); }
  } catch (err) {
    if (!apiDown) { apiDown = true; log('backend non raggiungibile:', err.message); }
    return;
  }

  for (const job of jobs) {
    let rendered;
    try {
      rendered = job.kind === 'PRECONTO' ? renderPreconto(job.payload) : null;
      if (!rendered) throw new Error(`kind sconosciuto: ${job.kind}`);
    } catch (err) {
      log(`job ${job.id}: payload non stampabile (${err.message})`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: false, error: err.message }) }).catch(() => {});
      continue;
    }
    try {
      await sendToPrinter(rendered);
      log(`job ${job.id}: stampato (${rendered.length} byte)`);
      await api(`/print-agent/jobs/${job.id}/ack`, { method: 'POST', body: JSON.stringify({ ok: true }) });
    } catch (err) {
      // Stampante giù: niente ack, il job resta in coda e si ritenta al
      // prossimo giro. Inutile provare anche i job successivi ora.
      log(`job ${job.id}: stampante non raggiungibile (${err.message}), ritento`);
      break;
    }
  }
}

log(`print-agent avviato: backend ${API_URL}, stampante ${PRINTER_IP}:${PRINTER_PORT}, poll ${POLL_MS}ms`);
setInterval(tick, POLL_MS);
tick();
