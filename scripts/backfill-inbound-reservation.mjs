// Collega allo storico dei messaggi in entrata la prenotazione corrispondente.
//
// Da quando logInboundMessage risolve la prenotazione al volo, i messaggi
// nuovi arrivano già agganciati; questo recupera quelli vecchi, che sono
// entrati quando la colonna non veniva valorizzata.
//
// Uso (di default NON scrive nulla, stampa solo cosa farebbe):
//   DATABASE_URL=... node scripts/backfill-inbound-reservation.mjs
//   DATABASE_URL=... node scripts/backfill-inbound-reservation.mjs --apply
//
// Criterio di abbinamento identico al runtime (server.ts): chiave telefono
// NAZIONALE — il prefisso 39 si toglie solo a 11/12 cifre, così i cellulari
// vecchio stile a 9 cifre combaciano — e fra più prenotazioni dello stesso
// numero vince quella più vicina nel tempo al messaggio, con le annullate
// in coda a parità di distanza.

import { Client } from 'pg';

const APPLY = process.argv.includes('--apply');
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
    console.error('Manca DATABASE_URL');
    process.exit(1);
}

const KEY = col => `
    CASE
      WHEN length(regexp_replace(${col}, '[^0-9]', '', 'g')) IN (11, 12)
       AND left(regexp_replace(${col}, '[^0-9]', '', 'g'), 2) = '39'
      THEN substr(regexp_replace(${col}, '[^0-9]', '', 'g'), 3)
      ELSE regexp_replace(${col}, '[^0-9]', '', 'g')
    END`;

const client = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
});

const SELECT_MATCHES = `
    SELECT m.id AS message_id, r.id AS reservation_id
      FROM outbound_messages m
      JOIN LATERAL (
          SELECT res.id
            FROM reservations res
           WHERE res.phone IS NOT NULL AND res.phone <> ''
             AND ${KEY('res.phone')} = ${KEY('m.from_phone_digits')}
           ORDER BY (res.reservation_status = 'CANCELLED') ASC,
                    abs(extract(epoch FROM (res.reservation_time - m.sent_at))) ASC
           LIMIT 1
      ) r ON true
     WHERE m.direction = 'inbound'
       AND m.reservation_id IS NULL
       AND m.from_phone_digits IS NOT NULL
       AND length(${KEY('m.from_phone_digits')}) >= 6`;

await client.connect();
try {
    const total = await client.query(
        `SELECT COUNT(*)::int AS n FROM outbound_messages
          WHERE direction = 'inbound' AND reservation_id IS NULL`
    );
    const matches = await client.query(SELECT_MATCHES);
    console.log(`messaggi in entrata senza prenotazione: ${total.rows[0].n}`);
    console.log(`abbinabili a una prenotazione:          ${matches.rowCount}`);
    console.log(`resteranno senza (cliente senza prenotazione): ${total.rows[0].n - matches.rowCount}`);

    const sample = await client.query(`
        SELECT m.sent_at::date AS giorno, m.from_phone_digits AS da,
               left(m.body, 40) AS testo, r.id AS pren, r.customer_name AS cliente
          FROM (${SELECT_MATCHES}) x
          JOIN outbound_messages m ON m.id = x.message_id
          JOIN reservations r ON r.id = x.reservation_id
         ORDER BY m.sent_at DESC LIMIT 5`);
    console.log('\nesempi:');
    for (const r of sample.rows) {
        console.log(`  ${r.giorno} ${r.da} "${(r.testo || '').trim()}" -> #${r.pren} ${r.cliente}`);
    }

    if (!APPLY) {
        console.log('\nAnteprima soltanto. Rilancia con --apply per scrivere.');
        process.exit(0);
    }

    const upd = await client.query(`
        UPDATE outbound_messages m
           SET reservation_id = x.reservation_id
          FROM (${SELECT_MATCHES}) x
         WHERE m.id = x.message_id`);
    console.log(`\nAggiornati ${upd.rowCount} messaggi.`);
} finally {
    await client.end();
}
