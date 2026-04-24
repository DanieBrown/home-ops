#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { access, appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import YAML from 'yaml';

const DEFAULT_PROFILE = 'chrome';
const DEFAULT_HOSTED_PROFILE = 'chrome-host';
const DEFAULT_CHANNELS = ['chrome', 'msedge', 'chromium'];
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CDP_PORT = 9222;
const REVIEW_EXTENSION_RELATIVE_DIR = ['tools', 'chrome', 'home-ops-review-tabs'];
const REVIEW_EXTENSION_NAME = 'home-ops-review-tabs';

const PORTAL_ALIASES = {
  facebook: 'facebook',
  greatschools: 'greatschools',
  nextdoor: 'nextdoor',
  relator: 'realtor',
  'realtor.com': 'realtor',
  'homes.com': 'homes',
};

const FALLBACK_PORTAL_TARGETS = {
  zillow: {
    name: 'Zillow',
    baseUrl: 'https://www.zillow.com/',
    searchUrls: ['https://www.zillow.com/'],
    loginRequired: true,
  },
  redfin: {
    name: 'Redfin',
    baseUrl: 'https://www.redfin.com/',
    searchUrls: ['https://www.redfin.com/'],
    loginRequired: true,
  },
  realtor: {
    name: 'Realtor.com',
    baseUrl: 'https://www.realtor.com/',
    searchUrls: ['https://www.realtor.com/'],
    loginRequired: true,
  },
  homes: {
    name: 'Homes.com',
    baseUrl: 'https://www.homes.com/',
    searchUrls: ['https://www.homes.com/'],
    loginRequired: true,
  },
  facebook: {
    name: 'Facebook',
    baseUrl: 'https://www.facebook.com/',
    searchUrls: ['https://www.facebook.com/'],
    loginRequired: true,
  },
  nextdoor: {
    name: 'Nextdoor',
    baseUrl: 'https://nextdoor.com/',
    searchUrls: ['https://nextdoor.com/'],
    loginRequired: true,
  },
};

const PLATFORM_FLAG_MAP = {
  '--facebook': 'facebook',
  '--greatschools': 'greatschools',
  '--nextdoor': 'nextdoor',
  '--zillow': 'zillow',
  '--redfin': 'redfin',
  '--realtor': 'realtor',
  '--realtor.com': 'realtor',
  '--relator': 'realtor',
  '--homes': 'homes',
  '--homes.com': 'homes',
};

const LOG_FILE_HEADER = 'opened_at\tclosed_at\tcaller\tprofile\tchannel\tplatforms\tuser_data_dir\tstatus\ttargets\n';

const HELP_TEXT = `Usage:
  node browser-session.mjs [portal|configured|all|url] [--profile NAME] [--channel CHANNEL]
  node browser-session.mjs --zillow --redfin --relator --homes --facebook --nextdoor --greatschools [--searches] [--caller scan]
  node browser-session.mjs configured --hosted --channel chrome [--caller setup]
  node browser-session.mjs --status [--profile NAME]

Examples:
  node browser-session.mjs configured --searches
  node browser-session.mjs zillow --profile chrome
  node browser-session.mjs --zillow --redfin --searches --caller scan
  node browser-session.mjs configured --hosted --channel chrome
  node browser-session.mjs --platform realtor --searches
  node browser-session.mjs --homes --hosted --caller init
  node browser-session.mjs --facebook --nextdoor --hosted --caller init
  node browser-session.mjs --greatschools --hosted --caller research
  node browser-session.mjs --status --profile chrome-host
  node browser-session.mjs https://www.zillow.com/

Notes:
  - This opens a headed persistent browser profile stored under output/browser-sessions/.
  - Chrome is preferred by default when it is installed locally.
  - Use --hosted to launch a real local Chrome window with a separate user-data-dir and CDP enabled.
  - When portals.yml is present, named targets come from its platforms plus supplemental source inventories such as sentiment_sources and school_sources.
  - The default configured set still limits itself to login-required targets.
  - Use --searches to open the configured search URLs instead of just the platform home pages.
  - Sign in manually, complete any captcha or anti-bot checks yourself, then close the browser.
  - The saved profile can be reused by other Playwright scripts in this repo.`;

function getProjectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function resolveBrowserProfileDir(projectRoot, profileName = DEFAULT_PROFILE) {
  return join(projectRoot, 'output', 'browser-sessions', profileName);
}

