#!/usr/bin/env node

/**
 * serve.mjs -- Local static server for the Home-Ops Profile Wizard.
 *
 * Serves the wizard UI from this directory on a loopback port, exposes the
 * current buyer profile at /api/profile, accepts the completed wizard
 * submission at POST /api/submit, proxies Wikipedia-backed state/county/town
 * lookups behind a JSON disk cache, and persists the in-flight wizard answers
 * so re-opening the wizard keeps your last selections.
 *
 * Usage:
 *   node tools/profile-wizard/serve.mjs [--port 4178] [--once]
 *
 * --once  Shut down the server after receiving the first successful submission.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

import { parseNarrative } from './parse-narrative.mjs';
import {
  loadStates,
  loadCounties,
  loadTowns,
  stateAbbreviation,
} from './geo-wikipedia.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const PROFILE_PATH = join(REPO_ROOT, 'config', 'profile.yml');
const STATE_DIR = join(REPO_ROOT, '.home-ops');
const SUBMISSION_FILE = join(STATE_DIR, 'profile-wizard-submission.json');
const ANSWERS_FILE = join(STATE_DIR, 'profile-wizard-answers.json');
const CACHE_DIR = join(STATE_DIR, 'wizard-geo-cache');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function parseArgs(argv) {
  const config = { port: 4178, once: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') { config.port = Number.parseInt(argv[index + 1] ?? '4178', 10); index += 1; continue; }
    if (arg === '--once') { config.once = true; continue; }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/profile-wizard/serve.mjs [--port 4178] [--once]');
      process.exit(0);
    }
  }
  return config;
}

function readProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try {
    return YAML.parse(readFileSync(PROFILE_PATH, 'utf8')) ?? {};
  } catch (error) {
    console.warn(`Failed to parse config/profile.yml: ${error.message}`);
    return {};
  }
}

function readAnswers() {
  if (!existsSync(ANSWERS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ANSWERS_FILE, 'utf8'));
  } catch (error) {
    console.warn(`Failed to parse ${ANSWERS_FILE}: ${error.message}`);
    return null;
  }
}

function writeAnswers(answers) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ANSWERS_FILE, `${JSON.stringify({ savedAt: new Date().toISOString(), answers }, null, 2)}\n`, 'utf8');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const relativePath = urlPath === '/' ? '/index.html' : urlPath;
  const absolutePath = join(__dirname, relativePath.replace(/^\/+/, ''));
  if (!absolutePath.startsWith(__dirname)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(absolutePath)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const body = readFileSync(absolutePath);
  const mime = MIME[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        rejectPromise(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => rejectPromise(err));
  });
}

async function handleSubmit(req, res, options) {
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw || '{}');
    const narrative = parsed?.answers?.narrative ?? {};
    let narrativeExtract = null;
    try {
      narrativeExtract = parseNarrative({
        wants: narrative.wants ?? '',
        avoids: narrative.avoids ?? '',
        notes: narrative.notes ?? '',
      });
    } catch (error) {
      console.warn(`Narrative parse failed: ${error.message}`);
    }
    const wrapped = {
      submittedAt: new Date().toISOString(),
      source: 'profile-wizard',
      payload: parsed,
      narrative_extract: narrativeExtract,
    };
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SUBMISSION_FILE, `${JSON.stringify(wrapped, null, 2)}\n`, 'utf8');
    // Also keep the raw answers for the wizard to re-seed from next time the
    // UI is opened even before the main agent ingests the submission.
    if (parsed?.answers) writeAnswers(parsed.answers);
    sendJson(res, 200, { ok: true, file: '.home-ops/profile-wizard-submission.json' });
    console.log(`\nWizard submission written to .home-ops/profile-wizard-submission.json`);
    console.log('Return to your AI chatbot and say: finish my profile from the wizard submission.');
    console.log('Home-Ops will regenerate portals.yml from your selections.\n');
    if (options.once) {
      setTimeout(() => process.exit(0), 250);
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleAnswerSave(req, res) {
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw || '{}');
    if (!parsed?.answers || typeof parsed.answers !== 'object') {
      sendJson(res, 400, { ok: false, error: 'Missing answers object' });
      return;
    }
    writeAnswers(parsed.answers);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleGeoStates(_req, res) {
  try {
    const states = await loadStates(CACHE_DIR);
    sendJson(res, 200, { states });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleGeoCounties(url, res) {
  try {
    const state = url.searchParams.get('state')?.trim();
    if (!state) {
      sendJson(res, 400, { ok: false, error: 'Missing state parameter' });
      return;
    }
    const counties = await loadCounties(CACHE_DIR, state);
    sendJson(res, 200, { state, counties });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message });
  }
}

async function handleGeoTowns(url, res) {
  try {
    const state = url.searchParams.get('state')?.trim();
    const county = url.searchParams.get('county')?.trim();
    if (!state || !county) {
      sendJson(res, 400, { ok: false, error: 'Missing state or county parameter' });
      return;
    }
    const towns = await loadTowns(CACHE_DIR, state, county);
    sendJson(res, 200, { state, county, abbr: stateAbbreviation(state), towns });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/profile') {
      sendJson(res, 200, { profile: readProfile(), savedAnswers: readAnswers() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/submit') {
      await handleSubmit(req, res, options);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/answers') {
      await handleAnswerSave(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/geo/states') {
      await handleGeoStates(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/geo/counties') {
      await handleGeoCounties(url, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/geo/towns') {
      await handleGeoTowns(url, res);
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405).end('Method not allowed');
  });

  server.on('error', (error) => {
    console.error(`Server error: ${error.message}`);
    process.exit(1);
  });

  server.listen(options.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${options.port}/`;
    console.log('Home-Ops Profile Wizard is running.');
    console.log(`  Open in your browser (or via Chrome MCP): ${url}`);
    console.log('  Complete the questions, click Submit, and return to your AI chatbot.');
    if (options.once) {
      console.log('  Server will exit after the first successful submission.');
    }
  });
}

main();
