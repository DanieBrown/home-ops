#!/usr/bin/env node

/**
 * doctor.mjs -- Setup validation for home-ops.
 * Checks the core prerequisites for scanning, evaluating, and tracking homes.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const isTTY = process.stdout.isTTY;
const green = (value) => (isTTY ? `\x1b[32m${value}\x1b[0m` : value);
const red = (value) => (isTTY ? `\x1b[31m${value}\x1b[0m` : value);
const dim = (value) => (isTTY ? `\x1b[2m${value}\x1b[0m` : value);

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    if (existsSync(executablePath)) {
      return { pass: true, label: 'Playwright chromium installed' };
    }
  } catch {
    // fall through to failure below
  }

  return {
    pass: false,
    label: 'Playwright chromium not installed',
    fix: 'Run: npx playwright install chromium',
  };
}

function checkFile(relativePath, label, fix) {
  if (existsSync(join(projectRoot, relativePath))) {
    return { pass: true, label };
  }
  return { pass: false, label: `${label} missing`, fix };
}

function ensureDir(relativePath) {
  const fullPath = join(projectRoot, relativePath);
  if (existsSync(fullPath)) {
    return { pass: true, label: `${relativePath} ready` };
  }

  try {
    mkdirSync(fullPath, { recursive: true });
    return { pass: true, label: `${relativePath} ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${relativePath} could not be created`,
      fix: `Create ${relativePath} manually`,
    };
  }
}

async function main() {
  console.log('\nhome-ops doctor');
  console.log('===============\n');

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
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
    ensureDir('data'),
    ensureDir('reports'),
    ensureDir('output'),
    ensureDir('output/browser-sessions'),
    ensureDir('batch/logs'),
    ensureDir('batch/tracker-additions'),
    ensureDir('batch/tracker-additions/merged'),
  ];

  let failures = 0;

  for (const result of checks) {
    if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
      continue;
    }

    failures += 1;
    console.log(`${red('✗')} ${result.label}`);
    const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
    fixes.forEach((hint) => console.log(`  ${dim(`→ ${hint}`)}`));
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run npm run doctor again.`);
    process.exit(1);
  }

  console.log('Result: All checks passed. Home-ops is ready.');
}

main().catch((error) => {
  console.error('doctor.mjs failed:', error.message);
  process.exit(1);
});