export function resolveReviewExtensionDir(projectRoot) {
  return join(projectRoot, ...REVIEW_EXTENSION_RELATIVE_DIR);
}

function resolveBrowserSessionLogPath(projectRoot) {
  return join(projectRoot, 'batch', 'logs', 'browser-sessions.tsv');
}

export function resolveBrowserSessionStatePath(projectRoot, profileName = DEFAULT_PROFILE) {
  return join(resolveBrowserProfileDir(projectRoot, profileName), 'session-state.json');
}

function normalizePlatformKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function canonicalPlatformKey(value) {
  const normalized = normalizePlatformKey(value);
  return PORTAL_ALIASES[normalized] ?? normalized;
}

function simplifyPlatformKey(value) {
  return canonicalPlatformKey(value).replace(/[^a-z0-9]+/g, '');
}

function buildPortalTargets(platformsNode) {
  if (!platformsNode || typeof platformsNode !== 'object') {
    return {};
  }

  const portalTargets = {};

  for (const [rawKey, rawValue] of Object.entries(platformsNode)) {
    if (!rawValue || typeof rawValue !== 'object') {
      continue;
    }

    const key = canonicalPlatformKey(rawKey);
    const searchUrls = Array.isArray(rawValue.search_urls)
      ? rawValue.search_urls
        .map((entry) => (typeof entry?.url === 'string' ? entry.url.trim() : ''))
        .filter(Boolean)
      : [];
    const baseUrl = typeof rawValue.base_url === 'string' && rawValue.base_url.trim()
      ? rawValue.base_url.trim()
      : searchUrls[0] ?? null;

    if (!baseUrl && searchUrls.length === 0) {
      continue;
    }

    portalTargets[key] = {
      name: typeof rawValue.name === 'string' && rawValue.name.trim() ? rawValue.name.trim() : rawKey,
      baseUrl: baseUrl ?? searchUrls[0],
      searchUrls,
      loginRequired: rawValue.login_required !== false,
    };
  }

  return portalTargets;
}

function buildSupplementalTargets(sourceNode) {
  if (!sourceNode || typeof sourceNode !== 'object') {
    return {};
  }

  const targets = {};

  for (const [rawKey, rawValue] of Object.entries(sourceNode)) {
    if (!rawValue || typeof rawValue !== 'object') {
      continue;
    }

    const key = canonicalPlatformKey(rawKey);
    const searchUrls = Array.isArray(rawValue.search_urls)
      ? rawValue.search_urls
        .map((entry) => (typeof entry?.url === 'string' ? entry.url.trim() : ''))
        .filter(Boolean)
      : [];
    const baseUrl = typeof rawValue.base_url === 'string' && rawValue.base_url.trim()
      ? rawValue.base_url.trim()
      : typeof rawValue.url === 'string' && rawValue.url.trim()
        ? rawValue.url.trim()
        : searchUrls[0] ?? FALLBACK_PORTAL_TARGETS[key]?.baseUrl ?? null;

    if (!baseUrl && searchUrls.length === 0) {
      continue;
    }

    targets[key] = {
      name: typeof rawValue.name === 'string' && rawValue.name.trim()
        ? rawValue.name.trim()
        : FALLBACK_PORTAL_TARGETS[key]?.name ?? rawKey,
      baseUrl: baseUrl ?? searchUrls[0],
      searchUrls: searchUrls.length > 0 ? searchUrls : [baseUrl ?? ''].filter(Boolean),
      loginRequired: rawValue.login_required !== false,
    };
  }

  return targets;
}

export async function loadBrowserTargets(projectRoot) {
  const portalsPath = join(projectRoot, 'portals.yml');

  try {
    const content = await readFile(portalsPath, 'utf8');
    const parsed = YAML.parse(content) ?? {};
    const browserTargets = {
      ...buildPortalTargets(parsed.platforms),
      ...buildSupplementalTargets(parsed.sentiment_sources),
      ...buildSupplementalTargets(parsed.school_sources),
    };

    return Object.keys(browserTargets).length > 0 ? browserTargets : { ...FALLBACK_PORTAL_TARGETS };
  } catch {
    return { ...FALLBACK_PORTAL_TARGETS };
  }
}

function resolveConfiguredPlatforms(portalTargets) {
  return Object.entries(portalTargets)
    .filter(([, config]) => config.loginRequired)
    .map(([key]) => key);
}

