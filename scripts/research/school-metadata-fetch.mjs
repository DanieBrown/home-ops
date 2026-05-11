#!/usr/bin/env node

/**
 * school-metadata-fetch.mjs -- Per-home school metadata capture.
 *
 * For each shortlisted home, reads the assigned school names from the
 * evaluation report and enriches each school through the configured school
 * sources in config/profile.yml. GreatSchools is handled through crawl4ai
 * against its search payload; Niche remains available as a fallback/source
 * when enabled.
 *
 * Output lands at output/school-metadata/{slug}.json with shape:
 *   { generatedAt, address, city, state, status, schools: [...] }
 *
 * Skips with status: "skipped-by-profile" if no school sources are opted in
 * via config/profile.yml.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import {
  extractSchoolNames,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';
import {
  attachHostedBrowser,
  navigateAndSettle,
  safeClose,
} from '../browser/browser-extract-utils.mjs';
import { extractListing } from './extract-listing-details.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'school-metadata');
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PROFILE = 'chrome-host';
const CRAWL4AI_SCRIPT = join(ROOT, 'scripts', 'research', 'python', 'school_metadata_crawl.py');
const GREATSCHOOLS_CRAWL4AI_SCRIPT = join(ROOT, 'scripts', 'research', 'python', 'greatschools_metadata_crawl.py');
const CRAWL4AI_PROFILE_DIR = join(ROOT, 'output', 'crawl4ai-profile');
const CRAWL4AI_TIMEOUT_MS = 45000;
const HOSTED_NICHE_TIMEOUT_MS = 30000;

const NICHE_GRADE_LETTER_MAP = {
  aplus: 'A+', a: 'A', aminus: 'A-',
  bplus: 'B+', b: 'B', bminus: 'B-',
  cplus: 'C+', c: 'C', cminus: 'C-',
  dplus: 'D+', d: 'D', dminus: 'D-',
  f: 'F',
};

const GRADE_PATTERNS = [
  { grade: 'elementary', pattern: /elementary/i },
  { grade: 'middle', pattern: /middle/i },
  { grade: 'high', pattern: /\bhigh\b/i },
];

function inferGradeLevel(name) {
  for (const { grade, pattern } of GRADE_PATTERNS) {
    if (pattern.test(name)) return grade;
  }
  return null;
}

const HELP_TEXT = `Usage:
  node school-metadata-fetch.mjs reports/001-foo.md
  node school-metadata-fetch.mjs --shortlist
  node school-metadata-fetch.mjs --top3

Captures configured school metadata per assigned school for each shortlisted home.

Options:
  --shortlist       Use the current Top 10 cohort.
  --top3            Use the refined Top 3.
  --profile <name>  Hosted browser profile for Niche fallback checks. Defaults to chrome-host.
  --json            Print JSON instead of human-readable text.
  --help            Show this help.`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, profileName: DEFAULT_PROFILE, json: false, help: false, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--profile') { config.profileName = argv[index + 1] ?? DEFAULT_PROFILE; index += 1; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'school-metadata-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes.' : 'No populated top-10 homes.');
    }
    return rows.map((row) => parseReport(ROOT, row.reportPath));
  }
  if (config.files.length === 0) {
    throw new Error('Provide a report path, or use --shortlist / --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function nicheSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build candidate Niche slugs for a school. Niche uses a stable pattern:
 *   {school-name}-{city}-{state}
 * but the school name on Niche sometimes drops the trailing word ("Middle
 * School" -> "middle"). We try the report's name as-is first, then a
 * stripped variant.
 */
