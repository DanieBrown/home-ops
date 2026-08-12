#!/usr/bin/env node

/**
 * test-deep-doc-sync.mjs -- modes/deep.md and the deep contracts must describe
 * the same set of scripts.
 *
 * Two failure modes this catches:
 *   - documented but ungated: deep.md tells the agent to run a capture step
 *     that no contract requires, so skipping it still passes every gate.
 *   - gated but undocumented: a contract requires a step deep.md never
 *     mentions, so an agent following the doc stalls on a gate it was never
 *     told to satisfy.
 *
 * The lists below are the intended contract. Both the doc and
 * contract-shared.mjs are checked against them, so drift on either side fails.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../shared/paths.mjs';
import { CONTRACTS } from '../hooks/contract-shared.mjs';

const deepDoc = readFileSync(join(ROOT, 'modes', 'deep.md'), 'utf8');

// ── Batch flow: modes/deep.md Phase A vs. the deep-shortlist contract ──

/** [script base name, deep-shortlist requirement id] */
const PHASE_A = [
  ['research-source-plan', 'research-source-plan'],
  ['community-lookup', 'community-lookup'],
  ['sentiment-browser-extract', 'sentiment-extract'],
  ['sentiment-public-extract', 'sentiment-public-extract'],
  ['construction-check', 'construction-check'],
  ['county-permits-check', 'county-permits-check'],
  ['school-metadata-fetch', 'school-metadata-fetch'],
  ['builder-check', 'builder-check'],
  ['hoa-docs-check', 'hoa-docs-check'],
  ['utility-options-check', 'utility-options-check'],
];

const phaseAStart = deepDoc.indexOf('### Phase A');
const phaseBStart = deepDoc.indexOf('### Phase B');
assert.ok(phaseAStart > -1 && phaseBStart > phaseAStart, 'modes/deep.md must have a Phase A and Phase B section');
const phaseABlock = deepDoc.slice(phaseAStart, phaseBStart);

const shortlist = CONTRACTS['deep-shortlist'].required;
const packet = shortlist.find((entry) => entry.id === 'deep-research-packet');
assert.ok(packet, 'deep-shortlist must define deep-research-packet');

for (const [script, requirementId] of PHASE_A) {
  assert.match(
    phaseABlock,
    new RegExp(`scripts/research/${script}\\.mjs --shortlist`),
    `modes/deep.md Phase A must document: node scripts/research/${script}.mjs --shortlist`,
  );

  const entry = shortlist.find((item) => item.id === requirementId);
  assert.ok(entry, `deep-shortlist contract must require ${requirementId} (${script})`);
  assert.ok(
    entry.patterns.some((rx) => rx.test(`node scripts/research/${script}.mjs --shortlist`)),
    `deep-shortlist/${requirementId} must match its documented Phase A command`,
  );
  assert.ok(
    packet.requires.includes(requirementId),
    `deep-research-packet must depend on ${requirementId} — otherwise Phase A can be skipped silently`,
  );
}

// Nothing in Phase A may be undocumented in the contract either.
const documentedScripts = [...phaseABlock.matchAll(/scripts\/research\/([a-z0-9-]+)\.mjs --shortlist/g)]
  .map((match) => match[1]);
// deep-research-packet is documented in the same block but is the consumer of
// the captures above, not one of them.
const knownScripts = new Set([...PHASE_A.map(([script]) => script), 'deep-research-packet']);
for (const script of documentedScripts) {
  assert.ok(
    knownScripts.has(script),
    `modes/deep.md Phase A documents ${script}.mjs but no deep-shortlist requirement covers it`,
  );
}

// ── Single flow: the runner, modes/deep.md Phase 2, and deep-single ──

const runnerSource = readFileSync(join(ROOT, 'scripts', 'pipeline', 'deep-single-final-runner.mjs'), 'utf8');
const phasesStart = runnerSource.indexOf('const phases = [');
assert.ok(phasesStart > -1, 'deep-single-final-runner.mjs must declare a phases array');
const phasesBlock = runnerSource.slice(phasesStart);

const runnerSteps = [...phasesBlock.matchAll(/contractId: '([^']+)'[\s\S]*?args: \['scripts\/research\/([a-z0-9-]+)\.mjs'/g)]
  .map((match) => ({ contractId: match[1], script: match[2] }));

assert.ok(runnerSteps.length >= 10, `expected the single runner to declare 10+ research phases, found ${runnerSteps.length}`);

const phase2Line = deepDoc.split('\n').find((line) => line.startsWith('This runner sequentially runs:'));
assert.ok(phase2Line, 'modes/deep.md must describe what deep-single-final-runner.mjs runs');

const deepSingle = CONTRACTS['deep-single'].required;
for (const { contractId, script } of runnerSteps) {
  assert.ok(
    phase2Line.includes(script),
    `modes/deep.md Phase 2 step list omits ${script}, which deep-single-final-runner.mjs does run`,
  );
  const entry = deepSingle.find((item) => item.id === contractId);
  assert.ok(entry, `deep-single contract must define ${contractId}`);
  assert.ok(
    entry.patterns.some((rx) => rx.test(`node scripts/research/${script}.mjs reports/001-foo-2026-08-11.md`)),
    `deep-single/${contractId} must match a real single-home ${script} run`,
  );
}

// And nothing may be listed in the doc that the runner does not run.
const listedScripts = phase2Line
  .replace('This runner sequentially runs:', '')
  .split(/[,.]/)
  .map((part) => part.replace(/^\s*and\s+/, '').trim())
  .filter((part) => /^[a-z0-9-]+$/.test(part));
const runnerScripts = new Set([...runnerSteps.map((step) => step.script), 'deep-research-packet']);
for (const script of listedScripts) {
  assert.ok(
    runnerScripts.has(script),
    `modes/deep.md Phase 2 lists ${script}, but deep-single-final-runner.mjs does not run it`,
  );
}

console.log('test-deep-doc-sync: all assertions passed');
