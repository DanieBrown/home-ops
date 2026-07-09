# Deep Briefing Model-First Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the deep-mode axis-agent outputs as a validated `output/axis/{slug}.json` sidecar and rebuild the briefing PDF around structured data (photos, gauges, sentiment chart, risk ring map, gate chips, page packing/furniture).

**Architecture:** A new writer script validates and persists the merged axis JSON with standard knowledge-store metadata; new contract gates make it a prerequisite of the briefing PDF. `briefing-pdf.mjs` gains a per-section consumption hierarchy (axis sidecar → raw capture sidecars → report-markdown regex fallback) and a new page model. The listing extractor caches photos through the authenticated hosted browser session so the PDF can embed them as base64.

**Tech Stack:** Node.js `.mjs` (ESM), Playwright `page.pdf()`, inline SVG for all charts, `node:assert/strict` tests registered in `scripts/system/test-all.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-08-deep-briefing-model-first-rebuild-design.md`

## Global Constraints

- **Zero new npm dependencies.** Charts are inline SVG; PDF rendering stays Playwright `page.pdf()`.
- **Node >= 18** (`package.json` engines). ESM `.mjs` only.
- **"Unknown, not favorable" doctrine:** every new PDF block degrades gracefully when its data is missing; a run with no axis sidecar must render today's legacy output.
- **Sidecar conventions:** all sidecars carry `withSidecarMetadata` fields and are registered via `recordArtifact` (`scripts/shared/knowledge-store.mjs`).
- **Windows-safe paths:** always normalize recorded paths with `.replace(/\\/g, '/')`.
- **Tests:** plain `node:assert/strict`, top-level `await` allowed, exit non-zero on failure, registered as a block in `scripts/system/test-all.mjs`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Axis output schemas** are defined in `.claude/agents/sentiment-axis.md`, `.claude/agents/risk-builder-axis.md`, `.claude/agents/schools-axis.md` — the sidecar stores them verbatim.

---

### Task 1: Axis sidecar writer script

**Files:**
- Create: `scripts/research/axis-sidecar-write.mjs`
- Create: `scripts/tests/test-axis-sidecar.mjs`
- Modify: `package.json` (add `axis:write` script)
- Modify: `scripts/system/test-all.mjs` (register test + `--help` check)

**Interfaces:**
- Consumes: `parseReport(root, path)` from `scripts/research/research-utils.mjs` (returns `{address, city, state, relativePath, metadata, sections, content}`); `withSidecarMetadata(record, opts)`, `recordArtifact(opts)`, `expiresInDays(days, from)`, `subjectKeyForTarget(target)` from `scripts/shared/knowledge-store.mjs`; `slugify` from `scripts/shared/text-utils.mjs`.
- Produces: `validateAxisPayload(payload, report) -> {ok: boolean, errors: string[]}`; `writeAxisSidecar(report, payload, {root}) -> Promise<{slug, outputPath, sidecar}>`; `buildAxisSlug(report) -> string`; CLI `node scripts/research/axis-sidecar-write.mjs --report <path> --input <json-path> [--json]`. Sidecar file `output/axis/{slug}.json` with top-level `address/city/state/slug/reportPath/sentiment/riskBuilder/schools/verdict` + metadata fields. Task 4's PDF loader and Task 2's contract assertions rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test-axis-sidecar.mjs`:

```js
#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReport } from '../research/research-utils.mjs';
import {
  buildAxisSlug,
  validateAxisPayload,
  writeAxisSidecar,
} from '../research/axis-sidecar-write.mjs';

const root = mkdtempSync(join(tmpdir(), 'axis-test-'));
mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(
  join(root, 'reports', '001-100-test-dr-2026-07-08.md'),
  '# 100 Test Dr - Apex, NC\n\n**Date:** 2026-07-08\n**Overall Score:** 4.0/5\n\n## Quick Take\n\nFixture home.\n',
  'utf8',
);
const report = parseReport(root, 'reports/001-100-test-dr-2026-07-08.md');
assert.equal(report.address, '100 Test Dr');
assert.equal(report.city, 'Apex');

const goodPayload = {
  sentiment: {
    slug: '100-test-dr-apex-nc',
    sentimentScores: {
      community: { score: 0.3, signalDirection: 'positive', evidenceCount: 4, proximityMix: 'near', quotes: ['Great neighbors'], source: 'sidecar' },
    },
    redFlagsTriggered: [],
    sourceCoverage: { google_maps: 'captured' },
    confidence: 'medium',
  },
  riskBuilder: {
    riskLevel: 'low',
    nearbyProjects: [],
    sourceCoverage: { ncdot: 'captured', county: 'captured', builder: 'not-applicable' },
    confidence: 'medium',
  },
  schools: {
    schools: [{ name: 'Test Elementary', gradeLevel: 'elementary', rating: 8, source: 'sidecar' }],
    weightedSchoolScore: 0.62,
    flags: [],
    sourceCoverage: 'captured',
    confidence: 'high',
  },
  verdict: {
    recommendation: 'pursue',
    confidence: 'medium',
    rationale: 'Fixture rationale.',
    inPersonChecks: ['Confirm fence'],
  },
};

assert.deepEqual(validateAxisPayload(goodPayload, report).errors, []);
assert.equal(validateAxisPayload(goodPayload, report).ok, true);

const missingBlock = validateAxisPayload(
  { sentiment: goodPayload.sentiment, schools: goodPayload.schools, verdict: goodPayload.verdict },
  report,
);
assert.equal(missingBlock.ok, false);
assert.ok(missingBlock.errors.some((error) => /riskBuilder/.test(error)));

const degraded = validateAxisPayload({
  sentiment: { status: 'missing-input', confidence: 'low' },
  riskBuilder: { status: 'missing-input', confidence: 'low' },
  schools: { status: 'missing-input', confidence: 'low' },
  verdict: { recommendation: 'pass', confidence: 'low', rationale: 'No evidence.', inPersonChecks: [] },
}, report);
assert.equal(degraded.ok, true);

const badRisk = validateAxisPayload(
  { ...goodPayload, riskBuilder: { riskLevel: 'extreme' } },
  report,
);
assert.equal(badRisk.ok, false);

const mismatch = validateAxisPayload(
  { ...goodPayload, address: '999 Other Rd', city: 'Cary' },
  report,
);
assert.equal(mismatch.ok, false);
assert.ok(mismatch.errors.some((error) => /address/.test(error)));

assert.equal(buildAxisSlug(report), '100-test-dr-apex-nc');

const { slug, outputPath, sidecar } = await writeAxisSidecar(report, goodPayload, { root });
assert.equal(slug, '100-test-dr-apex-nc');
assert.ok(existsSync(outputPath));
assert.equal(sidecar.schemaVersion, 1);
assert.equal(sidecar.scope, 'property');
assert.equal(sidecar.subjectKey, '100-test-dr-apex-nc');
assert.ok(sidecar.expiresAt);
const onDisk = JSON.parse(readFileSync(outputPath, 'utf8'));
assert.equal(onDisk.verdict.recommendation, 'pursue');
assert.equal(onDisk.reportPath, 'reports/001-100-test-dr-2026-07-08.md');
assert.equal(onDisk.address, '100 Test Dr');
assert.ok(existsSync(join(root, 'output', 'knowledge', 'index.json')));

