import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { ROOT } from '../shared/paths.mjs';
import { readSessionState } from '../browser/browser-session.mjs';

const CRAWL4AI_PAGE_FETCH = join(ROOT, 'scripts', 'research', 'python', 'crawl4ai_page_fetch.py');
const CRAWL4AI_PORTAL_EXTRACT = join(ROOT, 'scripts', 'research', 'python', 'crawl4ai_portal_extract.py');
const DEFAULT_PROFILE_DIR = join(ROOT, 'output', 'crawl4ai-profile');
const DEFAULT_HOSTED_PROFILE = 'chrome-host';
const VALID_CAPTURE_STATUSES = new Set(['captured', 'blocked', 'empty', 'error']);

function pythonCandidates() {
  return process.platform === 'win32'
    ? [['py', ['-3']], ['python3', []], ['python', []]]
    : [['python3', []], ['python', []]];
}

function probeCrawl4ai(candidate) {
  const [bin, baseArgs] = candidate;
  const probe = spawnSync(bin, [...baseArgs, '-c', 'import crawl4ai'], { encoding: 'utf8' });
  return probe.status === 0;
}

let cachedInvocation = undefined;

export function detectCrawl4aiInvocation() {
  if (cachedInvocation !== undefined) return cachedInvocation;
  cachedInvocation = null;
  for (const candidate of pythonCandidates()) {
    const [bin, baseArgs] = candidate;
    const versionProbe = spawnSync(bin, [...baseArgs, '--version'], { encoding: 'utf8' });
    if (versionProbe.status !== 0) continue;
    if (probeCrawl4ai(candidate)) {
      cachedInvocation = { bin, baseArgs };
      break;
    }
  }
  return cachedInvocation;
}

export function crawl4aiAvailable() {
  return Boolean(detectCrawl4aiInvocation());
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(value, fallback = 'error') {
  const status = String(value ?? '').trim().toLowerCase();
  return VALID_CAPTURE_STATUSES.has(status) ? status : fallback;
}

function parseJsonStdout(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    throw new Error('empty stdout');
  }

  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }
      try {
        return JSON.parse(line);
      } catch {
        // Keep looking for the final JSON payload.
      }
    }
    throw new Error('stdout did not contain a JSON object');
  }
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

export function normalizeCrawl4aiPortalResult(record = {}, fallback = {}) {
  const notes = [
    ...asArray(record.notes).map((note) => String(note)),
    ...asArray(fallback.notes).map((note) => String(note)),
  ].filter(Boolean);

  let captureStatus = normalizeStatus(record.captureStatus, null);
  if (!captureStatus) {
    if (record.unavailable || /not-installed|missing|environment/i.test(String(record.error ?? ''))) {
      captureStatus = 'error';
    } else if (/blocked|captcha|429|403|401/i.test(String(record.error ?? ''))) {
      captureStatus = 'blocked';
    } else if (record.listing || asArray(record.items).length > 0) {
      captureStatus = 'captured';
    } else {
      captureStatus = 'empty';
    }
  }

  return {
    ok: captureStatus === 'captured',
    provider: 'crawl4ai',
    mode: record.mode ?? fallback.mode ?? '',
    platform: record.platform ?? fallback.platform ?? 'other',
    url: record.url ?? fallback.url ?? '',
    finalUrl: record.finalUrl || record.url || fallback.url || '',
    statusCode: Number(record.statusCode ?? record.status ?? 0) || 0,
    captureStatus,
    items: asArray(record.items),
    listing: record.listing && typeof record.listing === 'object' ? record.listing : null,
    snapshot: record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : null,
    notes,
    error: record.error ?? fallback.error ?? null,
    unavailable: Boolean(record.unavailable ?? fallback.unavailable),
  };
}

async function readHostedCdpUrl(profileName) {
  const session = await readSessionState(ROOT, profileName);
  const cdpUrl = session?.data?.mode === 'hosted' && session.data.status === 'open'
    ? session.data.cdpUrl
    : null;
  if (!cdpUrl) {
    throw new Error(`Hosted browser session ${profileName} is not ready. Run /home-ops init first.`);
  }

  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    if (!response.ok) {
      throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(`Hosted browser session ${profileName} is not reachable: ${error.message}`);
  }

  return cdpUrl;
}