function buildNicheUrls(schoolName, city, state) {
  const hasSchoolSuffix = /\bSchool\b/i.test(schoolName);
  const stripped = schoolName.replace(/\bSchool\b/i, '').trim();
  const variants = [schoolName];
  // Strip "School" when present — Niche sometimes drops it for elementary slugs.
  if (stripped && stripped !== schoolName) variants.push(stripped);
  // Append "School" when missing — Niche sometimes requires it for middle/high
  // (e.g. "Holly Grove Middle" 404s; "Holly Grove Middle School" resolves).
  if (!hasSchoolSuffix) variants.push(`${schoolName} School`);
  const stateSlug = String(state || 'NC').toLowerCase();
  const citySlug = nicheSlug(city);
  const seen = new Set();
  const urls = [];
  for (const variant of variants) {
    const slug = `${nicheSlug(variant)}-${citySlug}-${stateSlug}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    urls.push(`https://www.niche.com/k12/${slug}/`);
  }
  return urls;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Niche serves 403 to plain UAs. These are honest browser headers --
        // we identify as a desktop Chrome client and let them throttle if
        // they want to. No evasion or rotation.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, html: '', url: response.url || url };
    }
    return { ok: true, status: response.status, html: await response.text(), url: response.url || url };
  } catch (error) {
    return { ok: false, status: 0, html: '', url, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function buildGreatSchoolsSearchUrl(schoolName, state) {
  const params = new URLSearchParams({
    q: schoolName,
    state: state || 'NC',
  });
  return `https://www.greatschools.org/search/search.page?${params.toString()}`;
}

function normalizeGreatSchoolsName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\bschool\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGreatSchoolsSearchPayload(html) {
  const match = String(html ?? '').match(/gon\.search=(\{[\s\S]*?\});gon\.event_tracker_page_data=/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function pickGreatSchoolsResult(schools, wantedName) {
  const wanted = normalizeGreatSchoolsName(wantedName);
  let best = null;
  for (const school of Array.isArray(schools) ? schools : []) {
    const candidate = normalizeGreatSchoolsName(school?.name);
    if (!candidate) continue;
    let score = 0;
    if (candidate === wanted) {
      score += 100;
    } else if (candidate.includes(wanted) || wanted.includes(candidate)) {
      score += 75;
    }
    const wantedTokens = new Set(wanted.split(/\s+/).filter(Boolean));
    const candidateTokens = new Set(candidate.split(/\s+/).filter(Boolean));
    const union = new Set([...wantedTokens, ...candidateTokens]);
    if (union.size > 0) {
      const overlap = [...wantedTokens].filter((token) => candidateTokens.has(token)).length;
      score += Math.round((25 * overlap) / union.size);
    }
    if (school?.type === 'school') score += 5;
    if (!best || score > best.score) best = { score, school };
  }
  return best?.score >= 40 ? best.school : null;
}

function greatSchoolsProfileUrl(value) {
  const path = String(value ?? '').trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `https://www.greatschools.org${path.startsWith('/') ? '' : '/'}${path}`;
}

function levelFromGreatSchools(value) {
  const text = String(value ?? '').toLowerCase();
  if (text === 'e' || /elementary|primary|kindergarten|k-?5|prek/.test(text)) return 'elementary';
  if (text === 'm' || /middle|junior|6-?8|7-?8/.test(text)) return 'middle';
  if (text === 'h' || /high|senior|9-?12|10-?12/.test(text)) return 'high';
  return null;
}

function camelKey(value) {
  const words = String(value ?? '').match(/[a-zA-Z0-9]+/g) ?? [];
  if (words.length === 0) return '';
  return words[0].charAt(0).toLowerCase() + words[0].slice(1)
    + words.slice(1).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function percentString(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return text.endsWith('%') ? text : `${text}%`;
}

function parseGreatSchoolsRecord(raw, schoolName, searchUrl) {
  const url = greatSchoolsProfileUrl(raw?.links?.profile) || searchUrl;
  const ethnicityDistribution = {};
  let freeReducedLunchPct = null;
  for (const entry of raw?.ethnicityInfo ?? []) {
    const label = String(entry?.label ?? '').trim();
    const percentage = percentString(entry?.percentage);
    if (!label || !percentage) continue;
    if (label.toLowerCase() === 'low-income') {
      freeReducedLunchPct = percentage;
      continue;
    }
    if (label.toLowerCase() === 'all students') continue;
    ethnicityDistribution[label] = percentage;
  }
  const greatSchoolsSubratings = {};
  for (const [label, value] of Object.entries(raw?.subratings ?? {})) {
    const key = camelKey(label.replace(/\s+Rating$/i, ''));
    if (key) greatSchoolsSubratings[key] = value;
  }
  const studentsPerTeacher = Number(raw?.studentsPerTeacher);
  const rating = Number(raw?.rating);
  return {
    name: raw?.name || schoolName,
    gradeLevel: raw?.gradeLevels || levelFromGreatSchools(raw?.levelCode),
    level: levelFromGreatSchools(raw?.levelCode || raw?.gradeLevels),
    district: raw?.districtName ?? null,
    url,
    source: 'greatschools',
    greatSchoolsRating: Number.isFinite(rating) ? rating : null,
    greatSchoolsRatingScale: raw?.ratingScale ?? null,
    nicheGrade: null,
    subGrades: null,
    greatSchoolsSubratings: Object.keys(greatSchoolsSubratings).length > 0 ? greatSchoolsSubratings : null,
    enrollment: Number.isFinite(Number(raw?.enrollment)) ? Number(raw.enrollment) : null,
    studentTeacherRatio: Number.isFinite(studentsPerTeacher) ? `${studentsPerTeacher}:1` : null,
    freeReducedLunchPct,
    percentProficient: { math: null, reading: null },
    averageTeacherSalary: null,
    ethnicityDistribution: Object.keys(ethnicityDistribution).length > 0 ? ethnicityDistribution : null,
    genderDistribution: null,
    stateRating: null,
    captureStatus: url && (Number.isFinite(rating) || raw?.enrollment != null) ? 'captured' : 'parse-failed',
    attemptedUrls: [searchUrl, url].filter((value, index, list) => value && list.indexOf(value) === index),
    finalUrl: url,
    provider: 'fetch-fallback',
  };
}

function decodeJsonString(value) {
  return String(value ?? '').replace(/\\u002F/g, '/').replace(/\\"/g, '"');
}

/**
 * Extract the overall Niche letter grade from the rendered HTML. The page
 * markup looks like: <div class="niche__grade niche__grade--aplus">A+</div>
 * Returns { letter, classKey } or null if not found.
 */
function extractOverallGrade(html) {
  const match = html.match(/overall-grade__niche-grade[\s\S]{0,400}?niche__grade--([a-z]+)/);
  if (!match) return null;
  const classKey = match[1];
  const letter = NICHE_GRADE_LETTER_MAP[classKey] ?? null;
  return letter ? { letter, classKey } : null;
}

/**
 * Pull a fact value by label from the embedded JSON. Niche's blob contains
 * many `"label":"X","tooltip":"Y","value":Z` triples per school. We accept
 * either tooltip or description as the secondary key since both shapes
 * appear in the rendered page.
 */
function extractFactByLabel(html, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `"label":"${escapedLabel}"(?:[^{}]{0,200})"value":(?:"([^"]*)"|([0-9.]+)|(\\{[^{}]+\\})|(null))`,
  );
  const match = html.match(pattern);
  if (!match) return null;
  if (match[1] !== undefined) return decodeJsonString(match[1]);
  if (match[2] !== undefined) return Number(match[2]);
  if (match[3] !== undefined) {
    try { return JSON.parse(match[3]); } catch { return null; }
  }
  return null;
}

function parseDecimalObject(rawObject) {
  if (!rawObject || typeof rawObject !== 'object') return null;
  const result = {};
  for (const [key, value] of Object.entries(rawObject)) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) {
      const pct = Math.round(numeric * 1000) / 10; // one-decimal percent
      result[key] = `${pct}%`;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function asPercent(decimalValue) {
  const numeric = typeof decimalValue === 'number' ? decimalValue : Number(decimalValue);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 1000) / 10;
}

function parseSchoolFromHtml(html, name, sourceUrl) {
  const overallGrade = extractOverallGrade(html);
  const academics = extractFactByLabel(html, 'Academics');
  const teachers = extractFactByLabel(html, 'Teachers');
  const diversity = extractFactByLabel(html, 'Diversity');
  const collegePrep = extractFactByLabel(html, 'College Prep');
  const clubs = extractFactByLabel(html, 'Clubs & Activities');
  const sports = extractFactByLabel(html, 'Sports');
  const healthSafety = extractFactByLabel(html, 'Health & Safety');

  const enrollment = extractFactByLabel(html, 'Students');
  const studentTeacherRaw = extractFactByLabel(html, 'Student-Teacher Ratio');
  const ratio = Number.isFinite(studentTeacherRaw) ? `${studentTeacherRaw}:1` : null;
  const freeReducedRaw = extractFactByLabel(html, 'Free or Reduced Lunch');
  const proficientMath = extractFactByLabel(html, 'Percent Proficient - Math');
  const proficientReading = extractFactByLabel(html, 'Percent Proficient - Reading');
  const teacherSalary = extractFactByLabel(html, 'Average Teacher Salary');
  const grades = extractFactByLabel(html, 'Grades');
  const diversityRaw = extractFactByLabel(html, 'Student Diversity');
  const genderRaw = extractFactByLabel(html, 'Gender');

  const subGrades = {};
  if (Number.isFinite(academics)) subGrades.academics = academics;
  if (Number.isFinite(teachers)) subGrades.teachers = teachers;
  if (Number.isFinite(diversity)) subGrades.diversity = diversity;
  if (Number.isFinite(collegePrep)) subGrades.collegePrep = collegePrep;
  if (Number.isFinite(clubs)) subGrades.clubs = clubs;
  if (Number.isFinite(sports)) subGrades.sports = sports;
  if (Number.isFinite(healthSafety)) subGrades.healthSafety = healthSafety;

  return {
    name,
    gradeLevel: typeof grades === 'string' ? grades : inferGradeLevel(name),
    url: sourceUrl,
    source: 'niche.com',
    nicheGrade: overallGrade,
    subGrades: Object.keys(subGrades).length > 0 ? subGrades : null,
    enrollment: Number.isFinite(enrollment) ? enrollment : null,
    studentTeacherRatio: ratio,
    freeReducedLunchPct: asPercent(freeReducedRaw),
    percentProficient: {
      math: asPercent(proficientMath),
      reading: asPercent(proficientReading),
    },
    averageTeacherSalary: Number.isFinite(teacherSalary) ? teacherSalary : null,
    ethnicityDistribution: parseDecimalObject(diversityRaw),
    genderDistribution: parseDecimalObject(genderRaw),
    // Legacy compatibility -- briefing-pdf old fallback path uses these.
    greatSchoolsRating: null,
    stateRating: null,
    captureStatus: overallGrade ? 'captured' : 'parse-failed',
  };
}

function pythonCandidates() {
  return process.platform === 'win32'
    ? [['py', ['-3']], ['python3', []], ['python', []]]
    : [['python3', []], ['python', []]];
}

function probeCrawl4ai(candidate) {
  const [bin, baseArgs] = candidate;
  const probe = spawnSync(bin, [...baseArgs, '-c', 'import crawl4ai'], { encoding: 'utf8' });
  return probe.status === 0;
}

function detectCrawl4aiInvocation() {
  for (const candidate of pythonCandidates()) {
    const [bin, baseArgs] = candidate;
    const versionProbe = spawnSync(bin, [...baseArgs, '--version'], { encoding: 'utf8' });
    if (versionProbe.status !== 0) continue;
    if (probeCrawl4ai(candidate)) {
      return { bin, baseArgs };
    }
  }
  return null;
}

let crawl4aiState = null;
function getCrawl4aiState() {
  if (crawl4aiState) return crawl4aiState;
  const invocation = detectCrawl4aiInvocation();
  if (!invocation) {
    console.warn('school-metadata-fetch: crawl4ai not importable; falling back to fetch(). Setup: scripts/research/python/README.md');
  }
  crawl4aiState = { invocation, available: Boolean(invocation) };
  return crawl4aiState;
}

function runCrawl4aiSidecar(invocation, name, city, state) {
  return new Promise((resolve) => {
    const child = spawn(invocation.bin, [
      ...invocation.baseArgs,
      CRAWL4AI_SCRIPT,
      '--school', name,
      '--city', city,
      '--state', state,
      '--profile-dir', CRAWL4AI_PROFILE_DIR,
      '--json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, CRAWL4AI_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn-error', error: error.message, stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, reason: 'timeout', stderr });
        return;
      }
      if (code === 2) {
        resolve({ ok: false, reason: 'environment-failure', stderr: stderr.trim() });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, reason: `exit-${code}`, stderr: stderr.trim() });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({ ok: false, reason: 'empty-stdout', stderr: stderr.trim() });
        return;
      }
      try {
        const record = JSON.parse(trimmed);
        resolve({ ok: true, record });
      } catch (error) {
        resolve({ ok: false, reason: 'parse-error', error: error.message, stdout: trimmed });
      }
    });
  });
}