rmSync(root, { recursive: true, force: true });
console.log('test-axis-sidecar: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/test-axis-sidecar.mjs`
Expected: FAIL with `Cannot find module ... axis-sidecar-write.mjs`

- [ ] **Step 3: Write the implementation**

Create `scripts/research/axis-sidecar-write.mjs`:

```js
#!/usr/bin/env node

/**
 * axis-sidecar-write.mjs -- Persist the merged axis-agent outputs for one home
 * as output/axis/{slug}.json.
 *
 * The three deep-mode axis agents (sentiment, risk-builder, schools) return
 * structured JSON to the main agent. The main agent merges those objects plus
 * its own verdict synthesis into a temp file under .home-ops/tmp/{commandId}/
 * and calls this script, which validates the payload shape, stamps standard
 * sidecar metadata, and writes the sidecar the briefing PDF consumes. Exits 1
 * on validation failure so the deep contract records the failure.
 */

import { readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import { parseReport } from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';
import {
  expiresInDays,
  recordArtifact,
  subjectKeyForTarget,
  withSidecarMetadata,
} from '../shared/knowledge-store.mjs';

const AXIS_EXPIRY_DAYS = 14;
const RISK_LEVELS = new Set(['low', 'moderate', 'high']);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

const HELP_TEXT = `Usage:
  node axis-sidecar-write.mjs --report reports/{N}-{slug}-{date}.md --input <merged-axis.json> [--json]

Validates the merged axis-agent payload and writes output/axis/{slug}.json.
The payload must contain "sentiment", "riskBuilder", "schools", and "verdict"
blocks. Each axis block is either its documented agent output schema or a
degraded { "status": "missing-input", ... } record.

Options:
  --report <path>   Canonical eval report for the home (required).
  --input <path>    JSON file holding the merged axis payload (required).
  --json            Print the result summary as JSON.
  --help            Show this help text.
`;

function parseCliArgs(argv) {
  const config = { reportPath: '', inputPath: '', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--report') { config.reportPath = argv[++i] ?? ''; continue; }
    if (arg === '--input') { config.inputPath = argv[++i] ?? ''; continue; }
    if (arg === '--json') { config.json = true; continue; }
    throw new Error(`Unknown option: ${arg}`);
  }
  return config;
}

function normalizeLocationField(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissingInput(block) {
  return isObject(block) && block.status === 'missing-input';
}

export function validateAxisPayload(payload, report = null) {
  if (!isObject(payload)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }
  const errors = [];
  for (const key of ['sentiment', 'riskBuilder', 'schools', 'verdict']) {
    if (!isObject(payload[key])) errors.push(`missing or non-object block: ${key}`);
  }

  const { sentiment, riskBuilder, schools, verdict } = payload;
  if (isObject(sentiment) && !isMissingInput(sentiment) && !isObject(sentiment.sentimentScores)) {
    errors.push('sentiment.sentimentScores must be an object (or sentiment.status must be "missing-input")');
  }
  if (isObject(riskBuilder) && !isMissingInput(riskBuilder) && !RISK_LEVELS.has(String(riskBuilder.riskLevel))) {
    errors.push('riskBuilder.riskLevel must be low|moderate|high (or riskBuilder.status must be "missing-input")');
  }
  if (isObject(schools) && !isMissingInput(schools) && !Array.isArray(schools.schools)) {
    errors.push('schools.schools must be an array (or schools.status must be "missing-input")');
  }
  if (isObject(verdict)) {
    if (!String(verdict.recommendation ?? '').trim()) errors.push('verdict.recommendation is required');
    if (!CONFIDENCE_LEVELS.has(String(verdict.confidence))) errors.push('verdict.confidence must be high|medium|low');
  }

  if (report && payload.address
    && normalizeLocationField(payload.address) !== normalizeLocationField(report.address)) {
    errors.push(`payload address "${payload.address}" does not match report address "${report.address}"`);
  }
  if (report && payload.city
    && normalizeLocationField(payload.city) !== normalizeLocationField(report.city)) {
    errors.push(`payload city "${payload.city}" does not match report city "${report.city}"`);
  }

  return { ok: errors.length === 0, errors };
}

export function buildAxisSlug(report) {
  return slugify(`${report.address}-${report.city}-${report.state || 'NC'}`) || 'axis-target';
}

export async function writeAxisSidecar(report, payload, { root = ROOT } = {}) {
  const slug = buildAxisSlug(report);
  const outputDir = join(root, 'output', 'axis');
  const outputPath = join(outputDir, `${slug}.json`);
  const generatedAt = new Date().toISOString();
  const target = { address: report.address, city: report.city, state: report.state || 'NC' };
  const sidecar = withSidecarMetadata({
    generatedAt,
    address: report.address,
    city: report.city,
    state: report.state || 'NC',
    slug,
    reportPath: report.relativePath,
    sentiment: payload.sentiment,
    riskBuilder: payload.riskBuilder,
    schools: payload.schools,
    verdict: payload.verdict,
  }, {
    kind: 'axis',
    scope: 'property',
    subject: target,
    subjectKey: subjectKeyForTarget(target),
    generatedAt,
    expiresAt: expiresInDays(AXIS_EXPIRY_DAYS, generatedAt),
    status: 'ok',
  });
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  recordArtifact({
    path: outputPath,
    kind: 'axis',
    scope: 'property',
    subject: target,
    subjectKey: sidecar.subjectKey,
    commandId: sidecar.commandId,
    generatedAt: sidecar.generatedAt,
    expiresAt: sidecar.expiresAt,
    sourceUrls: [],
    status: sidecar.status,
    warnings: sidecar.warnings,
    root,
  });
  return { slug, outputPath, sidecar };
}

function axisBlockStatus(block) {
  if (!isObject(block)) return 'missing';
  if (isMissingInput(block)) return 'missing-input';
  return 'ok';
}

async function main() {
  let config;
  try {
    config = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }
  if (!config.reportPath || !config.inputPath) {
    console.error('Error: --report and --input are both required.');
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  const report = parseReport(ROOT, config.reportPath);
  let payload;
  try {
    payload = JSON.parse(readFileSync(config.inputPath, 'utf8'));
  } catch (error) {
    console.error(`Error: could not parse ${config.inputPath} as JSON: ${error.message}`);
    process.exit(1);
  }

  const validation = validateAxisPayload(payload, report);
  if (!validation.ok) {
    console.error('Axis payload validation failed:');
    for (const error of validation.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const { slug, outputPath, sidecar } = await writeAxisSidecar(report, payload);
  const summary = {
    slug,
    outputPath: relative(ROOT, outputPath).replace(/\\/g, '/'),
    sentiment: axisBlockStatus(sidecar.sentiment),
    riskBuilder: axisBlockStatus(sidecar.riskBuilder),
    schools: axisBlockStatus(sidecar.schools),
    verdict: sidecar.verdict?.recommendation ?? null,
    confidence: sidecar.verdict?.confidence ?? null,
  };
  if (config.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`Axis sidecar written: ${summary.outputPath}`);
  console.log(`  sentiment: ${summary.sentiment} | riskBuilder: ${summary.riskBuilder} | schools: ${summary.schools}`);
  console.log(`  verdict: ${summary.verdict} (confidence ${summary.confidence})`);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/test-axis-sidecar.mjs`
Expected: PASS — prints `test-axis-sidecar: all assertions passed`

- [ ] **Step 5: Register the npm script and the test**

In `package.json` scripts block, after the line `"brief:single": "node scripts/reports/briefing-pdf.mjs --report",` add:

```json
    "axis:write": "node scripts/research/axis-sidecar-write.mjs",
```

In `scripts/system/test-all.mjs`: add `'scripts/research/axis-sidecar-write.mjs --help',` to the `scripts` array (after the `'scripts/reports/briefing-pdf.mjs --help',` line), and after the `test-utility-options.mjs` block add:

```js
{
  const result = run('node scripts/tests/test-axis-sidecar.mjs');
  if (result.ok) {
    pass('axis sidecar validation and write tests');
  } else {
    fail(`axis sidecar validation and write tests\n${result.output}`);
  }
}
```

- [ ] **Step 6: Verify registration**

Run: `node scripts/research/axis-sidecar-write.mjs --help`
Expected: prints the usage text, exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/research/axis-sidecar-write.mjs scripts/tests/test-axis-sidecar.mjs package.json scripts/system/test-all.mjs
git commit -m "feat: add axis-sidecar-write script persisting merged axis-agent outputs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Contract gates and reset classification

**Files:**
- Modify: `scripts/hooks/contract-shared.mjs:20` (export CONTRACTS), `:173-190` (deep-single), `:224-249` (deep-shortlist)
- Modify: `scripts/pipeline/reset-search-state.mjs:26-31` (OUTPUT_CACHE_SUBDIRS) and its help text (~line 142-144)
- Test: `scripts/tests/test-axis-sidecar.mjs` (extend)

**Interfaces:**
- Consumes: the `req(id, description, patterns, opts)` helper and `CONTRACTS` object in `contract-shared.mjs`.
- Produces: exported `CONTRACTS` const; requirement id `axis-sidecar` in both deep templates matched by `/axis-sidecar-write\.mjs\b/` or `/npm(?:\.cmd)?\s+run\s+axis:write\b/`; `briefing-pdf-deep-single.requires` includes `'axis-sidecar'`; `briefing-pdf.requires` (deep-shortlist) includes `'axis-sidecar'`; `output/axis` cleared by reset.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/test-axis-sidecar.mjs`, immediately before the final `rmSync(...)` line:

```js
const { CONTRACTS } = await import('../hooks/contract-shared.mjs');
const deepSingle = CONTRACTS['deep-single'].required;
const singleAxisReq = deepSingle.find((entry) => entry.id === 'axis-sidecar');
assert.ok(singleAxisReq, 'deep-single contract must include an axis-sidecar requirement');
assert.ok(singleAxisReq.patterns.some((rx) => rx.test('node scripts/research/axis-sidecar-write.mjs --report r.md --input a.json')));
assert.ok(singleAxisReq.requires.includes('deep-research-packet-single'));
const singlePdfReq = deepSingle.find((entry) => entry.id === 'briefing-pdf-deep-single');
assert.ok(singlePdfReq.requires.includes('axis-sidecar'), 'briefing-pdf-deep-single must require axis-sidecar');

const deepShortlist = CONTRACTS['deep-shortlist'].required;
const batchAxisReq = deepShortlist.find((entry) => entry.id === 'axis-sidecar');
assert.ok(batchAxisReq, 'deep-shortlist contract must include an axis-sidecar requirement');
assert.ok(batchAxisReq.requires.includes('deep-research-packet'));
const batchPdfReq = deepShortlist.find((entry) => entry.id === 'briefing-pdf');
assert.ok(batchPdfReq.requires.includes('axis-sidecar'), 'batch briefing-pdf must require axis-sidecar');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/test-axis-sidecar.mjs`
Expected: FAIL — `CONTRACTS` is undefined (not exported yet).

- [ ] **Step 3: Implement the contract changes**

In `scripts/hooks/contract-shared.mjs`:

1. Change `const CONTRACTS = {` to `export const CONTRACTS = {`.
2. In the `'deep-single'` template, after the closing of the `deep-research-packet-single` req (the `}),` at line ~180) and before the `review-tabs-single` req, insert:

```js
      req('axis-sidecar', 'Persist merged axis-agent outputs to output/axis/{slug}.json', [
        /axis-sidecar-write\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+axis:write\b/,
      ], { requires: ['deep-research-packet-single'], isGate: true }),
```

3. Still in `'deep-single'`, change the `briefing-pdf-deep-single` req's opts from `{ requires: ['review-tabs-single'], isGate: true }` to `{ requires: ['review-tabs-single', 'axis-sidecar'], isGate: true }`.
4. In the `'deep-shortlist'` template, after the `deep-research-packet` req and before `promote-finalists`, insert:

```js
      req('axis-sidecar', 'Persist merged axis-agent outputs to output/axis/{slug}.json (per home)', [
        /axis-sidecar-write\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+axis:write\b/,
      ], { requires: ['deep-research-packet'], isGate: true }),
```

5. Change the batch `briefing-pdf` req's `requires: ['review-tabs-top3']` to `requires: ['review-tabs-top3', 'axis-sidecar']`.

In `scripts/pipeline/reset-search-state.mjs`:

1. Add `'axis',` as the first entry of `OUTPUT_CACHE_SUBDIRS`:

```js
const OUTPUT_CACHE_SUBDIRS = [
  'axis',
  'briefings',
  'cache',
  'deep-packets',
  'evaluate-packets',
];
```

2. In the help text, change the line `  - output/briefings/, output/cache/` to `  - output/axis/, output/briefings/, output/cache/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/test-axis-sidecar.mjs`
Expected: PASS.
Also run: `node --check scripts/hooks/contract-shared.mjs && node scripts/pipeline/reset-search-state.mjs --help`
Expected: help text prints and includes `output/axis/`.

- [ ] **Step 5: Commit**

```bash
git add scripts/hooks/contract-shared.mjs scripts/pipeline/reset-search-state.mjs scripts/tests/test-axis-sidecar.mjs
git commit -m "feat: gate deep briefing PDF on axis sidecar; clear output/axis on reset

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Photo caching in the listing extractor

**Files:**
- Modify: `scripts/research/extract-listing-details.mjs` (imports at :25-28, new functions before `writeListing` ~:983, call in `main()` after `extractListing`)
- Create: `scripts/tests/test-photo-cache.mjs`
- Modify: `scripts/system/test-all.mjs` (register test)

**Interfaces:**
- Consumes: `attachHostedBrowser(ROOT, profileName) -> {browser, context, session}` and `safeClose({page, browser})` from `scripts/browser/browser-extract-utils.mjs`; `buildSlug(listing)` (already in file).
- Produces: `savePhotoBuffers(slug, buffers, {root}) -> Promise<string[]>` (workspace-relative forward-slash paths, exported); `downloadListingPhotos(listing, profileName) -> Promise<listing>` (exported; sets `listing.photos.localPaths`). Task 5's `photoDataUri` reads the `photos.localPaths` field from `output/listings/{slug}.json`.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test-photo-cache.mjs`:

```js
#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePhotoBuffers } from '../research/extract-listing-details.mjs';

const root = mkdtempSync(join(tmpdir(), 'photo-test-'));
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const localPaths = await savePhotoBuffers('100-test-dr-apex-nc', [onePixelPng, null, onePixelPng], { root });
assert.equal(localPaths.length, 2);
assert.equal(localPaths[0], 'output/listings/photos/100-test-dr-apex-nc/photo-1.jpg');
assert.equal(localPaths[1], 'output/listings/photos/100-test-dr-apex-nc/photo-3.jpg');
assert.ok(existsSync(join(root, localPaths[0])));
assert.ok(existsSync(join(root, localPaths[1])));

const empty = await savePhotoBuffers('100-test-dr-apex-nc', [null, undefined], { root });
assert.deepEqual(empty, []);

rmSync(root, { recursive: true, force: true });
console.log('test-photo-cache: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/tests/test-photo-cache.mjs`
Expected: FAIL — `savePhotoBuffers` is not exported.

- [ ] **Step 3: Implement photo caching**

In `scripts/research/extract-listing-details.mjs`:

1. Change the path import (line ~27) from `import { dirname, join } from 'path';` to `import { dirname, join, relative } from 'path';` (keep whatever names are currently imported and add `relative`).
2. Insert the following immediately above the `async function writeListing(listing)` definition:

```js
// ---------------------------------------------------------------------------
// Photo caching
// The briefing PDF embeds photos as base64 data URIs, so they must exist on
// disk at capture time -- remote hotlinks 403 or stall networkidle at render.
// ---------------------------------------------------------------------------

const PHOTO_DOWNLOAD_TIMEOUT_MS = 10000;
const PHOTO_MAX_COUNT = 3;

export async function savePhotoBuffers(slug, buffers, { root = ROOT } = {}) {
  const photoDir = join(root, 'output', 'listings', 'photos', slug);
  const localPaths = [];
  let wroteDir = false;
  for (let index = 0; index < buffers.length; index += 1) {
    const buffer = buffers[index];
    if (!buffer || buffer.length === 0) continue;
    if (!wroteDir) {
      await mkdir(photoDir, { recursive: true });
      wroteDir = true;
    }
    const filePath = join(photoDir, `photo-${index + 1}.jpg`);
    await writeFile(filePath, buffer);
    localPaths.push(relative(root, filePath).replace(/\\/g, '/'));
  }
  return localPaths;
}

async function fetchPhotoBuffer(requestContext, url) {
  if (requestContext) {
    try {
      const response = await requestContext.get(url, { timeout: PHOTO_DOWNLOAD_TIMEOUT_MS });
      if (response.ok()) return Buffer.from(await response.body());
    } catch { /* fall through to plain fetch */ }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PHOTO_DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch { /* unrecoverable for this photo */ }
  return null;
}

export async function downloadListingPhotos(listing, profileName) {
  const urls = (listing.photos?.urls ?? []).slice(0, PHOTO_MAX_COUNT);
  if (urls.length === 0) return listing;

  let browser = null;
  let requestContext = null;
  try {
    const attached = await attachHostedBrowser(ROOT, profileName);
    browser = attached.browser;
    requestContext = attached.context.request;
  } catch {
    listing.coverageNotes.push('photo download: hosted session unavailable, using direct fetch only');
  }

  const buffers = [];
  for (const url of urls) {
    buffers.push(await fetchPhotoBuffer(requestContext, url));
  }
  if (browser) await safeClose({ browser });

  const localPaths = await savePhotoBuffers(buildSlug(listing), buffers);
  if (localPaths.length > 0) {
    listing.photos.localPaths = localPaths;
  } else {
    listing.coverageNotes.push('photo download failed for all listing photos');
  }
  return listing;
}
```

3. In `main()`, immediately after the line that assigns `const listing = await extractListing(...)` (or equivalent — the call that produces `listing`) and before `writeListing(listing)` is called, insert:

```js
  await downloadListingPhotos(listing, config.profileName);
```

Do NOT call `downloadListingPhotos` inside `extractListing` itself — `school-metadata-fetch.mjs` imports `extractListing` and must not trigger photo downloads.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/tests/test-photo-cache.mjs`
Expected: PASS.
Also run: `node --check scripts/research/extract-listing-details.mjs && node scripts/tests/test-extract-parsers.mjs`
Expected: both succeed (existing parser tests unaffected).

- [ ] **Step 5: Register the test**

In `scripts/system/test-all.mjs`, after the axis-sidecar block from Task 1, add:

```js
{
  const result = run('node scripts/tests/test-photo-cache.mjs');
  if (result.ok) {
    pass('listing photo cache write tests');
  } else {
    fail(`listing photo cache write tests\n${result.output}`);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/research/extract-listing-details.mjs scripts/tests/test-photo-cache.mjs scripts/system/test-all.mjs
git commit -m "feat: cache listing photos at capture time for PDF embedding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: PDF axis data spine and fixture harness

**Files:**
- Modify: `scripts/reports/briefing-pdf.mjs` (`AXIS_DIR` const near :28-38, `loadFinalist` :2135-2170, `buildGapList` :202-262, export `buildHtml` :1577)
- Create: `scripts/tests/fixtures/briefing/046-fixture-home.md`
- Create: `scripts/tests/test-briefing-html.mjs`
- Modify: `scripts/system/test-all.mjs` (register test)

**Interfaces:**
- Consumes: `loadCompanionForReport(report, dir, label)` (already in briefing-pdf.mjs), `parseReport` from research-utils.
- Produces: `export function buildHtml(finalists, profile, mode, context = {})` where `context.trackerContent` is the raw `data/listings.md` string (used from Task 5 on); `finalist.axis` (parsed axis sidecar or null) and `finalist.axisMismatch` (string) on every finalist object. The test helper `makeFinalist(overrides)` in `test-briefing-html.mjs` that Tasks 5–8 extend.

- [ ] **Step 1: Create the fixture report**

Create `scripts/tests/fixtures/briefing/046-fixture-home.md`:

```markdown
# 100 Fixture Dr - Apex, NC

**Date:** 2026-07-08
**Source:** Realtor.com
**URL:** https://www.realtor.com/realestateandhomes-detail/fixture
**Price:** $700,000
**Beds/Baths:** 4/2.5
**SqFt:** 2,900
**Lot:** 12,000 sq ft
**Year Built:** 2015
**HOA:** $50/month
**Days on Market:** 3 days on market
**Overall Score:** 4.2/5
**Recommendation:** Worth touring
**Confidence:** Medium
**Verification:** active

## Quick Take

Fixture home for briefing HTML tests.

## Hard Requirement Gate

| Requirement | Result | Notes |
|---|---|---|
| Price | Pass | Inside the band. |
| Bedrooms | Pass | 4 bedrooms. |
| Yard usability | Needs validation | Fence not confirmed. |
| Busy road | Fail | Backs to a collector road. |

## Neighborhood Sentiment

No structured sentiment captured for this fixture.

## School Review

| School | Grades | Rating | Enrollment | Ratio | Notes |
|---|---|---:|---:|---|---|
| Fixture Elementary School | K-5 | 8/10 | 700 | 14:1 | Traditional calendar. |

## Development and Infrastructure

No development capture for this fixture.

## Risks and Open Questions

- Fence status unconfirmed.
- Road noise needs a drive-by.

## Recommendation

**Worth touring.** Fixture recommendation text.
```

- [ ] **Step 2: Write the failing test**

Create `scripts/tests/test-briefing-html.mjs`:

```js
#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ROOT } from '../shared/paths.mjs';
import { parseReport } from '../research/research-utils.mjs';
import { buildHtml } from '../reports/briefing-pdf.mjs';

const report = parseReport(ROOT, 'scripts/tests/fixtures/briefing/046-fixture-home.md');
assert.equal(report.address, '100 Fixture Dr');

export function makeFinalist(overrides = {}) {
  return {
    rank: 1,
    report,
    construction: null,
    permits: null,
    sentiment: null,
    builder: null,
    hoaRules: null,
    utilities: null,
    packet: null,
    listing: null,
    community: null,
    axis: null,
    constructionMismatch: '',
    permitsMismatch: '',
    sentimentMismatch: '',
    builderMismatch: '',
    hoaMismatch: '',
    utilitiesMismatch: '',
    packetMismatch: '',
    axisMismatch: '',
    ...overrides,
  };
}

// Legacy render without any axis sidecar must still work end-to-end.
const legacyHtml = buildHtml([makeFinalist()], null, 'single');
assert.ok(legacyHtml.includes('100 Fixture Dr'));
assert.ok(legacyHtml.includes('Neighborhood Sentiment'));
assert.ok(/Not yet captured from Facebook or Nextdoor/.test(legacyHtml));

// A missing axis sidecar is a named research gap.
assert.ok(/Axis-agent interpretation sidecar has not been written/.test(legacyHtml));

console.log('test-briefing-html: all assertions passed');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: FAIL — `buildHtml` is not exported (and the gap message does not exist yet).

- [ ] **Step 4: Implement the spine**

In `scripts/reports/briefing-pdf.mjs`:

1. After the `const UTILITIES_DIR = ...` line (~:38), add:

```js
const AXIS_DIR = join(ROOT, 'output', 'axis');
```

2. Change `function buildHtml(finalists, profile, mode = 'batch') {` to `export function buildHtml(finalists, profile, mode = 'batch', context = {}) {` (the `context` parameter is consumed in Task 5).
3. In `loadFinalist(reportPath, rank = 1)`, after the `utilitiesCompanion` line add:

```js
  const axisCompanion = loadCompanionForReport(report, AXIS_DIR, 'Axis');
```

and add to the returned object (alongside the other companions):

```js
    axis: axisCompanion.data,
    axisMismatch: axisCompanion.mismatchMessage,
```

4. In `buildGapList(report, finalist, profile)`, after the `if (!finalist.sentiment) {...}` block add:

```js
  if (!finalist.axis) {
    gaps.push('Axis-agent interpretation sidecar has not been written for this home (deep axis phase incomplete).');
  }
  if (finalist.axisMismatch) {
    gaps.push(finalist.axisMismatch);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: PASS.

- [ ] **Step 6: Register the test**

In `scripts/system/test-all.mjs`, after the photo-cache block, add:

```js
{
  const result = run('node scripts/tests/test-briefing-html.mjs');
  if (result.ok) {
    pass('briefing HTML fixture tests');
  } else {
    fail(`briefing HTML fixture tests\n${result.output}`);
  }
}
```

Note: `test-all.mjs` walks with `skipDirs` excluding `output/` and `reports/` but not `scripts/tests/fixtures/` — the fixture is a `.md` file, and the legacy/absolute-path scans only flag specific patterns; the fixture content above contains none of them.

- [ ] **Step 7: Commit**

```bash
git add scripts/reports/briefing-pdf.mjs scripts/tests/fixtures/briefing/046-fixture-home.md scripts/tests/test-briefing-html.mjs scripts/system/test-all.mjs
git commit -m "feat: load axis sidecar into briefing PDF data spine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Overview decision dashboard

**Files:**
- Modify: `scripts/reports/briefing-pdf.mjs` (new builders before `buildFinalistSection` ~:1441; overview assembly inside `buildFinalistSection` :1528-1553; badges row :1562-1566; `buildHtml` context threading :1577-1582; `run()` tracker read :2233-2285; CSS block before `</style>` ~:2101)
- Create: `scripts/tests/fixtures/briefing/photo-1.png` (written by the test setup command below)
- Test: `scripts/tests/test-briefing-html.mjs` (extend)

**Interfaces:**
- Consumes: `parseListingRow` from `scripts/shared/listings.mjs`; `LISTINGS_FILE` from `scripts/shared/paths.mjs`; `finalist.axis` from Task 4; `photos.localPaths` from Task 3.
- Produces: `export function parseGateRows(gateSection) -> Array<{requirement, result, state: 'pass'|'fail'|'unknown'}>`; `export function computeCityMedianPricePerSqft(trackerContent, city) -> {median, sampleSize} | null`; internal `photoDataUri(localPath)`, `buildPhotoStrip(finalist)`, `buildKpiTiles(finalist, medianInfo)`, `buildGateChips(report)`, `gaugeSvg(value, {min,max})`, `buildAxisScoreboard(finalist)`. `gaugeSvg` is reused by Task 8.

- [ ] **Step 1: Create the fixture photo**

Run (Git Bash):

```bash
node -e "require('fs').writeFileSync('scripts/tests/fixtures/briefing/photo-1.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64'))"
```

- [ ] **Step 2: Write the failing tests**

Append to `scripts/tests/test-briefing-html.mjs` (before the final `console.log`), and add `parseGateRows, computeCityMedianPricePerSqft` to the briefing-pdf import:

```js
// --- Task 5: overview dashboard ---
const gateRows = parseGateRows(report.sections['Hard Requirement Gate']);
assert.equal(gateRows.length, 4);
assert.deepEqual(gateRows.map((row) => row.state), ['pass', 'pass', 'unknown', 'fail']);
assert.deepEqual(parseGateRows(''), []);

const trackerFixture = [
  '| # | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes |',
  '|---|------|---------|------|-------|------------|------|-------|--------|--------|-------|',
  '| 1 | 2026-05-07 | 1 A St | Apex | $600,000 | 4/2 | 3,000 | 4/5 | Evaluated | [1](reports/1.md) | n |',
  '| 2 | 2026-05-07 | 2 B St | Apex | $700,000 | 4/2 | 2,800 | 4/5 | Evaluated | [2](reports/2.md) | n |',
  '| 3 | 2026-05-07 | 3 C St | Apex | $750,000 | 4/2 | 3,000 | 4/5 | Evaluated | [3](reports/3.md) | n |',
  '| 4 | 2026-05-07 | 4 D St | Cary | $900,000 | 4/2 | 3,000 | 4/5 | Evaluated | [4](reports/4.md) | n |',
].join('\n');
const median = computeCityMedianPricePerSqft(trackerFixture, 'Apex');
assert.equal(median.sampleSize, 3);
assert.equal(Math.round(median.median), 250);
assert.equal(computeCityMedianPricePerSqft(trackerFixture, 'Cary'), null);

const axisFixture = {
  address: '100 Fixture Dr',
  city: 'Apex',
  state: 'NC',
  sentiment: {
    sentimentScores: {
      community: { score: 0.4, signalDirection: 'positive', evidenceCount: 5, proximityMix: 'near', quotes: ['Lovely block parties'], source: 'sidecar' },
      traffic_commute: { score: -0.3, signalDirection: 'negative', evidenceCount: 3, proximityMix: 'adjacent', quotes: ['Backups on the collector'], source: 'sidecar' },
    },
    redFlagsTriggered: ['busy road'],
    sourceCoverage: { google_maps: 'captured', facebook: 'blocked' },
    confidence: 'medium',
  },
  riskBuilder: {
    riskLevel: 'moderate',
    nearbyProjects: [
      { description: 'Collector road widening', source: 'ncdot', status: 'active', distanceMiles: 0.8, caseId: 'STIP-U-1234' },
      { description: 'Subdivision phase 2', source: 'county-permit', status: 'approved', distanceMiles: 2.4, caseId: 'SUB-22-01' },
      { description: 'Sewer extension', source: 'county-permit', status: 'approved' },
    ],
    resaleRiskNote: 'Fixture resale note.',
    sourceCoverage: { ncdot: 'captured', county: 'captured', builder: 'not-applicable' },
    confidence: 'medium',
  },
  schools: {
    schools: [{ name: 'Fixture Elementary School', gradeLevel: 'elementary', rating: 8, source: 'sidecar' }],
    weightedSchoolScore: 0.64,
    flags: ['ratio-above-district-mean'],
    sourceCoverage: 'captured',
    confidence: 'high',
  },
  verdict: { recommendation: 'pursue', confidence: 'medium', rationale: 'Fixture.', inPersonChecks: [] },
};

const richFinalist = makeFinalist({
  axis: axisFixture,
  listing: {
    address: '100 Fixture Dr', city: 'Apex', state: 'NC',
    price: 700000, sqftFinished: 2900, beds: 4, baths: 2.5,
    yearBuilt: 2015, hoaMonthly: 50, daysOnMarket: 3, lotSqft: 12000,
    listingStatus: 'active', mls: 'FIX123',
    photos: { count: 10, urls: [], localPaths: ['scripts/tests/fixtures/briefing/photo-1.png'] },
  },
});
const richHtml = buildHtml([richFinalist], null, 'single', { trackerContent: trackerFixture });
assert.ok(richHtml.includes('data:image/png;base64'), 'photo strip embeds base64 data URI');
assert.ok(richHtml.includes('kpi-band'), 'KPI tiles render');
assert.ok(richHtml.includes('$241'), 'computed $/sqft renders (700000/2900)');
assert.ok(/vs Apex tracker median \(n=3\)/.test(richHtml), 'median delta renders');
assert.ok(richHtml.includes('gate-chip gate-pass'), 'gate pass chip renders');
assert.ok(richHtml.includes('gate-chip gate-fail'), 'gate fail chip renders');
assert.ok(richHtml.includes('gate-chip gate-unknown'), 'gate unknown chip renders');
assert.ok(richHtml.includes('axis-scoreboard'), 'axis scoreboard renders');
assert.ok(richHtml.includes('conf-badge'), 'per-axis confidence chips render');
assert.ok(richHtml.includes('MODERATE RISK'), 'risk chip renders');

// No axis, no photos -> dashboard blocks are simply absent, page still renders.
const bareHtml = buildHtml([makeFinalist()], null, 'single', { trackerContent: '' });
assert.ok(!bareHtml.includes('axis-scoreboard'));
assert.ok(!bareHtml.includes('data:image/png'));
assert.ok(bareHtml.includes('gate-chip'), 'gate chips come from the report, not the axis file');
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: FAIL — `parseGateRows` not exported.

- [ ] **Step 4: Implement the dashboard builders**

In `scripts/reports/briefing-pdf.mjs`:

1. Add to the imports: `import { parseListingRow } from '../shared/listings.mjs';` and extend the paths import to include `LISTINGS_FILE`: `import { ROOT, LISTINGS_FILE } from '../shared/paths.mjs';`
2. Insert the following block immediately above `function wrapReportPage(...)` (~:1434):

```js
// ---------------------------------------------------------------------------
// Overview dashboard builders (axis-first)
// ---------------------------------------------------------------------------

function photoDataUri(localPath) {
  const absolute = join(ROOT, localPath);
  if (!existsSync(absolute)) return '';
  try {
    const buffer = readFileSync(absolute);
    if (buffer.length > 2 * 1024 * 1024) return '';
    const ext = absolute.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
    return `data:image/${ext};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function buildPhotoStrip(finalist) {
  const localPaths = finalist.listing?.photos?.localPaths ?? [];
  const uris = localPaths.map(photoDataUri).filter(Boolean).slice(0, 3);
  if (uris.length === 0) return '';
  const [hero, ...thumbs] = uris;
  const thumbHtml = thumbs.map((uri) => `<div class="photo-thumb" style="background-image:url('${uri}')"></div>`).join('');
  return `
    <div class="photo-strip">
      <div class="photo-hero" style="background-image:url('${hero}')"></div>
      ${thumbHtml ? `<div class="photo-thumbs">${thumbHtml}</div>` : ''}
    </div>`;
}

function parseMoneyNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function computeCityMedianPricePerSqft(trackerContent, city) {
  const wanted = String(city ?? '').toLowerCase().trim();
  if (!wanted) return null;
  const values = String(trackerContent ?? '')
    .split(/\r?\n/)
    .map((line, index) => (line.trim().startsWith('|') ? parseListingRow(line, index) : null))
    .filter(Boolean)
    .filter((row) => row.city.toLowerCase().trim() === wanted)
    .map((row) => {
      const price = parseMoneyNumber(row.price);
      const sqft = parseMoneyNumber(row.sqft);
      return price && sqft ? price / sqft : null;
    })
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (values.length < 3) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return { median, sampleSize: values.length };
}

function buildKpiTiles(finalist, medianInfo) {
  const report = finalist.report;
  const listing = finalist.listing;
  const price = parseMoneyNumber(listing?.price) ?? parseMoneyNumber(report.metadata.price);
  const sqft = parseMoneyNumber(listing?.sqftFinished) ?? parseMoneyNumber(report.metadata.sqft);
  const pricePerSqft = price && sqft ? price / sqft : null;
  let ppsfDetail = '';
  if (pricePerSqft && medianInfo) {
    const deltaPct = Math.round(((pricePerSqft - medianInfo.median) / medianInfo.median) * 100);
    ppsfDetail = `${deltaPct >= 0 ? '+' : ''}${deltaPct}% vs ${report.city} tracker median (n=${medianInfo.sampleSize})`;
  }
  const tiles = [
    ['Price', price ? `$${price.toLocaleString()}` : firstNonEmpty(report.metadata.price, '--'), ''],
    ['$/SqFt', pricePerSqft ? `$${Math.round(pricePerSqft)}` : '--', ppsfDetail],
    ['Beds/Baths', firstNonEmpty(report.metadata.bedsBaths, listing?.beds != null ? `${listing.beds}/${listing.baths ?? '--'}` : '--'), ''],
    ['SqFt', sqft ? sqft.toLocaleString() : '--', ''],
    ['Lot', firstNonEmpty(report.metadata.lot, listing?.lotSqft ? `${Number(listing.lotSqft).toLocaleString()} sqft` : '--'), ''],
    ['Year', firstNonEmpty(report.metadata.yearBuilt, listing?.yearBuilt, '--'), ''],
    ['HOA', firstNonEmpty(report.metadata.hoa, listing?.hoaMonthly != null ? `$${listing.hoaMonthly}/mo` : '--'), ''],
    ['DOM', firstNonEmpty(report.metadata.daysOnMarket, listing?.daysOnMarket != null ? `${listing.daysOnMarket}d` : '--'), ''],
    ['Status', firstNonEmpty(report.metadata.verification, listing?.listingStatus, '--'), listing?.mls ? `MLS ${listing.mls}` : ''],
  ];
  const cells = tiles.map(([label, value, detail]) => `
    <div class="kpi-tile">
      <div class="kpi-value">${escapeHtml(String(value))}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      ${detail ? `<div class="kpi-detail">${escapeHtml(detail)}</div>` : ''}
    </div>`).join('');
  return `<div class="kpi-band">${cells}</div>`;
}

export function parseGateRows(gateSection) {
  const rows = [];
  for (const line of String(gateSection ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || /^\|\s*:?-{2,}/.test(trimmed)) continue;
    const cols = trimmed.split('|').slice(1, -1).map((col) => col.trim());
    if (cols.length < 2) continue;
    const [requirement, result] = cols;
    if (!requirement || /^requirement$/i.test(requirement)) continue;
    const normalized = result.toLowerCase();
    let state = 'unknown';
    if (/^(pass|yes|meets)/.test(normalized)) state = 'pass';
    else if (/^(fail|no\b)/.test(normalized)) state = 'fail';
    rows.push({ requirement, result, state });
  }
  return rows;
}

function buildGateChips(report) {
  const rows = parseGateRows(report.sections['Hard Requirement Gate']);
  if (rows.length === 0) return '';
  const chips = rows.map((row) => {
    const mark = row.state === 'pass' ? '&#10003;' : row.state === 'fail' ? '&#10007;' : '?';
    return `<span class="gate-chip gate-${row.state}" title="${escapeHtml(row.result)}"><span class="gate-mark">${mark}</span>${escapeHtml(row.requirement)}</span>`;
  }).join('');
  return `
    <div class="panel wide gate">
      <h3>Hard Requirement Gate</h3>
      <div class="gate-chips">${chips}</div>
    </div>`;
}

function gaugeSvg(value, { min = -1, max = 1 } = {}) {
  const clamped = Math.max(min, Math.min(max, Number(value) || 0));
  const pct = (clamped - min) / (max - min);
  const width = 160;
  const fill = clamped < 0 ? '#dc2626' : '#16a34a';
  return `<svg class="gauge" width="${width}" height="10" viewBox="0 0 ${width} 10"><rect x="0" y="2" width="${width}" height="6" rx="3" fill="#e5e7eb"></rect><rect x="0" y="2" width="${Math.max(3, Math.round(pct * width))}" height="6" rx="3" fill="${fill}"></rect></svg>`;
}

function buildAxisScoreboard(finalist) {
  const axis = finalist.axis;
  if (!axis) return '';
  const rows = [];
  for (const [dimension, entry] of Object.entries(axis.sentiment?.sentimentScores ?? {})) {
    rows.push(`
      <tr>
        <th>${escapeHtml(dimension.replace(/_/g, ' '))}</th>
        <td>${gaugeSvg(entry?.score)}</td>
        <td class="num ${Number(entry?.score) < 0 ? 'neg' : 'pos'}">${escapeHtml(String(entry?.score ?? '--'))}</td>
      </tr>`);
  }
  if (axis.schools?.weightedSchoolScore != null) {
    rows.push(`
      <tr>
        <th>schools (weighted)</th>
        <td>${gaugeSvg(axis.schools.weightedSchoolScore, { min: 0, max: 1 })}</td>
        <td class="num pos">${escapeHtml(String(axis.schools.weightedSchoolScore))}</td>
      </tr>`);
  }
  const risk = axis.riskBuilder?.riskLevel;
  const riskChip = risk
    ? `<p><span class="risk-chip risk-chip-${escapeHtml(String(risk))}">${escapeHtml(String(risk).toUpperCase())} RISK</span></p>`
    : '';
  if (rows.length === 0 && !riskChip) return '';
  return `
    <div class="panel wide axis-scoreboard">
      <h3>Axis Scores <span class="subtle">weight-applied, from axis agents</span></h3>
      ${riskChip}
      ${rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : ''}
    </div>`;
}

function buildConfidenceChips(finalist) {
  if (!finalist.axis) return '';
  return [
    ['sentiment', finalist.axis.sentiment?.confidence],
    ['risk', finalist.axis.riskBuilder?.confidence],
    ['schools', finalist.axis.schools?.confidence],
  ]
    .filter(([, level]) => level)
    .map(([label, level]) => `<span class="conf-badge conf-${escapeHtml(String(level))}">${escapeHtml(label)}: ${escapeHtml(String(level))}</span>`)
    .join('');
}
```

3. In `buildFinalistSection(finalist, profile, options = {})`, replace the `overviewPage` assembly (currently the `const overviewPage = wrapReportPage(...)` using `factsBlock`) with:

```js
  const medianInfo = computeCityMedianPricePerSqft(options.trackerContent ?? '', report.city);
  const overviewPage = wrapReportPage(`
    ${buildPhotoStrip(finalist)}
    ${buildKpiTiles(finalist, medianInfo)}
    ${buildGateChips(report)}
    ${buildAxisScoreboard(finalist)}
    <div class="overview-grid">
      <div class="panel decision wide">
        <h3>Decision Read</h3>
        <p>${escapeHtml(summarizeSection(plainText(recommendationText), 800))}</p>
      </div>
      ${concernBlock}
      ${gapBlock}
    </div>`, 'report-page-overview');
```

Delete the now-unused `const factsBlock = buildFactsCard(finalist);` line and the `buildFactsCard` function (the KPI band replaces it). `formatNumber` and `formatListingMoney` are called only from `buildFactsCard` today, so delete them too — but run `grep -n "formatNumber\|formatListingMoney\|buildFactsCard" scripts/reports/briefing-pdf.mjs` first and keep any helper that still has another caller.

4. In the `badges` div inside `buildFinalistSection` (`<div class="badges">...`), add `${buildConfidenceChips(finalist)}` after the recommendation badge span.
5. In `buildHtml`, thread the context into sections:

```js
  const finalistSections = finalists
    .map((finalist, idx) => buildFinalistSection(finalist, profile, {
      showRank,
      isFirst: idx === 0,
      trackerContent: context.trackerContent ?? '',
    }))
    .join('\n');
```

6. In `run()`, before `const html = buildHtml(finalists, profile, mode);`, add and pass:

```js
  const trackerContent = existsSync(LISTINGS_FILE) ? readFileSync(LISTINGS_FILE, 'utf8') : '';
  const html = buildHtml(finalists, profile, mode, { trackerContent });
```

7. Append to the CSS block (immediately before `</style>`):

```css
  /* Overview dashboard */
  .photo-strip { display: flex; gap: 6px; margin-bottom: 12px; height: 2.2in; }
  .photo-hero { flex: 2; border-radius: 8px; background-size: cover; background-position: center; }
  .photo-thumbs { flex: 1; display: flex; flex-direction: column; gap: 6px; }
  .photo-thumb { flex: 1; border-radius: 8px; background-size: cover; background-position: center; }
  .kpi-band {
    display: grid; grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 6px; margin-bottom: 12px;
  }
  .kpi-tile {
    border: 1px solid #e5e7eb; border-radius: 6px; padding: 7px 6px;
    text-align: center; background: #f8fafc;
  }
  .kpi-value { font-size: 10.5pt; font-weight: 700; color: #0f172a; }
  .kpi-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-top: 2px; }
  .kpi-detail { font-size: 6.6pt; color: #475569; margin-top: 2px; }
  .gate { margin-bottom: 12px; }
  .gate-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .gate-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 999px; font-size: 8pt; font-weight: 600;
  }
  .gate-pass { background: #dcfce7; color: #166534; }
  .gate-fail { background: #fee2e2; color: #991b1b; }
  .gate-unknown { background: #fef3c7; color: #92400e; }
  .gate-mark { font-weight: 800; }
  .axis-scoreboard { margin-bottom: 12px; }
  .axis-scoreboard th { width: 30%; text-transform: none; letter-spacing: 0; background: #f8fafc; }
  .gauge { vertical-align: middle; }
  .conf-badge {
    padding: 3px 8px; border-radius: 999px; font-size: 8pt; font-weight: 600;
  }
  .conf-high { background: #dcfce7; color: #166534; }
  .conf-medium { background: #fef3c7; color: #92400e; }
  .conf-low { background: #fee2e2; color: #991b1b; }
  .risk-chip {
    padding: 3px 10px; border-radius: 999px; font-size: 8.5pt; font-weight: 800;
    letter-spacing: 0.04em;
  }
  .risk-chip-low { background: #dcfce7; color: #166534; }
  .risk-chip-moderate { background: #fef3c7; color: #92400e; }
  .risk-chip-high { background: #fee2e2; color: #991b1b; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node scripts/tests/test-briefing-html.mjs && node scripts/tests/test-utility-options.mjs`
Expected: both PASS (`test-utility-options` imports briefing-pdf, so it guards against export breakage).

- [ ] **Step 6: Commit**

```bash
git add scripts/reports/briefing-pdf.mjs scripts/tests/test-briefing-html.mjs scripts/tests/fixtures/briefing/photo-1.png
git commit -m "feat: overview decision dashboard with photos, KPI tiles, gate chips, axis gauges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Sentiment evidence page (diverging bars + quotes + red flags)

**Files:**
- Modify: `scripts/reports/briefing-pdf.mjs` (new builder near the Task 5 block; `sentimentBlock` selection inside `buildFinalistSection` :1497-1512; CSS)
- Test: `scripts/tests/test-briefing-html.mjs` (extend)

**Interfaces:**
- Consumes: `finalist.axis.sentiment` (schema: `sentimentScores.{dim}.{score,signalDirection,evidenceCount,proximityMix,quotes,source}`, `redFlagsTriggered[]`, `sourceCoverage{}`, `confidence`).
- Produces: internal `divergingBarSvg(score)` and `buildSentimentAxisSection(finalist) -> string ('' when no axis sentiment)`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/test-briefing-html.mjs` before the final `console.log`:

```js
// --- Task 6: sentiment axis section ---
assert.ok(richHtml.includes('sentiment-axis'), 'axis sentiment section renders when axis data exists');
assert.ok(richHtml.includes('Lovely block parties'), 'verbatim quote renders');
assert.ok(richHtml.includes('class="diverge"'), 'diverging bar SVG renders');
assert.ok(richHtml.includes('Deal-breaker red flags'), 'red flag callout renders');
assert.ok(richHtml.includes('facebook: blocked'), 'source coverage chips render');
assert.ok(!richHtml.includes('Not yet captured from Facebook or Nextdoor'), 'legacy placeholder replaced when axis data exists');
assert.ok(bareHtml.includes('Not yet captured from Facebook or Nextdoor'), 'legacy fallback preserved without axis data');
```

(`richHtml` and `bareHtml` were built in the Task 5 section of the test; these assertions run against those same variables.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: FAIL on `sentiment-axis`.

- [ ] **Step 3: Implement**

In `scripts/reports/briefing-pdf.mjs`, add below `buildConfidenceChips`:

```js
function divergingBarSvg(score) {
  const clamped = Math.max(-1, Math.min(1, Number(score) || 0));
  const width = 220;
  const half = width / 2;
  const barWidth = Math.round(Math.abs(clamped) * half);
  const x = clamped < 0 ? half - barWidth : half;
  const fill = clamped < 0 ? '#dc2626' : '#16a34a';
  return `<svg class="diverge" width="${width}" height="12" viewBox="0 0 ${width} 12"><rect x="0" y="3" width="${width}" height="6" rx="3" fill="#f3f4f6"></rect><line x1="${half}" y1="0" x2="${half}" y2="12" stroke="#9ca3af" stroke-width="1"></line><rect x="${x}" y="3" width="${Math.max(2, barWidth)}" height="6" rx="3" fill="${fill}"></rect></svg>`;
}

function buildSentimentAxisSection(finalist) {
  const axisSentiment = finalist.axis?.sentiment;
  if (!axisSentiment?.sentimentScores) return '';
  const dimensions = Object.entries(axisSentiment.sentimentScores).map(([dimension, entry]) => {
    const quotes = (entry?.quotes ?? []).slice(0, 3)
      .map((quote) => `<li class="quote">&ldquo;${escapeHtml(summarizeSection(quote, 200))}&rdquo;</li>`)
      .join('');
    const meta = [
      `${Number(entry?.evidenceCount ?? 0)} signal${Number(entry?.evidenceCount ?? 0) === 1 ? '' : 's'}`,
      entry?.proximityMix ? String(entry.proximityMix) : '',
      entry?.source ? String(entry.source) : 'sidecar',
    ].filter(Boolean).join(' · ');
    return `
      <div class="sentiment-dimension">
        <div class="sentiment-row">
          <span class="sentiment-name">${escapeHtml(dimension.replace(/_/g, ' '))}</span>
          ${divergingBarSvg(entry?.score)}
          <span class="num ${Number(entry?.score) < 0 ? 'neg' : 'pos'}">${escapeHtml(String(entry?.score ?? '--'))}</span>
          <span class="subtle">${escapeHtml(meta)}</span>
        </div>
        ${quotes ? `<ul class="quote-list">${quotes}</ul>` : ''}
      </div>`;
  }).join('');
  const redFlags = (axisSentiment.redFlagsTriggered ?? [])
    .map((flag) => `<li>${escapeHtml(flag)}</li>`).join('');
  const coverage = Object.entries(axisSentiment.sourceCoverage ?? {})
    .map(([key, status]) => `<span class="coverage-chip">${escapeHtml(key)}: ${escapeHtml(String(status))}</span>`)
    .join(' ');
  return `
    <div class="panel wide sentiment-axis">
      <h3>Neighborhood Sentiment <span class="subtle">axis-agent interpretation, buyer-weighted</span></h3>
      ${dimensions}
      ${redFlags ? `<div class="redflag-box"><h4>Deal-breaker red flags</h4><ul>${redFlags}</ul></div>` : ''}
      ${coverage ? `<p class="coverage-row">${coverage}</p>` : ''}
      ${axisSentiment.confidence ? `<p class="muted">Confidence: ${escapeHtml(String(axisSentiment.confidence))}</p>` : ''}
    </div>`;
}
```

In `buildFinalistSection`, wrap the existing `sentimentBlock` ternary (the `sentiment ? <kpiRollup table template> : <unreviewed placeholder template>` expression at ~:1497-1512) as the fallback of the new builder. Concretely, two edits without touching the template literals themselves:

1. Change the line `const sentimentBlock = sentiment` to `const sentimentBlock = buildSentimentAxisSection(finalist) || (sentiment`
2. Change the ternary's closing line from `      </div>\`;` (the end of the unreviewed-placeholder template) to `      </div>\`);` — i.e. add the closing parenthesis after the final backtick, before the semicolon.

Append CSS before `</style>`:

```css
  /* Sentiment axis page */
  .sentiment-dimension { padding: 6px 0; border-bottom: 1px dashed #e5e7eb; }
  .sentiment-dimension:last-of-type { border-bottom: 0; }
  .sentiment-row { display: flex; align-items: center; gap: 10px; }
  .sentiment-name { min-width: 110px; font-weight: 600; font-size: 9.5pt; color: #1f2937; }
  .quote-list { margin: 4px 0 0 120px; padding-left: 12px; }
  .quote { font-size: 8.6pt; color: #475569; font-style: italic; }
  .redflag-box {
    background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;
    padding: 8px 10px; margin-top: 10px;
  }
  .redflag-box h4 { margin: 0 0 5px; color: #991b1b; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .redflag-box ul { margin: 0; padding-left: 14px; font-size: 8.8pt; }
  .coverage-row { margin-top: 8px; }
  .coverage-chip {
    display: inline-block; padding: 2px 8px; margin-right: 4px;
    border: 1px solid #e5e7eb; border-radius: 999px; font-size: 7.6pt; color: #475569;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/reports/briefing-pdf.mjs scripts/tests/test-briefing-html.mjs
git commit -m "feat: axis-driven sentiment page with diverging bars, quotes, red flags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Risk distance-ring map

**Files:**
- Modify: `scripts/reports/briefing-pdf.mjs` (`ringMapPoints` + `buildRiskRingMap` near the Task 5/6 builders; `buildDevelopmentInfrastructureSection` :815-879 gains an optional `finalist` param; call site in `buildFinalistSection` :1481; CSS)
- Test: `scripts/tests/test-briefing-html.mjs` (extend)

**Interfaces:**
- Consumes: `finalist.axis.riskBuilder.nearbyProjects[]` (`{description, source, status, distanceMiles?, caseId?}`), `resaleRiskNote`, `riskLevel`.
- Produces: `export function ringMapPoints(projects) -> {points: [{label, project, x, y}], legendOnly: [{label, project}]}`; internal `buildRiskRingMap(finalist)`. `buildDevelopmentInfrastructureSection({construction, permits, developmentText, finalist})` — existing callers that omit `finalist` (e.g. `buildConstructionBlurb`) must keep working.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/test-briefing-html.mjs` (add `ringMapPoints` to the import):

```js
// --- Task 7: risk ring map ---
const { points, legendOnly } = ringMapPoints(axisFixture.riskBuilder.nearbyProjects);
assert.equal(points.length, 2, 'projects with distanceMiles become dots');
assert.equal(legendOnly.length, 1, 'projects without distance are legend-only');
for (const point of points) {
  const dx = point.x - 150;
  const dy = point.y - 150;
  const radius = Math.sqrt(dx * dx + dy * dy);
  assert.ok(radius <= 130.5, 'dots stay inside the 5-mile ring');
}
const rerun = ringMapPoints(axisFixture.riskBuilder.nearbyProjects);
assert.deepEqual(rerun.points.map((p) => [p.x, p.y]), points.map((p) => [p.x, p.y]), 'angles are deterministic');
assert.deepEqual(ringMapPoints([]), { points: [], legendOnly: [] });

assert.ok(richHtml.includes('ring-map'), 'ring map renders in the infrastructure page');
assert.ok(richHtml.includes('Collector road widening'), 'project appears in ring legend');
assert.ok(richHtml.includes('Fixture resale note.'), 'axis resale note renders');
assert.ok(richHtml.includes('bearing is schematic'), 'schematic-bearing caption present');
assert.ok(!bareHtml.includes('ring-map'), 'no ring map without axis data');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: FAIL — `ringMapPoints` not exported.

- [ ] **Step 3: Implement**

Add below `buildSentimentAxisSection`:

```js
const RING_MAX_MILES = 5;
const RING_MAX_RADIUS_PX = 130;

function hashAngle(value) {
  let hash = 0;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return (Math.abs(hash) % 360) * (Math.PI / 180);
}

export function ringMapPoints(projects) {
  const points = [];
  const legendOnly = [];
  for (const [index, project] of (projects ?? []).entries()) {
    const label = index + 1;
    const distance = Number(project?.distanceMiles);
    if (!Number.isFinite(distance) || distance < 0) {
      legendOnly.push({ label, project });
      continue;
    }
    const clamped = Math.min(distance, RING_MAX_MILES);
    const angle = hashAngle(project.caseId || project.description || label);
    const radius = (clamped / RING_MAX_MILES) * RING_MAX_RADIUS_PX;
    points.push({
      label,
      project,
      x: 150 + radius * Math.cos(angle),
      y: 150 + radius * Math.sin(angle),
    });
  }
  return { points, legendOnly };
}

function projectDotColor(status) {
  const value = String(status ?? '').toLowerCase();
  if (/active|under|construction/.test(value)) return '#dc2626';
  if (/approved|proposed|planning|review|permit/.test(value)) return '#d97706';
  if (/complete|closed|built|open/.test(value)) return '#16a34a';
  return '#64748b';
}

function buildRiskRingMap(finalist) {
  const riskBuilder = finalist?.axis?.riskBuilder;
  const projects = riskBuilder?.nearbyProjects;
  if (!Array.isArray(projects) || projects.length === 0) return '';
  const { points, legendOnly } = ringMapPoints(projects);
  const rings = [1, 3, 5].map((miles) => {
    const radius = (miles / RING_MAX_MILES) * RING_MAX_RADIUS_PX;
    return `<circle cx="150" cy="150" r="${radius}" fill="none" stroke="#cbd5e1" stroke-width="1"></circle><text x="150" y="${150 - radius - 3}" text-anchor="middle" font-size="8" fill="#94a3b8">${miles} mi</text>`;
  }).join('');
  const dots = points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="6" fill="${projectDotColor(point.project.status)}"></circle><text x="${point.x.toFixed(1)}" y="${(point.y + 2.6).toFixed(1)}" text-anchor="middle" font-size="7" fill="#ffffff">${point.label}</text>`).join('');
  const legendEntries = [...points, ...legendOnly].map(({ label, project }) => {
    const distanceText = Number.isFinite(Number(project.distanceMiles))
      ? `${Number(project.distanceMiles).toFixed(1)} mi`
      : 'distance unknown';
    return `
      <li>
        <span class="legend-dot" style="background:${projectDotColor(project.status)}">${label}</span>
        ${escapeHtml(summarizeSection(firstNonEmpty(project.description, project.caseId, 'Project'), 110))}
        <span class="subtle">${escapeHtml(firstNonEmpty(project.status, 'status unknown'))} · ${escapeHtml(distanceText)}${project.source ? ` · ${escapeHtml(project.source)}` : ''}</span>
      </li>`;
  }).join('');
  return `
    <div class="ring-map-wrap">
      <svg class="ring-map" width="300" height="300" viewBox="0 0 300 300">
        ${rings}
        <circle cx="150" cy="150" r="7" fill="#0f172a"></circle>
        <text x="150" y="140" text-anchor="middle" font-size="8" fill="#0f172a">HOME</text>
        ${dots}
      </svg>
      <ol class="ring-legend">${legendEntries}</ol>
      <p class="muted">Distance rings are to scale; dot bearing is schematic (true direction not captured).</p>
    </div>`;
}
```

Change `buildDevelopmentInfrastructureSection({ construction, permits, developmentText = '' })` to `buildDevelopmentInfrastructureSection({ construction, permits, developmentText = '', finalist = null })` and, inside it, immediately after the `<table class="infra-status">...` line in the returned template, insert:

```js
      ${finalist ? buildRiskRingMap(finalist) : ''}
      ${finalist?.axis?.riskBuilder?.resaleRiskNote ? `<p class="resale-note"><strong>Resale risk:</strong> ${escapeHtml(finalist.axis.riskBuilder.resaleRiskNote)}</p>` : ''}
```

In `buildFinalistSection`, change the call to `buildDevelopmentInfrastructureSection({ construction, permits, developmentText, finalist })`.

Append CSS:

```css
  /* Risk ring map */
  .ring-map-wrap { display: flex; gap: 14px; align-items: flex-start; margin: 8px 0 10px; }
  .ring-map { flex-shrink: 0; }
  .ring-legend { margin: 0; padding-left: 0; list-style: none; font-size: 8.4pt; }
  .ring-legend li { margin-bottom: 6px; }
  .legend-dot {
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    color: #ffffff; font-size: 7pt; font-weight: 700; margin-right: 5px;
  }
  .resale-note { font-size: 9pt; margin-top: 4px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/reports/briefing-pdf.mjs scripts/tests/test-briefing-html.mjs
git commit -m "feat: risk distance-ring map from axis nearby projects

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Schools additions, page packing, page furniture

**Files:**
- Modify: `scripts/reports/briefing-pdf.mjs` (`buildSchoolsCard` :1324-1432 signature; `reportPages` assembly :1543-1553; `.report-page` CSS :1712-1723; `renderPdf` :2181-2199; `run()` :2277-2284)
- Test: `scripts/tests/test-briefing-html.mjs` (extend)

**Interfaces:**
- Consumes: `gaugeSvg` from Task 5; `finalist.axis.schools.{weightedSchoolScore, flags}`.
- Produces: `buildSchoolsCard(report, finalist)` (second param optional); `renderPdf(html, outputPath, footerLeft)`; compact page class `report-page-compact` holding up to 2 cards.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/test-briefing-html.mjs`:

```js
// --- Task 8: schools additions + packing ---
assert.ok(richHtml.includes('school-weighted'), 'weighted school gauge renders with axis data');
assert.ok(richHtml.includes('ratio above district mean'), 'axis school flags render');

const pageCount = (richHtml.match(/class="report-page/g) ?? []).length;
// With this fixture: overview, sentiment-axis, infrastructure, schools,
// 1 compact page (utilities "unreviewed" placeholder is the only compact card
// -- HOA/builder/commute are empty), and sources (the fixture report's URL
// yields one source-ledger link) = 6 pages.
assert.equal(pageCount, 6, `expected 6 report pages, got ${pageCount}`);
assert.ok(richHtml.includes('report-page-compact'), 'compact packing page exists');
```

Note for the implementer: the utilities card always renders (it has an "unreviewed" placeholder); HOA/builder/commute render empty for this fixture; the source ledger renders because `report.metadata.url` produces one link. If your count differs, print the classes with `richHtml.match(/report-page[a-z-]*/g)` and reconcile against the packing rules below rather than adjusting the assertion blindly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/tests/test-briefing-html.mjs`
Expected: FAIL on `school-weighted`.

- [ ] **Step 3: Implement**

1. Change `function buildSchoolsCard(report) {` to `function buildSchoolsCard(report, finalist = null) {` and build the axis extras at the top:

```js
  const axisSchools = finalist?.axis?.schools;
  const axisFlags = (axisSchools?.flags ?? [])
    .map((flag) => `<li>${escapeHtml(String(flag).replace(/-/g, ' '))}</li>`)
    .join('');
  const axisExtras = `
    ${axisSchools?.weightedSchoolScore != null ? `<p class="school-weighted">Weighted school score ${gaugeSvg(axisSchools.weightedSchoolScore, { min: 0, max: 1 })} <span class="num pos">${escapeHtml(String(axisSchools.weightedSchoolScore))}</span></p>` : ''}
    ${axisFlags ? `<ul class="school-flags">${axisFlags}</ul>` : ''}`;
```

Insert `${axisExtras}` into each of the three return branches of `buildSchoolsCard`, right after the closing `</table>`/`</ul>` of the school rows and before the trailing `<p class="muted">` note. Update the call site: `const schoolsBlock = buildSchoolsCard(report, finalist);`

2. Replace the `reportPages` array assembly in `buildFinalistSection` with:

```js
  const compactCards = [utilitiesBlock, hoaBlock, builderBlock, commuteBlock]
    .filter((block) => String(block ?? '').trim());
  const compactPages = [];
  for (let index = 0; index < compactCards.length; index += 2) {
    compactPages.push(wrapReportPage(compactCards.slice(index, index + 2).join('\n'), 'report-page-compact'));
  }
  const reportPages = [
    overviewPage,
    wrapReportPage(sentimentBlock, 'report-page-sentiment'),
    wrapReportPage(infrastructureBlock, 'report-page-infrastructure'),
    wrapReportPage(schoolsBlock, 'report-page-schools'),
    ...compactPages,
    wrapReportPage(sourceLedgerBlock, 'report-page-sources'),
  ].filter(Boolean).join('\n');
```

3. In the CSS, replace the `.report-page { ... min-height: 9.35in; ... }` and `.report-page:first-of-type { ... min-height: 8.1in; }` rules with:

```css
  .report-page {
    page-break-before: always;
    break-before: page;
    padding: 0;
  }
  .report-page:first-of-type {
    page-break-before: auto;
    break-before: auto;
  }
  .report-page-compact .panel,
  .report-page-compact .card {
    break-inside: avoid;
    page-break-inside: avoid;
    margin-bottom: 12px;
  }
  .school-flags { margin: 6px 0 0; padding-left: 16px; font-size: 8.6pt; color: #92400e; }
  .school-weighted { font-size: 9pt; margin-top: 8px; }
```

4. Change `async function renderPdf(html, outputPath)` to `async function renderPdf(html, outputPath, footerLeft = 'Home-Ops Decision Brief')` and replace the `page.pdf({...})` call with:

```js
    await page.pdf({
      path: outputPath,
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="width:100%;font-size:7pt;color:#9ca3af;padding:0 0.5in;display:flex;justify-content:space-between;">
          <span>${escapeHtml(footerLeft)}</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
      margin: { top: '0.5in', bottom: '0.65in', left: '0.5in', right: '0.5in' },
    });
```

5. In `run()`, compute the footer text and pass it:

```js
  const footerLeft = mode === 'single'
    ? [finalists[0].report.address, finalists[0].report.city].filter(Boolean).join(', ')
    : mode === 'combined'
      ? 'Home-Ops URL Deep Briefing'
      : 'Home-Ops Top 3 Finalist Briefing';
  await renderPdf(html, outputPath, footerLeft);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/tests/test-briefing-html.mjs && node scripts/tests/test-utility-options.mjs`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/reports/briefing-pdf.mjs scripts/tests/test-briefing-html.mjs
git commit -m "feat: school axis extras, compact page packing, PDF page footer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Mode docs, agent definitions, data contract, smoke run

**Files:**
- Modify: `modes/deep.md` (single-flow diagram :49-68, Phase 4 :139-163, multi-URL :190-211, batch Phase C :273-302, output style :361-369)
- Modify: `.claude/agents/sentiment-axis.md`, `.claude/agents/risk-builder-axis.md`, `.claude/agents/schools-axis.md` (and `.github/agents/*.agent.md` mirrors if they exist — check with `ls .github/agents/`)
- Modify: `DATA_CONTRACT.md`
- Test: full suite + manual smoke

**Interfaces:**
- Consumes: everything shipped in Tasks 1–8.
- Produces: authoritative mode instructions telling the main agent to write `.home-ops/tmp/{commandId}/axis-{slug}.json` and run `node scripts/research/axis-sidecar-write.mjs --report <report> --input <tmpfile>` per home, between the axis-agent phase and `review-tabs`/`briefing-pdf`.

- [ ] **Step 1: Update `modes/deep.md`**

1. In the single-home flow diagram, replace the two lines:

```
[main agent] update report    →  enrich the same reports/{N}-{slug}-{date}.md with deep findings
        ↓
review-tabs.mjs urls --replace
```

with:

```
[main agent] update report    →  enrich the same reports/{N}-{slug}-{date}.md with deep findings
        ↓
[main agent] merge axis JSON  →  .home-ops/tmp/{commandId}/axis-{slug}.json
axis-sidecar-write.mjs        →  output/axis/{slug}.json
        ↓ (gate: axis-sidecar)
review-tabs.mjs urls --replace
```

2. In "Phase 4 — Brief, PDF, and Tabs", renumber the existing steps and insert a new step 2 after the report-update step 1:

```markdown
2. Persist the axis layer. Merge the three axis agents' JSON outputs plus your own verdict synthesis into one JSON object with top-level keys `sentiment`, `riskBuilder`, `schools`, and `verdict` (`{recommendation, confidence, rationale, inPersonChecks}`). Write it to `.home-ops/tmp/{commandId}/axis-{slug}.json`, then run:
   ```
   node scripts/research/axis-sidecar-write.mjs --report reports/{N}-{slug}-{date}.md --input .home-ops/tmp/{commandId}/axis-{slug}.json
   ```
   The script validates the payload and writes `output/axis/{slug}.json` — the briefing PDF reads it to render the axis scoreboard, sentiment quotes, and risk ring map. If validation fails, fix the payload and re-run; do not skip this step (the `briefing-pdf-deep-single` gate requires it).
```

3. In the Multi-URL section, before the review-tabs command, add: `For each home, write the merged axis JSON and run axis-sidecar-write.mjs as in the single-home Phase 4 step 2.`
4. In batch Phase C, insert a new step between step 11 (review axis outputs) and step 12 (write brief):

```markdown
11a. For each home in the cohort, merge that home's axis outputs + verdict into `.home-ops/tmp/{commandId}/axis-{slug}.json` and run `node scripts/research/axis-sidecar-write.mjs --report <that home's report> --input <that tmp file>`. One sidecar per home; the batch `briefing-pdf` gate requires at least one successful axis-sidecar write.
```

5. In "Output Style", add the bullet: `- Persist every home's axis interpretation to output/axis/{slug}.json before rendering the PDF.`

- [ ] **Step 2: Update the axis agent definitions**

In each of `.claude/agents/sentiment-axis.md`, `.claude/agents/risk-builder-axis.md`, `.claude/agents/schools-axis.md`, add this line at the end of the "Hard rules" section:

```markdown
- Return strict JSON only (no prose around it) — the main agent persists your output verbatim into `output/axis/{slug}.json` via `axis-sidecar-write.mjs`.
```

Run `ls .github/agents/ 2>/dev/null` — if `sentiment-axis.agent.md` / `risk-builder-axis.agent.md` / `schools-axis.agent.md` exist there, apply the same line to each.

- [ ] **Step 3: Update `DATA_CONTRACT.md`**

Find the section listing generated/reset-cleared state (grep for `deep-packets`) and add `output/axis/` alongside it, described as: `output/axis/ — per-home axis-agent interpretation sidecars (generated, cleared by reset).`

- [ ] **Step 4: Run the full suite**

Run: `node scripts/system/test-all.mjs --quick`
Expected: 0 failed. (The suite syntax-checks every `.mjs`, runs all registered tests, and validates mode files.)

- [ ] **Step 5: Manual smoke run**

Run: `node scripts/reports/briefing-pdf.mjs --report reports/046-6728-fawn-hoof-trl-holly-springs-nc-2026-05-25.md --no-open`
Expected: `Wrote briefing PDF: output/briefings/6728-fawn-hoof-trl-holly-springs-nc-deep-<today>.pdf` with exit 0. This home has real capture sidecars but no axis sidecar, so it exercises the full legacy-fallback path plus the new gate-chip/KPI dashboard. Open the PDF and visually confirm: KPI band on page 1, gate chips, no empty full-height pages, footer with address + page numbers.

- [ ] **Step 6: Commit**

```bash
git add modes/deep.md .claude/agents/sentiment-axis.md .claude/agents/risk-builder-axis.md .claude/agents/schools-axis.md DATA_CONTRACT.md
git add .github/agents/ 2>/dev/null || true
git commit -m "docs: wire axis-sidecar step into deep mode, agents, and data contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
