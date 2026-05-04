#!/usr/bin/env node

/**
 * browser-extract-utils.mjs -- Shared CDP attach + page navigation/settle helpers
 * factored out of sentiment-browser-extract.mjs and community-lookup.mjs so the
 * new listing/school extractors can reuse the same battle-tested patterns.
 *
 * The point of this module is one canonical "attach and drive a hosted Chrome"
 * shape so per-extractor scripts can focus on portal-specific parsing.
 */

import { chromium } from 'playwright';
import { readSessionState } from './browser-session.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_NAV_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_CDP_HANDSHAKE_TIMEOUT_MS = 30000;

/**
 * Read the saved hosted-session state file and confirm CDP is reachable.
 * Throws if the session is missing, closed, or unreachable. The caller is
 * expected to surface that error to the user (run /home-ops init).
 */
export async function ensureHostedSession(projectRoot, profileName = DEFAULT_PROFILE) {
  const session = await readSessionState(projectRoot, profileName);
  if (!session?.data) {
    throw new Error(`No hosted browser session found for profile ${profileName}. Run /home-ops init first.`);
  }
  const data = session.data;
  if (data.mode !== 'hosted' || data.status !== 'open' || !data.cdpUrl) {
    throw new Error(`Hosted browser session ${profileName} is not ready. Run /home-ops init first.`);
  }
  try {
    const response = await fetch(`${data.cdpUrl}/json/version`);
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Hosted browser session ${profileName} is not reachable: ${error.message}`);
  }
  return data;
}

/**
 * Connect Playwright to the hosted Chrome via CDP and return the default
 * browser context. The caller is responsible for closing the browser when done.
 */
export async function attachHostedBrowser(projectRoot, profileName = DEFAULT_PROFILE) {
  const session = await ensureHostedSession(projectRoot, profileName);
  const browser = await chromium.connectOverCDP(session.cdpUrl, {
    timeout: DEFAULT_CDP_HANDSHAKE_TIMEOUT_MS,
    isLocal: true,
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error('Hosted browser session is running, but no default context was exposed.');
  }
  return { browser, context, session };
}

/**
 * Navigate a page to the given URL, settle briefly, and (optionally) wait for
 * a selector. Returns the page on success; on navigation failure, returns
 * { page: null, error }. The page object exposes navigationStatus when the
 * caller needs to detect blocks/redirects.
 */
export async function navigateAndSettle(context, url, opts = {}) {
  const navTimeout = opts.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const waitForSelector = opts.waitForSelector ?? null;
  const waitForSelectorTimeout = opts.waitForSelectorTimeoutMs ?? 8000;

  const page = await context.newPage();
  let response = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (error) {
    return { page: null, response: null, error };
  }

  await page.waitForTimeout(settleMs);

  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: waitForSelectorTimeout }).catch(() => null);
  }

  return { page, response, error: null };
}

/**
 * Read a structured-data candidate (JSON-LD or hydration script) from a page.
 * Returns the first matching object that satisfies `predicate`, or null when
 * nothing matches. Errors are swallowed; the caller is expected to fall back
 * to selector-based extraction when this returns null.
 */
export async function readStructuredData(page, opts = {}) {
  const evaluator = opts.evaluator;
  if (typeof evaluator !== 'function') {
    throw new Error('readStructuredData requires an evaluator function');
  }
  try {
    return await page.evaluate(evaluator);
  } catch {
    return null;
  }
}

/**
 * Close the page and (optionally) the browser, swallowing errors so caller
 * scripts don't have to wrap every cleanup call.
 */
export async function safeClose({ page, browser } = {}) {
  if (page) {
    await page.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
}

export const DEFAULTS = {
  profile: DEFAULT_PROFILE,
  navigationTimeoutMs: DEFAULT_NAV_TIMEOUT_MS,
  settleMs: DEFAULT_SETTLE_MS,
};
