#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';

import {
  ROOT,
  REPORTS_DIR,
  BATCH_DIR as TRACKER_ADDITIONS_DIR,
  MERGED_BATCH_DIR as TRACKER_MERGED_DIR,
  LISTINGS_FILE as LISTINGS_PATH,
  PIPELINE_FILE as PIPELINE_PATH,
  SHORTLIST_PATH,
  SCAN_HISTORY_PATH,
  PROFILE_PATH,
  HOME_OPS_DIR,
  OUTPUT_DIR,
} from '../shared/paths.mjs';

const SCAN_RUNNING_PATH = join(HOME_OPS_DIR, 'scan-running.json');
const SCAN_COMPLETE_PATH = join(HOME_OPS_DIR, 'scan-complete.json');
const ZILLOW_BLOCKED_PATH = join(HOME_OPS_DIR, 'zillow-session-blocked.json');
// Transient output subdirs that can bias repeat runs. Durable learning
// sidecars stay in output/ by default so reset/hunt does not erase local facts.
const OUTPUT_CACHE_SUBDIRS = [
  'briefings',
  'cache',
  'deep-packets',
  'evaluate-packets',
];

const LEARNED_OUTPUT_SUBDIRS = [
  'areas',
  'builder',
  'communities',
  'construction',
  'geocode',
  'hoa',
  'knowledge',
  'listings',
  'permits',
  'school-metadata',
  'sentiment',
  'utilities',
];

const LEARNED_OUTPUT_FILES = [
  'county-sources.json',
  'development-sources.json',
  'state-sources.json',
  'utility-sources.json',
];

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
  node reset-search-state.mjs --purge-knowledge

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

Also clears (research caches that bias re-runs):
  - output/briefings/, output/cache/
  - output/deep-packets/, output/evaluate-packets/

Preserves:
  - buyer-profile.md
  - config/profile.yml
  - modes/_profile.md
  - portals.yml
  - output/areas/, output/knowledge/
  - output/geocode/, output/permits/, output/school-metadata/
  - output/sentiment/, output/construction/, output/communities/
  - output/utilities/, output/listings/, output/builder/, output/hoa/
  - output/*-sources.json source inventories
  - output/browser-sessions/
  - batch/logs/

Use --purge-knowledge to also delete learned output sidecars and source
inventories. Browser sessions are still preserved.
`;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    purgeKnowledge: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--purge-knowledge') {
      options.purgeKnowledge = true;
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

function extractShortlistReportPaths(shortlistPath) {
  if (!existsSync(shortlistPath)) return new Set();
  try {
    const content = readFileSync(shortlistPath, 'utf8');
    const paths = new Set();
    const pattern = /\[.*?\]\((reports\/[^)]+\.md)\)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      paths.add(join(ROOT, match[1]));
    }
    return paths;
  } catch {
    return new Set();
  }
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

  const allReportFiles = listResettableFiles(REPORTS_DIR, () => true);
  const trackerAdditionFiles = listResettableFiles(TRACKER_ADDITIONS_DIR, (name) => name.endsWith('.tsv'));
  const trackerMergedFiles = listResettableFiles(TRACKER_MERGED_DIR, (name) => name.endsWith('.tsv'));
  const resetPolicy = loadResetPolicy();

  const preservedReportPaths = resetPolicy.preserveShortlistOnReset
    ? extractShortlistReportPaths(SHORTLIST_PATH)
    : new Set();
  const reportFiles = allReportFiles.filter((f) => !preservedReportPaths.has(f));
  const preservedReportCount = allReportFiles.length - reportFiles.length;

  const outputCacheFiles = OUTPUT_CACHE_SUBDIRS.flatMap((sub) =>
    listResettableFiles(join(OUTPUT_DIR, sub), () => true),
  );
  const learnedOutputFiles = options.purgeKnowledge
    ? [
        ...LEARNED_OUTPUT_SUBDIRS.flatMap((sub) => listResettableFiles(join(OUTPUT_DIR, sub), () => true)),
        ...LEARNED_OUTPUT_FILES.flatMap((name) => listResettableFiles(OUTPUT_DIR, (entry) => entry === name)),
      ]
    : [];

  console.log(`Reports to remove: ${reportFiles.length}${preservedReportCount > 0 ? ` (${preservedReportCount} preserved with shortlist)` : ''}`);
  console.log(`Tracker TSVs to remove: ${trackerAdditionFiles.length + trackerMergedFiles.length}`);
  console.log(`Transient output files to remove: ${outputCacheFiles.length}`);
  console.log(options.purgeKnowledge
    ? `Learned output files to purge: ${learnedOutputFiles.length}`
    : 'Learned output directories preserved: yes (use --purge-knowledge to delete them)');
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

  for (const filePath of [...reportFiles, ...trackerAdditionFiles, ...trackerMergedFiles, ...outputCacheFiles, ...learnedOutputFiles]) {
    rmSync(filePath, { force: true, recursive: true });
  }

  writeFileSync(LISTINGS_PATH, LISTINGS_TEMPLATE, 'utf8');
  writeFileSync(PIPELINE_PATH, PIPELINE_TEMPLATE, 'utf8');
  if (!resetPolicy.preserveShortlistOnReset) {
    writeFileSync(SHORTLIST_PATH, SHORTLIST_TEMPLATE, 'utf8');
  }
  writeFileSync(SCAN_HISTORY_PATH, HISTORY_HEADER, 'utf8');

  // Clear scan flag files so verify-pipeline-write starts clean after reset
  rmSync(SCAN_RUNNING_PATH, { force: true });
  rmSync(SCAN_COMPLETE_PATH, { force: true });
  rmSync(ZILLOW_BLOCKED_PATH, { force: true });

  if (options.purgeKnowledge) {
    console.log('\nReset complete. Buyer profiles, portal config, and browser sessions were preserved.');
    console.log('Learned output data was purged because --purge-knowledge was provided.');
  } else {
    console.log('\nReset complete. Buyer profiles, portal config, learned output data, and browser sessions were preserved.');
  }
  if (resetPolicy.preserveShortlistOnReset) {
    console.log('Shortlist preserved via config/profile.yml workflow.shortlist.preserve_on_reset=true.');
  }
}

main();
