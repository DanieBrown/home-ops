#!/usr/bin/env node

/**
 * test-contract-gates.mjs -- Contract gates must not be satisfiable by `--help`.
 *
 * A gate that regex-matches a bare script name is satisfied by running that
 * script with `--help`, which exits 0 having done no work. Two layers stop that:
 *
 *   1. on-bash.mjs refuses to touch requirement state for a help invocation,
 *      regardless of exit code. This is the universal guarantee and covers
 *      scripts that take no required argument at all.
 *   2. Contract patterns require a real argument wherever one genuinely exists
 *      (a report path, --shortlist, --report, --url). Defense in depth.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'contract-gate-test-'));
const statePath = join(tmpRoot, 'command-contract.json');

// Must be set before contract-shared.mjs is imported: STATE_PATH is resolved
// at module load so the test never writes over the live .home-ops contract.
process.env.HOME_OPS_CONTRACT_PATH = statePath;

const { CONTRACTS, STATE_PATH, isHelpInvocation, loadContract, startContract } =
  await import('../hooks/contract-shared.mjs');

assert.equal(STATE_PATH, statePath, 'HOME_OPS_CONTRACT_PATH must redirect the contract state file');

// ── 1. isHelpInvocation ────────────────────────────────────────────

const helpCommands = [
  'node scripts/research/construction-check.mjs --help',
  'node scripts/research/construction-check.mjs -h',
  'node scripts/pipeline/merge-tracker.mjs --help',
  'npm run check:construction -- --help',
  'npm.cmd run verify -- -h',
  '  node scripts/system/doctor.mjs --help  ',
];
for (const command of helpCommands) {
  assert.equal(isHelpInvocation(command), true, `must be treated as help: ${command}`);
}

const workCommands = [
  'node scripts/research/construction-check.mjs reports/001-foo-2026-08-11.md',
  'node scripts/research/construction-check.mjs --shortlist',
  'node scripts/reports/briefing-pdf.mjs --report reports/001-h-2026-08-11.md',
  'node scripts/tests/x.mjs --html-file scripts/tests/fixtures/a.html',
  'node scripts/research/helper-check.mjs --helper-mode',
  'node scripts/research/extract-listing-details.mjs --url https://example.com/homedetails/1-h-dr',
];
for (const command of workCommands) {
  assert.equal(isHelpInvocation(command), false, `must NOT be treated as help: ${command}`);
}

assert.equal(isHelpInvocation(''), false);
assert.equal(isHelpInvocation(null), false);
assert.equal(isHelpInvocation(undefined), false);

// ── 2. on-bash.mjs refuses to satisfy a requirement from a help run ──

function runHook(command, exitCode = 0) {
  const result = spawnSync(process.execPath, ['scripts/hooks/on-bash.mjs'], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { exitCode },
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME_OPS_CONTRACT_PATH: statePath },
  });
  assert.equal(result.status, 0, `on-bash.mjs must exit 0 (got ${result.status}): ${result.stderr}`);
  return result;
}

function requirement(id) {
  const contract = loadContract();
  const found = contract?.required?.find((entry) => entry.id === id);
  assert.ok(found, `contract must carry requirement ${id}`);
  return found;
}

// A gate whose script has no required argument — the hook is the only defense.
startContract('deep-shortlist');
runHook('node scripts/research/research-coverage-audit.mjs --help', 0);
let audit = requirement('research-audit');
assert.equal(audit.satisfied, false, '--help must not satisfy research-audit');
assert.equal(audit.failed, false, '--help must not mark research-audit failed either');
assert.equal(audit.attempts ?? 0, 0, '--help must not count as an attempt');

runHook('node scripts/research/research-coverage-audit.mjs', 0);
audit = requirement('research-audit');
assert.equal(audit.satisfied, true, 'a real research-coverage-audit run must satisfy the gate');

// A gate whose script does take a required argument.
startContract('deep-single');
runHook('node scripts/research/construction-check.mjs --help', 0);
let construction = requirement('construction-check-single');
assert.equal(construction.satisfied, false, '--help must not satisfy construction-check-single');
assert.equal(construction.failed, false, '--help must not mark construction-check-single failed');

runHook('node scripts/research/construction-check.mjs reports/001-foo-2026-08-11.md', 0);
construction = requirement('construction-check-single');
assert.equal(construction.satisfied, true, 'a real construction-check run must satisfy the gate');

// A genuine failure must still be recorded as failed.
runHook('node scripts/research/county-permits-check.mjs reports/001-foo-2026-08-11.md', 1);
const permits = requirement('county-permits-check-single');
assert.equal(permits.satisfied, false);
assert.equal(permits.failed, true, 'a non-zero exit must still mark the requirement failed');

// ── 3. Pattern-level defense in depth ───────────────────────────────
// Every gate whose script genuinely requires an argument must reject the bare
// `--help` form at the pattern level too, and must still accept real work.

const scriptGates = [
  ['deep-single', 'extract-listing-details',
    'node scripts/research/extract-listing-details.mjs --help',
    'node scripts/research/extract-listing-details.mjs --url https://example.com/h/1'],
  ['deep-single', 'extract-listing-details',
    'node scripts/pipeline/deep-single-runner.mjs --help',
    'node scripts/pipeline/deep-single-runner.mjs --url https://example.com/h/1 --profile chrome-host'],
  ['deep-single', 'school-assignments-fetch',
    'node scripts/research/school-assignments-fetch.mjs --help',
    'node scripts/research/school-assignments-fetch.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'research-source-plan-single',
    'node scripts/research/research-source-plan.mjs --help',
    'node scripts/research/research-source-plan.mjs reports/001-foo-2026-08-11.md --type all'],
  ['deep-single', 'community-lookup-single',
    'node scripts/research/community-lookup.mjs --help',
    'node scripts/research/community-lookup.mjs reports/001-foo-2026-08-11.md --profile chrome-host'],
  ['deep-single', 'sentiment-extract-single',
    'node scripts/research/sentiment-browser-extract.mjs --help',
    'node scripts/research/sentiment-browser-extract.mjs reports/001-foo-2026-08-11.md --profile chrome-host'],
  ['deep-single', 'sentiment-public-extract-single',
    'node scripts/research/sentiment-public-extract.mjs --help',
    'node scripts/research/sentiment-public-extract.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'construction-check-single',
    'node scripts/research/construction-check.mjs --help',
    'node scripts/research/construction-check.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'county-permits-check-single',
    'node scripts/research/county-permits-check.mjs --help',
    'node scripts/research/county-permits-check.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'school-metadata-fetch-single',
    'node scripts/research/school-metadata-fetch.mjs --help',
    'node scripts/research/school-metadata-fetch.mjs reports/001-foo-2026-08-11.md --profile chrome-host'],
  ['deep-single', 'builder-check-single',
    'node scripts/research/builder-check.mjs --help',
    'node scripts/research/builder-check.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'hoa-docs-check-single',
    'node scripts/research/hoa-docs-check.mjs --help',
    'node scripts/research/hoa-docs-check.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'utility-options-check-single',
    'node scripts/research/utility-options-check.mjs --help',
    'node scripts/research/utility-options-check.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'deep-research-packet-single',
    'node scripts/research/deep-research-packet.mjs --help',
    'node scripts/research/deep-research-packet.mjs reports/001-foo-2026-08-11.md'],
  ['deep-single', 'axis-sidecar',
    'node scripts/research/axis-sidecar-write.mjs --help',
    'node scripts/research/axis-sidecar-write.mjs --report reports/001-foo-2026-08-11.md --input a.json'],
  ['deep-single', 'review-tabs-single',
    'node scripts/browser/review-tabs.mjs --help',
    'node scripts/browser/review-tabs.mjs urls https://example.com/h/1 --replace'],
  ['deep-single', 'briefing-pdf-deep-single',
    'node scripts/reports/briefing-pdf.mjs --help',
    'node scripts/reports/briefing-pdf.mjs --report reports/001-foo-2026-08-11.md'],
  ['deep-shortlist', 'research-source-plan',
    'node scripts/research/research-source-plan.mjs --help',
    'node scripts/research/research-source-plan.mjs --shortlist --type all'],
  ['deep-shortlist', 'community-lookup',
    'node scripts/research/community-lookup.mjs --help',
    'node scripts/research/community-lookup.mjs --shortlist --profile chrome-host'],
  ['deep-shortlist', 'sentiment-extract',
    'node scripts/research/sentiment-browser-extract.mjs --help',
    'node scripts/research/sentiment-browser-extract.mjs --shortlist --profile chrome-host'],
  ['deep-shortlist', 'construction-check',
    'node scripts/research/construction-check.mjs --help',
    'node scripts/research/construction-check.mjs --shortlist'],
  ['deep-shortlist', 'sentiment-public-extract',
    'node scripts/research/sentiment-public-extract.mjs --help',
    'node scripts/research/sentiment-public-extract.mjs --shortlist'],
  ['deep-shortlist', 'utility-options-check',
    'node scripts/research/utility-options-check.mjs --help',
    'node scripts/research/utility-options-check.mjs --shortlist'],
  ['deep-shortlist', 'deep-research-packet',
    'node scripts/research/deep-research-packet.mjs --help',
    'node scripts/research/deep-research-packet.mjs --shortlist'],
  ['deep-shortlist', 'review-tabs-top3',
    'node scripts/browser/review-tabs.mjs --help',
    'node scripts/browser/review-tabs.mjs shortlist-top3 --replace'],
  ['hunt', 'review-tabs',
    'node scripts/browser/review-tabs.mjs --help',
    'node scripts/browser/review-tabs.mjs shortlist-top10 --replace'],
  ['hunt', 'browser-status',
    'node scripts/browser/browser-session.mjs --help',
    'node scripts/browser/browser-session.mjs --status --profile chrome-host'],
];

for (const [mode, id, helpCommand, realCommand] of scriptGates) {
  const entry = CONTRACTS[mode].required.find((item) => item.id === id);
  assert.ok(entry, `${mode} contract must define ${id}`);
  const matchesHelp = entry.patterns.some((rx) => rx.test(helpCommand));
  assert.equal(matchesHelp, false, `${mode}/${id} pattern must not match: ${helpCommand}`);
  const matchesReal = entry.patterns.some((rx) => rx.test(realCommand));
  assert.equal(matchesReal, true, `${mode}/${id} pattern must match real work: ${realCommand}`);
}

// The single-home runner satisfies its phases only when given a report.
const runnerGates = ['research-source-plan-single', 'construction-check-single', 'deep-research-packet-single'];
for (const id of runnerGates) {
  const entry = CONTRACTS['deep-single'].required.find((item) => item.id === id);
  assert.equal(
    entry.patterns.some((rx) => rx.test('node scripts/pipeline/deep-single-final-runner.mjs --help')),
    false,
    `deep-single/${id} must not be satisfied by deep-single-final-runner.mjs --help`,
  );
  assert.equal(
    entry.patterns.some((rx) => rx.test('node scripts/pipeline/deep-single-final-runner.mjs --report reports/001-foo-2026-08-11.md')),
    true,
    `deep-single/${id} must be satisfied by a real deep-single-final-runner.mjs run`,
  );
}

// Nothing in any contract may be satisfied by a bare `--help` on its own script.
for (const [mode, contract] of Object.entries(CONTRACTS)) {
  for (const entry of contract.required) {
    for (const pattern of entry.patterns) {
      assert.ok(
        pattern.source.length > 0,
        `${mode}/${entry.id} has an empty pattern`,
      );
    }
  }
}

rmSync(tmpRoot, { recursive: true, force: true });
console.log('test-contract-gates: all assertions passed');
