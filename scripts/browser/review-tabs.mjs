#!/usr/bin/env node

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import {
  appendSessionLog,
  launchHostedBrowserSession,
  loadBrowserTargets,
  readSessionState,
  resolveReviewExtensionDir,
  writeSessionState,
} from './browser-session.mjs';
import {
  auditParsedReport,
  getCriticalAuditFindings,
  parseReport,
  parseShortlist,
  resolveWorkspacePath,
} from '../research/research-utils.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_GROUP_COLOR = 'blue';
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
  --replace          Close all other top-level tabs across the hosted Chrome session before opening targets.
  --skip-finalist-gate  Allow shortlist-top3 to bypass the strict research gate.
  --dry-run          Resolve the target URLs and print them without changing Chrome.
  --help             Show this help text.
`;

function getProjectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function parseArgs(argv) {
  const config = {
    command: null,
    values: [],
    profileName: DEFAULT_PROFILE,
    groupTitle: null,
    groupColor: DEFAULT_GROUP_COLOR,
    replaceExisting: false,
    skipFinalistGate: false,
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

    if (arg === '--skip-finalist-gate') {
      config.skipFinalistGate = true;
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

async function readUtf8(filePath) {
  return readFile(filePath, 'utf8');
}

async function extractReviewTargetFromReport(projectRoot, reportPath) {
  const absoluteReportPath = resolveWorkspacePath(projectRoot, reportPath);
  let content;
  try {
    content = await readUtf8(absoluteReportPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[warn] Skipping shortlist entry — report not found: ${reportPath}`);
      return null;
    }
    throw err;
  }
  const urlLine = content.split(/\r?\n/).find((line) => line.startsWith('**URL:**'));

  if (urlLine) {
    const url = urlLine.replace('**URL:**', '').trim();
    if (url) {
      return url;
    }
  }

  return pathToFileURL(absoluteReportPath).href;
}

function validateFinalistGate(projectRoot, rows, config) {
  if (config.command !== 'shortlist-top3' || config.skipFinalistGate) {
    return;
  }

  const blocked = rows.flatMap((row) => {
    let report;
    try {
      report = parseReport(projectRoot, row.reportPath);
    } catch (err) {
      if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
        console.warn(`[warn] Skipping finalist gate check — report not found: ${row.reportPath}`);
        return [];
      }
      throw err;
    }
    const audit = auditParsedReport(report);
    const blockers = getCriticalAuditFindings(audit, {
      headings: ['Neighborhood Sentiment', 'School Review', 'Development and Infrastructure'],
      strictWarnings: true,
    });

    return blockers.length > 0
      ? [{ address: row.address, city: row.city, reportPath: report.relativePath, blockers }]
      : [];
  });

  if (blocked.length === 0) {
    return;
  }

  const details = blocked.map((row) => {
    const findings = row.blockers.map((finding) => `${finding.heading}: ${finding.message}`).join('; ');
    return `- ${row.address}, ${row.city} (${row.reportPath}) -> ${findings}`;
  }).join('\n');

  throw new Error(
    'Refined top 3 failed the strict finalist research gate.\n'
    + `${details}\n`
    + 'Run node scripts/research/shortlist-finalist-gate.mjs for a full report, or rerun with --skip-finalist-gate only if you intentionally want to bypass the evidence gate.',
  );
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

    const reviewTargets = [];
    for (const reportPath of config.values) {
      const reviewTarget = await extractReviewTargetFromReport(projectRoot, reportPath);
      if (reviewTarget) {
        reviewTargets.push(reviewTarget);
      }
    }

    return [...new Set(reviewTargets)];
  }

  if (config.command === 'shortlist-top10' || config.command === 'shortlist-top3') {
    const shortlist = parseShortlist(projectRoot);
    const rows = config.command === 'shortlist-top10' ? shortlist.top10 : shortlist.refinedTop3;
    validateFinalistGate(projectRoot, rows, config);
    const reviewTargets = [];

    for (const row of rows) {
      const reviewTarget = await extractReviewTargetFromReport(projectRoot, row.reportPath);
      if (reviewTarget) {
        reviewTargets.push(reviewTarget);
      }
    }

    return [...new Set(reviewTargets)];
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

function isBridgeBlockedError(error) {
  const message = String(error?.message ?? error ?? '');
  return message.includes('net::ERR_BLOCKED_BY_CLIENT')
    || message.includes('window.homeOpsReviewTabs');
}

async function fetchCdpJson(cdpUrl, endpoint, init = {}) {
  const response = await fetch(`${cdpUrl}${endpoint}`, init);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`CDP request failed for ${endpoint}: ${response.status} ${response.statusText}`);
  }

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function listTopLevelPageTargets(cdpUrl) {
  const targets = await fetchCdpJson(cdpUrl, '/json/list');
  return Array.isArray(targets)
    ? targets.filter((target) => target?.type === 'page' && target.id)
    : [];
}

