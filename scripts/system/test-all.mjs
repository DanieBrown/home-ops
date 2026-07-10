#!/usr/bin/env node

/**
 * test-all.mjs - Repository validation for home-ops
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { extname, join, relative } from 'path';
import { ROOT } from '../shared/paths.mjs';
const QUICK = process.argv.includes('--quick');

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(message) {
  console.log(`  PASS ${message}`);
  passed++;
}

function fail(message) {
  console.log(`  FAIL ${message}`);
  failed++;
}

function warn(message) {
  console.log(`  WARN ${message}`);
  warnings++;
}

function run(command, opts = {}) {
  try {
    const output = execSync(command, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();

    return { ok: true, output };
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : '';
    return { ok: false, output: `${stdout}${stderr}`.trim() };
  }
}

function fileExists(path) {
  return existsSync(join(ROOT, path));
}

function readFile(path) {
  return readFileSync(join(ROOT, path), 'utf-8');
}

function walk(dir, extensions, skipDirs = new Set()) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(ROOT, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) || skipDirs.has(relPath)) {
        continue;
      }
      files.push(...walk(fullPath, extensions, skipDirs));
      continue;
    }

    if (extensions.has(extname(entry.name))) {
      files.push(relPath);
    }
  }

  return files;
}

function scanForPatterns(files, patterns) {
  const hits = [];

  for (const file of files) {
    const content = readFile(file);
    for (const pattern of patterns) {
      if (content.includes(pattern)) {
        hits.push({ file, pattern });
      }
    }
  }

  return hits;
}

console.log('\nHome-ops test suite\n');

const skipDirs = new Set(['.git', 'node_modules', 'output', 'reports', 'batch/logs', '.superpowers', '.home-ops']);

console.log('1. Syntax checks');

const mjsFiles = walk(ROOT, new Set(['.mjs']), skipDirs);
for (const file of mjsFiles) {
  const result = run(`node --check "${file}"`);
  if (result.ok) {
    pass(`${file} syntax OK`);
  } else {
    fail(`${file} has syntax errors`);
  }
}

console.log('\n2. Script execution');

const scripts = [
  'scripts/browser/browser-session.mjs --status',
  'scripts/browser/open-url-in-hosted-session.mjs --help',
  'scripts/browser/review-tabs.mjs --help',
  'scripts/research/research-coverage-audit.mjs',
  'scripts/research/research-source-plan.mjs --address "100 Test Dr" --city "Apex" --type development',
  'scripts/research/research-source-plan.mjs --address "100 Test Dr" --city "Apex" --type sentiment',
  'scripts/research/sentiment-browser-extract.mjs --help',
  'scripts/research/construction-check.mjs --help',
  'scripts/research/utility-options-check.mjs --help',
  'scripts/reports/briefing-pdf.mjs --help',
  'scripts/research/axis-sidecar-write.mjs --help',
  'scripts/system/cache-utils.mjs --help',
  'scripts/system/test-cache-loop.mjs',
  'scripts/research/deep-research-packet.mjs --help',
  'scripts/research/shortlist-finalist-gate.mjs --help',
  'scripts/affordability/calculate-affordability.mjs --help',
  'scripts/affordability/apply-affordability.mjs --help',
  'scripts/system/temp-artifact-check.mjs',
  'scripts/system/doctor.mjs',
  'scripts/config/profile-sync-check.mjs',
  'scripts/pipeline/verify-pipeline.mjs',
  'scripts/pipeline/normalize-statuses.mjs',
  'scripts/pipeline/dedup-tracker.mjs',
  'scripts/pipeline/merge-tracker.mjs',
  'scripts/system/update-system.mjs check',
];

for (const script of scripts) {
  const result = run(`node ${script}`);
  if (result.ok) {
    pass(`${script} runs OK`);
  } else {
    fail(`${script} failed`);
  }
}

{
  const result = run('node scripts/tests/test-extract-parsers.mjs');
  if (result.ok) {
    pass('extract-listing-details parser unit tests');
  } else {
    fail(`extract-listing-details parser unit tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-crawl4ai-portal-extract.mjs');
  if (result.ok) {
    pass('crawl4ai portal extraction fixture tests');
  } else {
  fail(`crawl4ai portal extraction fixture tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-affordability.mjs');
  if (result.ok) {
    pass('affordability calculation and profile patch tests');
  } else {
    fail(`affordability calculation and profile patch tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-knowledge-store.mjs');
  if (result.ok) {
    pass('knowledge store indexing and reset tests');
  } else {
    fail(`knowledge store indexing and reset tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-generate-portals.mjs');
  if (result.ok) {
    pass('portal generation seed catalog tests');
  } else {
    fail(`portal generation seed catalog tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-utility-options.mjs');
  if (result.ok) {
    pass('utility estimate calculation and sidecar tests');
  } else {
    fail(`utility estimate calculation and sidecar tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-axis-sidecar.mjs');
  if (result.ok) {
    pass('axis sidecar validation and write tests');
  } else {
    fail(`axis sidecar validation and write tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-photo-cache.mjs');
  if (result.ok) {
    pass('listing photo cache write tests');
  } else {
    fail(`listing photo cache write tests\n${result.output}`);
  }
}

{
  const result = run('node scripts/tests/test-briefing-html.mjs');
  if (result.ok) {
    pass('briefing HTML fixture tests');
  } else {
    fail(`briefing HTML fixture tests\n${result.output}`);
  }
}

console.log(QUICK ? '\n3. Extended build checks (skipped --quick)' : '\n3. Extended build checks');

console.log('\n4. Data contract validation');

const systemFiles = [
  'CLAUDE.md',
  'VERSION',
  'DATA_CONTRACT.md',
  'modes/_shared.md',
  'modes/_profile.template.md',
  'modes/init.md',
  'modes/profile.md',
  'modes/afford.md',
  'modes/hunt.md',
  'modes/evaluate.md',
  'modes/compare.md',
  'modes/scan.md',
  'modes/tracker.md',
  'modes/deep.md',
  'templates/states.yml',
  'templates/portals.example.yml',
  'templates/research-defaults.yml',
  '.claude/skills/home-ops/SKILL.md',
];

for (const file of systemFiles) {
  if (fileExists(file)) {
    pass(`System file exists: ${file}`);
  } else {
    fail(`Missing system file: ${file}`);
  }
}

const userFiles = [
  'buyer-profile.md',
  'config/profile.yml',
  'modes/_profile.md',
  'portals.yml',
  'data/listings.md',
  'data/shortlist.md',
];

const gitAvailable = run('git --version').ok;
for (const file of userFiles) {
  if (!gitAvailable) {
    warn(`Skipping gitignore check for ${file}; git is unavailable`);
    continue;
  }

  const ignored = run(`git check-ignore "${file}"`);
  if (ignored.ok && ignored.output) {
    pass(`User file gitignored: ${file}`);
  } else {
    fail(`User file is tracked but should be ignored: ${file}`);
  }
}

if (fileExists('data/shortlist.md')) {
  const shortlist = readFile('data/shortlist.md');
  if (shortlist.includes('## Top 10 Homes') && shortlist.includes('## Refined Top 3 After Deep')) {
    pass('Shortlist file has top-10 and refined-top-3 sections');
  } else {
    fail('Shortlist file is missing the top-10 or refined-top-3 section');
  }
}

console.log('\n5. Legacy reference check');

const legacyPatterns = [
  ['career', 'ops'].join('-'),
  ['data', ['applications', 'md'].join('.')].join('/'),
  ['applications', 'md'].join('.'),
  ['cv', 'sync', 'check.mjs'].join('-'),
  ['/', 'career', 'ops'].join(''),
  ['article', ['digest', 'md'].join('.')].join('-'),
  ['cv', 'md'].join('.'),
];

const textFiles = walk(ROOT, new Set(['.md', '.mjs', '.yml', '.yaml', '.json', '.sh']), skipDirs)
  .filter((file) => !file.startsWith('reports/'));

const legacyHits = scanForPatterns(textFiles, legacyPatterns)
  .filter(({ file }) => !file.endsWith('test-all.mjs'));

if (legacyHits.length === 0) {
  pass('No stale career-era references found');
} else {
  for (const hit of legacyHits.slice(0, 20)) {
    fail(`Legacy reference in ${hit.file}: ${hit.pattern}`);
  }
  if (legacyHits.length > 20) {
    fail(`Additional legacy references found: ${legacyHits.length - 20}`);
  }
}

console.log('\n6. Absolute path check');

const absolutePathHits = [];
const unixHomePrefix = ['/', 'Users', '/'].join('');
const windowsHomePrefix = ['C:', 'Users'].join('\\');
for (const file of textFiles) {
  const content = readFile(file);
  if (content.includes(unixHomePrefix) || content.includes(windowsHomePrefix)) {
    absolutePathHits.push(file);
  }
}

if (absolutePathHits.length === 0) {
  pass('No absolute paths in code files');
} else {
  for (const file of absolutePathHits) {
    fail(`Absolute path found in ${file}`);
  }
}

console.log('\n7. Mode file integrity');

const expectedModes = [
  '_shared.md',
  '_profile.template.md',
  'init.md',
  'profile.md',
  'hunt.md',
  'evaluate.md',
  'compare.md',
  'scan.md',
  'tracker.md',
  'deep.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does not reference _profile.md');
}

console.log('\n8. CLAUDE.md integrity');

const claude = readFile('CLAUDE.md');
const requiredSections = [
  'Data Contract',
  'Ethical Use',
  'Listing Verification',
  'Tracker Rules',
  'OpenCode Commands',
  'First Run',
  'Onboarding',
];

for (const section of requiredSections) {
  if (claude.includes(section)) {
    pass(`CLAUDE.md has section: ${section}`);
  } else {
    fail(`CLAUDE.md missing section: ${section}`);
  }
}

console.log('\n9. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('Tests failed. Review the items above.');
  process.exit(1);
}

if (warnings > 0) {
  console.log('Tests passed with warnings.');
  process.exit(0);
}

console.log('All tests passed.');
process.exit(0);
