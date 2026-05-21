#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'fs';
import { extname, join, relative } from 'path';
import { HOME_OPS_DIR, ROOT } from '../shared/paths.mjs';

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.ps1', '.sh']);
const TEMP_NAME_PATTERN = /^(?:_?inspect|_?tmp|_?temp|_?scratch|_?throwaway|_?one[-_]?off)(?:[-_.].*)?$/i;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'output',
  'reports',
  'batch/logs',
  '.home-ops/tmp',
]);
const TMP_DIR = join(HOME_OPS_DIR, 'tmp');
const MAX_TMP_AGE_MS = 24 * 60 * 60 * 1000;

function rel(path) {
  return relative(ROOT, path).replace(/\\/g, '/');
}

function shouldSkipDir(path, name) {
  const relativePath = rel(path);
  return SKIP_DIRS.has(name) || SKIP_DIRS.has(relativePath);
}

function walk(dir, hits = []) {
  if (!existsSync(dir)) return hits;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(fullPath, entry.name)) walk(fullPath, hits);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const base = entry.name.slice(0, entry.name.length - extension.length);
    if (rel(fullPath) === 'scripts/system/temp-artifact-check.mjs') continue;
    if (SCRIPT_EXTENSIONS.has(extension) && TEMP_NAME_PATTERN.test(base)) {
      hits.push(rel(fullPath));
    }
  }
  return hits;
}

function oldTmpArtifacts() {
  if (!existsSync(TMP_DIR)) return [];
  const hits = [];
  const now = Date.now();

  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const stats = statSync(fullPath);
      if (entry.isDirectory()) {
        scan(fullPath);
        continue;
      }
      if (entry.isFile() && now - stats.mtimeMs > MAX_TMP_AGE_MS) {
        hits.push(rel(fullPath));
      }
    }
  }

  scan(TMP_DIR);
  return hits;
}

const misplacedScripts = walk(ROOT);
const staleTmpFiles = oldTmpArtifacts();

if (misplacedScripts.length === 0 && staleTmpFiles.length === 0) {
  console.log('Temporary artifact check passed.');
  process.exit(0);
}

if (misplacedScripts.length > 0) {
  console.error('Temporary one-off scripts must live under .home-ops/tmp/{commandId}/ and be removed after use:');
  misplacedScripts.forEach((path) => console.error(`- ${path}`));
}

if (staleTmpFiles.length > 0) {
  console.error('Stale temporary files older than 24 hours were found under .home-ops/tmp/:');
  staleTmpFiles.forEach((path) => console.error(`- ${path}`));
}

process.exit(1);
