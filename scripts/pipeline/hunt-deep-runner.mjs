#!/usr/bin/env node
/**
 * Deep shortlist data-collection runner (phases 1–4).
 * Runs the deterministic prep scripts that build research packets for every
 * shortlisted home. When these finish, the main agent fans out one AI subagent
 * per home to do the actual deep research, then calls hunt:deep-final to
 * promote finalists, run the gate, open tabs, and render the PDF.
 *
 * Steps:
 *   1. research-source-plan      — build per-home sentiment/school/development source plan
 *   2. sentiment-browser-extract — capture Facebook/Nextdoor evidence via hosted browser
 *   3. construction-check        — fetch NCDOT construction signals
 *   4. deep-research-packet      — assemble one packet per shortlisted home
 *
 * After this runner exits 0, the main agent reads output/deep-packets/ and
 * launches one subagent per home (see hunt.md Step 5b and modes/deep.md step 9).
 * Call hunt:deep-final after all subagents return.
 *
 * Exit codes:
 *   0 — all prep phases succeeded; proceed to subagent fan-out
 *   1 — a phase failed; see output above for which step and why
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadContract, saveContract } from '../hooks/contract-shared.mjs';

const ROOT = resolve(process.cwd());
const NODE = process.execPath;

const PHASES = [
  {
    contractId: 'research-source-plan',
    label: 'Shortlist research source plan',
    cmd: NODE,
    args: ['scripts/research/research-source-plan.mjs', '--shortlist', '--type', 'all'],
  },
  {
    contractId: 'sentiment-extract',
    label: 'Shortlist sentiment extraction',
    cmd: NODE,
    args: ['scripts/research/sentiment-browser-extract.mjs', '--shortlist', '--profile', 'chrome-host', '--concurrency', '4'],
  },
  {
    contractId: 'construction-check',
    label: 'Shortlist NCDOT construction check',
    cmd: NODE,
    args: ['scripts/research/construction-check.mjs', '--shortlist'],
  },
  {
    contractId: 'deep-research-packet',
    label: 'Deep research packets per shortlisted home',
    cmd: NODE,
    args: ['scripts/research/deep-research-packet.mjs', '--shortlist'],
  },
];

function markPhase(contractId, exitCode, command) {
  const contract = loadContract();
  if (!contract || !Array.isArray(contract.required)) return;
  const target = contract.required.find((r) => r.id === contractId);
  if (!target) return;
  target.attempts = (target.attempts ?? 0) + 1;
  target.last_exit_code = exitCode;
  target.last_command = command;
  target.last_ran_at = new Date().toISOString();
  target.last_source = 'hunt-deep-runner';
  if (exitCode === 0) {
    target.satisfied = true;
    target.failed = false;
    target.last_error = null;
  } else {
    target.satisfied = false;
    target.failed = true;
  }
  saveContract(contract);
}

for (const phase of PHASES) {
  const command = `${phase.cmd} ${phase.args.join(' ')}`;
  console.log(`\n[hunt-deep] ▶ ${phase.label}`);
  console.log(`[hunt-deep]   ${phase.args.join(' ')}`);

  const result = spawnSync(phase.cmd, phase.args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: false,
    windowsHide: false,
  });

  if (result.signal) {
    console.error(`\n[hunt-deep] ✗ "${phase.label}" killed by signal ${result.signal}. Aborting.`);
    markPhase(phase.contractId, 1, command);
    process.exit(1);
  }

  const exitCode = result.status ?? (result.error ? 1 : 0);
  markPhase(phase.contractId, exitCode, command);

  if (exitCode !== 0) {
    const detail = result.error?.message ?? `exit code ${exitCode}`;
    console.error(`\n[hunt-deep] ✗ "${phase.label}" failed (${detail}).`);
    console.error('[hunt-deep]   Fix the issue above, then re-run "npm run hunt:deep".');
    process.exit(1);
  }

  console.log(`[hunt-deep] ✓ ${phase.label} done`);
}

console.log('\n[hunt-deep] ✅ Deep prep complete. Packets written to output/deep-packets/.');
console.log('[hunt-deep]    The main agent should now launch one subagent per shortlisted home,');
console.log('[hunt-deep]    then call "npm run hunt:deep-final" after all workers return.');
process.exit(0);
