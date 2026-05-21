#!/usr/bin/env node

/**
 * school-assignments-fetch.mjs -- Resolve assigned schools for an address via
 * district/listing sources first, then GreatSchools as a fallback, and write
 * them to output/school-metadata/<slug>.json using the schema
 * school-metadata-fetch.mjs already publishes.
 *
 * Why this exists: school-metadata-fetch.mjs parses school NAMES out of an
 * already-written report. If the report doesn't list them yet (which happens
 * for fresh single-home runs), it returns "no-assigned-schools" and the deep
 * brief is forced to fall back on web search. This script closes that loop
 * by hitting the configured district assignment lookup first. GreatSchools is
 * still checked as a fallback/verification source, but it is no longer the
 * bottleneck that decides whether crawl4ai receives school names.
 *
 * Approach:
 *   1. Query the WCPSS public assignment lookup by address when the target is
 *      in Wake County.
 *   2. Fall back to assigned schools already captured from the listing JSON.
 *   3. Fall back to GreatSchools address search when district/listing data is
 *      unavailable.
 *   4. Write the same schema school-metadata-fetch.mjs writes, so the deep
 *      packet builder doesn't care which script populated the file.
 *
 * Hard rule: hosted browser only. No WebFetch / WebSearch.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { parseReport } from './research-utils.mjs';
import { expiresInDays, recordArtifact, subjectKeyForTarget, withSidecarMetadata } from '../shared/knowledge-store.mjs';
import {
  attachHostedBrowser,
  navigateAndSettle,
  safeClose,
} from '../browser/browser-extract-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'school-metadata');
const DEFAULT_PROFILE = 'chrome-host';
const SEARCH_TIMEOUT_MS = 30000;
const SCHOOL_PAGE_TIMEOUT_MS = 25000;
const WCPSS_LOOKUP_BASE = 'https://osageo.wcpss.net/assignment-lookup';

const HELP_TEXT = `Usage:
  node school-assignments-fetch.mjs --address "192 Castle Pond Way" --city "Fuquay-Varina" [--state NC]
  node school-assignments-fetch.mjs reports/001-foo.md
  node school-assignments-fetch.mjs --listing output/listings/<slug>.json

Looks up the assigned elementary / middle / high schools for an address from
WCPSS/listing data first, with GreatSchools fallback, and writes the metadata to
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
      listingSchools: [],
      listingUrl: null,
    };
  }
  if (config.listingPath) {
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
      listingSchools: Array.isArray(listing.assignedSchools) ? listing.assignedSchools : [],
      listingUrl: listing.canonicalUrl || listing.url || null,
    };
  }
  if (config.reportPath) {
    const report = parseReport(ROOT, config.reportPath);
    return {
      address: report.address,
      city: report.city,
      state: report.state || 'NC',
      reportPath: report.relativePath,
      listingSchools: [],
      listingUrl: report.metadata.url || null,
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
  if (text === 'e') return 'elementary';
  if (text === 'm') return 'middle';
  if (text === 'h') return 'high';
  return null;
}

function levelSortValue(level) {
  const normalized = levelFromGrade(level) || level;
  if (normalized === 'elementary') return 0;
  if (normalized === 'middle') return 1;
  if (normalized === 'high') return 2;
  return 9;
}

function buildWcpssSearchTerms(target) {
  const address = String(target.address ?? '').trim();
  const city = String(target.city ?? '').trim();
  return [
    address,
    [address, city].filter(Boolean).join(' '),
    address.replace(/\b(Lane|Ln|Road|Rd|Drive|Dr|Court|Ct|Way|Street|St|Avenue|Ave)\b\.?/gi, '').replace(/\s+/g, ' ').trim(),
  ]
    .map((value) => value.toUpperCase())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'User-Agent': 'Home-Ops local research assistant; school assignment lookup',
    },
  });
  if (!response.ok) {
    return { ok: false, status: response.status, data: null };
  }
  try {
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: response.status, data: null, error: error.message };
  }
}

function normalizeWcpssSchool(row) {
  return {
    name: row.name_long || null,
    level: levelFromGrade(row.grade_level),
    gradeLevel: row.grade_level || null,
    district: 'Wake County Public School System',
    rating: null,
    enrollment: null,
    studentTeacherRatio: null,
    ethnicityDistribution: null,
    url: row.url || null,
    source: 'wcpss',
    assignmentSource: 'wcpss',
    scenario: row.scenario || null,
    calendar: row.calendar || null,
    transportation: row.transportation_type || null,
    capStatus: row.cap_status || null,
    schoolCode: row.school_code || null,
    fetchStatus: 'ok',
  };
}

function normalizeListingSchool(row, listingUrl) {
  const name = row?.name || row?.schoolName || row?.officialName;
  if (!name) return null;
  return {
    name: String(name).trim(),
    level: levelFromGrade(row.level || row.gradeLevel || row.type),
    gradeLevel: row.gradeLevel || row.gradeRange || row.level || null,
    district: row.district || row.schoolDistrict || null,
    rating: row.rating ?? row.greatSchoolsRating ?? null,
    enrollment: row.enrollment ?? null,
    studentTeacherRatio: row.studentTeacherRatio ?? null,
    ethnicityDistribution: row.ethnicityDistribution ?? null,
    url: row.url || listingUrl || null,
    source: row.source || 'listing',
    assignmentSource: row.source || 'listing',
    fetchStatus: 'ok',
  };
}

function dedupeSchools(schools) {
  const seen = new Set();
  const result = [];
  for (const school of schools) {
    if (!school?.name) continue;
    const key = `${String(school.name).trim().toLowerCase()}|${school.level || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(school);
  }
  return result.sort((a, b) => levelSortValue(a.level) - levelSortValue(b.level));
}

async function captureSchoolsFromWcpss(target) {
  if (!/NC/i.test(target.state || 'NC')) {
    return {
      status: 'skipped-non-nc',
      schools: [],
      searchUrl: null,
      assignmentUrl: null,
      candidatesScraped: 0,
      error: null,
    };
  }

  const searchTerms = buildWcpssSearchTerms(target);
  let searchUrl = null;
  let search = null;
  let candidates = [];
  for (const searchText of searchTerms) {
    searchUrl = `${WCPSS_LOOKUP_BASE}/php/functions/search_wcpss_addresses.php?search_text=${encodeURIComponent(searchText)}`;
    search = await fetchJson(searchUrl);
    if (!search.ok) break;
    candidates = Array.isArray(search.data?.features) ? search.data.features : [];
    if (candidates.length > 0) break;
  }

  if (!search?.ok) {
    return {
      status: 'search-failed',
      schools: [],
      searchUrl,
      assignmentUrl: null,
      candidatesScraped: 0,
      error: search.error || `HTTP ${search.status}`,
    };
  }

  const targetAddress = `${target.address} ${target.city}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const picked = candidates.find((feature) => {
    const full = String(feature?.attributes?.full_addr ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return full.includes(targetAddress) || targetAddress.includes(full);
  }) ?? candidates[0];

  const x = Number.parseFloat(picked?.attributes?.x);
  const y = Number.parseFloat(picked?.attributes?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      status: 'no-address-match',
      schools: [],
      searchUrl,
      assignmentUrl: null,
      candidatesScraped: candidates.length,
      error: null,
    };
  }

  const assignmentUrl = `${WCPSS_LOOKUP_BASE}/php/functions/get_assignment_info.php?x=${x}&y=${y}&scenarios=CURRENT,NEXT`;
  const assignment = await fetchJson(assignmentUrl);
  if (!assignment.ok || !Array.isArray(assignment.data)) {
    return {
      status: 'assignment-failed',
      schools: [],
      searchUrl,
      assignmentUrl,
      candidatesScraped: candidates.length,
      error: assignment.error || `HTTP ${assignment.status}`,
    };
  }

  const rows = assignment.data.filter((row) => row.assignment_type === 'BASE');
  const currentRows = rows.filter((row) => row.scenario === 'CURRENT');
  const nextRows = rows.filter((row) => row.scenario === 'NEXT');
  const selectedRows = currentRows.length > 0 ? currentRows : nextRows;
  const schools = dedupeSchools(selectedRows.map(normalizeWcpssSchool));
  return {
    status: schools.length ? 'ok' : 'no-assigned-schools',
    schools,
    searchUrl,
    assignmentUrl,
    candidatesScraped: candidates.length,
    matchedAddress: picked?.attributes?.full_addr ?? null,
    scenarioUsed: currentRows.length > 0 ? 'CURRENT' : (nextRows.length > 0 ? 'NEXT' : null),
    error: null,
  };
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

async function captureSchoolsFromGreatSchools(target, profileName) {
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

function buildListingFallbackCapture(target) {
  const schools = dedupeSchools(
    (target.listingSchools ?? [])
      .map((school) => normalizeListingSchool(school, target.listingUrl))
      .filter(Boolean),
  );
  return {
    status: schools.length ? 'ok' : 'no-assigned-schools',
    schools,
    sourcesChecked: schools.length
      ? [{
        name: 'listing-source-assigned-schools',
        url: target.listingUrl,
        candidatesScraped: schools.length,
      }]
      : [],
    note: schools.length ? null : 'No listing-source assigned schools were available.',
  };
}

async function captureSchools(target, profileName) {
  const sourcesChecked = [];

  const wcpss = await captureSchoolsFromWcpss(target);
  sourcesChecked.push({
    name: 'wcpss-address-lookup',
    url: wcpss.assignmentUrl || wcpss.searchUrl,
    searchUrl: wcpss.searchUrl,
    assignmentUrl: wcpss.assignmentUrl,
    status: wcpss.status,
    candidatesScraped: wcpss.candidatesScraped ?? 0,
    matchedAddress: wcpss.matchedAddress ?? null,
    scenarioUsed: wcpss.scenarioUsed ?? null,
    error: wcpss.error ?? null,
  });
  if (wcpss.schools.length > 0) {
    return {
      status: 'ok',
      schools: wcpss.schools,
      sourcesChecked,
      primarySource: 'wcpss',
      note: null,
    };
  }

  const listing = buildListingFallbackCapture(target);
  sourcesChecked.push(...listing.sourcesChecked);
  if (listing.schools.length > 0) {
    return {
      status: 'ok',
      schools: listing.schools,
      sourcesChecked,
      primarySource: 'listing',
      note: null,
    };
  }

  const greatSchools = await captureSchoolsFromGreatSchools(target, profileName);
  sourcesChecked.push({
    name: 'greatschools-address-search',
    url: greatSchools.searchUrl,
    status: greatSchools.status,
    candidatesScraped: greatSchools.candidatesScraped ?? 0,
    error: greatSchools.error ?? null,
  });
  return {
    ...greatSchools,
    sourcesChecked,
    primarySource: greatSchools.schools.length > 0 ? 'greatschools' : 'none',
  };
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
    sourcesChecked: capture.sourcesChecked ?? [],
    primarySource: capture.primarySource ?? null,
    note: capture.error
      ? `error: ${capture.error}`
      : (capture.status === 'no-assigned-schools'
        ? 'No assigned-school names found from WCPSS, listing data, or GreatSchools.'
        : null),
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  const sourceUrls = [
    ...(payload.sourcesChecked ?? []).map((source) => source.url),
    ...(payload.schools ?? []).map((school) => school.url ?? school.sourceUrl),
  ].filter(Boolean);
  const sidecar = withSidecarMetadata(payload, {
    kind: 'school-metadata',
    scope: 'property',
    subject: target,
    subjectKey: subjectKeyForTarget(target),
    expiresAt: expiresInDays(90, payload.generatedAt),
    sourceUrls,
    status: payload.status,
    warnings: payload.note ? [payload.note] : [],
  });
  await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  recordArtifact({
    path: outputPath,
    kind: 'school-metadata',
    scope: 'property',
    subject: target,
    subjectKey: sidecar.subjectKey,
    commandId: sidecar.commandId,
    generatedAt: sidecar.generatedAt,
    expiresAt: sidecar.expiresAt,
    sourceUrls: sidecar.sourceUrls,
    status: sidecar.status,
    warnings: sidecar.warnings,
  });
  return { outputPath, payload: sidecar };
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