function runGreatSchoolsCrawl4aiSidecar(invocation, name, city, state) {
  return new Promise((resolve) => {
    const child = spawn(invocation.bin, [
      ...invocation.baseArgs,
      GREATSCHOOLS_CRAWL4AI_SCRIPT,
      '--school', name,
      '--city', city,
      '--state', state,
      '--profile-dir', CRAWL4AI_PROFILE_DIR,
      '--json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, CRAWL4AI_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn-error', error: error.message, stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, reason: 'timeout', stderr });
        return;
      }
      if (code === 2) {
        resolve({ ok: false, reason: 'environment-failure', stderr: stderr.trim() });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, reason: `exit-${code}`, stderr: stderr.trim() });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({ ok: false, reason: 'empty-stdout', stderr: stderr.trim() });
        return;
      }
      try {
        const record = JSON.parse(trimmed);
        resolve({ ok: true, record });
      } catch (error) {
        resolve({ ok: false, reason: 'parse-error', error: error.message, stdout: trimmed });
      }
    });
  });
}

function emptyCaptureRecord(name, urls, captureStatus, provider, source = 'niche.com') {
  return {
    name,
    gradeLevel: inferGradeLevel(name),
    url: urls[0] ?? null,
    source,
    nicheGrade: null,
    subGrades: null,
    enrollment: null,
    studentTeacherRatio: null,
    freeReducedLunchPct: null,
    percentProficient: { math: null, reading: null },
    averageTeacherSalary: null,
    ethnicityDistribution: null,
    genderDistribution: null,
    greatSchoolsRating: null,
    stateRating: null,
    captureStatus,
    attemptedUrls: urls,
    provider,
  };
}

