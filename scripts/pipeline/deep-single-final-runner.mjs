#!/usr/bin/env node
/**
 * Deep single-home post-eval runner.
 *
 * Runs the rest of the deterministic data-capture chain against the canonical
 * eval report the main agent just wrote. Mirrors hunt-deep-runner for the
 * batch flow but with single-home script invocations (positional report path
 * instead of --shortlist).
 *
 * Steps:
 *   1. research-source-plan       — concrete lookup plan from portals.yml
 *   2. community-lookup           — mapdevelopers community resolution
 *   3. sentiment-browser-extract  — Facebook/Nextdoor (login-walled)
 *   4. sentiment-public-extract   — Google Maps (traffic_commute source)
 *   5. construction-check         — NCDOT projects
 *   6. county-permits-check       — county GIS spatial query
 *   7. school-metadata-fetch      — Niche.com / GreatSchools details
 *   8. builder-check              — builder reputation lookup
 *   9. deep-research-packet       — assemble single-home packet
 *
 * After this runner exits 0, the main agent should:
 *   - Launch the 3 axis agents (Sentiment, Risk & Builder, Schools)
 *   - Update the same canonical reports/{N}-{slug}-{date}.md with the deep findings
 *   - Run briefing-pdf.mjs --report <canonical-report>
 *   - Run review-tabs.mjs urls <listing-url> --replace
 *   - Open the briefing PDF tab last so it survives the tab replacement
 *
 * Final hosted-Chrome state: exactly 2 tabs (listing URL + briefing PDF).
 *
 * Exit codes:
 *   0 — all phases succeeded; proceed to axis agents + brief + PDF
 *   1 — a phase failed; see output above
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from '../shared/paths.mjs';
import { loadContract, saveContract } from '../hooks/contract-shared.mjs';

const NODE = process.execPath;

const HELP_TEXT = `Usage:
  node deep-single-final-runner.mjs --report reports/{N}-{slug}-{date}.md [--profile chrome-host]

Post-evaluation phase of the single-home deep flow. Runs the source plan,
community lookup, sentiment, construction, permits, school metadata, builder
check, and deep-research-packet scripts against the canonical eval report
the main agent just wrote.

Options:
  --report <path>    Path to the canonical eval report just written (required).
  --profile <name>   Hosted browser profile. Defaults to chrome-host.
  --help             Show this help text.
`;

function parseArgs(argv) {
  const config = { reportPath: '', profileName: 'chrome-host', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--report') { config.reportPath = argv[++i] ?? ''; continue; }
    if (arg === '--profile') { config.profileName = argv[++i] ?? 'chrome-host'; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (!config.reportPath) {
      config.reportPath = arg;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }
  return config;
}

function markPhase(contractId, exitCode, command) {
  const contract = loadContract();
  if (!contract || !Array.isArray(contract.required)) return;
  const target = contract.required.find((r) => r.id === contractId);
  if (!target) return;
  target.attempts = (target.attempts ?? 0) + 1;
  target.last_exit_code = exitCode;
  target.last_command = command;
  target.last_ran_at = new Date().toISOString();
  target.last_source = 'deep-single-final-runner';
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

function runPhase(phase) {
  const command = `${phase.cmd} ${phase.args.join(' ')}`;
  console.log(`\n[deep-single-final] ▶ ${phase.label}`);
  console.log(`[deep-single-final]   ${phase.args.join(' ')}`);
  const result = spawnSync(phase.cmd, phase.args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: false,
    windowsHide: false,
  });
  if (result.signal) {
    console.error(`\n[deep-single-final] ✗ "${phase.label}" killed by signal ${result.signal}.`);
    markPhase(phase.contractId, 1, command);
    return 1;
  }
  const exitCode = result.status ?? (result.error ? 1 : 0);
  markPhase(phase.contractId, exitCode, command);
  if (exitCode !== 0) {
    const detail = result.error?.message ?? `exit code ${exitCode}`;
    console.error(`\n[deep-single-final] ⚠ "${phase.label}" exited ${detail} — continuing so partial sidecars still land.`);
    return exitCode;
  }
  console.log(`[deep-single-final] ✓ ${phase.label} done`);
  return 0;
}

function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }
  if (config.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (!config.reportPath) {
    console.error('Error: --report is required');
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  const reportArg = config.reportPath;

  const phases = [
    {
      contractId: 'research-source-plan-single',
      label: 'Source plan from portals.yml',
      cmd: NODE,
      args: ['scripts/research/research-source-plan.mjs', reportArg, '--type', 'all'],
    },
    {
      contractId: 'community-lookup-single',
      label: 'Community resolution (mapdevelopers)',
      cmd: NODE,
      args: ['scripts/research/community-lookup.mjs', reportArg, '--profile', config.profileName],
    },
    {
      contractId: 'sentiment-extract-single',
      label: 'Browser sentiment capture (Facebook/Nextdoor)',
      cmd: NODE,
      args: ['scripts/research/sentiment-browser-extract.mjs', reportArg, '--profile', config.profileName],
    },
    {
      contractId: 'sentiment-public-extract-single',
      label: 'Public sentiment capture (Google Maps)',
      cmd: NODE,
      args: ['scripts/research/sentiment-public-extract.mjs', reportArg],
    },
    {
      contractId: 'construction-check-single',
      label: 'NCDOT construction check',
      cmd: NODE,
      args: ['scripts/research/construction-check.mjs', reportArg],
    },
    {
      contractId: 'county-permits-check-single',
      label: 'County permits spatial query',
      cmd: NODE,
      args: ['scripts/research/county-permits-check.mjs', reportArg],
    },
    {
      contractId: 'school-metadata-fetch-single',
      label: 'School metadata details',
      cmd: NODE,
      args: ['scripts/research/school-metadata-fetch.mjs', reportArg, '--profile', config.profileName],
    },
    {
      contractId: 'builder-check-single',
      label: 'Builder reputation lookup',
      cmd: NODE,
      args: ['scripts/research/builder-check.mjs', reportArg],
    },
    {
      contractId: 'deep-research-packet-single',
      label: 'Deep research packet assembly',
      cmd: NODE,
      args: ['scripts/research/deep-research-packet.mjs', reportArg],
    },
  ];

  // Track whether the deep-research-packet (the only hard-required step)
  // succeeded; everything else is recorded but allowed to fail soft so partial
  // sidecars still land.
  let packetExit = 1;
  for (const phase of phases) {
    const exitCode = runPhase(phase);
    if (phase.contractId === 'deep-research-packet-single') {
      packetExit = exitCode;
    }
  }

  console.log('\n[deep-single-final] ✅ Post-eval data capture complete.');
  console.log('[deep-single-final]    Main agent: launch the 3 axis agents (Sentiment / Risk & Builder / Schools),');
  console.log('[deep-single-final]    update the same canonical report with deep findings, then run:');
  console.log('[deep-single-final]      node scripts/reports/briefing-pdf.mjs --report <canonical-report>');
  console.log('[deep-single-final]      node scripts/browser/review-tabs.mjs urls <listing-url> --replace');
  console.log('[deep-single-final]    Open the PDF tab last so it survives the --replace.');

  process.exit(packetExit === 0 ? 0 : 1);
}

main();
