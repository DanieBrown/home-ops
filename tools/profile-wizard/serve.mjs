#!/usr/bin/env node

/**
 * serve.mjs -- Local static server for the Home-Ops Profile Wizard.
 *
 * Serves the wizard UI from this directory on a loopback port, exposes the
 * current buyer profile at /api/profile, and accepts the completed wizard
 * submission at POST /api/submit. The submission is written to
 * .home-ops/profile-wizard-submission.json so the main agent can ingest it
 * during /home-ops profile.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const PROFILE_PATH = join(REPO_ROOT, 'config', 'profile.yml');
const SUBMISSION_DIR = join(REPO_ROOT, '.home-ops');
const SUBMISSION_FILE = join(SUBMISSION_DIR, 'profile-wizard-submission.json');

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
    if (!existsSync(SUBMISSION_DIR)) {
      mkdirSync(SUBMISSION_DIR, { recursive: true });
    }
    writeFileSync(SUBMISSION_FILE, `${JSON.stringify(wrapped, null, 2)}\n`, 'utf8');
    sendJson(res, 200, { ok: true, file: '.home-ops/profile-wizard-submission.json' });
    console.log(`\nWizard submission written to .home-ops/profile-wizard-submission.json`);
    console.log('Return to your chat and say: finish my profile from the wizard submission.');
    console.log('Home-Ops will regenerate portals.yml from your selections.\n');
    if (options.once) {
      setTimeout(() => process.exit(0), 250);
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/profile')) {
      sendJson(res, 200, { profile: readProfile() });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/submit')) {
      await handleSubmit(req, res, options);
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
    console.log('  Complete the questions, click Submit, and return to Claude Code.');
    if (options.once) {
      console.log('  Server will exit after the first successful submission.');
    }
  });
}

main();