async function captureSchoolViaCrawl4ai(name, city, state, invocation) {
  const urls = buildNicheUrls(name, city, state);
  const result = await runCrawl4aiSidecar(invocation, name, city, state);

  if (!result.ok) {
    if (result.reason === 'environment-failure') {
      console.warn(`school-metadata-fetch: crawl4ai sidecar reported environment failure (${result.stderr || 'no stderr'}). Falling back to fetch().`);
      crawl4aiState = { invocation: null, available: false };
      return null;
    }
    const status = result.reason === 'timeout' ? 'timeout' : 'sidecar-failed';
    return emptyCaptureRecord(name, urls, status, 'crawl4ai');
  }

  const record = result.record;
  if (record && record.error) {
    const status = record.error === 'all-candidates-failed' ? 'not-found' : 'parse-failed';
    return emptyCaptureRecord(name, record.attempted ?? urls, status, 'crawl4ai');
  }
  if (!record || !record.nicheGrade) {
    return emptyCaptureRecord(name, urls, 'parse-failed', 'crawl4ai');
  }
  if (!Array.isArray(record.attemptedUrls) || record.attemptedUrls.length === 0) {
    record.attemptedUrls = urls;
  }
  if (!record.provider) record.provider = 'crawl4ai';
  return record;
}

async function captureSchoolViaFetch(name, city, state) {
  const urls = buildNicheUrls(name, city, state);
  for (const url of urls) {
    const result = await fetchHtml(url);
    if (result.ok && /overall-grade__niche-grade/.test(result.html)) {
      const parsed = parseSchoolFromHtml(result.html, name, result.url);
      return { ...parsed, attemptedUrls: urls, finalUrl: result.url, provider: 'fetch-fallback' };
    }
  }
  return emptyCaptureRecord(name, urls, 'fetch-failed', 'fetch-fallback');
}

async function captureSchoolViaGreatSchoolsCrawl4ai(name, city, state, invocation) {
  const searchUrl = buildGreatSchoolsSearchUrl(name, state);
  const result = await runGreatSchoolsCrawl4aiSidecar(invocation, name, city, state);

  if (!result.ok) {
    if (result.reason === 'environment-failure') {
      console.warn(`school-metadata-fetch: GreatSchools crawl4ai sidecar reported environment failure (${result.stderr || 'no stderr'}). Falling back to fetch().`);
      crawl4aiState = { invocation: null, available: false };
      return null;
    }
    const status = result.reason === 'timeout' ? 'timeout' : 'sidecar-failed';
    return emptyCaptureRecord(name, [searchUrl], status, 'crawl4ai', 'greatschools');
  }

  const record = result.record;
  if (record && record.error) {
    const status = record.error === 'blocked'
      ? 'blocked'
      : record.error === 'school-not-found'
        ? 'not-found'
        : record.error === 'search-fetch-failed'
          ? 'fetch-failed'
          : 'parse-failed';
    return emptyCaptureRecord(name, record.attempted ?? [searchUrl], status, 'crawl4ai', 'greatschools');
  }
  if (!record || record.captureStatus !== 'captured') {
    return emptyCaptureRecord(name, [searchUrl], 'parse-failed', 'crawl4ai', 'greatschools');
  }
  if (!Array.isArray(record.attemptedUrls) || record.attemptedUrls.length === 0) {
    record.attemptedUrls = [searchUrl, record.url].filter(Boolean);
  }
  if (!record.provider) record.provider = 'crawl4ai';
  if (!record.source) record.source = 'greatschools';
  return record;
}

