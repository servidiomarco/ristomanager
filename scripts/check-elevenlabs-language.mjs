#!/usr/bin/env node
// Verifica che l'agent ElevenLabs sia configurato per rispondere anche in
// inglese. Va eseguito da un ambiente che raggiunge api.elevenlabs.io
// (es. il tuo PC o Railway) — NON dal sandbox di Claude, dove l'egress
// verso ElevenLabs è bloccato dalla policy di rete.
//
// Uso (dalla root del repo):
//   ELEVENLABS_API_KEY=xxx ELEVENLABS_AGENT_ID=agent_5401kq7cjqa8evzbvwpbeghefm6w \
//     node scripts/check-elevenlabs-language.mjs
//
// Exit code 0 se l'inglese risulta attivo, 1 altrimenti.

const API_BASE = 'https://api.elevenlabs.io/v1';
const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;

if (!apiKey || !agentId) {
  console.error('Mancano ELEVENLABS_API_KEY e/o ELEVENLABS_AGENT_ID.');
  process.exit(2);
}

const res = await fetch(`${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`, {
  headers: { 'xi-api-key': apiKey },
});
if (!res.ok) {
  console.error(`GET agent fallita: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const agent = await res.json();
const cc = agent.conversation_config ?? {};
const agentCfg = cc.agent ?? {};

// La lingua principale (default all'inizio della chiamata).
const primary = agentCfg.language ?? '(non impostata)';

// Le lingue aggiuntive possono comparire in punti diversi a seconda di come
// il dashboard le salva: raccogliamo i codici da tutte le sedi plausibili.
const presetLangs = new Set();
for (const container of [cc.language_presets, agent.platform_settings?.language_presets]) {
  if (container && typeof container === 'object') {
    for (const k of Object.keys(container)) presetLangs.add(k);
  }
}
// Alcune versioni dell'API espongono un array esplicito.
for (const arrField of [cc.additional_languages, agentCfg.additional_languages, agent.additional_languages]) {
  if (Array.isArray(arrField)) for (const k of arrField) presetLangs.add(k);
}

// Il tool di sistema che rileva la lingua del chiamante e fa lo switch.
// NB: i built-in tools stanno sotto agent.prompt.built_in_tools.
const ld = agentCfg.prompt?.built_in_tools?.language_detection
  ?? agentCfg.built_in_tools?.language_detection
  ?? (Array.isArray(agentCfg.prompt?.tools)
      ? agentCfg.prompt.tools.find(t => t?.name === 'language_detection')
      : null)
  ?? (Array.isArray(agentCfg.tools)
      ? agentCfg.tools.find(t => t?.name === 'language_detection')
      : null);
const langDetectionOn = !!ld;

// Il system prompt contiene la sezione bilingue?
const promptText = agentCfg.prompt?.prompt ?? '';
const promptHasLanguageSection = /#\s*LINGUA/i.test(promptText);

const englishConfigured = presetLangs.has('en') || primary === 'en';

console.log('=== Verifica lingua agent ElevenLabs ===');
console.log(`Agent:                 ${agent.name ?? agentId}`);
console.log(`Lingua principale:     ${primary}`);
console.log(`Lingue aggiuntive:     ${[...presetLangs].join(', ') || '(nessuna)'}`);
console.log(`English configurato:   ${englishConfigured ? 'SÌ' : 'NO'}`);
console.log(`Language detection:    ${langDetectionOn ? 'attivo' : 'DISATTIVO'}`);
console.log(`Prompt sezione LINGUA: ${promptHasLanguageSection ? 'presente' : 'MANCANTE'}`);
console.log('');

const problems = [];
if (!englishConfigured) problems.push('English non è tra le lingue dell\'agent (aggiungilo in Agent → Language → Additional languages).');
if (!langDetectionOn) problems.push('Il tool "Language detection" è disattivo: senza, l\'agent non passa all\'inglese da solo.');
if (!promptHasLanguageSection) problems.push('Il system prompt live non contiene la sezione "# LINGUA": ripubblicalo con scripts/update-elevenlabs-prompt.mjs --apply.');

if (problems.length === 0) {
  console.log('✅ Tutto in ordine: l\'agent può rispondere in inglese quando il cliente parla inglese.');
  process.exit(0);
} else {
  console.log('⚠️  Da sistemare:');
  for (const p of problems) console.log(`   - ${p}`);
  process.exit(1);
}
