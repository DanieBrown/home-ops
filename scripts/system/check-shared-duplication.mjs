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
 * Each new shared helper should be added to SHARED_EXPORTS so the hook stays
 * useful as scripts/shared/ grows.
 */

import { existsSync, readFileSync } from 'fs';

const SHARED_EXPORTS = new Map([
  ['slugify', '../shared/text-utils.mjs'],
  ['normalizeStreetSuffixes', '../shared/text-utils.mjs'],
  ['normalizeAddress', '../shared/text-utils.mjs'],
  ['normalizeCity', '../shared/text-utils.mjs'],
  ['parseListingRow', '../shared/listings.mjs'],
  ['serializeListing', '../shared/listings.mjs'],
  ['parseScore', '../shared/listings.mjs'],
  ['parseReportNumber', '../shared/listings.mjs'],
  ['mergeNotes', '../shared/listings.mjs'],
  ['chooseBetterStatus', '../shared/listings.mjs'],
  ['readCanonicalStatuses', '../shared/states.mjs'],
  ['buildCanonicalLookup', '../shared/states.mjs'],
]);

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

async function resolveFilePath() {
  if (process.argv[2]) {
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
  // Match `import { ..., name, ... } from '../shared/...'` and the
  // `import { name as alias }` form used by deliberate wrappers.
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
    findings.push({ name, modulePath });
  }
  return findings;
}

async function main() {
  const filePath = await resolveFilePath();
  if (!filePath || !existsSync(filePath) || !isInScope(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const findings = findDuplicates(content);
  if (findings.length === 0) {
    return;
  }

  const lines = [
    `[shared-duplication] ${filePath}:`,
  ];
  for (const finding of findings) {
    lines.push(`  - ${finding.name}() is already exported from ${finding.modulePath}`);
  }
  lines.push('  Consider importing from scripts/shared/ unless this is a deliberate wrapper.');

  process.stderr.write(`${lines.join('\n')}\n`);
}

main().catch(() => {
  // Hook failures must not block edits -- swallow and exit clean.
});
