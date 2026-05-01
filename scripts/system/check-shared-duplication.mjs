#!/usr/bin/env node

/**
 * check-shared-duplication.mjs -- PostToolUse hook for Claude Code.
 *
 * Reads the Claude Code hook payload from stdin (or accepts a file path on
 * argv for manual testing). If the edited file is a .mjs under scripts/ but
 * outside scripts/shared/, warns when it defines a function whose name is
 * already exported from a shared module.
 *
 * Skips files that import the matching name from scripts/shared/ -- those are
 * deliberate wrappers (e.g., merge-tracker's parseListingRow that adds status
 * canonicalization).
 *
 * Run with --scan-all to scan every non-shared .mjs under scripts/ in one pass.
 * Exits 0 regardless -- warn only, never block.
 *
 * Each new shared helper should be added to SHARED_EXPORTS so the hook stays
 * useful as scripts/shared/ grows.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SHARED_EXPORTS = new Map([
  ['slugify',               '../shared/text-utils.mjs'],
  ['normalizeStreetSuffixes','../shared/text-utils.mjs'],
  ['normalizeAddress',      '../shared/text-utils.mjs'],
  ['normalizeCity',         '../shared/text-utils.mjs'],
  ['parseListingRow',       '../shared/listings.mjs'],
  ['serializeListing',      '../shared/listings.mjs'],
  ['parseScore',            '../shared/listings.mjs'],
  ['parseReportNumber',     '../shared/listings.mjs'],
  ['mergeNotes',            '../shared/listings.mjs'],
  ['chooseBetterStatus',    '../shared/listings.mjs'],
  ['readCanonicalStatuses', '../shared/states.mjs'],
  ['buildCanonicalLookup',  '../shared/states.mjs'],
  ['normalizeStatus',       '../shared/states.mjs'],
  ['parseArgs',             '../shared/cli.mjs'],
  ['printHelp',             '../shared/cli.mjs'],
]);

// Alias keys from CANONICAL_ALIASES -- 3+ of these in a Map literal is a signal
const ALIAS_PROBE_KEYS = ['discovered', 'shortlisted', 'watchlist', 'bid', 'offer sent', 'declined'];

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

async function resolveFilePath() {
  if (process.argv[2] && process.argv[2] !== '--scan-all') {
    return process.argv[2];
  }

  if (process.stdin.isTTY) {
    return null;
  }

  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      return null;
    }
    const payload = JSON.parse(raw);
    return payload?.tool_input?.file_path ?? null;
  } catch {
    return null;
  }
}

function isInScope(filePath) {
  if (!filePath.endsWith('.mjs')) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (!/(?:^|\/)scripts\//.test(normalized)) {
    return false;
  }
  if (/(?:^|\/)scripts\/shared\//.test(normalized)) {
    return false;
  }
  return true;
}

function alreadyImports(content, name) {
  const direct = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*shared/`);
  const aliased = new RegExp(`import\\s*\\{[^}]*\\b${name}\\s+as\\s+\\w+[^}]*\\}\\s*from\\s*['"][^'"]*shared/`);
  return direct.test(content) || aliased.test(content);
}

function findDuplicates(content) {
  const findings = [];
  for (const [name, modulePath] of SHARED_EXPORTS) {
    const defined = new RegExp(`function\\s+${name}\\s*\\(`).test(content);
    if (!defined) {
      continue;
    }
    if (alreadyImports(content, name)) {
      continue;
    }
    findings.push({ name, modulePath, rule: 'function-duplicate' });
  }
  return findings;
}

function findStructuralViolations(content) {
  const findings = [];

  // Rule: inline ROOT computation (dirname+fileURLToPath pattern)
  if (/dirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url/.test(content)) {
    if (!alreadyImports(content, 'ROOT')) {
      findings.push({
        rule: 'inline-root',
        message: 'Inline ROOT computation detected — use ROOT from scripts/shared/paths.mjs',
        modulePath: '../shared/paths.mjs',
      });
    }
  }

  // Rule: inline status alias map (Map literal with 3+ alias keys as Map pair first elements)
  const aliasKeyHits = ALIAS_PROBE_KEYS.filter(
    (k) => content.includes(`['${k}',`) || content.includes(`["${k}",`)
  ).length;
  if (aliasKeyHits >= 3 && /new\s+Map\s*\(/.test(content)) {
    if (!alreadyImports(content, 'CANONICAL_ALIASES') && !alreadyImports(content, 'normalizeStatus')) {
      findings.push({
        rule: 'inline-alias-map',
        message: 'Inline status alias map detected — use CANONICAL_ALIASES from scripts/shared/states.mjs',
        modulePath: '../shared/states.mjs',
      });
    }
  }

  return findings;
}

function checkFile(filePath) {
  if (!existsSync(filePath) || !isInScope(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, 'utf-8');
  return [...findDuplicates(content), ...findStructuralViolations(content)];
}

function walkScripts(scriptsDir) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!full.replace(/\\/g, '/').endsWith('/scripts/shared')) {
            walk(full);
          }
        } else if (entry.endsWith('.mjs')) {
          files.push(full);
        }
      } catch { /* skip unreadable */ }
    }
  }
  walk(scriptsDir);
  return files;
}

function reportFindings(filePath, findings) {
  if (findings.length === 0) {
    return;
  }
  const lines = [`[shared-duplication] ${filePath}:`];
  for (const f of findings) {
    if (f.rule === 'function-duplicate') {
      lines.push(`  - ${f.name}() is already exported from ${f.modulePath}`);
    } else {
      lines.push(`  - ${f.message}`);
    }
  }
  lines.push('  Consider importing from scripts/shared/ unless this is a deliberate wrapper.');
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function main() {
  const scanAll = process.argv.includes('--scan-all');

  if (scanAll) {
    const scriptsDir = join(process.cwd(), 'scripts');
    const files = walkScripts(scriptsDir);
    let totalViolations = 0;
    for (const file of files) {
      const findings = checkFile(file);
      if (findings.length > 0) {
        totalViolations += findings.length;
        reportFindings(file, findings);
      }
    }
    if (totalViolations > 0) {
      process.stderr.write(`[shared-duplication] ${totalViolations} violation(s) found across ${files.length} script(s) scanned.\n`);
    }
    // Exit 0 regardless -- warn only, never block
    return;
  }

  const filePath = await resolveFilePath();
  if (!filePath || !existsSync(filePath) || !isInScope(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const findings = [...findDuplicates(content), ...findStructuralViolations(content)];
  reportFindings(filePath, findings);
}

main().catch(() => {
  // Hook failures must not block edits -- swallow and exit clean.
});