function resolveNamedPlatform(name, portalTargets) {
  const directKey = canonicalPlatformKey(name);
  if (portalTargets[directKey]) {
    return directKey;
  }

  const simplified = simplifyPlatformKey(name);
  return Object.keys(portalTargets)
    .find((candidate) => simplifyPlatformKey(candidate) === simplified) ?? null;
}

function normalizeTargetSelection({ target, selectedPlatforms, useSearchUrls, portalTargets }) {
  let labels = [];

  if (selectedPlatforms.length > 0) {
    labels = selectedPlatforms.map((platform) => {
      const resolved = resolveNamedPlatform(platform, portalTargets);
      if (!resolved) {
        throw new Error(`Unknown configured platform: ${platform}`);
      }
      return resolved;
    });
  } else if (!target || target === 'all') {
    labels = Object.keys(portalTargets);
  } else if (target === 'configured') {
    labels = resolveConfiguredPlatforms(portalTargets);
  } else {
    const resolved = resolveNamedPlatform(target, portalTargets);
    if (resolved) {
      labels = [resolved];
    } else if (/^https?:\/\//i.test(target)) {
      return {
        urls: [target],
        labels: ['custom-url'],
      };
    } else {
      throw new Error(`Unknown portal target: ${target}`);
    }
  }

  if (labels.length === 0) {
    throw new Error('No configured browser session targets were found. Check portals.yml or pass an explicit URL.');
  }

  const urls = [];
  const seen = new Set();

  for (const label of labels) {
    const config = portalTargets[label];
    const candidates = useSearchUrls && config.searchUrls.length > 0
      ? config.searchUrls
      : [config.baseUrl];

    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      urls.push(candidate);
    }
  }

  return { urls, labels };
}

export async function appendSessionLog(projectRoot, row) {
  const logPath = resolveBrowserSessionLogPath(projectRoot);
  await mkdir(dirname(logPath), { recursive: true });

  try {
    await access(logPath);
  } catch {
    await appendFile(logPath, LOG_FILE_HEADER, 'utf8');
  }

  await appendFile(logPath, `${row}\n`, 'utf8');
}

