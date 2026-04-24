#!/usr/bin/env node

/**
 * verify-pipeline-write.mjs -- Confirm that a scan actually persisted to data/pipeline.md.
 *
 * Contract: /home-ops scan runs scan-listings.mjs, which writes added listings to
 * data/pipeline.md. This script is the gate that proves the pipeline file is
 * valid and current. It MUST be invoked after every /home-ops scan run so the
 * contract hook can satisfy the scan mode. Exit 0 on success, 1 on failure.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const STALE_WINDOW_MINUTES = 60;

function fail(message) {
  console.error(`verify-pipeline-write: ${message}`);
  process.exit(1);
}

if (!existsSync(PIPELINE_PATH)) {
  fail(`data/pipeline.md does not exist. Re-run /home-ops scan.`);
}

const content = readFileSync(PIPELINE_PATH, 'utf8');
if (!content.includes('## Pending') || !content.includes('## Processed')) {
  fail(`data/pipeline.md is missing required "## Pending" and "## Processed" sections.`);
}

const stats = statSync(PIPELINE_PATH);
const ageMinutes = (Date.now() - stats.mtimeMs) / 60000;
if (ageMinutes > STALE_WINDOW_MINUTES) {
  fail(`data/pipeline.md has not been modified in ${Math.round(ageMinutes)} minutes. Re-run /home-ops scan to refresh the pending list.`);
}

const pendingIndex = content.indexOf('## Pending');
const processedIndex = content.indexOf('## Processed', pendingIndex);
const pendingBlock = content.slice(pendingIndex, processedIndex);
const pendingCount = (pendingBlock.match(/^- \[[ xX]\] /gm) ?? []).length;

console.log(`data/pipeline.md verified (${pendingCount} pending entries, mtime ${Math.round(ageMinutes)}m ago).`);
process.exit(0);
