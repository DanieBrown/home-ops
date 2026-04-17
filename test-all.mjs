#!/usr/bin/env node

/**
 * test-all.mjs - Repository validation for home-ops
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, extname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
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

const skipDirs = new Set(['.git', 'node_modules', 'output', 'reports', 'batch/logs']);

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
  'browser-session.mjs --status',
  'review-tabs.mjs --help',
  'research-coverage-audit.mjs',
  'research-source-plan.mjs --top3 --type development',
  'research-source-plan.mjs --top3 --type sentiment',
  'sentiment-browser-extract.mjs --help',
  'shortlist-finalist-gate.mjs --help',
  'doctor.mjs',
  'profile-sync-check.mjs',
  'verify-pipeline.mjs',
  'normalize-statuses.mjs',
  'dedup-tracker.mjs',
  'merge-tracker.mjs',
  'update-system.mjs check',
];

for (const script of scripts) {
  const result = run(`node ${script}`);
  if (result.ok) {
    pass(`${script} runs OK`);
  } else {
    fail(`${script} failed`);
  }
}

if (!QUICK) {
  console.log('\n3. Dashboard build');

  const hasGo = run('go version');
  if (!hasGo.ok) {
    warn('Go toolchain not installed; dashboard build skipped');
  } else {
    const build = run('go build ./...', { cwd: join(ROOT, 'dashboard') });
    if (build.ok) {
      pass('Dashboard compiles');
    } else {
      fail('Dashboard build failed');
    }
  }
} else {
  console.log('\n3. Dashboard build (skipped --quick)');
}

console.log('\n4. Data contract validation');

const systemFiles = [
  'CLAUDE.md',
  'VERSION',
  'DATA_CONTRACT.md',
  'modes/_shared.md',
  'modes/_profile.template.md',
  'modes/init.md',
  'modes/profile.md',
  'modes/hunt.md',
  'modes/evaluate.md',
  'modes/compare.md',
  'modes/scan.md',
  'modes/tracker.md',
  'modes/deep.md',
  'templates/states.yml',
  'templates/portals.example.yml',
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

const textFiles = walk(ROOT, new Set(['.md', '.mjs', '.go', '.yml', '.yaml', '.json', '.sh']), skipDirs)
  .filter((file) => !file.startsWith('reports/'));

const legacyHits = scanForPatterns(textFiles, legacyPatterns)
  .filter(({ file }) => file !== 'test-all.mjs');

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
