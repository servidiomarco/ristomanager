#!/usr/bin/env node
// Pushes the system prompt from docs/elevenlabs-agent-prompt.md to the live
// ElevenLabs Conversational-AI agent. Extracts the block between
// `## ---INIZIO PROMPT---` and `## ---FINE PROMPT---`, then PATCHes
// conversation_config.agent.prompt.prompt.
//
// Usage (from repo root):
//   ELEVENLABS_API_KEY=xxx ELEVENLABS_AGENT_ID=yyy \
//     node scripts/update-elevenlabs-prompt.mjs [--apply]
//
// Without --apply it runs dry: fetches the current prompt, computes a diff
// summary, but does NOT write. Pass --apply to actually update.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = resolve(__dirname, '..', 'docs', 'elevenlabs-agent-prompt.md');
const API_BASE = 'https://api.elevenlabs.io/v1';

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apply = process.argv.includes('--apply');

if (!apiKey || !agentId) {
  console.error('Missing ELEVENLABS_API_KEY and/or ELEVENLABS_AGENT_ID env vars.');
  process.exit(2);
}

const raw = readFileSync(PROMPT_FILE, 'utf8');
const startMarker = '## ---INIZIO PROMPT---';
const endMarker = '## ---FINE PROMPT---';
const startIdx = raw.indexOf(startMarker);
const endIdx = raw.indexOf(endMarker);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error(`Could not find prompt markers in ${PROMPT_FILE}.`);
  process.exit(2);
}
const promptBody = raw.slice(startIdx + startMarker.length, endIdx).trim();
if (!promptBody) {
  console.error('Extracted prompt is empty. Aborting.');
  process.exit(2);
}

console.log(`Prompt file:  ${PROMPT_FILE}`);
console.log(`Agent ID:     ${agentId}`);
console.log(`Local prompt: ${promptBody.length} chars, ${promptBody.split('\n').length} lines`);

const getRes = await fetch(`${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`, {
  headers: { 'xi-api-key': apiKey },
});
if (!getRes.ok) {
  console.error(`GET agent failed: ${getRes.status} ${getRes.statusText}`);
  console.error(await getRes.text());
  process.exit(1);
}
const agent = await getRes.json();
const currentPrompt = agent?.conversation_config?.agent?.prompt?.prompt ?? '';
console.log(`Live prompt:  ${currentPrompt.length} chars, ${currentPrompt.split('\n').length} lines`);

if (currentPrompt === promptBody) {
  console.log('Live prompt already matches local file. Nothing to do.');
  process.exit(0);
}

if (!apply) {
  console.log('\nDry run — pass --apply to push. First 40 chars of local prompt:');
  console.log(`  ${JSON.stringify(promptBody.slice(0, 40))}`);
  console.log('First 40 chars of live prompt:');
  console.log(`  ${JSON.stringify(currentPrompt.slice(0, 40))}`);
  process.exit(0);
}

const patchRes = await fetch(`${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`, {
  method: 'PATCH',
  headers: {
    'xi-api-key': apiKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    conversation_config: {
      agent: {
        prompt: {
          prompt: promptBody,
        },
      },
    },
  }),
});
if (!patchRes.ok) {
  console.error(`PATCH agent failed: ${patchRes.status} ${patchRes.statusText}`);
  console.error(await patchRes.text());
  process.exit(1);
}
console.log('\nOK — prompt updated on ElevenLabs.');
