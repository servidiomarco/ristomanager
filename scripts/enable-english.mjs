#!/usr/bin/env node
// Abilita l'inglese sull'agent ElevenLabs via API, in modo idempotente:
//   1. accende il built-in tool `language_detection` (switch automatico di lingua)
//   2. aggiunge English (`en`) tra le lingue dell'agent (language_presets),
//      con un first message inglese dedicato
//   3. corregge soft_timeout_config se viola il limite ElevenLabs
//      (timeout_seconds * max_soft_timeouts_per_generation <= 24s), altrimenti
//      la PATCH verrebbe rifiutata dalla stessa validazione che blocca il save
//      in dashboard.
// Fa GET dell'agent, fonde le modifiche con la config esistente (non sovrascrive
// gli altri tool/preset), fa PATCH e infine ri-verifica stampando l'esito.
//
// NON tocca il system prompt: per quello usa scripts/update-elevenlabs-prompt.mjs --apply
//
// Va eseguito da un ambiente che raggiunge api.elevenlabs.io (il tuo Mac / Railway),
// NON dal sandbox di Claude (egress bloccato).
//
// Uso (dalla root del repo):
//   ELEVENLABS_API_KEY=xxx ELEVENLABS_AGENT_ID=agent_5401kq7cjqa8evzbvwpbeghefm6w \
//     node scripts/enable-english.mjs [--dry-run]

const API_BASE = 'https://api.elevenlabs.io/v1';
const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
const dryRun = process.argv.includes('--dry-run');

if (!apiKey || !agentId) {
  console.error('Mancano ELEVENLABS_API_KEY e/o ELEVENLABS_AGENT_ID.');
  process.exit(2);
}

const EN_FIRST_MESSAGE =
  'Hi, this is Sofia from Vecchio Frantoio. I can help you book a table. ' +
  'For anything else please call between 10:30-14:30 or 18:45-23:30. ' +
  'When would you like to book?';

const headers = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };

// 1) GET stato attuale ------------------------------------------------------
const getRes = await fetch(`${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`, { headers });
if (!getRes.ok) {
  console.error(`GET agent fallita: ${getRes.status} ${getRes.statusText}`);
  console.error(await getRes.text());
  process.exit(1);
}
const agent = await getRes.json();
const cc = agent.conversation_config ?? {};
const agentCfg = cc.agent ?? {};

// 2) Costruisci la config aggiornata (merge, non replace) -------------------
// NB: built_in_tools sta sotto agent.PROMPT.built_in_tools, non agent.built_in_tools.
const promptCfg = agentCfg.prompt ?? {};
const currentBuiltIn = promptCfg.built_in_tools ?? {};
// Oggetto tool completo: una versione minimale non viene accettata/persistita
// dall'API (torna null). Rispecchia lo schema del backup dell'agent.
const newBuiltIn = {
  ...currentBuiltIn,
  language_detection: {
    type: 'system',
    name: 'language_detection',
    description: "Detect the user's language and switch to it.",
    response_timeout_secs: 20,
    disable_interruptions: false,
    interruption_mode: 'allow',
    force_pre_tool_speech: false,
    pre_tool_speech: 'auto',
    assignments: [],
    tool_call_sound: null,
    tool_call_sound_behavior: 'auto',
    tool_error_handling_mode: 'auto',
    params: { system_tool_type: 'language_detection' },
  },
};

const currentPresets = cc.language_presets ?? {};
const newPresets = {
  ...currentPresets,
  en: {
    // `overrides` è il modo con cui la dashboard registra una lingua aggiuntiva;
    // qui diamo il first message inglese, il resto viene auto-tradotto.
    overrides: {
      agent: { first_message: EN_FIRST_MESSAGE },
    },
  },
};

const patchBody = {
  conversation_config: {
    agent: { prompt: { built_in_tools: newBuiltIn } },
    language_presets: newPresets,
  },
};

// Correggi soft_timeout_config se supera il limite di 24s: il prodotto
// timeout_seconds * max_soft_timeouts_per_generation non può eccederlo, e
// una config non valida fa fallire QUALSIASI PATCH (stessa validazione della
// dashboard). Merge sul valore esistente per non perdere i filler messages.
const SOFT_TIMEOUT_LIMIT = 24;
const currentSoft = cc.turn?.soft_timeout_config ?? null;
let softTimeoutFixed = null;
if (currentSoft) {
  const secs = Number(currentSoft.timeout_seconds) || 0;
  const maxN = Number(currentSoft.max_soft_timeouts_per_generation) || 0;
  if (secs > 0 && maxN > 0 && secs * maxN > SOFT_TIMEOUT_LIMIT) {
    const allowed = Math.max(1, Math.floor(SOFT_TIMEOUT_LIMIT / secs));
    softTimeoutFixed = { from: maxN, to: allowed, secs };
    patchBody.conversation_config.turn = {
      soft_timeout_config: { ...currentSoft, max_soft_timeouts_per_generation: allowed },
    };
  }
}

console.log('Agent:', agent.name ?? agentId);
console.log('Lingua principale:', agentCfg.language);
console.log('Lingue aggiuntive attuali:', Object.keys(currentPresets).join(', ') || '(nessuna)');
console.log('language_detection attuale:', currentBuiltIn.language_detection ? 'attivo' : 'DISATTIVO');
if (softTimeoutFixed) {
  console.log(`soft_timeout: correggo max_soft_timeouts_per_generation ${softTimeoutFixed.from} → ${softTimeoutFixed.to} (${softTimeoutFixed.secs}s cad., limite ${SOFT_TIMEOUT_LIMIT}s)`);
}

if (dryRun) {
  console.log('\n--dry-run: PATCH che verrebbe inviata:');
  console.log(JSON.stringify(patchBody, null, 2));
  process.exit(0);
}

// 3) PATCH ------------------------------------------------------------------
const patchRes = await fetch(`${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify(patchBody),
});
if (!patchRes.ok) {
  console.error(`\nPATCH fallita: ${patchRes.status} ${patchRes.statusText}`);
  console.error(await patchRes.text());
  process.exit(1);
}
console.log('\nPATCH inviata. Ri-verifico...');

// 4) Ri-verifica ------------------------------------------------------------
const verifyRes = await fetch(`${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`, { headers });
const after = await verifyRes.json();
const acc = after.conversation_config ?? {};
const aAgent = acc.agent ?? {};
const presetsAfter = Object.keys(acc.language_presets ?? {});
const ldAfter = !!aAgent.prompt?.built_in_tools?.language_detection;
const englishAfter = presetsAfter.includes('en') || aAgent.language === 'en';

console.log('\n=== Dopo la modifica ===');
console.log('Lingue aggiuntive:', presetsAfter.join(', ') || '(nessuna)');
console.log('English configurato:', englishAfter ? 'SÌ' : 'NO');
console.log('Language detection:', ldAfter ? 'attivo' : 'DISATTIVO');

if (englishAfter && ldAfter) {
  console.log('\n✅ Inglese abilitato. Ora pubblica anche il prompt:');
  console.log('   node scripts/update-elevenlabs-prompt.mjs --apply');
  process.exit(0);
} else {
  console.log('\n⚠️  Qualcosa non ha attecchito: incolla questo output per capire lo schema atteso.');
  if (!ldAfter) {
    console.log('\n[debug] agent.prompt.built_in_tools memorizzato dopo la PATCH:');
    console.log(JSON.stringify(aAgent.prompt?.built_in_tools ?? null, null, 2));
  }
  process.exit(1);
}
