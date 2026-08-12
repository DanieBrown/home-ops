#!/usr/bin/env node

/**
 * doctor.mjs -- Setup validation for home-ops.
 * Checks the core prerequisites for scanning, evaluating, and tracking homes.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { ROOT } from '../shared/paths.mjs';
import { hasHelpFlag } from '../shared/cli.mjs';

const HELP_TEXT = `Usage:
  node doctor.mjs

Setup validation for home-ops. Checks the prerequisites for scanning,
evaluating, and tracking homes:
  - Node.js >= 18, installed dependencies, Playwright chromium
  - crawl4ai Python sidecar (optional -- school metadata degrades without it)
  - a hosted browser binary for the CDP session
  - the buyer-layer files: buyer-profile.md, config/profile.yml, portals.yml
  - the mode files and templates/states.yml
  - the review-tabs extension manifest and bridge
  - the writable directories: data, reports, output, batch
  - leftover scratch under .home-ops/tmp/
  - that portals.yml search URLs cover every configured profile area, and
    that sentiment, school, and development sources are configured

  - that every package.json script appears in docs/COMMANDS.md

Exits 1 when a check fails; warnings alone exit 0.

Options:
  --strict     Promote advisory warnings to failures. Currently this makes an
               undocumented npm script a hard failure instead of a warning.
  --help, -h   Show this help text.
`;

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const STRICT = process.argv.slice(2).includes('--strict');

const isTTY = process.stdout.isTTY;
const green = (value) => (isTTY ? `\x1b[32m${value}\x1b[0m` : value);
const yellow = (value) => (isTTY ? `\x1b[33m${value}\x1b[0m` : value);
const red = (value) => (isTTY ? `\x1b[31m${value}\x1b[0m` : value);
const dim = (value) => (isTTY ? `\x1b[2m${value}\x1b[0m` : value);

function passResult(label) {
  return { level: 'pass', label };
}

function warnResult(label, fix) {
  return { level: 'warn', label, fix };
}

function failResult(label, fix) {
  return { level: 'fail', label, fix };
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) {
    return passResult(`Node.js >= 18 (v${process.versions.node})`);
  }

  return failResult(
    `Node.js >= 18 (found v${process.versions.node})`,
    'Install Node.js 18 or later from https://nodejs.org',
  );
}

function checkDependencies() {
  if (existsSync(join(ROOT, 'node_modules'))) {
    return passResult('Dependencies installed');
  }

  return failResult('Dependencies not installed', 'Run: npm run bootstrap');
}

function pythonCandidatesForDoctor() {
  return process.platform === 'win32'
    ? [['py', ['-3']], ['python3', []], ['python', []]]
    : [['python3', []], ['python', []]];
}

function checkCrawl4ai() {
  const setupHint = process.platform === 'win32'
    ? 'Run: npm run bootstrap:python'
    : 'Run: npm run bootstrap -- --python';

  let foundPython = null;
  for (const [bin, baseArgs] of pythonCandidatesForDoctor()) {
    const versionProbe = spawnSync(bin, [...baseArgs, '--version'], { encoding: 'utf8' });
    if (versionProbe.status !== 0) continue;
    foundPython = `${bin}${baseArgs.length ? ' ' + baseArgs.join(' ') : ''}`;
    const probe = spawnSync(bin, [...baseArgs, '-c', 'import crawl4ai'], { encoding: 'utf8' });
    if (probe.status === 0) {
      return passResult(`crawl4ai: ok via ${foundPython} (school metadata sidecar enabled)`);
    }
  }

  if (!foundPython) {
    return warnResult(
      'Python 3.10+ not found on PATH (crawl4ai pilot will fall back to fetch())',
      ['Install Python 3.10+ from https://www.python.org/downloads/.', setupHint],
    );
  }

  return warnResult(
    `crawl4ai not importable via ${foundPython} (school metadata will use fetch() fallback)`,
    setupHint,
  );
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    if (existsSync(executablePath)) {
      return passResult('Playwright chromium installed');
    }
  } catch {
    // fall through to failure below
  }

  return failResult('Playwright chromium not installed', 'Run: npm run bootstrap');
}

function checkFile(relativePath, label, fix) {
  if (existsSync(join(ROOT, relativePath))) {
    return passResult(label);
  }

  return failResult(`${label} missing`, fix);
}

function ensureDir(relativePath) {
  const fullPath = join(ROOT, relativePath);
  if (existsSync(fullPath)) {
    return passResult(`${relativePath} ready`);
  }

  try {
    mkdirSync(fullPath, { recursive: true });
    return passResult(`${relativePath} ready (auto-created)`);
  } catch {
    return failResult(`${relativePath} could not be created`, `Create ${relativePath} manually`);
  }
}

function checkTempArtifacts() {
  const result = spawnSync(process.execPath, ['scripts/system/temp-artifact-check.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return passResult('No stale one-off scripts or temporary artifacts');
  }
  return failResult(
    'Temporary artifact cleanup check failed',
    'Move one-off scripts under .home-ops/tmp/{commandId}/ and remove them after use.',
  );
}

/**
 * Every package.json script must appear in docs/COMMANDS.md.
 *
 * Without this the reference rots within a few features -- which is how 50 of
 * 78 scripts ended up undocumented, including the entire update/rollback
 * subsystem. Advisory by default (a warning) so a routine doctor run is not
 * blocked by a docs gap; `--strict` makes it a hard failure for CI.
 */
