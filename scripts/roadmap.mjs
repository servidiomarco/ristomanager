// CLI della pagina Roadmap per le sessioni Claude Code.
//
// L'admin approva un task dalla pagina Roadmap (status 'queued'); qui Claude
// lo prende in carico, lo lavora e lo chiude scrivendo l'esito, che riappare
// in pagina in tempo reale (il polling della pagina passa dal refetch on
// socket 'roadmap:changed'; questo script scrive solo a DB, quindi l'esito si
// vede al prossimo refresh/refetch della pagina).
//
// Uso (serve DATABASE_URL nell'ambiente):
//   node scripts/roadmap.mjs list                 # coda: task approvati + in lavorazione
//   node scripts/roadmap.mjs start <id>           # prendi in carico (queued → in_progress)
//   node scripts/roadmap.mjs done <id> "esito"    # chiudi con nota (→ done)
//   node scripts/roadmap.mjs all                  # intera roadmap, per fase

import { Client } from 'pg';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const [cmd, idArg, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim();

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

const printTask = (t) => {
  console.log(`#${t.id} [${t.status}] (${t.phase_key}) ${t.title}`);
  if (t.description) console.log(`    ${t.description.replace(/\n/g, '\n    ')}`);
  if (t.claude_prompt) console.log(`    PROMPT: ${t.claude_prompt.replace(/\n/g, '\n    ')}`);
  if (t.result_note) console.log(`    ESITO: ${t.result_note.replace(/\n/g, '\n    ')}`);
};

try {
  if (cmd === 'list' || cmd === undefined) {
    const { rows } = await client.query(
      `SELECT * FROM roadmap_tasks WHERE status IN ('queued', 'in_progress') ORDER BY phase_key, position, id`
    );
    if (rows.length === 0) {
      console.log('Coda vuota: nessun task approvato per Claude.');
    } else {
      console.log(`${rows.length} task in coda:\n`);
      rows.forEach(printTask);
    }
  } else if (cmd === 'all') {
    const { rows } = await client.query(`SELECT * FROM roadmap_tasks ORDER BY phase_key, position, id`);
    rows.forEach(printTask);
  } else if (cmd === 'start') {
    const { rows } = await client.query(
      `UPDATE roadmap_tasks SET status = 'in_progress', updated_at = NOW()
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [Number(idArg)]
    );
    if (rows.length === 0) {
      console.error(`Task ${idArg} non trovato o non in coda (solo i task 'queued' si possono prendere in carico).`);
      process.exit(1);
    }
    console.log('Preso in carico:');
    printTask(rows[0]);
  } else if (cmd === 'done') {
    if (!note) {
      console.error('Serve una nota di esito: node scripts/roadmap.mjs done <id> "cosa è stato fatto"');
      process.exit(1);
    }
    const { rows } = await client.query(
      `UPDATE roadmap_tasks SET status = 'done', result_note = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'in_progress') RETURNING *`,
      [Number(idArg), note]
    );
    if (rows.length === 0) {
      console.error(`Task ${idArg} non trovato o non in lavorazione.`);
      process.exit(1);
    }
    console.log('Chiuso:');
    printTask(rows[0]);
  } else {
    console.error(`Comando sconosciuto: ${cmd}. Usa list | all | start <id> | done <id> "nota".`);
    process.exit(1);
  }
} finally {
  await client.end();
}
