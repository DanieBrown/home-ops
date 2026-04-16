#!/usr/bin/env node

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import {
  appendSessionLog,
  launchHostedBrowserSession,
  loadBrowserTargets,
  readSessionState,
  resolveReviewExtensionDir,
  writeSessionState,
} from './browser-session.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_GROUP_COLOR = 'blue';
const SHORTLIST_PATH = 'data/shortlist.md';
const REVIEW_EXTENSION_NAME = 'home-ops-review-tabs';

const HELP_TEXT = `Usage:
  node review-tabs.mjs shortlist-top10 [--profile chrome-host] [--group "Top 10"] [--color blue]
  node review-tabs.mjs shortlist-top3 [--profile chrome-host] [--replace]
  node review-tabs.mjs reports <report-path> [more-report-paths...] [--group "Top 10"] [--replace]
  node review-tabs.mjs urls <url> [more-urls...] [--group "Top 10"] [--replace]

Options:
  --profile <name>   Hosted browser profile to reuse. Defaults to chrome-host.
  --group <name>     Optional Chrome tab-group title.
  --color <name>     Chrome tab-group color. Defaults to blue.
  --replace          Close all other tabs in the hosted Chrome window before opening targets.
  --dry-run          Resolve the target URLs and print them without changing Chrome.
  --help             Show this help text.
`;

function getProjectRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

function parseArgs(argv) {
  const config = {
    command: null,
    values: [],
    profileName: DEFAULT_PROFILE,
    groupTitle: null,
    groupColor: DEFAULT_GROUP_COLOR,
    replaceExisting: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--group') {
      config.groupTitle = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--color') {
      config.groupColor = argv[index + 1] ?? DEFAULT_GROUP_COLOR;
      index += 1;
      continue;
    }

    if (arg === '--replace') {
      config.replaceExisting = true;
      continue;
    }

    if (arg === '--dry-run') {
      config.dryRun = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!config.command) {
      config.command = arg;
      continue;
    }

    config.values.push(arg);
  }

  if (config.help) {
    return config;
  }

  if (!config.command) {
    throw new Error('A command is required.');
  }

  if (!config.profileName) {
    throw new Error('A non-empty profile name is required when using --profile.');
  }

  if (!config.groupColor) {
    throw new Error('A non-empty tab-group color is required when using --color.');
  }

  return config;
}