function checkCommandDocs({ strict = false } = {}) {
  const docsPath = join(ROOT, 'docs', 'COMMANDS.md');
  if (!existsSync(docsPath)) {
    return failResult(
      'docs/COMMANDS.md is missing',
      'Restore the command reference; doctor uses it to verify every npm script is documented.',
    );
  }

  let scripts;
  try {
    scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {});
  } catch (error) {
    return warnResult(`Could not read package.json scripts (${error.message})`, 'Fix package.json, then re-run doctor.');
  }

  const docs = readFileSync(docsPath, 'utf8');
  // Match the script name as a whole token so `merge` is not satisfied by
  // `merge-tracker` appearing somewhere in the file.
  const undocumented = scripts.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(^|[^\\w:-])${escaped}([^\\w:-]|$)`).test(docs);
  });

  if (undocumented.length === 0) {
    return passResult(`docs/COMMANDS.md covers all ${scripts.length} npm scripts`);
  }

  const label = `docs/COMMANDS.md is missing ${undocumented.length} npm script${undocumented.length === 1 ? '' : 's'}: ${undocumented.join(', ')}`;
  const fix = 'Add each one to docs/COMMANDS.md with its underlying script, its flags, and a one-line description.';
  return strict ? failResult(label, fix) : warnResult(label, fix);
}

function findAvailableHostedBrowsers() {
  const candidatesByPlatform = {
    win32: {
      chrome: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
      msedge: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      chromium: [
        'C:\\Program Files\\Chromium\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
      ],
    },
    darwin: {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    },
    linux: {
      chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
      msedge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
      chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
    },
  };

  const platformCandidates = candidatesByPlatform[process.platform] ?? {};
  const orderedChannels = ['chrome', 'msedge', 'chromium'];
  const installed = [];

  for (const channel of orderedChannels) {
    const match = (platformCandidates[channel] ?? []).find((candidate) => existsSync(candidate));
    if (match) {
      installed.push({ channel, path: match });
    }
  }

  return installed;
}

function checkHostedBrowserAvailability() {
  const installed = findAvailableHostedBrowsers();

  if (installed.length === 0) {
    return failResult(
      'No supported local hosted browser channel found',
      [
        'Install Google Chrome, Microsoft Edge, or Chromium so /home-ops init can launch a hosted browser session.',
        'If Chrome is blocked on this machine, install Edge and rerun doctor.',
      ],
    );
  }

  const primary = installed[0];
  if (primary.channel === 'chrome') {
    return passResult(`Hosted browser available: chrome (${primary.path})`);
  }

  return warnResult(
    `Hosted browser fallback available: ${primary.channel} (${primary.path})`,
    'Chrome is not installed, but the hosted session launcher will fall back automatically.',
  );
}

async function checkProfileAndPortalCoverage(dependenciesInstalled) {
  if (!dependenciesInstalled) {
    return [warnResult(
      'Advanced profile and portal coverage checks skipped',
      'Run npm run bootstrap, then rerun doctor to validate YAML-backed search area and source coverage.',
    )];
  }

  const profilePath = join(ROOT, 'config', 'profile.yml');
  const portalsPath = join(ROOT, 'portals.yml');
  if (!existsSync(profilePath) || !existsSync(portalsPath)) {
    return [];
  }

  let YAML;
  try {
    ({ default: YAML } = await import('yaml'));
  } catch {
    return [warnResult(
      'YAML parser unavailable for advanced config checks',
      'Reinstall dependencies with npm install so doctor can validate profile-to-portal coverage.',
    )];
  }

  let profile;
  let portals;
  try {
    profile = YAML.parse(readFileSync(profilePath, 'utf8')) ?? {};
    portals = YAML.parse(readFileSync(portalsPath, 'utf8')) ?? {};
  } catch (error) {
    return [failResult('config/profile.yml or portals.yml could not be parsed', error.message)];
  }

  const checks = [];
  const profileAreas = (profile.search?.areas ?? [])
    .map((entry) => String(entry?.name ?? '').trim())
    .filter(Boolean);

  if (profileAreas.length === 0) {
    checks.push(warnResult(
      'config/profile.yml has no configured search areas',
      'Add search.areas entries so doctor can validate portal coverage against the buyer profile.',
    ));
    return checks;
  }

  const platforms = portals.platforms && typeof portals.platforms === 'object'
    ? Object.entries(portals.platforms)
    : [];

  if (platforms.length === 0) {
    checks.push(failResult(
      'portals.yml has no configured listing platforms',
      'Add platforms.*.search_urls entries so scan mode can discover listings.',
    ));
    return checks;
  }

  checks.push(passResult(`portals.yml defines ${platforms.length} listing platform(s)`));

  for (const [platformKey, rawConfig] of platforms) {
    const searchUrls = Array.isArray(rawConfig?.search_urls) ? rawConfig.search_urls : [];
    if (searchUrls.length === 0) {
      checks.push(failResult(
        `${platformKey} has no configured search URLs`,
        `Add portals.yml platforms.${platformKey}.search_urls entries for the profile search areas.`,
      ));
      continue;
    }

    const configuredAreas = new Set(
      searchUrls.map((entry) => String(entry?.area ?? '').trim()).filter(Boolean),
    );
    const missingAreas = profileAreas.filter((area) => !configuredAreas.has(area));

    if (missingAreas.length > 0) {
      checks.push(warnResult(
        `${platformKey} is missing search URL coverage for: ${missingAreas.join(', ')}`,
        `Add search_urls for the missing areas in portals.yml platforms.${platformKey}.search_urls.`,
      ));
    } else {
      checks.push(passResult(`${platformKey} search URLs cover all configured profile areas`));
    }
  }

  const coverageSections = [
    ['sentiment_sources', 'Sentiment sources configured'],
    ['school_sources', 'School sources configured'],
    ['development_sources', 'Development sources configured'],
  ];

  for (const [key, label] of coverageSections) {
    const node = portals[key];
    const hasEntries = node && typeof node === 'object' && Object.keys(node).length > 0;
    if (hasEntries) {
      checks.push(passResult(label));
    } else {
      checks.push(warnResult(
        `${key} missing or empty in portals.yml`,
        `Populate ${key} in portals.yml so evaluate and deep have an explicit source inventory to use and audit.`,
      ));
    }
  }

  return checks;
}

async function main() {
  console.log('\nhome-ops doctor');
  console.log('===============\n');

  const dependencyCheck = checkDependencies();
  const checks = [
    checkNodeVersion(),
    dependencyCheck,
    await checkPlaywright(),
    checkCrawl4ai(),
    checkHostedBrowserAvailability(),
    checkFile('buyer-profile.md', 'buyer-profile.md found', 'Create buyer-profile.md with areas, requirements, and deal-breakers.'),
    checkFile('config/profile.yml', 'config/profile.yml found', 'Copy config/profile.example.yml to config/profile.yml and fill in buyer details.'),
    checkFile('portals.yml', 'portals.yml found', 'Create portals.yml with platform search URLs for the target towns.'),
    checkFile('templates/states.yml', 'templates/states.yml found', 'Restore templates/states.yml with the canonical listing states.'),
    checkFile('modes/_shared.md', 'modes/_shared.md found', 'Restore the shared mode instructions.'),
    checkFile('modes/_profile.md', 'modes/_profile.md found', 'Create modes/_profile.md with buyer-specific overrides.'),
    checkFile('modes/init.md', 'modes/init.md found', 'Create the browser-session initialization mode.'),
    checkFile('modes/profile.md', 'modes/profile.md found', 'Create the interactive buyer-profile mode.'),
    checkFile('modes/hunt.md', 'modes/hunt.md found', 'Create the sequential hunt mode.'),
    checkFile('modes/evaluate.md', 'modes/evaluate.md found', 'Create the single-listing evaluation mode.'),
    checkFile('modes/compare.md', 'modes/compare.md found', 'Create the comparison mode.'),
    checkFile('modes/scan.md', 'modes/scan.md found', 'Restore the listing scan mode.'),
    checkFile('modes/tracker.md', 'modes/tracker.md found', 'Restore the tracker mode.'),
    checkFile('modes/deep.md', 'modes/deep.md found', 'Restore the deep research mode.'),
    checkFile('tools/chrome/home-ops-review-tabs/manifest.json', 'review-tabs extension manifest found', 'Restore tools/chrome/home-ops-review-tabs/manifest.json for hosted review tab automation.'),
    checkFile('tools/chrome/home-ops-review-tabs/bridge.html', 'review-tabs extension bridge found', 'Restore tools/chrome/home-ops-review-tabs/bridge.html for hosted review tab automation.'),
    ensureDir('data'),
    ensureDir('reports'),
    ensureDir('output'),
    ensureDir('output/browser-sessions'),
    ensureDir('batch/logs'),
    ensureDir('batch/tracker-additions'),
    ensureDir('batch/tracker-additions/merged'),
    checkTempArtifacts(),
    checkCommandDocs({ strict: STRICT }),
    ...(await checkProfileAndPortalCoverage(dependencyCheck.level === 'pass')),
  ];

  let failures = 0;
  let warningCount = 0;

  for (const result of checks) {
    if (result.level === 'pass') {
      console.log(`${green('✓')} ${result.label}`);
      continue;
    }

    if (result.level === 'warn') {
      warningCount += 1;
      console.log(`${yellow('!')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      fixes.filter(Boolean).forEach((hint) => console.log(`  ${dim(`→ ${hint}`)}`));
      continue;
    }

    failures += 1;
    console.log(`${red('✗')} ${result.label}`);
    const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
    fixes.filter(Boolean).forEach((hint) => console.log(`  ${dim(`→ ${hint}`)}`));
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run npm run doctor again.`);
    process.exit(1);
  }

  if (warningCount > 0) {
    console.log(`Result: All critical checks passed with ${warningCount} warning${warningCount === 1 ? '' : 's'}.`);
    process.exit(0);
  }

  console.log('Result: All checks passed. Home-ops is ready.');
}

main().catch((error) => {
  console.error('doctor.mjs failed:', error.message);
  process.exit(1);
});