export async function writeSessionState(projectRoot, profileName, state) {
  const statePath = resolveBrowserSessionStatePath(projectRoot, profileName);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function readSessionState(projectRoot, profileName) {
  try {
    const statePath = resolveBrowserSessionStatePath(projectRoot, profileName);
    const content = await readFile(statePath, 'utf8');
    return {
      statePath,
      data: JSON.parse(content),
    };
  } catch {
    return null;
  }
}

function formatTargetsForLog(targets) {
  return targets.join(' | ');
}

function resolveBrowserExecutable(channel) {
  const normalized = channel ?? 'chrome';
  const platform = process.platform;

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

  const platformCandidates = candidatesByPlatform[platform] ?? {};
  const requestedChannels = normalized === 'chrome'
    ? ['chrome', 'msedge', 'chromium']
    : [normalized];

  for (const candidateChannel of requestedChannels) {
    const candidates = platformCandidates[candidateChannel] ?? [];
    const match = candidates.find((candidate) => existsSync(candidate));

    if (match) {
      return {
        channel: candidateChannel,
        executablePath: match,
        fallbackFrom: candidateChannel === normalized ? null : normalized,
      };
    }
  }

  throw new Error(`Could not find a local executable for browser channel: ${normalized}`);
}

async function waitForCdpEndpoint(endpointURL, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpointURL}/json/version`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Continue polling until timeout.
    }

    await delay(400);
  }

  throw new Error(`Timed out waiting for CDP endpoint at ${endpointURL}`);
}

export async function launchHostedBrowserSession({
  projectRoot = getProjectRoot(),
  profileName = DEFAULT_HOSTED_PROFILE,
  channel = 'chrome',
  targets = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cdpPort = DEFAULT_CDP_PORT,
} = {}) {
  const effectiveUserDataDir = resolveBrowserProfileDir(projectRoot, profileName);
  await mkdir(effectiveUserDataDir, { recursive: true });

  const resolvedBrowser = resolveBrowserExecutable(channel);
  const executablePath = resolvedBrowser.executablePath;
  const endpointURL = `http://127.0.0.1:${cdpPort}`;
  const reviewExtensionDir = resolveReviewExtensionDir(projectRoot);
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${effectiveUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${reviewExtensionDir}`,
    `--load-extension=${reviewExtensionDir}`,
    ...targets,
  ];

  const child = spawn(executablePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  const versionInfo = await waitForCdpEndpoint(endpointURL, timeoutMs);

  return {
    channel: resolvedBrowser.channel,
    requestedChannel: channel,
    fallbackFrom: resolvedBrowser.fallbackFrom,
    userDataDir: effectiveUserDataDir,
    executablePath,
    cdpPort,
    cdpUrl: endpointURL,
    wsEndpoint: versionInfo.webSocketDebuggerUrl ?? null,
    browserVersion: versionInfo.Browser ?? null,
    pid: child.pid ?? null,
    navigationResults: targets.map((target) => ({ target, ok: true })),
  };
}

export async function connectToSavedBrowserSession({
  projectRoot = getProjectRoot(),
  profileName = DEFAULT_PROFILE,
  userDataDir = null,
  channel = null,
  targets = ['about:blank'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!userDataDir) {
    const savedState = await readSessionState(projectRoot, profileName);

    if (savedState?.data?.mode === 'hosted' && savedState.data.cdpUrl) {
      const browser = await chromium.connectOverCDP(savedState.data.cdpUrl, {
        timeout: timeoutMs,
        isLocal: true,
      });
      const context = browser.contexts()[0];

      if (!context) {
        throw new Error(`Hosted browser profile ${profileName} is running, but no default context was exposed.`);
      }

      const page = context.pages()[0] ?? await context.newPage();

      return {
        mode: 'hosted',
        browser,
        context,
        page,
        channel: savedState.data.channel ?? 'chrome',
        userDataDir: savedState.data.userDataDir,
      };
    }
  }

  const launched = await launchPersistentBrowserSession({
    projectRoot,
    profileName,
    userDataDir,
    channel,
    targets,
    timeoutMs,
  });

  return {
    mode: 'persistent',
    browser: null,
    context: launched.context,
    page: launched.context.pages()[0] ?? await launched.context.newPage(),
    channel: launched.channel,
    userDataDir: launched.userDataDir,
  };
}

function reportFinalizeError(error) {
  console.error(`Warning: unable to update browser session state: ${error.message}`);
}

function parseArgs(argv) {
  const config = {
    target: 'all',
    profileName: DEFAULT_PROFILE,
    profileExplicit: false,
    channel: null,
    caller: 'manual',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cdpPort: DEFAULT_CDP_PORT,
    help: false,
    hosted: false,
    statusOnly: false,
    useSearchUrls: false,
    selectedPlatforms: new Set(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--status') {
      config.statusOnly = true;
      continue;
    }

    if (arg === '--searches') {
      config.useSearchUrls = true;
      continue;
    }

    if (arg === '--hosted') {
      config.hosted = true;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? '';
      config.profileExplicit = true;
      index += 1;
      continue;
    }

    if (arg === '--platform') {
      const platformName = argv[index + 1] ?? '';
      config.selectedPlatforms.add(platformName);
      index += 1;
      continue;
    }

    if (arg === '--channel') {
      config.channel = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--caller') {
      config.caller = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      config.timeoutMs = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }

    if (arg === '--cdp-port') {
      config.cdpPort = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }

    if (PLATFORM_FLAG_MAP[arg]) {
      config.selectedPlatforms.add(PLATFORM_FLAG_MAP[arg]);
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (config.selectedPlatforms.size > 0) {
      throw new Error('Do not mix a positional portal target with platform flags like --zillow or --redfin.');
    }

    if (config.target !== 'all') {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    config.target = arg;
  }

  if (config.hosted && !config.profileExplicit) {
    config.profileName = DEFAULT_HOSTED_PROFILE;
  }

  if (!config.profileName) {
    throw new Error('A non-empty profile name is required when using --profile.');
  }

  if ([...config.selectedPlatforms].some((platform) => !String(platform).trim())) {
    throw new Error('Expected a platform name after --platform.');
  }

  if (!config.caller) {
    throw new Error('A non-empty caller value is required when using --caller.');
  }

  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error('Expected --timeout-ms to be a positive integer.');
  }

  if (!Number.isFinite(config.cdpPort) || config.cdpPort <= 0) {
    throw new Error('Expected --cdp-port to be a positive integer.');
  }

  return config;
}

export async function launchPersistentBrowserSession({
  projectRoot = getProjectRoot(),
  profileName = DEFAULT_PROFILE,
  userDataDir = null,
  channel = null,
  targets = Object.values(FALLBACK_PORTAL_TARGETS).map((target) => target.baseUrl),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const effectiveUserDataDir = userDataDir ?? resolveBrowserProfileDir(projectRoot, profileName);
  await mkdir(effectiveUserDataDir, { recursive: true });

  const requestedChannels = channel ? [channel] : DEFAULT_CHANNELS;
  const errors = [];

  for (const candidate of requestedChannels) {
    try {
      const context = await chromium.launchPersistentContext(effectiveUserDataDir, {
        channel: candidate,
        headless: false,
        viewport: null,
        args: ['--start-maximized'],
      });

      const navigationResults = [];
      const firstPage = context.pages()[0] ?? await context.newPage();
      const [firstTarget, ...restTargets] = targets;
      const pages = [firstPage];

      for (let index = 0; index < restTargets.length; index += 1) {
        pages.push(await context.newPage());
      }

      const allTargets = [firstTarget, ...restTargets].filter(Boolean);
      for (let index = 0; index < allTargets.length; index += 1) {
        const target = allTargets[index];
        const page = pages[index] ?? await context.newPage();

        try {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          navigationResults.push({ target, ok: true });
        } catch (error) {
          navigationResults.push({ target, ok: false, error: error.message.split('\n')[0] });
        }
      }

      return {
        context,
        channel: candidate,
        userDataDir: effectiveUserDataDir,
        navigationResults,
      };
    } catch (error) {
      errors.push(`${candidate}: ${error.message.split('\n')[0]}`);
    }
  }

  throw new Error(`Unable to launch a supported browser channel. ${errors.join(' | ')}`);
}

async function printSessionStatus(projectRoot, profileName) {
  const state = await readSessionState(projectRoot, profileName);

  if (!state) {
    console.log(`No saved browser session metadata found for profile: ${profileName}`);
    console.log('Run npm run browser:setup to create a repo-local headed browser session.');
    return;
  }

  const { data, statePath } = state;
  console.log(`Profile: ${profileName}`);
  console.log(`State file: ${statePath}`);
  console.log(`Mode: ${data.mode ?? 'persistent'}`);
  console.log(`Status: ${data.status}`);
  console.log(`Channel: ${data.channel}`);
  console.log(`Opened at: ${data.openedAt}`);
  console.log(`Closed at: ${data.closedAt ?? 'still open or not recorded'}`);
  console.log(`Caller: ${data.caller}`);
  console.log(`Platforms: ${(data.platforms ?? []).join(', ') || 'n/a'}`);
  console.log(`Targets: ${(data.targets ?? []).length}`);
  console.log(`User data dir: ${data.userDataDir}`);

  if (data.mode === 'hosted' && data.cdpUrl) {
    try {
      const response = await fetch(`${data.cdpUrl}/json/version`);
      console.log(`CDP endpoint: ${data.cdpUrl}`);
      console.log(`CDP reachable: ${response.ok ? 'yes' : 'no'}`);
    } catch {
      console.log(`CDP endpoint: ${data.cdpUrl}`);
      console.log('CDP reachable: no');
    }
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

  const projectRoot = getProjectRoot();

  if (config.statusOnly) {
    await printSessionStatus(projectRoot, config.profileName);
    return;
  }

  const portalTargets = await loadBrowserTargets(projectRoot);
  const targetSelection = normalizeTargetSelection({
    target: config.target,
    selectedPlatforms: [...config.selectedPlatforms],
    useSearchUrls: config.useSearchUrls,
    portalTargets,
  });
  const startedAt = new Date().toISOString();

  if (config.hosted) {
    const launched = await launchHostedBrowserSession({
      projectRoot,
      profileName: config.profileName,
      channel: config.channel ?? 'chrome',
      targets: targetSelection.urls,
      timeoutMs: config.timeoutMs,
      cdpPort: config.cdpPort,
    });

    await writeSessionState(projectRoot, config.profileName, {
      schemaVersion: 1,
      mode: 'hosted',
      caller: config.caller,
      profile: config.profileName,
      channel: launched.channel,
      platforms: targetSelection.labels,
      targets: targetSelection.urls,
      userDataDir: launched.userDataDir,
      executablePath: launched.executablePath,
      extensions: [REVIEW_EXTENSION_NAME],
      cdpUrl: launched.cdpUrl,
      wsEndpoint: launched.wsEndpoint,
      pid: launched.pid,
      openedAt: startedAt,
      closedAt: null,
      status: 'open',
    });

    await appendSessionLog(projectRoot, [
      startedAt,
      '',
      config.caller,
      config.profileName,
      launched.channel,
      targetSelection.labels.join(','),
      launched.userDataDir,
      'opened-hosted',
      formatTargetsForLog(targetSelection.urls),
    ].join('\t'));

    console.log(`Opened hosted browser using channel: ${launched.channel}`);
    if (launched.fallbackFrom) {
      console.log(`Requested channel ${launched.fallbackFrom} was unavailable; fell back to ${launched.channel}.`);
    }
    console.log(`Profile directory: ${launched.userDataDir}`);
    console.log(`Targets opened: ${targetSelection.urls.length}`);
    console.log(`CDP endpoint: ${launched.cdpUrl}`);
    console.log('Sign in manually in this real browser window. Leave it running for scans or liveness checks that attach over CDP.');
    return;
  }

  let launched;
  try {
    launched = await launchPersistentBrowserSession({
      projectRoot,
      profileName: config.profileName,
      channel: config.channel,
      targets: targetSelection.urls,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    await writeSessionState(projectRoot, config.profileName, {
      schemaVersion: 1,
      mode: 'persistent',
      caller: config.caller,
      profile: config.profileName,
      channel: config.channel,
      platforms: targetSelection.labels,
      targets: targetSelection.urls,
      userDataDir: resolveBrowserProfileDir(projectRoot, config.profileName),
      openedAt: startedAt,
      closedAt: startedAt,
      status: 'failed',
      lastError: error.message,
    });
    throw error;
  }

  const { context, channel, userDataDir, navigationResults } = launched;
  const sessionState = {
    schemaVersion: 1,
    mode: 'persistent',
    caller: config.caller,
    profile: config.profileName,
    channel,
    platforms: targetSelection.labels,
    targets: targetSelection.urls,
    userDataDir,
    openedAt: startedAt,
    closedAt: null,
    status: 'open',
  };

  await writeSessionState(projectRoot, config.profileName, sessionState);
  await appendSessionLog(projectRoot, [
    startedAt,
    '',
    config.caller,
    config.profileName,
    channel,
    targetSelection.labels.join(','),
    userDataDir,
    'opened',
    formatTargetsForLog(targetSelection.urls),
  ].join('\t'));

  console.log(`Opened browser session using channel: ${channel}`);
  console.log(`Profile directory: ${userDataDir}`);
  console.log(`Targets opened: ${targetSelection.urls.length}`);
  console.log('Sign in manually, complete any anti-bot checks yourself, then close the browser window to save the session.');

  for (const result of navigationResults.filter((entry) => !entry.ok)) {
    console.log(`Warning: preloading ${result.target} failed: ${result.error}`);
  }

  let closed = false;
  let finalStatus = 'closed';
  let finalized = false;

  const finalizeSession = async () => {
    if (finalized) {
      return;
    }
    finalized = true;

    const closedAt = new Date().toISOString();
    await writeSessionState(projectRoot, config.profileName, {
      ...sessionState,
      closedAt,
      status: finalStatus,
    });
    await appendSessionLog(projectRoot, [
      startedAt,
      closedAt,
      config.caller,
      config.profileName,
      channel,
      targetSelection.labels.join(','),
      userDataDir,
      finalStatus,
      formatTargetsForLog(targetSelection.urls),
    ].join('\t'));
  };

  context.once('close', () => {
    closed = true;
    void finalizeSession().catch(reportFinalizeError);
  });

  const closeHandler = async (exitCode, status) => {
    finalStatus = status;

    if (!closed) {
      try {
        await context.close();
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    await finalizeSession().catch(reportFinalizeError);

    if (typeof exitCode === 'number') {
      process.exit(exitCode);
    }
  };

  process.once('SIGINT', () => {
    void closeHandler(130, 'interrupted');
  });

  process.once('SIGTERM', () => {
    void closeHandler(143, 'terminated');
  });

  await new Promise((resolvePromise) => context.once('close', resolvePromise));
}

const entryFile = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryFile && fileURLToPath(import.meta.url) === entryFile) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}