function normalizeWorkspacePath(rawPath) {
  return String(rawPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveWorkspacePath(projectRoot, rawPath) {
  const normalized = normalizeWorkspacePath(rawPath);
  return join(projectRoot, normalized);
}

async function readUtf8(filePath) {
  return readFile(filePath, 'utf8');
}

function parseMarkdownTable(lines, startHeader) {
  const startIndex = lines.findIndex((line) => line.trim() === startHeader);
  if (startIndex === -1) {
    return [];
  }

  const rows = [];

  for (let index = startIndex + 2; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('|')) {
      break;
    }

    const columns = trimmed.split('|').slice(1, -1).map((value) => value.trim());
    rows.push(columns);
  }

  return rows;
}

function extractMarkdownLinkTarget(value) {
  const match = String(value ?? '').match(/\[[^\]]+\]\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

function normalizeKey(address, city) {
  return `${String(address ?? '').trim().toLowerCase()}|${String(city ?? '').trim().toLowerCase()}`;
}

async function parseShortlist(projectRoot) {
  const content = await readUtf8(join(projectRoot, SHORTLIST_PATH));
  const lines = content.split(/\r?\n/);
  const compareRows = parseMarkdownTable(lines, '## Compare Top 10');
  const refinedRows = parseMarkdownTable(lines, '## Refined Top 3 After Deep');

  const compareTop10 = compareRows.map((columns) => ({
    rank: columns[0],
    tag: columns[1],
    trackerNumber: columns[2],
    address: columns[3],
    city: columns[4],
    score: columns[5],
    status: columns[6],
    reportPath: extractMarkdownLinkTarget(columns[7]),
    notes: columns[8],
  })).filter((row) => row.reportPath);

  const compareIndex = new Map(compareTop10.map((row) => [normalizeKey(row.address, row.city), row]));

  const refinedTop3 = refinedRows.map((columns) => {
    const address = columns[1];
    const city = columns[2];
    return {
      rank: columns[0],
      address,
      city,
      updatedVerdict: columns[3],
      why: columns[4],
      reportPath: compareIndex.get(normalizeKey(address, city))?.reportPath ?? null,
    };
  }).filter((row) => row.reportPath);

  return { compareTop10, refinedTop3 };
}

async function extractListingUrlFromReport(projectRoot, reportPath) {
  const absoluteReportPath = resolveWorkspacePath(projectRoot, reportPath);
  const content = await readUtf8(absoluteReportPath);
  const urlLine = content.split(/\r?\n/).find((line) => line.startsWith('**URL:**'));

  if (!urlLine) {
    return null;
  }

  const url = urlLine.replace('**URL:**', '').trim();
  return url || null;
}

async function resolveTargets(projectRoot, config) {
  if (config.command === 'urls') {
    if (config.values.length === 0) {
      throw new Error('The urls command requires at least one URL.');
    }

    return [...new Set(config.values.map((value) => String(value).trim()).filter(Boolean))];
  }

  if (config.command === 'reports') {
    if (config.values.length === 0) {
      throw new Error('The reports command requires at least one report path.');
    }

    const urls = [];
    for (const reportPath of config.values) {
      const url = await extractListingUrlFromReport(projectRoot, reportPath);
      if (url) {
        urls.push(url);
      }
    }

    return [...new Set(urls)];
  }

  if (config.command === 'shortlist-top10' || config.command === 'shortlist-top3') {
    const shortlist = await parseShortlist(projectRoot);
    const rows = config.command === 'shortlist-top10' ? shortlist.compareTop10 : shortlist.refinedTop3;
    const urls = [];

    for (const row of rows) {
      const url = await extractListingUrlFromReport(projectRoot, row.reportPath);
      if (url) {
        urls.push(url);
      }
    }

    return [...new Set(urls)];
  }

  throw new Error(`Unknown command: ${config.command}`);
}

async function canReachCdp(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function parseCdpPort(cdpUrl) {
  try {
    return Number.parseInt(new URL(cdpUrl).port || '9222', 10);
  } catch {
    return 9222;
  }
}

async function ensureHostedBrowserSession(projectRoot, profileName) {
  const savedState = await readSessionState(projectRoot, profileName);

  if (savedState?.data?.mode === 'hosted' && savedState.data.cdpUrl && await canReachCdp(savedState.data.cdpUrl)) {
    if (!Array.isArray(savedState.data.extensions) || !savedState.data.extensions.includes(REVIEW_EXTENSION_NAME)) {
      throw new Error('The current hosted Chrome session was started before Home-Ops review-tab support was added. Run /home-ops init or npm.cmd run browser:setup once to refresh Chrome, then retry the review-tab command.');
    }

    return {
      reusedExisting: true,
      cdpUrl: savedState.data.cdpUrl,
      state: savedState.data,
    };
  }

  const browserTargets = await loadBrowserTargets(projectRoot);
  const fallbackTargets = savedState?.data?.targets?.length
    ? savedState.data.targets
    : Object.entries(browserTargets)
      .filter(([, value]) => value.loginRequired)
      .map(([, value]) => value.baseUrl)
      .filter(Boolean);
  const fallbackLabels = savedState?.data?.platforms?.length
    ? savedState.data.platforms
    : Object.entries(browserTargets)
      .filter(([, value]) => value.loginRequired)
      .map(([key]) => key);
  const launched = await launchHostedBrowserSession({
    projectRoot,
    profileName,
    channel: savedState?.data?.channel ?? 'chrome',
    targets: fallbackTargets.length > 0 ? fallbackTargets : ['about:blank'],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cdpPort: parseCdpPort(savedState?.data?.cdpUrl ?? 'http://127.0.0.1:9222'),
  });
  const openedAt = new Date().toISOString();

  await writeSessionState(projectRoot, profileName, {
    schemaVersion: 1,
    mode: 'hosted',
    caller: 'review-tabs',
    profile: profileName,
    channel: launched.channel,
    platforms: fallbackLabels,
    targets: fallbackTargets.length > 0 ? fallbackTargets : ['about:blank'],
    userDataDir: launched.userDataDir,
    executablePath: launched.executablePath,
    extensions: [REVIEW_EXTENSION_NAME],
    cdpUrl: launched.cdpUrl,
    wsEndpoint: launched.wsEndpoint,
    pid: launched.pid,
    openedAt,
    closedAt: null,
    status: 'open',
  });

  await appendSessionLog(projectRoot, [
    openedAt,
    '',
    'review-tabs',
    profileName,
    launched.channel,
    fallbackLabels.join(','),
    launched.userDataDir,
    'reopened-hosted',
    (fallbackTargets.length > 0 ? fallbackTargets : ['about:blank']).join(' | '),
  ].join('\t'));

  return {
    reusedExisting: false,
    cdpUrl: launched.cdpUrl,
    state: {
      channel: launched.channel,
      platforms: fallbackLabels,
      targets: fallbackTargets,
      userDataDir: launched.userDataDir,
    },
  };
}

async function getExtensionBridgeUrl(projectRoot) {
  const manifestPath = join(resolveReviewExtensionDir(projectRoot), 'manifest.json');
  const manifest = JSON.parse(await readUtf8(manifestPath));
  const keyBytes = Buffer.from(String(manifest.key ?? '').replace(/\s+/g, ''), 'base64');
  const digest = createHash('sha256').update(keyBytes).digest();
  const alphabet = 'abcdefghijklmnop';
  let extensionId = '';

  for (let index = 0; index < 16; index += 1) {
    const byte = digest[index];
    extensionId += alphabet[byte >> 4] + alphabet[byte & 0x0f];
  }

  return `chrome-extension://${extensionId}/bridge.html`;
}

async function run() {
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
  const urls = await resolveTargets(projectRoot, config);

  if (urls.length === 0) {
    throw new Error('No review URLs could be resolved from the requested source.');
  }

  const effectiveGroupTitle = config.groupTitle
    ?? (config.command === 'shortlist-top10' ? 'Top 10' : null);

  if (config.dryRun) {
    console.log(JSON.stringify({
      profile: config.profileName,
      replaceExisting: config.replaceExisting,
      groupTitle: effectiveGroupTitle,
      groupColor: config.groupColor,
      count: urls.length,
      urls,
    }, null, 2));
    return;
  }

  const session = await ensureHostedBrowserSession(projectRoot, config.profileName);
  const browser = await chromium.connectOverCDP(session.cdpUrl, {
    timeout: DEFAULT_TIMEOUT_MS,
    isLocal: true,
  });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Hosted Chrome did not expose a default context.');
    }

    const bridgePageUrl = await getExtensionBridgeUrl(projectRoot);
    const bridgePage = await context.newPage();

    try {
      await bridgePage.goto(bridgePageUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      const result = await bridgePage.evaluate((payload) => {
        return window.homeOpsReviewTabs.openReviewTabs(payload);
      }, {
        urls,
        groupTitle: effectiveGroupTitle,
        groupColor: config.groupColor,
        replaceExisting: config.replaceExisting,
      });

      console.log(`Opened ${result.urls.length} review tabs in hosted Chrome.`);
      if (effectiveGroupTitle) {
        console.log(`Tab group: ${effectiveGroupTitle}`);
      }
      console.log(`Hosted session: ${session.reusedExisting ? 'reused' : 'reopened'}`);
    } finally {
      await bridgePage.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});