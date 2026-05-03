#!/usr/bin/env node
/**
 * open-browser.mjs — Open the profile wizard in a headed Playwright browser.
 *
 * Usage: node scripts/profile-wizard/open-browser.mjs [--url http://127.0.0.1:4178/]
 *
 * Waits up to 10 s for the server to be reachable before opening the page.
 * Exits immediately after the browser tab opens — does not keep the process alive.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const urlArgIndex = args.indexOf('--url');
const TARGET_URL = urlArgIndex !== -1 ? args[urlArgIndex + 1] : 'http://127.0.0.1:4178/';
const MAX_WAIT_MS = 10_000;
const POLL_MS = 300;

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status < 500) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

const ready = await waitForServer(TARGET_URL, MAX_WAIT_MS);
if (!ready) {
  console.error(`open-browser: server not reachable at ${TARGET_URL} after ${MAX_WAIT_MS / 1000}s`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto(TARGET_URL);
console.log(`open-browser: wizard open at ${TARGET_URL}`);
// Detach — the browser window stays open after this process exits.
await browser.disconnect().catch(() => {});
process.exit(0);
