#!/usr/bin/env node

/**
 * sentiment-doctor.mjs -- coverage diagnostic for neighborhood sentiment
 * capture.
 *
 * For a target, prints one line per sentiment source naming: whether the
 * buyer profile opts into it (config/profile.yml), whether portals.yml
 * resolved it into the source plan, whether a capture sidecar recorded it,
 * its status, snippet count, and -- for anything skipped or missing -- the
 * exact reason and the upstream field that caused it. This is the tool a
 * later regression should be caught by in thirty seconds instead of a
 * multi-hour trace through community-lookup, sentiment-browser-extract, and
 * deep-research-packet.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import {
  buildSentimentSourcePlan,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const SENTIMENT_DIR = join(ROOT, 'output', 'sentiment');
const COMMUNITY_DIR = join(ROOT, 'output', 'communities');
const PACKET_DIR = join(ROOT, 'output', 'deep-packets');

const HELP_TEXT = `Usage:
  node sentiment-doctor.mjs reports/003-foo.md
  node sentiment-doctor.mjs --shortlist
  node sentiment-doctor.mjs --top3
  node sentiment-doctor.mjs --address "200 Meadowcrest Pl" --city "Holly Springs" [--state NC]

Prints one coverage line per sentiment source configured for the target:
opted-in in the buyer profile, present in the portals.yml-derived source
plan, attempted by a capture script, its status, snippet count, and -- for
anything skipped or missing -- the exact reason and the upstream field that
caused it. Also flags when the stored deep-research-packet source plan
disagrees with a freshly built one.

Options:
  --shortlist         Use the current populated Top 10 cohort from data/shortlist.md.
  --top3              Use the current refined top 3 from data/shortlist.md.
  --address <value>   Manual target address when no report exists yet.
  --city <value>      Manual target city.
  --state <value>     Manual target state. Defaults to NC.
  --json              Print JSON instead of human-readable text.
  --help              Show this help text.`;

function parseArgs(argv) {
  const config = {
    shortlist: false, top3: false, address: '', city: '', state: 'NC', json: false, help: false, files: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--address') { config.address = argv[index + 1] ?? ''; index += 1; continue; }
    if (arg === '--city') { config.city = argv[index + 1] ?? ''; index += 1; continue; }
    if (arg === '--state') { config.state = argv[index + 1] ?? 'NC'; index += 1; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function buildManualTarget(config) {
  if (!config.address || !config.city) {
    throw new Error('Manual diagnosis requires both --address and --city.');
  }
  return {
    filePath: null,
    relativePath: null,
    address: config.address.trim(),
    city: config.city.trim(),
    state: (config.state || 'NC').trim(),
    title: `${config.address.trim()} - ${config.city.trim()}, ${(config.state || 'NC').trim()}`,
    metadata: { recommendation: '', overallScore: '' },
    scoreNumber: null,
    sections: {
      'Quick Take': '', 'Summary Card': '', 'Hard Requirement Gate': '', 'Property Fit': '',
      'Neighborhood Sentiment': '', 'School Review': '', 'Development and Infrastructure': '',
      'Financial Snapshot': '', 'Risks and Open Questions': '', 'Recommendation': '',
    },
  };
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes found in data/shortlist.md.' : 'No populated top-10 homes found in data/shortlist.md.');
    }
    return rows.map((row) => parseReport(ROOT, row.reportPath));
  }
  if (config.address || config.city) {
    return [buildManualTarget(config)];
  }
  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist, --top3, or --address/--city.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function targetSlug(target) {
  return slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || null;
}

function summarizeQueryResults(queryResults) {
  const statuses = (queryResults ?? []).map((entry) => entry.status);
  const snippetCount = (queryResults ?? []).reduce((sum, entry) => sum + (entry.snippets?.length ?? 0), 0);
  const status = statuses.length === 0
    ? 'no-queries'
    : statuses.includes('ok')
      ? 'captured'
      : statuses[0];
  const reason = (queryResults ?? []).find((entry) => entry.reason)?.reason ?? null;
  return { status, snippetCount, reason };
}

/**
 * Cross-reference buyer intent (profile.yml), the resolved plan
 * (portals.yml), and what a capture run actually recorded (the sidecar), so
 * a source that silently disappears anywhere along that chain is visible in
 * one line instead of requiring a multi-file trace.
 */
export function diagnoseCoverage(target, researchContext, sidecars = null) {
  const slug = targetSlug(target);
  const loaded = sidecars ?? {
    sentimentSidecar: slug ? readJsonIfExists(join(SENTIMENT_DIR, `${slug}.json`)) : null,
    communitySidecar: slug ? readJsonIfExists(join(COMMUNITY_DIR, `${slug}.json`)) : null,
    packetSidecar: slug ? readJsonIfExists(join(PACKET_DIR, `${slug}.json`)) : null,
  };
  return evaluateCoverage(target, researchContext, slug, loaded);
}

/**
 * Pure evaluation core, split out from diagnoseCoverage's file I/O so tests
 * can pass fixture sidecar objects directly instead of touching output/,
 * which is durable user-layer data per DATA_CONTRACT.md.
 */
