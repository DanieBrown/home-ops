#!/usr/bin/env node

// Reset first-party browser state for one or more configured portal sites.
//
// This is a troubleshooting helper for a stale or corrupt hosted-browser
// session. It is intentionally not an anti-bot bypass: it does not change the
// browser fingerprint, network address, or retry a blocked workflow.

import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { parseArgs } from '../shared/cli.mjs';
import { ROOT } from '../shared/paths.mjs';
import { readSessionState } from './browser-session.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const CONNECT_TIMEOUT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 30000;

export const PLATFORM_SITE_DATA = {
  zillow: {
    name: 'Zillow',
    domains: ['zillow.com'],
    origins: ['https://www.zillow.com', 'https://zillow.com'],
    homeUrl: 'https://www.zillow.com/',
  },
  redfin: {
    name: 'Redfin',
    domains: ['redfin.com'],
    origins: ['https://www.redfin.com', 'https://redfin.com'],
    homeUrl: 'https://www.redfin.com/',
  },
  realtor: {
    name: 'Realtor.com',
    domains: ['realtor.com'],
    origins: ['https://www.realtor.com', 'https://realtor.com'],
    homeUrl: 'https://www.realtor.com/',
  },
  homes: {
    name: 'Homes.com',
    domains: ['homes.com'],
    origins: ['https://www.homes.com', 'https://homes.com'],
    homeUrl: 'https://www.homes.com/',
  },
};

const REFRESH_SCHEMA = {
  '--profile': { type: 'value', key: 'profileName' },
  '--no-open': { type: 'flag', key: 'noOpen' },
  '--zillow': { type: 'platform', include: 'zillow' },
  '--redfin': { type: 'platform', include: 'redfin' },
  '--relator': { type: 'platform', include: 'realtor' },
  '--realtor': { type: 'platform', include: 'realtor' },
  '--realtor.com': { type: 'platform', include: 'realtor' },
  '--homes': { type: 'platform', include: 'homes' },
  '--homes.com': { type: 'platform', include: 'homes' },
};

const REFRESH_DEFAULTS = {
  profileName: DEFAULT_PROFILE,
  noOpen: false,
};

const HELP_TEXT = `Usage:
  node refresh-site-data.mjs --relator
  node refresh-site-data.mjs --zillow --redfin
  node refresh-site-data.mjs --relator --no-open

Options:
  --zillow        Reset first-party Zillow browser data.
  --redfin        Reset first-party Redfin browser data.
  --relator       Reset first-party Realtor.com browser data.
  --realtor       Backward-compatible alias for --relator.
  --homes         Reset first-party Homes.com browser data.
  --profile NAME  Hosted browser profile (default: chrome-host).
  --no-open       Do not open a clean portal homepage after the reset.
  --help          Show this help text.

The command requires an active hosted browser session and at least one portal
flag. It closes only matching portal tabs, clears matching first-party cookies
and origin storage, and clears the browser's shared HTTP cache. Other portal
cookies remain intact. It does not bypass a server-side access restriction.`;

