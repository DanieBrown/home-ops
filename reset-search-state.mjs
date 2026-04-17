#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER_ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');
const TRACKER_MERGED_DIR = join(TRACKER_ADDITIONS_DIR, 'merged');
const LISTINGS_PATH = join(ROOT, 'data', 'listings.md');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const SHORTLIST_PATH = join(ROOT, 'data', 'shortlist.md');
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');

const HISTORY_HEADER = 'url\tfirst_seen\tplatform\tarea\taddress\tstatus\n';
const LISTINGS_TEMPLATE = [
  '# Listings Tracker',
  '',
  '| # | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes |',
  '|---|------|---------|------|-------|------------|------|-------|--------|--------|-------|',
  '',
].join('\n');
const PIPELINE_TEMPLATE = [
  '## Pending',
  '',
  'Add listing URLs here, one per line. Accepted inputs:',
  '- Direct Zillow, Redfin, or Realtor.com listing URLs',
  '- local:reports/<file>.md for reprocessing an existing report later',
  '',
  'Example:',
  '- https://www.zillow.com/homedetails/123-Main-St-Holly-Springs-NC-27540/12345678_zpid/',
  '- https://www.redfin.com/NC/Apex/123-Main-St-27502/home/123456789',
  '',
  '## Processed',
  '',
].join('\n');
const SHORTLIST_TEMPLATE = [
  '# Review Shortlist',
  '',
  'This file stores the latest top-10 cohort from evaluate or compare and the handoff into deep mode.',
  '',
  '## Latest Top 10 Cohort',
  '',
  '- Cohort ID: not set',
  '- Created: not set',
  '- Source Mode: not set',
  '- Scope: not set',
  '- Trigger: not set',
  '- Top 10 Status: not started',
  '- Deep Batch Status: not started',
  '- Deep Batch Report: none',
  '- Finalist Review Status: not started',
  '',
  '## Top 10 Homes',
  '',
  '| Rank | Tag | Tracker # | Address | City | Score | Status | Report | Notes |',
  '|------|-----|-----------|---------|------|-------|--------|--------|-------|',
  '| 1 | Top 10 - Rank 1 |  |  |  |  |  |  |  |',
  '| 2 | Top 10 - Rank 2 |  |  |  |  |  |  |  |',
  '| 3 | Top 10 - Rank 3 |  |  |  |  |  |  |  |',
  '| 4 | Top 10 - Rank 4 |  |  |  |  |  |  |  |',
  '| 5 | Top 10 - Rank 5 |  |  |  |  |  |  |  |',
  '| 6 | Top 10 - Rank 6 |  |  |  |  |  |  |  |',
  '| 7 | Top 10 - Rank 7 |  |  |  |  |  |  |  |',
  '| 8 | Top 10 - Rank 8 |  |  |  |  |  |  |  |',
  '| 9 | Top 10 - Rank 9 |  |  |  |  |  |  |  |',
  '| 10 | Top 10 - Rank 10 |  |  |  |  |  |  |  |',
  '',
  '## Refined Top 3 After Deep',
  '',
  '| Rank | Address | City | Updated Verdict | Why |',
  '|------|---------|------|-----------------|-----|',
  '| 1 |  |  |  |  |',
  '| 2 |  |  |  |  |',
  '| 3 |  |  |  |  |',
  '',
  '## Notes',
  '',
  '- Evaluate or compare overwrites this file with the latest top-10 cohort.',
  '- Deep mode uses the populated top-10 rows above when the user asks for a batch deep dive on the shortlist.',
  '- After the deep batch, keep only the refined top 3 tabs open in the hosted Chrome window.',
  '',
].join('\n');

const HELP_TEXT = `Usage:
  node reset-search-state.mjs
  node reset-search-state.mjs --dry-run

Resets generated search and evaluation state while preserving buyer profiles,
portal configuration, and browser session data.

Clears:
  - reports/*.md (generated reports only)
  - batch/tracker-additions/*.tsv
  - batch/tracker-additions/merged/*.tsv
  - data/listings.md (back to header only)
  - data/pipeline.md (back to an empty template)
  - data/shortlist.md (back to an empty shortlist template unless workflow.shortlist.preserve_on_reset is true)
  - data/scan-history.tsv (back to header only)

Preserves:
  - buyer-profile.md
  - config/profile.yml
  - modes/_profile.md
  - portals.yml
  - output/browser-sessions/
  - batch/logs/
`;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function listResettableFiles(dirPath, matcher) {
  if (!existsSync(dirPath)) {
    return [];
  }

  return readdirSync(dirPath)
    .filter((name) => name !== '.gitkeep')
    .filter((name) => matcher(name))
    .map((name) => join(dirPath, name));
}

function loadResetPolicy() {
  if (!existsSync(PROFILE_PATH)) {
    return {
      preserveShortlistOnReset: false,
    };
  }

  try {
    const parsed = YAML.parse(readFileSync(PROFILE_PATH, 'utf8')) ?? {};
    return {
      preserveShortlistOnReset: parsed.workflow?.shortlist?.preserve_on_reset === true,
    };
  } catch {
    return {
      preserveShortlistOnReset: false,
    };
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const reportFiles = listResettableFiles(REPORTS_DIR, () => true);
  const trackerAdditionFiles = listResettableFiles(TRACKER_ADDITIONS_DIR, (name) => name.endsWith('.tsv'));
  const trackerMergedFiles = listResettableFiles(TRACKER_MERGED_DIR, (name) => name.endsWith('.tsv'));
  const resetPolicy = loadResetPolicy();

  console.log(`Reports to remove: ${reportFiles.length}`);
  console.log(`Tracker TSVs to remove: ${trackerAdditionFiles.length + trackerMergedFiles.length}`);
  console.log('Files to reset:');
  console.log('- data/listings.md');
  console.log('- data/pipeline.md');
  console.log(resetPolicy.preserveShortlistOnReset
    ? '- data/shortlist.md (preserved by workflow.shortlist.preserve_on_reset=true)'
    : '- data/shortlist.md');
  console.log('- data/scan-history.tsv');

  if (options.dryRun) {
    console.log('\nDry run only. No files were changed.');
    return;
  }

  for (const filePath of [...reportFiles, ...trackerAdditionFiles, ...trackerMergedFiles]) {
    rmSync(filePath, { force: true, recursive: true });
  }

  writeFileSync(LISTINGS_PATH, LISTINGS_TEMPLATE, 'utf8');
  writeFileSync(PIPELINE_PATH, PIPELINE_TEMPLATE, 'utf8');
  if (!resetPolicy.preserveShortlistOnReset) {
    writeFileSync(SHORTLIST_PATH, SHORTLIST_TEMPLATE, 'utf8');
  }
  writeFileSync(SCAN_HISTORY_PATH, HISTORY_HEADER, 'utf8');

  console.log('\nReset complete. Buyer profiles, portal config, and browser sessions were preserved.');
  if (resetPolicy.preserveShortlistOnReset) {
    console.log('Shortlist preserved via config/profile.yml workflow.shortlist.preserve_on_reset=true.');
  }
}

main();