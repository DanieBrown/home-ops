#!/usr/bin/env node
/**
 * Deep single-home pre-eval runner.
 *
 * Runs the deterministic Playwright-driven scripts that produce ground-truth
 * listing facts and assigned-school metadata for one URL, so the main agent
 * can write a canonical evaluation report from real data instead of falling
 * back to WebSearch.
 *
 * Steps:
 *   1. extract-listing-details   — scrape Zillow/Redfin/Realtor/Homes via hosted Chrome
 *   2. school-assignments-fetch  — resolve assigned schools via GreatSchools
 *
 * After this runner exits 0, the main agent should:
 *   - Read output/listings/<slug>.json + output/school-metadata/<slug>.json
 *   - Write the canonical evaluate report to reports/{N}-{slug}-{date}.md
 *   - Append a tracker row to data/listings.md
 *   - Then call deep-single-final-runner.mjs --report <path>
 *
 * Exit codes:
 *   0 — both phases succeeded
 *   1 — a phase failed; see output above
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { loadContract, saveContract } from '../hooks/contract-shared.mjs';

const NODE = process.execPath;

const HELP_TEXT = `Usage:
  node deep-single-runner.mjs --url <listing-url> [--profile chrome-host]

Pre-evaluation phase of the single-home deep flow. Drives extract-listing-details
and school-assignments-fetch against the hosted Chrome session so the main
agent has structured listing data + GreatSchools metadata before writing the
canonical evaluate report.

Options:
  --url <url>        Listing URL to scrape (required).
  --profile <name>   Hosted browser profile. Defaults to chrome-host.
  --help             Show this help text.
`;

function parseArgs(argv) {
  const config = { url: '', profileName: 'chrome-host', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--url') { config.url = argv[++i] ?? ''; continue; }
    if (arg === '--profile') { config.profileName = argv[++i] ?? 'chrome-host'; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (!config.url) {
      config.url = arg;
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
  target.last_source = 'deep-single-runner';
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
  console.log(`\n[deep-single] ▶ ${phase.label}`);
  console.log(`[deep-single]   ${phase.args.join(' ')}`);
  const result = spawnSync(phase.cmd, phase.args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: false,
    windowsHide: false,
  });
  if (result.signal) {
    console.error(`\n[deep-single] ✗ "${phase.label}" killed by signal ${result.signal}.`);
    markPhase(phase.contractId, 1, command);
    return 1;
  }
  const exitCode = result.status ?? (result.error ? 1 : 0);
  markPhase(phase.contractId, exitCode, command);
  if (exitCode !== 0) {
    const detail = result.error?.message ?? `exit code ${exitCode}`;
    console.error(`\n[deep-single] ✗ "${phase.label}" failed (${detail}).`);
    return exitCode;
  }
  console.log(`[deep-single] ✓ ${phase.label} done`);
  return 0;
}

function loadListing(slug) {
  const path = join(ROOT, 'output', 'listings', `${slug}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function findListingSlugByUrl(url) {
  try {
    const listingsDir = resolve(ROOT, 'output', 'listings');
    if (!existsSync(listingsDir)) return null;
    const files = readdirSync(listingsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const slug = file.replace(/\.json$/, '');
      const listing = loadListing(slug);
      if (listing && listing.url === url) return slug;
    }
  } catch {
    // ignore
  }
  return null;
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
  if (!config.url) {
    console.error('Error: --url is required');
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  // Phase 1: listing extraction
  const extractPhase = {
    contractId: 'extract-listing-details',
    label: 'Listing facts via Playwright',
    cmd: NODE,
    args: ['scripts/research/extract-listing-details.mjs', '--url', config.url, '--profile', config.profileName],
  };
  if (runPhase(extractPhase) !== 0) {
    console.error('[deep-single]   Fix the listing-extraction failure above, then re-run.');
    process.exit(1);
  }

  // Look up the slug the extractor used so we can reference its output for
  // the school-assignments fetch.
  const slug = findListingSlugByUrl(config.url);
  if (!slug) {
    console.error('[deep-single] ✗ Could not locate output/listings/<slug>.json after extraction. Aborting.');
    process.exit(1);
  }
  const listingPath = `output/listings/${slug}.json`;

  // Phase 2: school assignments
  const schoolsPhase = {
    contractId: 'school-assignments-fetch',
    label: 'Assigned-school capture via GreatSchools',
    cmd: NODE,
    args: ['scripts/research/school-assignments-fetch.mjs', '--listing', listingPath, '--profile', config.profileName],
  };
  if (runPhase(schoolsPhase) !== 0) {
    // Schools failure is not a hard stop — record it but keep going.
    console.warn('[deep-single]   School-assignments fetch failed; the main agent should record the gap in the brief.');
  }

  console.log('\n[deep-single] ✅ Pre-eval phase complete.');
  console.log(`[deep-single]    Listing JSON:  ${listingPath}`);
  console.log(`[deep-single]    School JSON:   output/school-metadata/${slug}.json`);
  console.log('[deep-single]    Main agent: write reports/{N}-{slug}-{date}.md from the listing JSON,');
  console.log('[deep-single]    update data/listings.md, then call deep-single-final-runner.mjs --report <path>.');
  process.exit(0);
}

main();
