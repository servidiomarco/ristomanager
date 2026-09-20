#!/usr/bin/env node
// Pushes the workflow NODE prompts from docs/elevenlabs-agent-prompt.md to the
// live ElevenLabs Conversational-AI agent. Companion to
// update-elevenlabs-prompt.mjs, which only touches the system prompt.
//
// The agent is a workflow: every node carries its own `additional_prompt` that
// is appended to the system prompt while that node is active. Those texts drift
// silently — twice already, each time producing a real incident:
//   - case Taddeo (18/09/2026): `reservation_flow` summarised the booking flow
//     without the known-caller branch, so the agent asked a caller already in
//     the address book for their name from scratch;
//   - case Aragosta (19/09/2026): the closed-zone rule lived in the system
//     prompt only, and the node kept steering the conversation its own way.
// Nothing in the API warns you: the node simply contradicts the prompt.
//
// The manual is the source of truth. Every node documented there under
// `Testo corrente del nodo \`<id>\`` followed by a fenced block is synced.
// A node with no block in the manual is left alone and reported, so adding a
// node to the workflow doesn't silently fall out of the repo.
//
// Usage (from repo root):
//   ELEVENLABS_API_KEY=xxx ELEVENLABS_AGENT_ID=yyy \
//     node scripts/update-elevenlabs-node.mjs [--apply | --pull]
//
// Modes:
//   default   Dry run: fetch live, compare with the manual, print a summary.
//   --apply   Push manual → live (one PATCH with every changed node).
//   --pull    Fetch live → write docs/elevenlabs-agent-nodes.live.md in the
//             manual's own format, so you can diff/merge before pushing.
//
// Railway holds the credentials:
//   railway run --service ristomanager -- node scripts/update-elevenlabs-node.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = resolve(__dirname, '..', 'docs', 'elevenlabs-agent-prompt.md');
const LIVE_FILE = resolve(__dirname, '..', 'docs', 'elevenlabs-agent-nodes.live.md');
const API_BASE = 'https://api.elevenlabs.io/v1';

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apply = process.argv.includes('--apply');
const pull = process.argv.includes('--pull');

if (!apiKey || !agentId) {
  console.error('Missing ELEVENLABS_API_KEY and/or ELEVENLABS_AGENT_ID env vars.');
  process.exit(2);
}

if (apply && pull) {
  console.error('Pick either --apply or --pull, not both.');
  process.exit(2);
}

const agentUrl = `${API_BASE}/convai/agents/${encodeURIComponent(agentId)}`;

