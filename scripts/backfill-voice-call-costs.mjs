// Backfill di durata e costo su voice_calls (Fase 1 dei minuti di Sofia).
//
// Fino a settembre 2026 il post-call leggeva la durata da un campo che
// ElevenLabs non manda (call_duration_seconds invece di call_duration_secs)
// e scartava il costo: quasi tutte le righe hanno duration_seconds e
// cost_usd a NULL. Qui si rilegge il dettaglio di ogni conversazione e si
// riempiono SOLO i campi mancanti — transcript, riassunto e collegamenti
// restano come sono.
//
// Uso (DATABASE_URL = DATABASE_PUBLIC_URL del servizio Postgres):
//   DATABASE_URL=... ELEVENLABS_API_KEY=... node scripts/backfill-voice-call-costs.mjs          # prova, non scrive
//   DATABASE_URL=... ELEVENLABS_API_KEY=... node scripts/backfill-voice-call-costs.mjs --apply  # scrive

import { Client } from 'pg';

const { DATABASE_URL, ELEVENLABS_API_KEY } = process.env;
const apply = process.argv.includes('--apply');

if (!DATABASE_URL || !ELEVENLABS_API_KEY) {
  console.error('Missing DATABASE_URL or ELEVENLABS_API_KEY');
  process.exit(1);
}

// Stessa lettura di extractVoiceCallCost in services/elevenlabsService.ts.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
function readCost(metadata) {
  const credits = num(metadata?.cost);
  const llm = num(metadata?.charging?.llm_price);
  const platform = num(metadata?.charging?.platform_price);
  return {
    cost_credits: credits === null ? null : Math.round(credits),
    cost_usd: llm === null && platform === null ? null : (llm ?? 0) + (platform ?? 0),
    llm_cost_usd: llm,
    platform_cost_usd: platform,
  };
}

async function fetchDetail(conversationId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    if (r.status === 429) { await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); continue; }
    if (r.status === 404) return { notFound: true };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { detail: await r.json() };
  }
  throw new Error('HTTP 429 dopo 4 tentativi');
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT conversation_id FROM voice_calls
    WHERE duration_seconds IS NULL OR cost_usd IS NULL
    ORDER BY created_at DESC`
);
console.log(`${rows.length} chiamate senza durata o costo${apply ? '' : ' (prova: nessuna scrittura, --apply per scrivere)'}`);

let updated = 0, notFound = 0, noData = 0, errored = 0, seconds = 0, usd = 0;
let next = 0;

async function worker() {
  while (next < rows.length) {
    const { conversation_id } = rows[next++];
    try {
      const { detail, notFound: nf } = await fetchDetail(conversation_id);
      if (nf) { notFound++; continue; }
      const duration = num(detail?.metadata?.call_duration_secs);
      const cost = readCost(detail?.metadata);
      if (duration === null && cost.cost_usd === null) { noData++; continue; }
      seconds += duration ?? 0;
      usd += cost.cost_usd ?? 0;
      if (apply) {
        await client.query(
          `UPDATE voice_calls
              SET duration_seconds  = COALESCE(duration_seconds, $2),
                  cost_credits      = COALESCE(cost_credits, $3),
                  cost_usd          = COALESCE(cost_usd, $4),
                  llm_cost_usd      = COALESCE(llm_cost_usd, $5),
                  platform_cost_usd = COALESCE(platform_cost_usd, $6)
            WHERE conversation_id = $1`,
          [conversation_id, duration === null ? null : Math.trunc(duration),
           cost.cost_credits, cost.cost_usd, cost.llm_cost_usd, cost.platform_cost_usd]
        );
      }
      updated++;
      if (updated % 200 === 0) console.log(`  ${updated} / ${rows.length}`);
    } catch (err) {
      errored++;
      console.warn(`  ${conversation_id}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: 6 }, worker));
await client.end();

console.log(`\n${apply ? 'Aggiornate' : 'Da aggiornare'}: ${updated} · non trovate su ElevenLabs: ${notFound} · senza dati: ${noData} · errori: ${errored}`);
console.log(`Totale recuperato: ${Math.round(seconds / 60)} minuti, ${usd.toFixed(2)} $`);
