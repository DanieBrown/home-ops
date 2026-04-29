#!/usr/bin/env node

/**
 * school-metadata-fetch.mjs -- Per-home school metadata capture from Niche.com.
 *
 * For each shortlisted home, reads the assigned school names from the
 * evaluation report and fetches the matching Niche.com page. Niche embeds
 * structured data in the rendered HTML as JSON `label/value` triples plus
 * `niche__grade--<letter>` CSS classes -- both robust enough to extract
 * without parsing the full DOM. We capture grade letters, sub-grades,
 * enrollment, student-teacher ratio, free/reduced lunch %, math/reading
 * proficiency, average teacher salary, and the full ethnicity + gender
 * distributions.
 *
 * Output lands at output/school-metadata/{slug}.json with shape:
 *   { generatedAt, address, city, state, status, schools: [...] }
 *
 * Niche enforces bot detection -- the fetcher uses realistic browser
 * headers. Skips with status: "skipped-by-profile" if no school sources
 * are opted in via config/profile.yml.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  ROOT,
  extractSchoolNames,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'school-metadata');
const DEFAULT_TIMEOUT_MS = 20000;

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

Captures Niche.com metadata per assigned school for each shortlisted home.

Options:
  --shortlist       Use the current Top 10 cohort.
  --top3            Use the refined Top 3.
  --json            Print JSON instead of human-readable text.
  --help            Show this help.`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, files: [] };
  for (const arg of argv) {
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
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
  const cleaned = schoolName.replace(/\bSchool\b/i, '').trim();
  const variants = [schoolName];
  if (cleaned && cleaned !== schoolName) variants.push(cleaned);
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

async function captureSchool(name, city, state) {
  const urls = buildNicheUrls(name, city, state);
  for (const url of urls) {
    const result = await fetchHtml(url);
    if (result.ok && /overall-grade__niche-grade/.test(result.html)) {
      const parsed = parseSchoolFromHtml(result.html, name, result.url);
      return { ...parsed, attemptedUrls: urls, finalUrl: result.url };
    }
  }
  return {
    name,
    gradeLevel: inferGradeLevel(name),
    url: urls[0] ?? null,
    source: 'niche.com',
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
    captureStatus: 'fetch-failed',
    attemptedUrls: urls,
  };
}

async function captureForTarget(target, schoolsEnabled) {
  if (!schoolsEnabled) {
    return {
      status: 'skipped-by-profile',
      schools: [],
      sourcesChecked: [],
      note: 'No school sources opted in via config/profile.yml research_sources.schools.',
    };
  }

  const schoolNames = extractSchoolNames(target);
  if (schoolNames.length === 0) {
    return {
      status: 'no-assigned-schools',
      schools: [],
      sourcesChecked: [],
      note: 'No assigned school names extracted from the report.',
    };
  }

  const schools = [];
  for (const name of schoolNames) {
    schools.push(await captureSchool(name, target.city, target.state || 'NC'));
  }

  const captured = schools.filter((s) => s.captureStatus === 'captured').length;
  const status = captured === schools.length ? 'captured' : captured > 0 ? 'partial' : 'fetch-failed';
  return {
    status,
    schools,
    sourcesChecked: [{ name: 'Niche.com', baseUrl: 'https://www.niche.com/k12/', schoolsAttempted: schools.length, schoolsCaptured: captured }],
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
  const schoolsEnabled = Object.values(researchContext.profile?.research_sources?.schools ?? {})
    .some((value) => value === true);
  const targets = resolveTargets(config);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const records = [];
  for (const target of targets) {
    const capture = await captureForTarget(target, schoolsEnabled);
    const record = {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath,
      ...capture,
    };
    await writeFile(buildOutputPath(target), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push(record);
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  console.log('\nNiche school metadata capture\n');
  for (const r of records) {
    console.log(`${r.address} | ${r.city}, ${r.state}`);
    console.log(`Status: ${r.status} | Schools: ${r.schools.length}`);
    for (const s of r.schools) {
      const grade = s.nicheGrade?.letter ?? '—';
      const enroll = s.enrollment != null ? s.enrollment : '—';
      const ratio = s.studentTeacherRatio ?? '—';
      console.log(`  - ${s.name} [${s.gradeLevel ?? '?'}] niche ${grade}, enrollment ${enroll}, ratio ${ratio} (${s.captureStatus})`);
    }
    console.log('');
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  run().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}
