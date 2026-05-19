#!/usr/bin/env node

/**
 * utility-options-check.mjs -- Capture planning estimates for electric,
 * water/sewer, natural gas, and internet provider options for deep reports.
 *
 * The command writes one JSON sidecar per home under output/utilities/{slug}.json.
 * It uses structured local rate fixtures where available, public/geocoded
 * provider signals where reachable, and explicit blocked/unconfirmed statuses
 * anywhere address-gated provider data cannot be verified.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { ensureGeocode } from './geocode.mjs';
import { loadResearchConfig, parseReport, parseShortlist } from './research-utils.mjs';
import { buildUtilityOptionsRecord } from './utility-options-core.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'utilities');

const HELP_TEXT = `Usage:
  node utility-options-check.mjs reports/001-foo.md
  node utility-options-check.mjs --shortlist
  node utility-options-check.mjs --top3

Writes output/utilities/{address-city-state}.json with estimated monthly
electric, water/sewer, natural-gas, and internet provider options for deep PDFs.
Availability remains unconfirmed unless an official or provider-reported source
supports it; blocked address-gated pages are recorded as gaps.

Options:
  --shortlist    Use the current Top 10 cohort from data/shortlist.md.
  --top3         Use the refined Top 3 from data/shortlist.md.
  --no-network   Skip live geocode/FCC-derived internet lookups.
  --json         Print JSON instead of human-readable text.
  --help         Show this help text.
`;

function parseArgs(argv) {
  const config = {
    shortlist: false,
    top3: false,
    json: false,
    help: false,
    noNetwork: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--no-network') { config.noNetwork = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }

  return config;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'utility-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3
        ? 'No refined top-3 homes found in data/shortlist.md.'
        : 'No populated top-10 homes found in data/shortlist.md.');
    }

    const targets = [];
    for (const row of rows) {
      try {
        targets.push(parseReport(ROOT, row.reportPath));
      } catch (error) {
        if (error.code === 'ENOENT' || String(error.message).includes('ENOENT')) {
          console.warn(`[warn] Skipping shortlist entry - report not found: ${row.reportPath}`);
        } else {
          throw error;
        }
      }
    }

    if (targets.length === 0) {
      throw new Error('No shortlist entries have readable reports. Re-run hunt to generate fresh evaluation reports.');
    }
    return targets;
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist or --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

async function geocodeForUtilities(target, config) {
  if (config.noNetwork) {
    return null;
  }
  try {
    const record = await ensureGeocode(target);
    return record?.status === 'ok' ? record : null;
  } catch (error) {
    return {
      status: 'blocked',
      lat: null,
      lng: null,
      source: 'us-census-geocoder',
      error: String(error?.message ?? error),
    };
  }
}

function printSummary(records) {
  console.log('\nUtilities/provider options\n');
  for (const record of records) {
    const estimate = record.monthlyEstimate ?? {};
    const typical = estimate.typical == null ? 'unknown' : `$${Number(estimate.typical).toFixed(0)}/mo`;
    const providerCounts = Object.fromEntries(
      Object.entries(record.providers ?? {}).map(([kind, providers]) => [kind, providers.length]),
    );
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    console.log(`Estimated core monthly: ${typical} (${estimate.confidence ?? 'low'} confidence)`);
    console.log(`Providers captured: electric ${providerCounts.electric ?? 0}, water/sewer ${providerCounts.waterSewer ?? 0}, gas ${providerCounts.naturalGas ?? 0}, internet ${providerCounts.internet ?? 0}`);
    if (record.warnings?.length) {
      console.log(`Warnings: ${record.warnings.join(' | ')}`);
    }
    console.log('');
  }
}

async function run() {
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

  const targets = resolveTargets(config);
  const researchContext = loadResearchConfig(ROOT);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const records = [];
  for (const target of targets) {
    const geocodeRecord = await geocodeForUtilities(target, config);
    const record = await buildUtilityOptionsRecord(target, researchContext, {
      geocodeRecord,
      skipNetwork: config.noNetwork,
    });
    const outputPath = buildOutputPath(target);
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push({ ...record, outputPath });
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  printSummary(records);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  run().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

export { buildOutputPath as utilityOptionsOutputPath, parseArgs as parseUtilityOptionsArgs };
