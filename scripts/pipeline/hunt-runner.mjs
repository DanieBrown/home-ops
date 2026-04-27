#!/usr/bin/env node
/**
 * Sequential runner for hunt phases 1–7.
 *
 * Runs each phase as a child process and waits for it to finish before
 * starting the next one. No AI parallel-call races, no Bash tool timeouts.
 * Updates the contract state after each phase so downstream gate checks work.
 *
 * The AI should:
 *   1. Run `npm.cmd run browser:status` first (confirms session, satisfies gate)
 *   2. Run `npm.cmd run hunt:sequential [--zillow] [--redfin] [--relator] [--homes]`
 *   3. Run `npm.cmd run browser:review -- shortlist-top10 --replace`
 *   4. Run the parallel deep shortlist scripts
 *
 * Exit codes:
 *   0 — all phases succeeded; proceed to browser:review and deep shortlist branch
 *   1 — a phase failed; investigate and re-run after fixing the root cause
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadContract, saveContract } from '../hooks/contract-shared.mjs';

const ROOT = resolve(process.cwd());
const isWin = process.platform === 'win32';
const NPM = isWin ? 'npm.cmd' : 'npm';

const scanFlags = process.argv.slice(2).filter((a) => a.startsWith('--'));

const PHASES = [
  {
    contractId: 'reset:data',
    label: 'Reset generated state',
    cmd: NPM,
    args: ['run', 'reset:data'],
  },
  {
    contractId: 'verify-pipeline',
    label: 'Post-reset pipeline health check',
    cmd: NPM,
    args: ['run', 'verify'],
  },
  {
    contractId: 'scan',
    label: 'Portal scan',
    cmd: NPM,
    args: scanFlags.length > 0 ? ['run', 'scan', '--', ...scanFlags] : ['run', 'scan'],
  },
  {
    contractId: 'verify-pipeline-write',
    label: 'Verify pipeline was updated by scan',
    cmd: NPM,
    args: ['run', 'scan:verify'],
  },
  {
    contractId: 'evaluate-pending',
    label: 'Batch evaluate pending listings',
    cmd: NPM,
    args: ['run', 'evaluate:pending'],
  },
  {
    contractId: 'merge-tracker',
    label: 'Merge staged tracker additions',
    cmd: NPM,
    args: ['run', 'merge'],
  },
  {
    contractId: 'research-audit',
    label: 'Research coverage audit',
    cmd: NPM,
    args: ['run', 'audit:research'],
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
  target.last_source = 'hunt-runner';
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

// Safety check: browser:status must have been confirmed before running phases.
const openingContract = loadContract();
if (openingContract?.mode === 'hunt') {
  const browserStatus = openingContract.required?.find((r) => r.id === 'browser-status');
  if (browserStatus && !browserStatus.satisfied) {
    console.error('[hunt-runner] browser:status has not been confirmed yet.');
    console.error('[hunt-runner] Run "npm.cmd run browser:status" first and confirm CDP is reachable.');
    process.exit(1);
  }
}

for (const phase of PHASES) {
  const command = `${phase.cmd} ${phase.args.join(' ')}`;
  console.log(`\n[hunt-runner] ▶ ${phase.label}`);
  console.log(`[hunt-runner]   ${command}`);

  const result = spawnSync(phase.cmd, phase.args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: isWin,
    windowsHide: false,
  });

  if (result.signal) {
    console.error(`\n[hunt-runner] ✗ "${phase.label}" killed by signal ${result.signal}. Aborting.`);
    markPhase(phase.contractId, 1, command);
    process.exit(1);
  }

  const exitCode = result.status ?? (result.error ? 1 : 0);
  markPhase(phase.contractId, exitCode, command);

  if (exitCode !== 0) {
    const detail = result.error?.message ?? `exit code ${exitCode}`;
    console.error(`\n[hunt-runner] ✗ "${phase.label}" failed (${detail}). Aborting sequential run.`);
    console.error('[hunt-runner]   Fix the issue above, then restart the hunt.');
    process.exit(1);
  }

  console.log(`[hunt-runner] ✓ ${phase.label} done`);
}

console.log('\n[hunt-runner] ✅ All sequential phases complete.');
console.log('[hunt-runner]    Next: browser:review shortlist-top10, then the deep shortlist branch.');
process.exit(0);
