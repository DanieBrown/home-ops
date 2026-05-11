#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { fetchPmmsRates } from '../../scripts/affordability/calculate-affordability.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const PROFILE_PATH = join(REPO_ROOT, 'config', 'profile.yml');
const STATE_DIR = join(REPO_ROOT, '.home-ops');
const SUBMISSION_FILE = join(STATE_DIR, 'afford-wizard-submission.json');
const ANSWERS_FILE = join(STATE_DIR, 'afford-wizard-answers.json');
let cachedRates = null;
let cachedRatesAt = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const config = { port: 4179, once: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      config.port = Number.parseInt(argv[index + 1] ?? '4179', 10);
      index += 1;
    } else if (arg === '--once') {
      config.once = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/afford-wizard/serve.mjs [--port 4179] [--once]');
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

async function readBody(req, limitBytes = 256 * 1024) {
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
    req.on('error', (error) => rejectPromise(error));
  });
}

async function handleSubmit(req, res, options) {
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw || '{}');
    if (!parsed?.answers || typeof parsed.answers !== 'object') {
      sendJson(res, 400, { ok: false, error: 'Missing answers object' });
      return;
    }
    const wrapped = {
      submittedAt: new Date().toISOString(),
      source: 'afford-wizard',
      payload: parsed,
    };
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SUBMISSION_FILE, `${JSON.stringify(wrapped, null, 2)}\n`, 'utf8');
    writeAnswers(parsed.answers);
    sendJson(res, 200, { ok: true, file: '.home-ops/afford-wizard-submission.json' });
    console.log('\nAffordability wizard submission written to .home-ops/afford-wizard-submission.json\n');
    if (options.once) setTimeout(() => process.exit(0), 250);
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

async function handleRates(_req, res) {
  try {
    const now = Date.now();
    if (!cachedRates || now - cachedRatesAt > 15 * 60 * 1000) {
      cachedRates = await fetchPmmsRates({ timeoutMs: 8000 });
      cachedRatesAt = now;
    }
    sendJson(res, 200, { ok: true, rates: cachedRates });
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
    if (req.method === 'GET' && url.pathname === '/api/rates') {
      await handleRates(req, res);
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
    console.log('Home-Ops Affordability Wizard is running.');
    console.log(`  READY ${url}`);
    console.log('  Complete the fields, click Submit, then tell your AI chatbot you are done.');
    if (options.once) console.log('  Server will exit after the first successful submission.');
  });
}

main();
