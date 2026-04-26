#!/usr/bin/env node
/**
 * Deep shortlist finalization runner (phases 5–8).
 * Called by the main agent AFTER per-home subagents have returned their
 * deep research findings. Promotes the top 3 finalists, runs the gate,
 * opens the finalist tabs, and renders the briefing PDF.
 *
 * Steps:
 *   5. promote-finalists       — auto-select top-3 from the updated shortlist
 *   6. shortlist-finalist-gate — gate check (validates research completeness)
 *   7. browser:review top3     — replace tabs with finalist top 3
 *   8. briefing-pdf            — render top-3 briefing PDF
 *
 * Prerequisites: hunt:deep (phases 1–4) must have completed and all per-home
 * subagents must have returned before calling this runner.
 *
 * Exit codes:
 *   0 — all finalization phases succeeded
 *   1 — a phase failed; see output above for which step and why
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadContract, saveContract } from '../hooks/contract-shared.mjs';

const ROOT = resolve(process.cwd());
const NODE = process.execPath;

const PHASES = [
  {
    contractId: 'promote-finalists',
    label: 'Auto-promote top-3 from shortlist into Refined Top 3 section',
    cmd: NODE,
    args: ['scripts/research/promote-finalists.mjs'],
  },
  {
    contractId: 'finalist-gate',
    label: 'Shortlist finalist gate',
    cmd: NODE,
    args: ['scripts/research/shortlist-finalist-gate.mjs'],
  },
  {
    contractId: 'review-tabs-top3',
    label: 'Replace browser tabs with top-3 finalists',
    cmd: NODE,
    args: ['scripts/browser/review-tabs.mjs', 'shortlist-top3', '--replace'],
  },
  {
    contractId: 'briefing-pdf',
    label: 'Render top-3 briefing PDF',
    cmd: NODE,
    args: ['scripts/reports/briefing-pdf.mjs'],
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
  target.last_source = 'hunt-deep-final-runner';
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
  console.log(`\n[hunt-deep-final] ▶ ${phase.label}`);
  console.log(`[hunt-deep-final]   ${phase.args.join(' ')}`);

  const result = spawnSync(phase.cmd, phase.args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: false,
    windowsHide: false,
  });

  if (result.signal) {
    console.error(`\n[hunt-deep-final] ✗ "${phase.label}" killed by signal ${result.signal}. Aborting.`);
    markPhase(phase.contractId, 1, command);
    process.exit(1);
  }

  const exitCode = result.status ?? (result.error ? 1 : 0);
  markPhase(phase.contractId, exitCode, command);

  if (exitCode !== 0) {
    const detail = result.error?.message ?? `exit code ${exitCode}`;
    console.error(`\n[hunt-deep-final] ✗ "${phase.label}" failed (${detail}).`);
    if (phase.contractId === 'finalist-gate') {
      console.error('[hunt-deep-final]   Finalist gate blocked promotion. Review the gate output above.');
      console.error('[hunt-deep-final]   Fix research gaps or use --skip-finalist-gate if overriding manually.');
    } else {
      console.error('[hunt-deep-final]   Fix the issue above, then re-run "npm run hunt:deep-final".');
    }
    process.exit(1);
  }

  console.log(`[hunt-deep-final] ✓ ${phase.label} done`);
}

console.log('\n[hunt-deep-final] ✅ Deep finalization complete.');
console.log('[hunt-deep-final]    Briefing PDF rendered. Top-3 tabs are open in hosted Chrome.');
process.exit(0);
