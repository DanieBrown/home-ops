#!/usr/bin/env node

/**
 * Open a URL in a new tab of the existing hosted Playwright/CDP browser.
 *
 * This is intentionally hosted-only: it never falls back to the OS default
 * browser. Commands that use it should ask the user to run browser:setup if
 * the hosted session is unavailable.
 */

import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { chromium } from 'playwright';
import { ROOT } from '../shared/paths.mjs';
import { readSessionState } from './browser-session.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_TARGET_URL = 'http://127.0.0.1:4179/';
const DEFAULT_TIMEOUT_MS = 10000;
const POLL_MS = 300;

const HELP_TEXT = `Usage:
  node scripts/browser/open-url-in-hosted-session.mjs [--url URL] [--profile chrome-host]

Options:
  --url <url>         URL to open. Defaults to http://127.0.0.1:4179/.
  --profile <name>   Hosted browser profile to reuse. Defaults to chrome-host.
  --timeout-ms <ms>  Server/CDP/navigation timeout. Defaults to 10000.
  --help             Show this help text.

Notes:
  - Opens a new tab in the existing hosted Playwright/CDP browser session.
  - Does not fall back to the OS default browser.
  - If no hosted session is running, run npm.cmd run browser:setup and retry.`;

function parseArgs(argv) {
  const config = {
    targetUrl: DEFAULT_TARGET_URL,
    profileName: DEFAULT_PROFILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--url') {
      config.targetUrl = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      config.timeoutMs = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (config.targetUrl !== DEFAULT_TARGET_URL) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    config.targetUrl = arg;
  }

  if (config.help) {
    return config;
  }

  if (!config.targetUrl) {
    throw new Error('A non-empty URL is required.');
  }

  try {
    const parsed = new URL(config.targetUrl);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
  } catch (error) {
    throw new Error(`Invalid URL: ${config.targetUrl}. ${error.message}`);
  }

  if (!config.profileName) {
    throw new Error('A non-empty profile name is required when using --profile.');
  }

  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error('Expected --timeout-ms to be a positive integer.');
  }

  return config;
}

function isLocalHttpUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function waitForLocalServer(targetUrl, timeoutMs) {
  if (!isLocalHttpUrl(targetUrl)) {
    return;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok || response.status < 500) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await delay(POLL_MS);
  }

  throw new Error(`Local server was not reachable at ${targetUrl} after ${timeoutMs}ms.`);
}

async function ensureHostedSession(profileName, timeoutMs) {
  const savedState = await readSessionState(ROOT, profileName);

  if (!savedState?.data) {
    throw new Error(
      `Hosted browser session not available for profile ${profileName}. `
      + 'Run npm.cmd run browser:setup, leave Chrome open, then retry.',
    );
  }

  const { data } = savedState;

  if (data.mode !== 'hosted' || data.status !== 'open' || !data.cdpUrl) {
    throw new Error(
      `Hosted browser session ${profileName} is not open. `
      + 'Run npm.cmd run browser:setup, leave Chrome open, then retry.',
    );
  }

  try {
    const response = await fetch(`${data.cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `Hosted browser session ${profileName} is not reachable: ${error.message}. `
      + 'Run npm.cmd run browser:setup, leave Chrome open, then retry.',
    );
  }

  return data;
}

async function openNewHostedTab({ cdpUrl, targetUrl, timeoutMs }) {
  const browser = await chromium.connectOverCDP(cdpUrl, {
    timeout: timeoutMs,
    isLocal: true,
  });
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error('Hosted browser session is running, but no default context was exposed.');
  }

  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.bringToFront().catch(() => {});
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
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

  await waitForLocalServer(config.targetUrl, config.timeoutMs);
  const session = await ensureHostedSession(config.profileName, config.timeoutMs);
  await openNewHostedTab({
    cdpUrl: session.cdpUrl,
    targetUrl: config.targetUrl,
    timeoutMs: config.timeoutMs,
  });

  console.log(`open-url: opened ${config.targetUrl} in a new hosted Playwright tab (${config.profileName})`);
}

const entryFile = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryFile && fileURLToPath(import.meta.url) === entryFile) {
  main().then(() => {
    process.exit(0);
  }).catch((error) => {
    console.error(`open-url: ${error.message}`);
    process.exit(1);
  });
}