async function captureSchoolViaGreatSchoolsFetch(name, state) {
  const searchUrl = buildGreatSchoolsSearchUrl(name, state);
  const result = await fetchHtml(searchUrl);
  if (!result.ok) {
    return emptyCaptureRecord(name, [searchUrl], result.status === 403 || result.status === 429 ? 'blocked' : 'fetch-failed', 'fetch-fallback', 'greatschools');
  }
  if (isNicheBlockedPage(result.html, result.status)) {
    return emptyCaptureRecord(name, [searchUrl], 'blocked', 'fetch-fallback', 'greatschools');
  }
  const payload = parseGreatSchoolsSearchPayload(result.html);
  const picked = pickGreatSchoolsResult(payload?.schools, name);
  if (!picked) {
    return emptyCaptureRecord(name, [searchUrl], 'not-found', 'fetch-fallback', 'greatschools');
  }
  return parseGreatSchoolsRecord(picked, name, searchUrl);
}

async function captureSchoolViaGreatSchools(name, city, state) {
  const { invocation, available } = getCrawl4aiState();
  let viaPython = null;
  if (available) {
    viaPython = await captureSchoolViaGreatSchoolsCrawl4ai(name, city, state, invocation);
    if (viaPython?.captureStatus === 'captured' || viaPython?.captureStatus === 'blocked') return viaPython;
  }

  const viaFetch = await captureSchoolViaGreatSchoolsFetch(name, state);
  if (viaFetch?.captureStatus === 'captured' || viaFetch?.captureStatus === 'blocked') return viaFetch;
  return viaPython ?? viaFetch;
}

function isNicheBlockedPage(html, status) {
  if (status === 403 || status === 429) return true;
  const text = String(html ?? '').toLowerCase();
  return text.includes('access to this page has been denied')
    || text.includes('press & hold to confirm')
    || text.includes('are you a human')
    || text.includes('captcha');
}

function isNicheNotFoundPage(html, status) {
  if (status === 404) return true;
  const text = String(html ?? '').toLowerCase();
  return text.includes('page not found') || text.includes('the page you are looking for could not');
}

async function captureSchoolViaHostedBrowser(name, city, state, profileName) {
  const urls = buildNicheUrls(name, city, state);
  let attached = null;
  const attemptedStatuses = [];
  let sawBlocked = false;
  let sawNotFound = false;
  try {
    attached = await attachHostedBrowser(ROOT, profileName || DEFAULT_PROFILE);
    const { browser, context } = attached;
    try {
      for (const url of urls) {
        const { page, response, error } = await navigateAndSettle(context, url, {
          navigationTimeoutMs: HOSTED_NICHE_TIMEOUT_MS,
          settleMs: 2500,
        });
        if (!page) {
          attemptedStatuses.push({ url, status: 'navigation-failed', error: error?.message || 'unknown' });
          continue;
        }
        try {
          const status = response?.status?.() ?? null;
          const pagePayload = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            html: document.documentElement?.innerHTML ?? '',
          })).catch(() => ({ url, title: '', html: '' }));
          const finalUrl = pagePayload.url || url;
          if (isNicheBlockedPage(pagePayload.html, status)) {
            sawBlocked = true;
            attemptedStatuses.push({ url, finalUrl, status: 'blocked', httpStatus: status, title: pagePayload.title });
            continue;
          }
          if (isNicheNotFoundPage(pagePayload.html, status)) {
            sawNotFound = true;
            attemptedStatuses.push({ url, finalUrl, status: 'not-found', httpStatus: status, title: pagePayload.title });
            continue;
          }
          if (/overall-grade__niche-grade|niche__grade--/.test(pagePayload.html)) {
            const parsed = parseSchoolFromHtml(pagePayload.html, name, finalUrl);
            return {
              ...parsed,
              attemptedUrls: urls,
              attemptedStatuses,
              finalUrl,
              provider: 'hosted-browser-fallback',
            };
          }
          attemptedStatuses.push({ url, finalUrl, status: 'parse-failed', httpStatus: status, title: pagePayload.title });
        } finally {
          await safeClose({ page });
        }
      }
    } finally {
      await safeClose({ browser });
    }
  } catch (error) {
    attemptedStatuses.push({ url: urls[0] ?? null, status: 'hosted-browser-error', error: error.message });
  }

  const status = sawBlocked ? 'blocked' : sawNotFound ? 'not-found' : 'parse-failed';
  return {
    ...emptyCaptureRecord(name, urls, status, 'hosted-browser-fallback'),
    attemptedStatuses,
  };
}

async function captureSchoolViaNiche(name, city, state, profileName) {
  const { invocation, available } = getCrawl4aiState();
  let viaPython = null;
  if (available) {
    viaPython = await captureSchoolViaCrawl4ai(name, city, state, invocation);
    if (viaPython?.captureStatus === 'captured') return viaPython;
  }

  const viaHosted = await captureSchoolViaHostedBrowser(name, city, state, profileName);
  if (viaHosted?.captureStatus === 'captured' || viaHosted?.captureStatus === 'blocked') {
    return viaHosted;
  }

  const viaFetch = await captureSchoolViaFetch(name, city, state);
  if (viaFetch?.captureStatus === 'captured') return viaFetch;

  return viaHosted ?? viaPython ?? viaFetch;
}

