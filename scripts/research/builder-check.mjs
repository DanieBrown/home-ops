#!/usr/bin/env node

/**
 * builder-check.mjs -- Detect the home's builder from report text and look
 * up their quality reputation on Avid Ratings and Eliant. Writes one record
 * per home to output/builder/{slug}.json so the Risk & Builder Quality axis
 * agent can include builder context in the deep brief and briefing PDF.
 *
 * If no builder is detected from the report text, writes status:
 * "no-builder-detected" and exits cleanly without making any HTTP requests.
 * Absent or unreachable review sites degrade to status: "not-found" so
 * downstream agents can reason about coverage gaps.
 *
 * Avid Ratings and Eliant are public sites -- no login or hosted browser
 * session is required.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import {
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'builder');
const DEFAULT_TIMEOUT_MS = 20000;

// Well-known builder brands, ordered longest-first to prefer the more specific
// match (e.g. "Smith Douglas Homes" before "Smith Douglas").
const KNOWN_BUILDERS = [
  'Smith Douglas Homes',
  'David Weekley Homes',
  'Stanley Martin Homes',
  'Taylor Morrison',
  'Century Communities',
  'Caviness & Cates',
  'Toll Brothers',
  'Meritage Homes',
  'Beazer Homes',
  'Ashton Woods',
  'Eastwood Homes',
  'Essex Homes',
  'Chesmar Homes',
  'True Homes',
  'Epcon Communities',
  'Dan Ryan Builders',
  'D.R. Horton',
  'DR Horton',
  'Ryan Homes',
  'Pulte Homes',
  'PulteGroup',
  'KB Homes',
  'KB Home',
  'Meritage',
  'Lennar',
  'NVHomes',
  'NVR',
  'Centex',
  'Del Webb',
  'DiVosta',
  'Beazer',
  'Chesmar',
  'Pulte',
  'Epcon',
  'Smith Douglas',
  'David Weekley',
  'Stanley Martin',
  'Dan Ryan',
  'M/I Homes',
  'MI Homes',
];

// Canonical name for display (normalises dot-notation variants).
const BUILDER_CANONICAL = {
  'D.R. Horton': 'DR Horton',
  'NVHomes': 'NVR',
  'MI Homes': 'M/I Homes',
  'Pulte Homes': 'Pulte',
  'PulteGroup': 'Pulte',
};

const HELP_TEXT = `Usage:
  node builder-check.mjs reports/001-foo.md
  node builder-check.mjs --shortlist
  node builder-check.mjs --top3
  node builder-check.mjs --address "200 Meadowcrest Pl" --city "Holly Springs"

Detects the home's builder from report text and looks up their quality
reputation on Avid Ratings and Eliant. Writes output/builder/{slug}.json
for each target.

Options:
  --shortlist       Use the current top-10 cohort from data/shortlist.md.
  --top3            Use the current refined top-3 from data/shortlist.md.
  --address <val>   Manual target address.
  --city <val>      Manual target city.
  --state <val>     Manual target state. Defaults to NC.
  --json            Print JSON instead of human-readable text.
  --help            Show this help text.
`;

function parseArgs(argv) {
  const config = {
    shortlist: false, top3: false, json: false, help: false,
    address: '', city: '', state: 'NC', files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--address') { config.address = argv[++i] ?? ''; continue; }
    if (arg === '--city') { config.city = argv[++i] ?? ''; continue; }
    if (arg === '--state') { config.state = argv[++i] ?? 'NC'; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'builder-target';
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
      } catch (err) {
        if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
          console.warn(`[warn] Skipping shortlist entry — report not found: ${row.reportPath}`);
        } else {
          throw err;
        }
      }
    }
    if (targets.length === 0) {
      throw new Error('No shortlist entries have readable reports. Re-run evaluate to generate fresh reports.');
    }
    return targets;
  }

  if (config.address || config.city) {
    return [{
      address: config.address,
      city: config.city,
      state: config.state || 'NC',
      content: '',
      metadata: {},
      sections: {},
      relativePath: '',
    }];
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist or --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function detectBuilder(target) {
  const text = String(target.content ?? '');
  if (!text.trim()) {
    return { builderName: null, detectionSource: null, detectionConfidence: null };
  }

  // 1. Explicit metadata field: **Builder:** Value
  const fieldMatch = text.match(/\*\*Builder:\*\*\s*([A-Za-z0-9'&. -]+?)(?=\n|\r|$)/i)
    || text.match(/^Builder:\s*([A-Za-z0-9'&. -]+?)(?=\n|\r|$)/im);
  if (fieldMatch) {
    const name = fieldMatch[1].trim();
    if (name.length >= 3) {
      return { builderName: BUILDER_CANONICAL[name] ?? name, detectionSource: 'report_field', detectionConfidence: 'high' };
    }
  }

  // 2. Known builder brand scan (word-boundary match, longest name wins)
  for (const builder of KNOWN_BUILDERS) {
    const escaped = builder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      const canonical = BUILDER_CANONICAL[builder] ?? builder;
      return { builderName: canonical, detectionSource: 'known_brand', detectionConfidence: 'high' };
    }
  }

  // 3. Generic "built by NAME" pattern
  const builtByMatch = text.match(/built by ([A-Z][A-Za-z0-9'&. -]{2,48?})(?:[.,\n\r]|$)/i);
  if (builtByMatch) {
    const name = builtByMatch[1].trim().replace(/\s+/g, ' ');
    if (name.length >= 3) {
      return { builderName: name, detectionSource: 'description', detectionConfidence: 'medium' };
    }
  }

  return { builderName: null, detectionSource: null, detectionConfidence: null };
}

function toBuilderSlug(builderName) {
  return String(builderName ?? '')
    .toLowerCase()
    .replace(/\bd\.r\.\s*horton\b/i, 'dr-horton')
    .replace(/\bm\/i\s+homes\b/i, 'mi-homes')
    .replace(/[.\s/&]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'home-ops/builder-check (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, status: response.status, text: '', url };
    const text = await response.text();
    return { ok: true, status: response.status, text, url };
  } catch (error) {
    return { ok: false, status: 0, text: '', url, error: String(error?.message ?? error) };
  }
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function lookupAvidRatings(builderSlug) {
  const url = `https://www.avidratings.com/reviews/${builderSlug}`;
  const page = await fetchText(url);

  if (!page.ok) {
    // Try stripping a common "homes" suffix (e.g. "smith-douglas-homes" → "smith-douglas")
    if (builderSlug.endsWith('-homes')) {
      const shortSlug = builderSlug.slice(0, -6);
      const retryPage = await fetchText(`https://www.avidratings.com/reviews/${shortSlug}`);
      if (retryPage.ok) {
        return parseAvidPage(retryPage.text, retryPage.url);
      }
    }
    return { found: false, url, httpStatus: page.status, error: page.error ?? null };
  }

  return parseAvidPage(page.text, page.url);
}

function parseAvidPage(html, url) {
  const body = stripHtml(html);

  // "4.3 / 5 from 361 surveys" — the canonical Avid Ratings summary line
  const overallMatch = body.match(/(\d+\.\d+)\s*\/\s*5\s+from\s+([\d,]+)\s+survey/i);
  if (!overallMatch) {
    return { found: false, url, reason: 'score-not-found' };
  }

  const overall = parseFloat(overallMatch[1]);
  const reviewCount = parseInt(overallMatch[2].replace(/,/g, ''), 10);

  const categoryPatterns = {
    qualityOfHome: /quality of home[^0-9]*(\d+\.\d+)/i,
    qualityOfExperience: /quality of experience[^0-9]*(\d+\.\d+)/i,
    caringDisplayed: /caring displayed[^0-9]*(\d+\.\d+)/i,
    responsiveness: /(?:overall\s+)?responsiveness[^0-9]*(\d+\.\d+)/i,
  };

  const categories = {};
  for (const [key, pattern] of Object.entries(categoryPatterns)) {
    const match = body.match(pattern);
    if (match) categories[key] = parseFloat(match[1]);
  }

  // Extract short review snippets: look for quoted text or sentences after
  // a star/date pattern that suggest homeowner comments.
  const snippets = [];
  const snippetCandidatePattern = /"([^"]{40,280})"/g;
  let match;
  while (snippets.length < 5 && (match = snippetCandidatePattern.exec(body)) !== null) {
    const candidate = match[1].trim();
    if (candidate.split(' ').length >= 8 && !snippets.includes(candidate)) {
      snippets.push(candidate);
    }
  }

  return {
    found: true,
    overall,
    reviewCount,
    categories: Object.keys(categories).length > 0 ? categories : null,
    snippets: snippets.length > 0 ? snippets : null,
    url,
  };
}

async function lookupEliant(builderSlug) {
  const url = `https://reviews.eliant.com/${builderSlug}`;
  const page = await fetchText(url);

  if (!page.ok) {
    return { found: false, url, httpStatus: page.status, error: page.error ?? null };
  }

  const body = stripHtml(page.text);
  const scoreMatch = body.match(/(\d+\.\d+)\s*\/\s*5/);
  if (!scoreMatch) {
    return { found: false, url, reason: 'score-not-found' };
  }

  const overall = parseFloat(scoreMatch[1]);
  const reviewCountMatch = body.match(/([\d,]+)\s+(?:homeowner\s+)?review/i);
  const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch[1].replace(/,/g, ''), 10) : null;

  return { found: true, overall, reviewCount, url };
}

function buildRecord(target, detection, reviews) {
  const { builderName, detectionSource, detectionConfidence } = detection;

  if (!builderName) {
    return {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath || null,
      builderName: null,
      builderSlug: null,
      detectionSource: null,
      detectionConfidence: null,
      reviews: {},
      status: 'no-builder-detected',
    };
  }

  const builderSlug = toBuilderSlug(builderName);
  const avidFound = reviews.avidRatings?.found === true;
  const eliantFound = reviews.eliant?.found === true;
  const status = (avidFound || eliantFound) ? 'found' : 'not-found';

  return {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath || null,
    builderName,
    builderSlug,
    detectionSource,
    detectionConfidence,
    reviews: {
      ...(avidFound ? {
        avidRatings: {
          overall: reviews.avidRatings.overall,
          reviewCount: reviews.avidRatings.reviewCount,
          categories: reviews.avidRatings.categories ?? null,
          snippets: reviews.avidRatings.snippets ?? null,
          url: reviews.avidRatings.url,
        },
      } : {}),
      ...(eliantFound ? {
        eliant: {
          overall: reviews.eliant.overall,
          reviewCount: reviews.eliant.reviewCount,
          url: reviews.eliant.url,
        },
      } : {}),
    },
    status,
  };
}

function printSummary(records) {
  console.log('\nBuilder check\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    if (record.status === 'no-builder-detected') {
      console.log('  Builder: not detected in report text');
    } else if (record.status === 'not-found') {
      console.log(`  Builder: ${record.builderName} — no review data found on Avid Ratings or Eliant`);
    } else {
      console.log(`  Builder: ${record.builderName} (${record.detectionConfidence} confidence, source: ${record.detectionSource})`);
      const avid = record.reviews.avidRatings;
      const eliant = record.reviews.eliant;
      if (avid) console.log(`  Avid Ratings: ${avid.overall}/5 from ${avid.reviewCount ?? '?'} surveys — QoH: ${avid.categories?.qualityOfHome ?? '?'}`);
      if (eliant) console.log(`  Eliant: ${eliant.overall}/5 from ${eliant.reviewCount ?? '?'} reviews`);
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
  await mkdir(OUTPUT_DIR, { recursive: true });
  const records = [];

  for (const target of targets) {
    const detection = detectBuilder(target);
    let reviews = {};

    if (detection.builderName) {
      const builderSlug = toBuilderSlug(detection.builderName);
      const [avidResult, eliantResult] = await Promise.all([
        lookupAvidRatings(builderSlug),
        lookupEliant(builderSlug),
      ]);
      reviews = { avidRatings: avidResult, eliant: eliantResult };
    }

    const record = buildRecord(target, detection, reviews);
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

export function readBuilderRecord(target) {
  const outputPath = buildOutputPath(target);
  if (!existsSync(outputPath)) return null;
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

export { buildOutputPath as builderRecordPath };
