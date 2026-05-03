#!/usr/bin/env node
/**
 * open-browser.mjs — Open the profile wizard in the hosted CDP browser session.
 *
 * Usage: node scripts/profile-wizard/open-browser.mjs [--url http://127.0.0.1:4178/]
 *
 * Connects to the existing hosted Chrome session (output/browser-sessions/chrome-host/session-state.json)
 * via CDP, opens the wizard URL in a new tab, then disconnects — leaving the browser running.
 * Falls back to OS-native launcher if no hosted session is found.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { spawn } from 'child_process';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SESSION_STATE_PATH = join(ROOT, 'output', 'browser-sessions', 'chrome-host', 'session-state.json');

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

async function openViaCDP(cdpUrl) {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto(TARGET_URL);
  // Do not call browser.close() — the remote Chrome process must keep running.
  // Playwright CDP connections do not kill the browser when Node exits.
}

function openViaOS() {
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/c', 'start', '', TARGET_URL], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [TARGET_URL], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [TARGET_URL], { detached: true, stdio: 'ignore' });
  }
  child.unref();
}

const ready = await waitForServer(TARGET_URL, MAX_WAIT_MS);
if (!ready) {
  console.error(`open-browser: server not reachable at ${TARGET_URL} after ${MAX_WAIT_MS / 1000}s`);
  process.exit(1);
}

// Try hosted CDP session first.
let cdpUrl = null;
try {
  const raw = await readFile(SESSION_STATE_PATH, 'utf8');
  const state = JSON.parse(raw);
  cdpUrl = state?.cdpUrl ?? state?.data?.cdpUrl ?? null;
} catch { /* no session yet */ }

if (cdpUrl) {
  try {
    await openViaCDP(cdpUrl);
    console.log(`open-browser: wizard open at ${TARGET_URL} (hosted CDP session)`);
    process.exit(0);
  } catch (err) {
    console.warn(`open-browser: CDP connect failed (${err.message}), falling back to OS launcher`);
  }
}

openViaOS();
console.log(`open-browser: wizard open at ${TARGET_URL} (OS launcher)`);
process.exit(0);