async function captureSchool(name, city, state, profileName, enabledSources) {
  const attempts = [];
  if (enabledSources.greatschools) {
    const viaGreatSchools = await captureSchoolViaGreatSchools(name, city, state);
    if (viaGreatSchools) attempts.push(viaGreatSchools);
    if (viaGreatSchools?.captureStatus === 'captured' || viaGreatSchools?.captureStatus === 'blocked') {
      return viaGreatSchools;
    }
  }

  if (enabledSources.niche) {
    const viaNiche = await captureSchoolViaNiche(name, city, state, profileName);
    if (viaNiche) attempts.push(viaNiche);
    if (viaNiche?.captureStatus === 'captured' || viaNiche?.captureStatus === 'blocked') {
      return viaNiche;
    }
  }

  return attempts[0] ?? emptyCaptureRecord(name, [], 'skipped-by-profile', 'none', 'none');
}

function loadJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function assignmentSourceChecksOnly(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter((source) => !/^(Niche\.com|GreatSchools)$/i.test(String(source?.name ?? '').trim()));
}

function targetSlug(target) {
  return slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'school-metadata-target';
}

function uniqueNames(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeSchoolNameKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\bschool\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function normalizedLevel(...values) {
  for (const value of values) {
    const text = String(value ?? '').toLowerCase();
    if (!text) continue;
    if (/elementary|\bpk\b|\bk\b|k-?5|primary|\be\b/.test(text)) return 'elementary';
    if (/middle|junior|6-?8|\bm\b/.test(text)) return 'middle';
    if (/\bhigh\b|9-?12|\bh\b/.test(text)) return 'high';
  }
  return null;
}

function pushSourceUrl(target, label, url, status) {
  const clean = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(clean)) return;
  const key = clean.toLowerCase();
  if (target.some((entry) => entry.url.toLowerCase() === key)) return;
  target.push({
    label,
    url: clean,
    status: status || null,
  });
}