export async function crawl4aiPortalExtract(options = {}) {
  const mode = String(options.mode ?? '').trim();
  const platform = String(options.platform ?? 'other').trim() || 'other';
  const url = String(options.url ?? '').trim();
  const profileName = String(options.profileName ?? DEFAULT_HOSTED_PROFILE).trim() || DEFAULT_HOSTED_PROFILE;

  if (!mode || !['search', 'detail'].includes(mode)) {
    throw new Error('crawl4aiPortalExtract requires mode "search" or "detail"');
  }
  if (!url) {
    throw new Error('crawl4aiPortalExtract requires a URL');
  }

  const invocation = detectCrawl4aiInvocation();
  if (!invocation) {
    return normalizeCrawl4aiPortalResult({
      provider: 'crawl4ai',
      mode,
      platform,
      url,
      finalUrl: url,
      statusCode: 0,
      captureStatus: 'error',
      error: 'crawl4ai-not-installed',
      unavailable: true,
      notes: ['crawl4ai is not installed; portal extraction unavailable'],
    }, { mode, platform, url });
  }

  let cdpUrl = options.cdpUrl ?? '';
  if (!options.htmlFile && !cdpUrl) {
    cdpUrl = await readHostedCdpUrl(profileName);
  }

  const timeoutMs = Number(options.timeoutMs ?? 30000);
  const args = [
    ...invocation.baseArgs,
    CRAWL4AI_PORTAL_EXTRACT,
    '--mode', mode,
    '--platform', platform,
    '--url', url,
    '--timeout-ms', String(timeoutMs),
    '--delay-ms', String(Number(options.delayMs ?? 1200)),
    '--json',
  ];

  if (cdpUrl) {
    args.push('--cdp-url', cdpUrl);
  }
  if (options.htmlFile) {
    args.push('--html-file', String(options.htmlFile));
  }

  return new Promise((resolve) => {
    const child = spawn(invocation.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child);
    }, timeoutMs + 15000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(normalizeCrawl4aiPortalResult({
        mode,
        platform,
        url,
        finalUrl: url,
        captureStatus: 'error',
        error: error.message,
      }, { mode, platform, url }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve(normalizeCrawl4aiPortalResult({
          mode,
          platform,
          url,
          finalUrl: url,
          captureStatus: 'error',
          error: 'timeout',
          notes: [`crawl4ai portal extraction exceeded ${timeoutMs}ms`],
        }, { mode, platform, url }));
        return;
      }

      if (code === 2) {
        resolve(normalizeCrawl4aiPortalResult({
          mode,
          platform,
          url,
          finalUrl: url,
          captureStatus: 'error',
          error: stderr.trim() || 'environment-failure',
          unavailable: true,
          notes: [stderr.trim() || 'crawl4ai environment failure'],
        }, { mode, platform, url }));
        return;
      }

      if (code !== 0) {
        resolve(normalizeCrawl4aiPortalResult({
          mode,
          platform,
          url,
          finalUrl: url,
          captureStatus: 'error',
          error: stderr.trim() || `exit-${code}`,
          notes: [stderr.trim() || `crawl4ai portal sidecar exited ${code}`],
        }, { mode, platform, url }));
        return;
      }

      try {
        const record = parseJsonStdout(stdout);
        resolve(normalizeCrawl4aiPortalResult(record, { mode, platform, url }));
      } catch (error) {
        resolve(normalizeCrawl4aiPortalResult({
          mode,
          platform,
          url,
          finalUrl: url,
          captureStatus: 'error',
          error: error.message,
          notes: [stderr.trim()].filter(Boolean),
        }, { mode, platform, url }));
      }
    });
  });
}

export function crawl4aiFetchPage(url, options = {}) {
  const invocation = detectCrawl4aiInvocation();
  if (!invocation) {
    return Promise.resolve({
      ok: false,
      status: 0,
      url,
      finalUrl: url,
      html: '',
      provider: 'crawl4ai',
      error: 'crawl4ai-not-installed',
      unavailable: true,
    });
  }

  const timeoutMs = Number(options.timeoutMs ?? 25000);
  const profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
  return new Promise((resolve) => {
    const child = spawn(invocation.bin, [
      ...invocation.baseArgs,
      CRAWL4AI_PAGE_FETCH,
      '--url', url,
      '--profile-dir', profileDir,
      '--timeout-ms', String(timeoutMs),
      '--json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child);
    }, timeoutMs + 10000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 0,
        url,
        finalUrl: url,
        html: '',
        provider: 'crawl4ai',
        error: error.message,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, status: 0, url, finalUrl: url, html: '', provider: 'crawl4ai', error: 'timeout' });
        return;
      }
      if (code === 2) {
        resolve({ ok: false, status: 0, url, finalUrl: url, html: '', provider: 'crawl4ai', error: stderr.trim() || 'environment-failure', unavailable: true });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, status: 0, url, finalUrl: url, html: '', provider: 'crawl4ai', error: stderr.trim() || `exit-${code}` });
        return;
      }
      try {
        const record = JSON.parse(stdout.trim());
        resolve({
          ok: Boolean(record.ok),
          status: record.status ?? 0,
          url,
          finalUrl: record.finalUrl || record.url || url,
          html: record.html || '',
          provider: 'crawl4ai',
          error: record.error ?? null,
        });
      } catch (error) {
        resolve({ ok: false, status: 0, url, finalUrl: url, html: '', provider: 'crawl4ai', error: error.message });
      }
    });
  });
}
