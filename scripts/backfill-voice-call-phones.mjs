// Backfill voice_calls.phone for rows where phone IS NULL by re-querying
// the ElevenLabs conversation detail endpoint and reading
// metadata.phone_call.external_number (the field the sync endpoint uses).
//
// One-off: run once after the fix is deployed. Not wired into any route.

import { Client } from 'pg';

const {
  DATABASE_URL,
  ELEVENLABS_API_KEY,
} = process.env;

if (!DATABASE_URL || !ELEVENLABS_API_KEY) {
  console.error('Missing DATABASE_URL or ELEVENLABS_API_KEY');
  process.exit(1);
}

function normalizeItalianPhone(input) {
  if (!input) return '';
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('39') && digits.length >= 11) return '+' + digits;
  if (digits.length === 10 && (digits.startsWith('3') || digits.startsWith('0'))) {
    return '+39' + digits;
  }
  return digits.startsWith('+') ? digits : '+' + digits;
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT conversation_id FROM voice_calls WHERE phone IS NULL ORDER BY created_at DESC`
);

console.log(`Found ${rows.length} rows with NULL phone`);

let backfilled = 0;
let stillNoPhone = 0;
let notFound = 0;
let errored = 0;

for (const { conversation_id } of rows) {
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversation_id)}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    if (r.status === 404) { notFound++; continue; }
    if (!r.ok) { errored++; console.warn(`  ${conversation_id}: HTTP ${r.status}`); continue; }
    const detail = await r.json();
    const phoneRaw =
      detail?.metadata?.phone_call?.external_number ||
      detail?.metadata?.phone_number ||
      detail?.metadata?.phone;
    if (!phoneRaw) { stillNoPhone++; continue; }
    const phone = normalizeItalianPhone(phoneRaw);
    await client.query(
      `UPDATE voice_calls SET phone = $1 WHERE conversation_id = $2`,
      [phone, conversation_id]
    );
    backfilled++;
    console.log(`  ${conversation_id} → ${phone}`);
  } catch (err) {
    errored++;
    console.warn(`  ${conversation_id}: ${err.message}`);
  }
}

await client.end();
console.log(`\nDone. backfilled=${backfilled} stillNoPhone=${stillNoPhone} notFound=${notFound} errored=${errored}`);
