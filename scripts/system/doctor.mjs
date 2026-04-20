#!/usr/bin/env node

/**
 * doctor.mjs -- Setup validation for home-ops.
 * Checks the core prerequisites for scanning, evaluating, and tracking homes.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

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
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return passResult('Dependencies installed');
  }

  return failResult('Dependencies not installed', 'Run: npm install');
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

  return failResult('Playwright chromium not installed', 'Run: npx playwright install chromium');
}

function checkFile(relativePath, label, fix) {
  if (existsSync(join(projectRoot, relativePath))) {
    return passResult(label);
  }

  return failResult(`${label} missing`, fix);
}

function ensureDir(relativePath) {
  const fullPath = join(projectRoot, relativePath);
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
      'Run npm install, then rerun doctor to validate YAML-backed search area and source coverage.',
    )];
  }

  const profilePath = join(projectRoot, 'config', 'profile.yml');
  const portalsPath = join(projectRoot, 'portals.yml');
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