export function hostnameMatchesDomains(hostname, domains) {
  const normalizedHost = String(hostname ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return domains.some((domain) => {
    const normalizedDomain = String(domain).trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
  });
}

export function urlMatchesPlatform(rawUrl, platform) {
  const spec = PLATFORM_SITE_DATA[platform];
  if (!spec) return false;

  try {
    const parsed = new URL(String(rawUrl ?? ''));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && hostnameMatchesDomains(parsed.hostname, spec.domains);
  } catch {
    return false;
  }
}

function cookieMatchesPlatforms(cookie, platforms) {
  return platforms.some((platform) => {
    const spec = PLATFORM_SITE_DATA[platform];
    return spec && hostnameMatchesDomains(cookie?.domain, spec.domains);
  });
}

export function parseRefreshArgs(argv) {
  const config = parseArgs(argv, REFRESH_SCHEMA, { defaults: REFRESH_DEFAULTS });
  if (!config.help && config.selectedPlatforms.size === 0) {
    throw new Error('Choose at least one portal flag, such as --relator. The command will not clear every login implicitly.');
  }
  if (!config.profileName) {
    throw new Error('Expected a non-empty profile name after --profile.');
  }
  return config;
}

async function checkCdpReachable(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function clearPortalSiteData(context, platforms, { clearHttpCache = true } = {}) {
  const selected = [...new Set(platforms)];
  for (const platform of selected) {
    if (!PLATFORM_SITE_DATA[platform]) {
      throw new Error(`Unsupported portal for site-data refresh: ${platform}`);
    }
  }

  const matchingPages = context.pages().filter((page) =>
    selected.some((platform) => urlMatchesPlatform(page.url(), platform)));
  for (const page of matchingPages) {
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }

  const cookiesBefore = await context.cookies();
  const matchingCookiesBefore = cookiesBefore.filter((cookie) => cookieMatchesPlatforms(cookie, selected));

  for (const platform of selected) {
    for (const domain of PLATFORM_SITE_DATA[platform].domains) {
      const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await context.clearCookies({ domain: new RegExp(`(^|\\.)${escaped}$`, 'i') });
    }
  }

  const controlPage = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(controlPage);
  try {
    for (const platform of selected) {
      for (const origin of PLATFORM_SITE_DATA[platform].origins) {
        await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      }
    }
    if (clearHttpCache) {
      await cdp.send('Network.clearBrowserCache');
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  const cookiesAfter = await context.cookies();
  const matchingCookiesAfter = cookiesAfter.filter((cookie) => cookieMatchesPlatforms(cookie, selected));
  return {
    closedTabs: matchingPages.length,
    clearedCookies: Math.max(0, matchingCookiesBefore.length - matchingCookiesAfter.length),
    remainingMatchingCookies: matchingCookiesAfter.length,
    clearedHttpCache: clearHttpCache,
  };
}

export async function refreshSavedHostedSession({
  projectRoot = ROOT,
  profileName = DEFAULT_PROFILE,
  platforms,
  openHomepages = true,
} = {}) {
  const session = await readSessionState(projectRoot, profileName);
  if (!session?.data || session.data.mode !== 'hosted' || !session.data.cdpUrl) {
    throw new Error(`No hosted browser session metadata found for profile ${profileName}. Run npm.cmd run browser:setup first.`);
  }
  if (!await checkCdpReachable(session.data.cdpUrl)) {
    throw new Error(`Hosted browser session ${profileName} is not reachable. Run npm.cmd run browser:setup first.`);
  }

  const browser = await chromium.connectOverCDP(session.data.cdpUrl, {
    timeout: CONNECT_TIMEOUT_MS,
    isLocal: true,
  });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(`Hosted browser profile ${profileName} exposed no default context.`);
    }

    const result = await clearPortalSiteData(context, platforms);
    const opened = [];
    if (openHomepages) {
      for (const platform of platforms) {
        const spec = PLATFORM_SITE_DATA[platform];
        const page = await context.newPage();
        try {
          await page.goto(spec.homeUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        } catch {
          // Keep the tab open so the user can refresh or complete a challenge manually.
        }
        opened.push({ platform, url: spec.homeUrl });
      }
    }
    return { ...result, opened };
  } finally {
    // Disconnect from CDP without closing the user's hosted browser.
    await browser.close().catch(() => {});
  }
}

async function main() {
  let config;
  try {
    config = parseRefreshArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exitCode = 1;
    return;
  }

  if (config.help) {
    console.log(HELP_TEXT);
    return;
  }

  const platforms = [...config.selectedPlatforms];
  const result = await refreshSavedHostedSession({
    profileName: config.profileName,
    platforms,
    openHomepages: !config.noOpen,
  });
  const names = platforms.map((platform) => PLATFORM_SITE_DATA[platform].name).join(', ');

  console.log(`Refreshed first-party site data for: ${names}`);
  console.log(`Closed matching tabs: ${result.closedTabs}`);
  console.log(`Cleared matching cookies: ${result.clearedCookies}`);
  console.log('Cleared origin storage: yes');
  console.log(`Cleared shared HTTP cache: ${result.clearedHttpCache ? 'yes' : 'no'}`);
  console.log(`Opened clean homepages: ${result.opened.length}`);
  console.log('Complete any sign-in or human-verification step manually. If the site still blocks access, stop and retry later; this command does not bypass server-side restrictions.');
}

const entryFile = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryFile && fileURLToPath(import.meta.url) === entryFile) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