function buildStandardizedSchools(assignedSchools = [], metadataSchools = []) {
  const assigned = Array.isArray(assignedSchools) ? assignedSchools : [];
  const metadata = Array.isArray(metadataSchools) ? metadataSchools : [];
  const metadataByName = new Map();
  for (const school of metadata) {
    const key = normalizeSchoolNameKey(school?.name);
    if (!key || metadataByName.has(key)) continue;
    metadataByName.set(key, school);
  }

  const rows = [];
  const seen = new Set();
  const baseRows = assigned.length > 0 ? assigned : metadata;
  for (const base of baseRows) {
    const key = normalizeSchoolNameKey(base?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const enrichment = assigned.length > 0 ? metadataByName.get(key) : base;
    const sourceUrls = [];
    pushSourceUrl(sourceUrls, 'Assignment', base?.url, base?.source || base?.assignmentSource || base?.fetchStatus);
    pushSourceUrl(sourceUrls, 'Metadata', enrichment?.url, enrichment?.source || enrichment?.provider || enrichment?.captureStatus);
    for (const url of enrichment?.attemptedUrls ?? []) {
      pushSourceUrl(sourceUrls, 'Metadata attempted', url, enrichment?.captureStatus);
    }

    const hasNicheGrade = Boolean(enrichment?.nicheGrade?.letter);
    const hasGreatSchoolsRating = enrichment?.greatSchoolsRating !== null && enrichment?.greatSchoolsRating !== undefined;
    const hasListingRating = base?.rating !== null && base?.rating !== undefined;
    rows.push({
      name: firstPresent(base?.name, enrichment?.name),
      level: normalizedLevel(base?.level, base?.gradeLevel, enrichment?.gradeLevel, base?.name, enrichment?.name),
      gradeLevel: firstPresent(enrichment?.gradeLevel, base?.gradeLevel, base?.level),
      district: firstPresent(base?.district, enrichment?.district),
      assignmentSource: firstPresent(base?.assignmentSource, base?.source),
      assignmentUrl: base?.url ?? null,
      schoolCode: base?.schoolCode ?? null,
      calendar: base?.calendar ?? null,
      transportation: base?.transportation ?? null,
      capStatus: base?.capStatus ?? null,
      rating: firstPresent(base?.rating, enrichment?.greatSchoolsRating),
      ratingSource: hasListingRating
        ? firstPresent(base?.source, base?.assignmentSource)
        : hasGreatSchoolsRating
          ? 'greatschools'
          : hasNicheGrade
            ? 'niche.com'
            : null,
      greatSchoolsRatingScale: enrichment?.greatSchoolsRatingScale ?? null,
      greatSchoolsSubratings: enrichment?.greatSchoolsSubratings ?? null,
      nicheGrade: enrichment?.nicheGrade ?? null,
      subGrades: enrichment?.subGrades ?? null,
      enrollment: firstPresent(enrichment?.enrollment, base?.enrollment),
      studentTeacherRatio: firstPresent(enrichment?.studentTeacherRatio, base?.studentTeacherRatio),
      freeReducedLunchPct: enrichment?.freeReducedLunchPct ?? null,
      percentProficient: enrichment?.percentProficient ?? null,
      averageTeacherSalary: enrichment?.averageTeacherSalary ?? null,
      ethnicityDistribution: firstPresent(enrichment?.ethnicityDistribution, base?.ethnicityDistribution),
      genderDistribution: enrichment?.genderDistribution ?? null,
      metadataSource: firstPresent(enrichment?.source, enrichment?.provider),
      metadataUrl: enrichment?.url ?? null,
      metadataStatus: firstPresent(enrichment?.captureStatus, base?.fetchStatus),
      sourceUrls,
    });
  }

  for (const school of metadata) {
    const key = normalizeSchoolNameKey(school?.name);
    if (!key || seen.has(key)) continue;
    const sourceUrls = [];
    pushSourceUrl(sourceUrls, 'Metadata', school?.url, school?.source || school?.provider || school?.captureStatus);
    for (const url of school?.attemptedUrls ?? []) {
      pushSourceUrl(sourceUrls, 'Metadata attempted', url, school?.captureStatus);
    }
    rows.push({
      name: school.name,
      level: normalizedLevel(school.gradeLevel, school.name),
      gradeLevel: school.gradeLevel ?? null,
      district: null,
      assignmentSource: null,
      assignmentUrl: null,
      schoolCode: null,
      calendar: null,
      transportation: null,
      capStatus: null,
      rating: school.greatSchoolsRating ?? null,
      ratingSource: school.greatSchoolsRating != null ? 'greatschools' : (school.nicheGrade?.letter ? 'niche.com' : null),
      greatSchoolsRatingScale: school.greatSchoolsRatingScale ?? null,
      greatSchoolsSubratings: school.greatSchoolsSubratings ?? null,
      nicheGrade: school.nicheGrade ?? null,
      subGrades: school.subGrades ?? null,
      enrollment: school.enrollment ?? null,
      studentTeacherRatio: school.studentTeacherRatio ?? null,
      freeReducedLunchPct: school.freeReducedLunchPct ?? null,
      percentProficient: school.percentProficient ?? null,
      averageTeacherSalary: school.averageTeacherSalary ?? null,
      ethnicityDistribution: school.ethnicityDistribution ?? null,
      genderDistribution: school.genderDistribution ?? null,
      metadataSource: school.source || school.provider || null,
      metadataUrl: school.url ?? null,
      metadataStatus: school.captureStatus ?? null,
      sourceUrls,
    });
  }

  return rows;
}

/**
 * Resolve the assigned school names for a target with a layered fallback so
 * the crawl4ai sidecar still has work to do when individual sources fail:
 *   1. Names parsed from the eval report (existing behavior).
 *   2. Names already written by extract-listing-details into the listing
 *      JSON's `assignedSchools[]` -- portal-direct, the most reliable source
 *      when GreatSchools fails for an address.
 *   3. Names previously written into the school-metadata sidecar (e.g. by
 *      school-assignments-fetch.mjs running before this script).
 * Returns { names, source } so the caller can record provenance.
 */
async function extractAlternateListingSchools(target, profileName) {
  const slug = targetSlug(target);
  const builderRecord = loadJsonIfExists(join(ROOT, 'output', 'builder', `${slug}.json`));
  const candidateUrls = [
    builderRecord?.detectionSourceUrl,
  ].filter((url) => /^https?:\/\/(?:www\.)?(?:redfin|realtor|homes)\.com\//i.test(String(url ?? '')));

  for (const url of candidateUrls) {
    const listing = await extractListing(url, { profileName }).catch(() => null);
    const schools = Array.isArray(listing?.assignedSchools) ? listing.assignedSchools : [];
    const names = uniqueNames(schools.map((entry) => entry?.name));
    if (names.length > 0) {
      return {
        names,
        source: `alternate-listing:${listing?.platform || 'listing'}`,
        assignmentSourcesChecked: [{
          name: `${listing?.platform || 'alternate'}-assigned-schools`,
          url: listing?.canonicalUrl || listing?.url || url,
          status: 'ok',
        }],
        assignedSchools: schools,
      };
    }
  }

  return null;
}

async function resolveSchoolNames(target, profileName) {
  const slug = targetSlug(target);

  const listingPath = join(ROOT, 'output', 'listings', `${slug}.json`);
  const listing = loadJsonIfExists(listingPath);
  const listingNames = uniqueNames(
    Array.isArray(listing?.assignedSchools)
      ? listing.assignedSchools.map((entry) => entry?.name)
      : [],
  );
  if (listingNames.length > 0) {
    return {
      names: listingNames,
      source: 'listing-json',
      assignmentSourcesChecked: [{
        name: `${listing?.platform || 'listing'}-assigned-schools`,
        url: listing?.canonicalUrl || listing?.url || '',
        status: 'ok',
      }],
      assignedSchools: listing.assignedSchools,
    };
  }

  const priorMetadata = loadJsonIfExists(join(OUTPUT_DIR, `${slug}.json`));
  const priorAssignedSchools = Array.isArray(priorMetadata?.assignedSchools) ? priorMetadata.assignedSchools : [];
  const priorAssignedNames = uniqueNames(priorAssignedSchools.map((entry) => entry?.name));
  if (priorAssignedNames.length > 0) {
    return {
      names: priorAssignedNames,
      source: priorMetadata?.primarySource ? `prior-school-metadata:${priorMetadata.primarySource}` : 'prior-school-metadata:assigned-schools',
      assignmentSourcesChecked: assignmentSourceChecksOnly(priorMetadata?.sourcesChecked),
      assignedSchools: priorAssignedSchools,
    };
  }

  const priorNames = uniqueNames(
    Array.isArray(priorMetadata?.schools)
      ? priorMetadata.schools.map((entry) => entry?.name)
      : [],
  );
  if (priorNames.length > 0) {
    return {
      names: priorNames,
      source: priorMetadata?.primarySource ? `prior-school-metadata:${priorMetadata.primarySource}` : 'prior-school-metadata',
      assignmentSourcesChecked: assignmentSourceChecksOnly(priorMetadata?.sourcesChecked),
      assignedSchools: Array.isArray(priorMetadata?.assignedSchools) ? priorMetadata.assignedSchools : priorMetadata.schools,
    };
  }

  const reportNames = extractSchoolNames(target);
  if (reportNames.length > 0) {
    return {
      names: reportNames,
      source: 'report',
      assignmentSourcesChecked: [{
        name: 'report-school-review',
        url: target.relativePath ?? target.reportPath ?? '',
        status: 'ok',
      }],
    };
  }

  const alternateListing = await extractAlternateListingSchools(target, profileName);
  if (alternateListing) return alternateListing;

  return { names: [], source: 'none', assignmentSourcesChecked: [], assignedSchools: [] };
}

function enabledSchoolSources(profile) {
  const configured = profile?.research_sources?.schools ?? {};
  return {
    greatschools: configured.greatschools === true,
    niche: configured.niche === true,
  };
}

function sourcesEnabled(enabledSources) {
  return Object.values(enabledSources).some(Boolean);
}

function sourceCoverageEntry(enabledSources, schools) {
  const entries = [];
  if (enabledSources.greatschools) {
    const captured = schools.filter((school) => school?.source === 'greatschools' && school.captureStatus === 'captured').length;
    entries.push({
      name: 'GreatSchools',
      url: 'https://www.greatschools.org/search/search.page',
      baseUrl: 'https://www.greatschools.org/',
      schoolsAttempted: schools.length,
      schoolsCaptured: captured,
    });
  }
  if (enabledSources.niche) {
    const captured = schools.filter((school) => /niche/i.test(school?.source || '') && school.captureStatus === 'captured').length;
    entries.push({
      name: 'Niche.com',
      url: 'https://www.niche.com/k12/',
      baseUrl: 'https://www.niche.com/k12/',
      schoolsAttempted: schools.length,
      schoolsCaptured: captured,
    });
  }
  return entries;
}

async function captureForTarget(target, enabledSources, profileName) {
  if (!sourcesEnabled(enabledSources)) {
    return {
      status: 'skipped-by-profile',
      schools: [],
      sourcesChecked: [],
      note: 'No supported school sources opted in via config/profile.yml research_sources.schools.',
    };
  }

  const {
    names: schoolNames,
    source: nameSource,
    assignmentSourcesChecked,
    assignedSchools,
  } = await resolveSchoolNames(target, profileName);
  if (schoolNames.length === 0) {
    return {
      status: 'no-assigned-schools',
      schools: [],
      sourcesChecked: [],
      schoolNameSource: 'none',
      note: 'No assigned school names found in the report, listing JSON, or prior school metadata.',
    };
  }

  const schools = [];
  for (const name of schoolNames) {
    schools.push(await captureSchool(name, target.city, target.state || 'NC', profileName, enabledSources));
  }

  const captured = schools.filter((s) => s.captureStatus === 'captured').length;
  const blocked = schools.filter((s) => s.captureStatus === 'blocked').length;
  const status = captured === schools.length
    ? 'captured'
    : captured > 0
      ? 'partial'
      : blocked > 0
        ? 'blocked'
        : 'fetch-failed';
  return {
    status,
    schools,
    sourcesChecked: [
      ...assignmentSourcesChecked,
      ...sourceCoverageEntry(enabledSources, schools),
    ],
    schoolNameSource: nameSource,
    assignedSchools: Array.isArray(assignedSchools) ? assignedSchools : [],
    note: status === 'captured' ? null : `${schools.length - captured} of ${schools.length} schools could not be captured.`,
  };
}

export function readSchoolMetadata(target) {
  const path = buildOutputPath(target);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function schoolMetadataPath(target) {
  return buildOutputPath(target);
}

async function run() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message); console.error(''); console.error(HELP_TEXT); process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const researchContext = loadResearchConfig(ROOT);
  const enabledSources = enabledSchoolSources(researchContext.profile);
  const targets = resolveTargets(config);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const records = [];
  for (const target of targets) {
    const capture = await captureForTarget(target, enabledSources, config.profileName);
    const record = {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath,
      ...capture,
      standardizedSchools: buildStandardizedSchools(capture.assignedSchools, capture.schools),
    };
    await writeFile(buildOutputPath(target), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push(record);
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  console.log('\nSchool metadata capture\n');
  for (const r of records) {
    console.log(`${r.address} | ${r.city}, ${r.state}`);
    console.log(`Status: ${r.status} | Schools: ${r.schools.length}`);
    for (const s of r.schools) {
      const grade = s.nicheGrade?.letter ?? '—';
      const rating = s.greatSchoolsRating != null ? `${s.greatSchoolsRating}/10` : '—';
      const enroll = s.enrollment != null ? s.enrollment : '—';
      const ratio = s.studentTeacherRatio ?? '—';
      console.log(`  - ${s.name} [${s.gradeLevel ?? '?'}] greatschools ${rating}, niche ${grade}, enrollment ${enroll}, ratio ${ratio} (${s.captureStatus})`);
    }
    console.log('');
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  run().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}
