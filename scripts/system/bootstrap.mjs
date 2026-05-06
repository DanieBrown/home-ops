#!/usr/bin/env node

/**
 * bootstrap.mjs -- dependency preflight and first-run installer for Home-Ops.
 *
 * Keep this script dependency-free. It runs before browser/init commands that
 * import Playwright or YAML, so it must work when node_modules is absent.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const REQUIRED_NODE_MAJOR = 18;
const REQUIRED_PYTHON = { major: 3, minor: 10 };

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npmCommandArgs(args) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, ...args],
    };
  }

  return {
    command: npmBin,
    args,
  };
}

function run(command, args, label) {
  console.log(`[bootstrap] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status}`);
  }
}

function runOptional(command, args, label) {
  console.log(`[bootstrap] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.warn(`[bootstrap] Optional step failed: ${result.error.message}`);
    return false;
  }

  if (result.status !== 0) {
    console.warn(`[bootstrap] Optional step exited with status ${result.status}`);
    return false;
  }

  return true;
}

function runCapture(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major >= REQUIRED_NODE_MAJOR) return;
  throw new Error(`Node.js ${REQUIRED_NODE_MAJOR}+ is required; found ${process.version}.`);
}

function parseArgs(argv) {
  return {
    setupPython: argv.includes('--python'),
    installPython: argv.includes('--install-python'),
  };
}

function npmIsAvailable() {
  const npm = npmCommandArgs(['--version']);
  const result = spawnSync(npm.command, npm.args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0;
}

function packageIsResolvable(packageName) {
  try {
    require.resolve(packageName, { paths: [ROOT] });
    return true;
  } catch {
    return false;
  }
}

function dependenciesAreInstalled() {
  return existsSync(join(ROOT, 'node_modules'))
    && packageIsResolvable('playwright')
    && packageIsResolvable('yaml');
}

function playwrightChromiumIsInstalled() {
  try {
    const { chromium } = require('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function pythonCandidates() {
  return process.platform === 'win32'
    ? [['py', ['-3']], ['python3', []], ['python', []]]
    : [['python3', []], ['python', []]];
}

function parsePythonVersion(output) {
  const match = String(output ?? '').match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    text: match[0],
  };
}

function pythonVersionIsSupported(version) {
  if (!version) return false;
  if (version.major > REQUIRED_PYTHON.major) return true;
  return version.major === REQUIRED_PYTHON.major && version.minor >= REQUIRED_PYTHON.minor;
}

function findSupportedPython() {
  for (const [bin, baseArgs] of pythonCandidates()) {
    const result = runCapture(bin, [...baseArgs, '--version']);
    if (result.status !== 0) continue;

    const version = parsePythonVersion(`${result.stdout}\n${result.stderr}`);
    if (pythonVersionIsSupported(version)) {
      return { bin, baseArgs, version };
    }
  }

  return null;
}

function wingetIsAvailable() {
  if (process.platform !== 'win32') return false;
  return runCapture('winget', ['--version']).status === 0;
}

function attemptPythonRuntimeInstall() {
  if (process.platform !== 'win32') {
    console.warn('[bootstrap] Python auto-install is currently only attempted on Windows with winget.');
    return false;
  }

  if (!wingetIsAvailable()) {
    console.warn('[bootstrap] winget was not found, so Python could not be auto-installed.');
    return false;
  }

  return runOptional('winget', [
    'install',
    '--exact',
    '--id',
    'Python.Python.3.12',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ], 'Installing Python 3.12 with winget');
}

function pythonModuleIsImportable(python, moduleName) {
  const result = runCapture(python.bin, [...python.baseArgs, '-c', `import ${moduleName}`]);
  return result.status === 0;
}

function setupPythonSidecar({ installPython = false } = {}) {
  let python = findSupportedPython();

  if (!python && installPython) {
    attemptPythonRuntimeInstall();
    python = findSupportedPython();
  }

  if (!python) {
    const setupHint = process.platform === 'win32'
      ? 'Install Python 3.10+ or rerun: npm run bootstrap:python'
      : 'Install Python 3.10+, then run: npm run bootstrap -- --python';
    console.warn(`[bootstrap] Python ${REQUIRED_PYTHON.major}.${REQUIRED_PYTHON.minor}+ not found; school metadata sidecar will use the Node fallback. ${setupHint}`);
    return;
  }

  const label = `${python.bin}${python.baseArgs.length ? ` ${python.baseArgs.join(' ')}` : ''}`;
  console.log(`[bootstrap] Python sidecar interpreter: ${label} (${python.version.text})`);

  if (!pythonModuleIsImportable(python, 'crawl4ai')) {
    runOptional(
      python.bin,
      [...python.baseArgs, '-m', 'pip', 'install', '-r', 'scripts/research/python/requirements.txt'],
      'Installing Python sidecar packages',
    );
  } else {
    console.log('[bootstrap] Python sidecar packages already installed');
  }

  if (!pythonModuleIsImportable(python, 'playwright')) {
    console.warn('[bootstrap] Python Playwright module is still unavailable after package setup; school metadata sidecar may fall back to Node fetch().');
    return;
  }

  runOptional(
    python.bin,
    [...python.baseArgs, '-m', 'playwright', 'install', 'chromium'],
    'Installing Python Playwright Chromium',
  );

  runOptional(
    python.bin,
    [...python.baseArgs, '-m', 'crawl4ai.install'],
    'Installing crawl4ai browser assets',
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  checkNodeVersion();

  if (!npmIsAvailable()) {
    throw new Error('npm is required but was not found on PATH. Reopen your terminal after installing Node.js, then rerun init.');
  }

  if (!dependenciesAreInstalled()) {
    const npm = npmCommandArgs(['install']);
    run(npm.command, npm.args, 'Installing project dependencies');
  } else {
    console.log('[bootstrap] Project dependencies already installed');
  }

  if (!playwrightChromiumIsInstalled()) {
    const npm = npmCommandArgs(['exec', '--', 'playwright', 'install', 'chromium']);
    run(npm.command, npm.args, 'Installing Playwright Chromium');
  } else {
    console.log('[bootstrap] Playwright Chromium already installed');
  }

  if (options.setupPython) {
    setupPythonSidecar({ installPython: options.installPython });
  }
}

try {
  main();
} catch (error) {
  console.error(`[bootstrap] ${error.message}`);
  process.exit(1);
}