async function openPageTarget(cdpUrl, url) {
  const encodedUrl = encodeURIComponent(url);

  try {
    return await fetchCdpJson(cdpUrl, `/json/new?${encodedUrl}`, { method: 'PUT' });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('405')) {
      throw error;
    }

    return fetchCdpJson(cdpUrl, `/json/new?${encodedUrl}`);
  }
}

async function closePageTarget(cdpUrl, id) {
  await fetchCdpJson(cdpUrl, `/json/close/${id}`);
}

async function activatePageTarget(cdpUrl, id) {
  await fetchCdpJson(cdpUrl, `/json/activate/${id}`);
}

async function replaceHostedTabsViaCdp(cdpUrl, urls, session) {
  const existingTargets = await listTopLevelPageTargets(cdpUrl);
  const createdTargets = [];

  for (const url of urls) {
    const target = await openPageTarget(cdpUrl, url);
    if (target?.id) {
      createdTargets.push(target);
    }
  }

  for (const target of existingTargets) {
    await closePageTarget(cdpUrl, target.id).catch(() => {});
  }

  const createdTargetIds = new Set(createdTargets.map((target) => target.id).filter(Boolean));
  const lingeringTargets = (await listTopLevelPageTargets(cdpUrl))
    .filter((target) => target.id && !createdTargetIds.has(target.id));

  for (const target of lingeringTargets) {
    await closePageTarget(cdpUrl, target.id).catch(() => {});
  }

  if (createdTargets[0]?.id) {
    await activatePageTarget(cdpUrl, createdTargets[0].id).catch(() => {});
  }

  console.log(`Opened ${createdTargets.length} finalist tabs in hosted Chrome.`);
  console.log(`Closed ${existingTargets.length + lingeringTargets.length} non-finalist hosted tabs across the session.`);
  console.log(`Hosted session: ${session.reusedExisting ? 'reused' : 'reopened'}`);
  console.log('Review helper: raw CDP replacement');
}

async function openReviewTabsDirectly(browser, context, urls, config, session) {
  const existingPages = browser.contexts()
    .flatMap((currentContext) => currentContext.pages())
    .filter((page) => !page.isClosed());
  const openedPages = [];

  for (const url of urls) {
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      openedPages.push(page);
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  if (config.replaceExisting) {
    await Promise.all(existingPages.map((page) => page.close().catch(() => {})));
  }

  console.log(`Opened ${openedPages.length} review tabs in hosted Chrome.`);
  if (config.replaceExisting) {
    console.log(`Closed ${existingPages.length} existing hosted tabs before leaving the finalists.`);
  }
  if (config.groupTitle) {
    console.log(`Tab group skipped because the review extension bridge was unavailable: ${config.groupTitle}`);
  }
  console.log(`Hosted session: ${session.reusedExisting ? 'reused' : 'reopened'}`);
  console.log('Review helper: direct CDP fallback');
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

  if (config.replaceExisting) {
    await replaceHostedTabsViaCdp(session.cdpUrl, urls, session);
    return;
  }

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
      } catch (error) {
        if (!isBridgeBlockedError(error)) {
          throw error;
        }

        console.warn('Review extension bridge unavailable; falling back to direct tab control.');
        await bridgePage.close().catch(() => {});
        await openReviewTabsDirectly(browser, context, urls, {
          replaceExisting: config.replaceExisting,
          groupTitle: effectiveGroupTitle,
        }, session);
      }
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