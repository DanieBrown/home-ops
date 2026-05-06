import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { ROOT } from '../shared/paths.mjs';

const CRAWL4AI_PAGE_FETCH = join(ROOT, 'scripts', 'research', 'python', 'crawl4ai_page_fetch.py');
const DEFAULT_PROFILE_DIR = join(ROOT, 'output', 'crawl4ai-profile');

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
      child.kill('SIGKILL');
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
