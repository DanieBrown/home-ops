#!/usr/bin/env node

/**
 * school-assignments-fetch.mjs -- Resolve assigned schools for an address via
 * the hosted Chrome session and write them to output/school-metadata/<slug>.json
 * using the schema school-metadata-fetch.mjs already publishes.
 *
 * Why this exists: school-metadata-fetch.mjs parses school NAMES out of an
 * already-written report. If the report doesn't list them yet (which happens
 * for fresh single-home runs), it returns "no-assigned-schools" and the deep
 * brief is forced to fall back on web search. This script closes that loop
 * by hitting GreatSchools directly with the address.
 *
 * Approach:
 *   1. Open https://www.greatschools.org/search/search.page?... with the
 *      address as locationLabel (the URL pattern research-source-plan already
 *      builds for the school source plan).
 *   2. Wait for the assigned-schools panel to render.
 *   3. page.evaluate() to extract elementary / middle / high school names,
 *      ratings, and link URLs.
 *   4. For each school link, navigate and capture rating + enrollment +
 *      student/teacher ratio + ethnicity distribution.
 *   5. Write the same schema school-metadata-fetch.mjs writes, so the deep
 *      packet builder doesn't care which script populated the file.
 *
 * Hard rule: hosted browser only. No WebFetch / WebSearch.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { parseReport } from './research-utils.mjs';
import {
  attachHostedBrowser,
  navigateAndSettle,
  safeClose,
} from '../browser/browser-extract-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'school-metadata');
const DEFAULT_PROFILE = 'chrome-host';
const SEARCH_TIMEOUT_MS = 30000;
const SCHOOL_PAGE_TIMEOUT_MS = 25000;

const HELP_TEXT = `Usage:
  node school-assignments-fetch.mjs --address "192 Castle Pond Way" --city "Fuquay-Varina" [--state NC]
  node school-assignments-fetch.mjs reports/001-foo.md
  node school-assignments-fetch.mjs --listing output/listings/<slug>.json

Looks up the assigned elementary / middle / high schools for an address on
GreatSchools via the hosted Chrome session and writes the metadata to
output/school-metadata/<slug>.json. Used by deep-single-runner.mjs as the
address-driven fallback when the eval report doesn't yet list schools.

Options:
  --address <value>   Manual target address.
  --city <value>      Manual target city.
  --state <value>     Manual target state. Defaults to NC.
  --listing <path>    Read address/city/state from an extract-listing-details JSON.
  --profile <name>    Hosted browser profile. Defaults to chrome-host.
  --json              Print JSON to stdout instead of the human summary.
  --help              Show this help text.
`;

function parseArgs(argv) {
  const config = {
    address: '',
    city: '',
    state: 'NC',
    listingPath: '',
    reportPath: '',
    profileName: DEFAULT_PROFILE,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--address') { config.address = argv[++i] ?? ''; continue; }
    if (arg === '--city') { config.city = argv[++i] ?? ''; continue; }
    if (arg === '--state') { config.state = argv[++i] ?? 'NC'; continue; }
    if (arg === '--listing') { config.listingPath = argv[++i] ?? ''; continue; }
    if (arg === '--profile') { config.profileName = argv[++i] ?? DEFAULT_PROFILE; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (!config.reportPath) {
      config.reportPath = arg;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }
  return config;
}

async function resolveTarget(config) {
  if (config.address && config.city) {
    return {
      address: config.address.trim(),
      city: config.city.trim(),
      state: (config.state || 'NC').trim(),
      reportPath: null,
    };
  }
  if (config.listingPath) {
    const { readFile } = await import('fs/promises');
    const raw = await readFile(config.listingPath, 'utf8');
    const listing = JSON.parse(raw);
    if (!listing.address || !listing.city) {
      throw new Error(`Listing JSON ${config.listingPath} is missing address or city.`);
    }
    return {
      address: String(listing.address).trim(),
      city: String(listing.city).trim(),
      state: String(listing.state || 'NC').trim(),
      reportPath: null,
    };
  }
  if (config.reportPath) {
    const report = parseReport(ROOT, config.reportPath);
    return {
      address: report.address,
      city: report.city,
      state: report.state || 'NC',
      reportPath: report.relativePath,
    };
  }
  throw new Error('Provide either --address + --city, --listing <json>, or a report path positional argument.');
}

function buildSearchUrl(target) {
  const locationLabel = `${target.address} ${target.city} ${target.state} USA`;
  const params = new URLSearchParams({
    city: target.city,
    locationLabel,
    state: target.state,
  });
  params.append('st[]', 'public');
  return `https://www.greatschools.org/search/search.page?${params.toString()}`;
}

function buildSlug(target) {
  return slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'school-target';
}

function buildOutputPath(target) {
  return join(OUTPUT_DIR, `${buildSlug(target)}.json`);
}

function levelFromGrade(value) {
  const text = String(value ?? '').toLowerCase();
  if (/elementary|primary|kindergarten|k-?5|k-?4|prek/.test(text)) return 'elementary';
  if (/middle|junior|6-?8|7-?8/.test(text)) return 'middle';
  if (/high|senior|9-?12|10-?12/.test(text)) return 'high';
  return null;
}

async function scrapeAssignedList(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    // GreatSchools renders assigned schools in a "Schools serving this address"
    // panel. We grab any /school/ links that have a rating chip nearby.
    const candidates = [];
    const seen = new Set();
    const links = Array.from(document.querySelectorAll('a[href*="/school/"]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = link.closest('[class*="School"], [class*="school"], li, article, section, div');
      const cardText = norm(card?.innerText || link.innerText || '');
      const ratingMatch = cardText.match(/(\d+)\s*\/\s*10/);
      const gradeMatch = cardText.match(/(?:Grades?|Levels?)\s*[:\-]?\s*([A-Za-z0-9\s\-–—,]+)/i);
      const enrollmentMatch = cardText.match(/Enrollment\s*[:\-]?\s*([0-9,]+)/i);
      const ratioMatch = cardText.match(/Student[\/-]\s*Teacher\s*Ratio\s*[:\-]?\s*([0-9]+\s*[:\/]\s*[0-9]+)/i);
      candidates.push({
        name: norm(link.innerText || link.textContent || ''),
        href,
        ratingRaw: ratingMatch ? ratingMatch[1] : null,
        gradeRange: gradeMatch ? norm(gradeMatch[1]) : null,
        enrollment: enrollmentMatch ? enrollmentMatch[1].replace(/,/g, '') : null,
        studentTeacherRatio: ratioMatch ? norm(ratioMatch[1]) : null,
      });
    }
    return candidates;
  }).catch(() => []);
}

function pickLevels(candidates) {
  const result = {
    elementary: null,
    middle: null,
    high: null,
  };
  for (const candidate of candidates) {
    if (!candidate.name || !candidate.href) continue;
    const level = levelFromGrade(candidate.gradeRange) || levelFromGrade(candidate.name);
    if (!level) continue;
    if (!result[level]) {
      result[level] = candidate;
      result[level].level = level;
    }
  }
  return result;
}

async function scrapeSchoolDetails(context, school) {
  const targetUrl = school.href.startsWith('http')
    ? school.href
    : `https://www.greatschools.org${school.href}`;
  const { page } = await navigateAndSettle(context, targetUrl, {
    navigationTimeoutMs: SCHOOL_PAGE_TIMEOUT_MS,
    settleMs: 1500,
  });
  if (!page) {
    return { ...school, url: targetUrl, fetchStatus: 'navigation-failed' };
  }
  try {
    const detail = await page.evaluate(() => {
      const norm = (value) => String(value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      const bodyText = norm(document.body?.innerText || '');
      const ratingMatch = bodyText.match(/(\d+)\s*\/\s*10/);
      const enrollmentMatch = bodyText.match(/Total\s+enrollment\s*[:\-]?\s*([0-9,]+)|Enrollment\s*[:\-]?\s*([0-9,]+)/i);
      const ratioMatch = bodyText.match(/Student[\/-]\s*Teacher\s*Ratio\s*[:\-]?\s*([0-9]+\s*[:\/]\s*[0-9]+)/i);
      const districtMatch = bodyText.match(/(?:District|School District)\s*[:\-]?\s*([A-Z][^|\n]{2,80})/);
      const ethnicityRaw = bodyText.match(/Ethnicity[\s\S]{0,400}/i)?.[0] || '';
      const ethnicity = {};
      const ethRegex = /(White|Black|African\s+American|Asian|Hispanic|Latino|Two\s+or\s+more\s+races|Native\s+American|Pacific\s+Islander)\s*[:\-]?\s*(\d+)\s*%/gi;
      let m;
      while ((m = ethRegex.exec(ethnicityRaw)) !== null) {
        ethnicity[m[1]] = Number(m[2]);
      }
      return {
        rating: ratingMatch ? Number(ratingMatch[1]) : null,
        enrollment: enrollmentMatch ? Number((enrollmentMatch[1] || enrollmentMatch[2]).replace(/,/g, '')) : null,
        studentTeacherRatio: ratioMatch ? ratioMatch[1].replace(/\s+/g, '') : null,
        district: districtMatch ? districtMatch[1].trim() : null,
        ethnicity: Object.keys(ethnicity).length ? ethnicity : null,
      };
    }).catch(() => ({}));
    return {
      ...school,
      url: targetUrl,
      ...detail,
      fetchStatus: 'ok',
    };
  } finally {
    await safeClose({ page });
  }
}

async function captureSchools(target, profileName) {
  const attached = await attachHostedBrowser(ROOT, profileName);
  const { browser, context } = attached;
  try {
    const searchUrl = buildSearchUrl(target);
    const { page, error } = await navigateAndSettle(context, searchUrl, {
      navigationTimeoutMs: SEARCH_TIMEOUT_MS,
      settleMs: 2500,
    });
    if (!page) {
      return {
        status: 'search-navigation-failed',
        error: error?.message || 'unknown',
        schools: [],
        searchUrl,
      };
    }
    let candidates = [];
    try {
      await page.waitForSelector('a[href*="/school/"]', { timeout: 10000 }).catch(() => null);
      candidates = await scrapeAssignedList(page);
    } finally {
      await safeClose({ page });
    }

    const picks = pickLevels(candidates);
    const ordered = ['elementary', 'middle', 'high']
      .map((level) => picks[level])
      .filter(Boolean);

    const schools = [];
    for (const school of ordered) {
      const detail = await scrapeSchoolDetails(context, school);
      schools.push({
        name: detail.name,
        level: detail.level,
        gradeLevel: detail.gradeRange || null,
        district: detail.district || null,
        rating: detail.rating ?? (detail.ratingRaw ? Number(detail.ratingRaw) : null),
        enrollment: detail.enrollment ?? (detail.enrollment === undefined ? null : detail.enrollment),
        studentTeacherRatio: detail.studentTeacherRatio || null,
        ethnicityDistribution: detail.ethnicity || null,
        url: detail.url,
        source: 'greatschools',
        fetchStatus: detail.fetchStatus || 'unknown',
      });
    }

    return {
      status: schools.length ? 'ok' : 'no-assigned-schools',
      schools,
      searchUrl,
      candidatesScraped: candidates.length,
    };
  } finally {
    await safeClose({ browser });
  }
}

async function writeMetadata(target, capture) {
  const outputPath = buildOutputPath(target);
  const payload = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.reportPath,
    status: capture.status,
    schools: capture.schools,
    sourcesChecked: [
      {
        name: 'greatschools',
        url: capture.searchUrl,
        candidatesScraped: capture.candidatesScraped ?? 0,
      },
    ],
    note: capture.error
      ? `error: ${capture.error}`
      : (capture.status === 'no-assigned-schools'
        ? 'No assigned-school links found on the GreatSchools search page.'
        : null),
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { outputPath, payload };
}

function printSummary(target, capture, outputPath) {
  console.log('\nSchool assignments capture\n');
  console.log(`${target.address}, ${target.city}, ${target.state}`);
  console.log(`Status: ${capture.status} | Schools captured: ${capture.schools.length}`);
  for (const school of capture.schools) {
    const rating = school.rating ?? '--';
    const enrollment = school.enrollment ?? '--';
    console.log(`  - [${school.level || '?'}] ${school.name} (rating ${rating}/10, enrollment ${enrollment})`);
  }
  console.log(`\nWrote ${outputPath}`);
}

async function main() {
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

  const target = await resolveTarget(config);
  const capture = await captureSchools(target, config.profileName);
  const { outputPath, payload } = await writeMetadata(target, capture);

  if (config.json) {
    console.log(JSON.stringify({ outputPath, payload }, null, 2));
    return;
  }
  printSummary(target, capture, outputPath);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
