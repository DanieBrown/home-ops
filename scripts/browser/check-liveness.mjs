#!/usr/bin/env node

/**
 * check-liveness.mjs -- Playwright listing liveness checker.
 *
 * Tests whether real-estate listing URLs are still active or have moved to a
 * sold, pending, off-market, or removed state.
 *
 * Usage:
 *   node check-liveness.mjs <url1> [url2] ...
 *   node check-liveness.mjs --file urls.txt
 *   node check-liveness.mjs --profile chrome-host <url1> [url2] ...
 *
 * Exit code: 0 if all active, 1 if any are inactive or uncertain.
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { chromium } from 'playwright';
import { connectToSavedBrowserSession } from './browser-session.mjs';

const INACTIVE_PATTERNS = [
  /off market/i,
  /no longer available/i,
  /listing (has been )?removed/i,
  /property (is )?no longer available/i,
  /this home is no longer/i,
  /delisted/i,
  /withdrawn from market/i,
  /sold\s+on\s+/i,
  /pending/i,
  /under contract/i,
  /contingent/i,
  /page not found/i,
  /404/i,
];

const INACTIVE_URL_PATTERNS = [
  /off-market/i,
  /sold/i,
  /pending/i,
  /delisted/i,
  /removed/i,
];

const ACTIVE_PATTERNS = [
  /schedule (a )?tour/i,
  /request (a )?tour/i,
  /contact (an )?(agent|realtor)/i,
  /ask a question/i,
  /save (this )?(home|listing)/i,
  /facts and features/i,
  /property details/i,
  /est\.? payment/i,
  /get pre-?qualified/i,
];

const ADDRESS_PATTERN = /\b\d{1,5}\s+[a-z0-9.' -]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|circle|cir|boulevard|blvd|way|place|pl)\b/i;
const MIN_CONTENT_CHARS = 400;

const HELP_TEXT = `Usage:
  node check-liveness.mjs <url1> [url2] ...
  node check-liveness.mjs --file urls.txt
  node check-liveness.mjs --profile chrome-host <url1> [url2] ...

Options:
  --file <path>        Read URLs from a text file.
  --profile <name>     Reuse a persistent browser profile from output/browser-sessions/<name>.
  --profile-dir <path> Reuse a persistent browser profile from an explicit directory.
  --channel <name>     Force a browser channel such as msedge, chrome, or chromium.
  --headed             Keep the browser window visible in non-profile mode.
  --help               Show this help text.`;

function parseArgs(argv) {
  const config = {
    urls: [],
    filePath: null,
    profileName: null,
    profileDir: null,
    channel: null,
    headed: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--file') {
      config.filePath = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--profile-dir') {
      config.profileDir = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--channel') {
      config.channel = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--headed') {
      config.headed = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    config.urls.push(arg);
  }

  if (config.filePath === '') {
    throw new Error('Expected a file path after --file.');
  }

  if (config.profileName === '') {
    throw new Error('Expected a profile name after --profile.');
  }

  if (config.profileDir === '') {
    throw new Error('Expected a directory path after --profile-dir.');
  }

  if (config.channel === '') {
    throw new Error('Expected a browser channel name after --channel.');
  }

  return config;
}

async function checkUrl(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = response?.status() ?? 0;
    if (status === 404 || status === 410) {
      return { result: 'expired', reason: `HTTP ${status}` };
    }

    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    if (INACTIVE_URL_PATTERNS.some((pattern) => pattern.test(finalUrl))) {
      return { result: 'expired', reason: `redirected to inactive URL: ${finalUrl}` };
    }

    const { title, bodyText } = await page.evaluate(() => ({
      title: document.title ?? '',
      bodyText: document.body?.innerText ?? '',
    }));
    const combined = `${title}\n${bodyText}`;

    if (INACTIVE_PATTERNS.some((pattern) => pattern.test(combined))) {
      return { result: 'expired', reason: 'inactive listing language detected' };
    }

    const hasActiveControls = ACTIVE_PATTERNS.some((pattern) => pattern.test(combined));
    const hasAddress = ADDRESS_PATTERN.test(combined);
    const hasListingDensity = combined.trim().length >= MIN_CONTENT_CHARS;

    if (hasActiveControls && hasAddress && hasListingDensity) {
      return { result: 'active', reason: 'address, active controls, and listing content detected' };
    }

    if (hasAddress && hasListingDensity) {
      return { result: 'uncertain', reason: 'listing-like content detected but no active tour/contact controls found' };
    }

    return { result: 'expired', reason: 'insufficient listing detail detected' };
  } catch (error) {
    return { result: 'expired', reason: `navigation error: ${error.message.split('\n')[0]}` };
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const urls = options.filePath
    ? (await readFile(options.filePath, 'utf-8')).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : options.urls;

  if (urls.length === 0) {
    console.error(HELP_TEXT);
    process.exit(1);
  }

  console.log(`Checking ${urls.length} URL(s)...\n`);

  let browser;
  let context;
  let page;
  let sessionMode = 'standalone';

  if (options.profileName || options.profileDir) {
    const launched = await connectToSavedBrowserSession({
      projectRoot: resolve('.'),
      profileName: options.profileName ?? 'chrome-host',
      userDataDir: options.profileDir ? resolve(options.profileDir) : null,
      channel: options.channel,
      targets: ['about:blank'],
    });

    browser = launched.browser;
    context = launched.context;
    page = launched.page;
    sessionMode = launched.mode;
    console.log(`Using saved browser profile: ${launched.userDataDir}`);
    console.log(`Browser channel: ${launched.channel}\n`);
    console.log(`Connection mode: ${sessionMode}\n`);
  } else {
    browser = await chromium.launch({
      headless: !options.headed,
      channel: options.channel ?? undefined,
    });
    page = await browser.newPage();
  }

  let active = 0;
  let expired = 0;
  let uncertain = 0;

  for (const url of urls) {
    const { result, reason } = await checkUrl(page, url);
    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    console.log(`${icon} ${result.padEnd(10)} ${url}`);
    if (result !== 'active') {
      console.log(`           ${reason}`);
    }

    if (result === 'active') active += 1;
    if (result === 'expired') expired += 1;
    if (result === 'uncertain') uncertain += 1;
  }

  if (context && sessionMode === 'persistent') {
    await context.close();
  }

  if (browser) {
    await browser.close();
  }

  console.log(`\nResults: ${active} active  ${expired} inactive  ${uncertain} uncertain`);
  if (expired > 0 || uncertain > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