export function evaluateCoverage(target, researchContext, slug, { sentimentSidecar, communitySidecar, packetSidecar }) {
  const sentimentPlan = buildSentimentSourcePlan(target, researchContext);
  const profileEnabled = researchContext.profile?.research_sources?.sentiment ?? {};
  const capturedByKey = new Map((sentimentSidecar?.sources ?? []).map((entry) => [entry.key, entry]));
  const planByKey = new Map(sentimentPlan.entries.map((entry) => [entry.key, entry]));
  const allKeys = new Set([...Object.keys(profileEnabled), ...planByKey.keys(), ...capturedByKey.keys()]);

  const rows = [...allKeys].sort().map((key) => {
    const enabledInProfile = profileEnabled[key] === true;
    const planEntry = planByKey.get(key) ?? null;
    const inPlan = Boolean(planEntry);
    const captured = capturedByKey.get(key) ?? null;
    const attempted = Boolean(captured);

    if (!attempted) {
      let reason = 'no record found in the sentiment sidecar';
      let upstreamField = null;
      if (!enabledInProfile) {
        reason = 'not opted in at config/profile.yml research_sources.sentiment';
        upstreamField = 'config/profile.yml research_sources.sentiment.' + key;
      } else if (!inPlan) {
        reason = 'opted in, but portals.yml sentiment_sources has no entry (regenerate with node scripts/config/generate-portals.mjs)';
        upstreamField = 'portals.yml sentiment_sources.' + key;
      } else if (!sentimentSidecar) {
        reason = 'no capture has been run for this target yet';
        upstreamField = `output/sentiment/${slug}.json (missing)`;
      } else {
        reason = 'enabled and planned, but the capture script never wrote a record for it -- a source-selection filter is likely dropping it before the capture loop';
        upstreamField = `output/sentiment/${slug}.json sources[] (key "${key}" absent)`;
      }
      return {
        key, enabledInProfile, inPlan, attempted, status: 'not-attempted', snippetCount: 0, reason, upstreamField,
      };
    }

    const { status, snippetCount, reason } = summarizeQueryResults(captured.queryResults);
    let upstreamField = null;
    if (status !== 'captured' && reason) {
      if (/no-community-match/.test(reason) || /community lookup/.test(reason)) {
        upstreamField = communitySidecar
          ? `output/communities/${slug}.json status="${communitySidecar.status}" community=${JSON.stringify(communitySidecar.community)}`
          : `output/communities/${slug}.json (missing)`;
      } else if (/no community URL/.test(reason)) {
        upstreamField = 'sentiment-browser-extract.mjs buildBrowserSourceUrl()';
      }
    }
    return {
      key, enabledInProfile, inPlan, attempted, status, snippetCount, reason, upstreamField,
    };
  });

  const packetEntryCount = packetSidecar?.sourcePlans?.sentiment?.entries?.length ?? null;
  const packetCoverageCount = packetSidecar?.sentimentEvidence?.coverageSummary?.configuredSources ?? null;
  const planEntryCount = sentimentPlan.entries.length;
  const capturedCount = capturedByKey.size;
  const consistency = {
    planEntryCount,
    capturedCount,
    packetEntryCount,
    packetCoverageCount,
    planVsPacketPlanMismatch: packetEntryCount !== null && packetEntryCount !== planEntryCount,
    packetPlanVsCoverageMismatch: packetEntryCount !== null && packetCoverageCount !== null && packetEntryCount !== packetCoverageCount,
  };

  return { target, slug, rows, consistency };
}

function formatRow(row) {
  const bits = [
    row.key.padEnd(12),
    `profile:${row.enabledInProfile ? 'yes' : 'no '}`,
    `plan:${row.inPlan ? 'yes' : 'no '}`,
    `attempted:${row.attempted ? 'yes' : 'no '}`,
    `status:${String(row.status).padEnd(16)}`,
    `snippets:${row.snippetCount}`,
  ];
  let line = `  - ${bits.join(' | ')}`;
  if (row.reason) {
    line += `\n      reason: ${row.reason}`;
  }
  if (row.upstreamField) {
    line += `\n      upstream field: ${row.upstreamField}`;
  }
  return line;
}

function printDiagnosis(result) {
  console.log(`\n${result.target.address} | ${result.target.city}, ${result.target.state}`);
  if (!result.slug) {
    console.log('  Could not derive a slug for this target (missing address/city).');
    return;
  }
  for (const row of result.rows) {
    console.log(formatRow(row));
  }
  const { consistency } = result;
  console.log(`  plan entries: ${consistency.planEntryCount} | captured sources: ${consistency.capturedCount} | packet plan entries: ${consistency.packetEntryCount ?? 'no packet'} | packet coverage: ${consistency.packetCoverageCount ?? 'no packet'}`);
  if (consistency.planVsPacketPlanMismatch) {
    console.log('  MISMATCH: the stored deep-research-packet source plan disagrees with a freshly built plan. Rerun deep-research-packet.mjs.');
  }
  if (consistency.packetPlanVsCoverageMismatch) {
    console.log('  MISMATCH: the packet\'s planned source count disagrees with its captured-evidence coverage count. A source was planned but never captured (or vice versa) -- check the rows above for "attempted:no".');
  }
}

async function main() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const targets = resolveTargets(config);
  const researchContext = loadResearchConfig(ROOT);
  const results = targets.map((target) => diagnoseCoverage(target, researchContext));

  if (config.json) {
    console.log(JSON.stringify({ count: results.length, results }, null, 2));
    return;
  }
  console.log('\nSentiment coverage diagnostic');
  results.forEach(printDiagnosis);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