async function fetchAgent() {
  const res = await fetch(agentUrl, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) {
    console.error(`GET agent failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }
  return res.json();
}

/**
 * Read the node texts out of the manual.
 *
 * Anchor is a line containing `Testo corrente del nodo \`<id>\``; the text is
 * the first fenced block after it. Returns a Map id → text.
 */
function readManualNodes() {
  const raw = readFileSync(PROMPT_FILE, 'utf8');
  const anchor = /Testo corrente del nodo `([a-z0-9_]+)`/g;
  const nodes = new Map();
  let match;
  while ((match = anchor.exec(raw)) !== null) {
    const id = match[1];
    const open = raw.indexOf('```', match.index);
    if (open < 0) {
      console.error(`Node \`${id}\`: anchor found but no fenced block after it.`);
      process.exit(2);
    }
    // Skip the opening fence and its (optional) language tag line.
    const bodyStart = raw.indexOf('\n', open) + 1;
    const close = raw.indexOf('```', bodyStart);
    if (close < 0) {
      console.error(`Node \`${id}\`: fenced block is never closed.`);
      process.exit(2);
    }
    const text = raw.slice(bodyStart, close).trim();
    if (!text) {
      console.error(`Node \`${id}\`: fenced block is empty. Aborting.`);
      process.exit(2);
    }
    nodes.set(id, text);
  }
  return nodes;
}

// The workflow is a TOP-LEVEL field on the agent — not inside
// conversation_config, where the rest of the agent's configuration lives.
const liveNodes = (agent) => agent?.workflow?.nodes ?? {};

// --pull short-circuits everything: dump the live node prompts in the same
// shape the manual uses, ready to paste.
if (pull) {
  const agent = await fetchAgent();
  const entries = Object.entries(liveNodes(agent))
    .filter(([, node]) => typeof node?.additional_prompt === 'string' && node.additional_prompt.trim());
  const blocks = entries.map(([id, node]) =>
    `Testo corrente del nodo \`${id}\` (label «${node.label ?? ''}», tipo \`${node.type}\`):\n\n` +
    '```\n' + node.additional_prompt.trim() + '\n```\n'
  );
  writeFileSync(LIVE_FILE, `# Nodi del workflow — copia dal vivo\n\n${blocks.join('\n')}`);
  console.log(`Saved ${entries.length} live node prompts to ${LIVE_FILE}`);
  process.exit(0);
}

const manual = readManualNodes();
if (manual.size === 0) {
  console.error(`No node blocks found in ${PROMPT_FILE}.`);
  process.exit(2);
}

const agent = await fetchAgent();
const live = liveNodes(agent);

console.log(`Manual file:  ${PROMPT_FILE}`);
console.log(`Agent ID:     ${agentId}`);
console.log(`Nodes live:   ${Object.keys(live).join(', ') || '(none)'}`);
console.log('');

const changed = [];
for (const [id, text] of manual) {
  const node = live[id];
  if (!node) {
    console.error(`  ${id.padEnd(16)} MISSING on the agent — check the node id in the manual.`);
    process.exit(1);
  }
  const current = node.additional_prompt ?? '';
  if (current === text) {
    console.log(`  ${id.padEnd(16)} già allineato (${text.length} char)`);
  } else {
    console.log(`  ${id.padEnd(16)} DA AGGIORNARE — live ${current.length} char, manuale ${text.length} char`);
    changed.push([id, text]);
  }
}

// A node that exists on the agent but nowhere in the manual can drift without
// anybody noticing. Name it every run — that's the whole point of this script.
const undocumented = Object.entries(live)
  .filter(([id, node]) => !manual.has(id) && typeof node?.additional_prompt === 'string' && node.additional_prompt.trim())
  .map(([id]) => id);
if (undocumented.length) {
  console.log('');
  console.log(`  Nodi con un prompt proprio ma NON documentati nel manuale: ${undocumented.join(', ')}`);
  console.log('  Portali nel manuale (--pull li dà già nel formato giusto) o resteranno fuori controllo.');
}

if (!changed.length) {
  console.log('\nNiente da fare.');
  process.exit(0);
}

if (!apply) {
  console.log(`\nDry run — passa --apply per scrivere ${changed.length} nodo/i.`);
  process.exit(0);
}

// PATCH wants the whole `workflow` object back: send it as it came, with only
// the changed nodes swapped, so edges/subgraphs/positions survive untouched.
const nextNodes = { ...live };
for (const [id, text] of changed) {
  nextNodes[id] = { ...live[id], additional_prompt: text };
}
const patchRes = await fetch(agentUrl, {
  method: 'PATCH',
  headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow: { ...agent.workflow, nodes: nextNodes } }),
});
if (!patchRes.ok) {
  console.error(`PATCH agent failed: ${patchRes.status} ${patchRes.statusText}`);
  console.error(await patchRes.text());
  process.exit(1);
}

// Read back rather than trusting the 200: a PATCH that drops a field answers
// just as cheerfully as one that lands.
const after = liveNodes(await fetchAgent());
const mismatched = changed.filter(([id, text]) => (after[id]?.additional_prompt ?? '') !== text);
if (mismatched.length) {
  console.error(`\nATTENZIONE: la rilettura non coincide per ${mismatched.map(([id]) => id).join(', ')}.`);
  process.exit(1);
}
console.log(`\nOK — ${changed.length} nodo/i aggiornati e riletti uguali: ${changed.map(([id]) => id).join(', ')}`);
