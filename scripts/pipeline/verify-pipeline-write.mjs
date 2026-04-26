#!/usr/bin/env node

/**
 * verify-pipeline-write.mjs -- Confirm that a scan actually persisted to data/pipeline.md.
 *
 * If scan-running.json exists and scan-complete.json does not, this script waits
 * for the scan to finish (PID-based polling, up to 10 minutes) before checking
 * pipeline.md. If the scan PID is already dead with no complete marker, it fails
 * immediately so the hunt runner does not evaluate a stale pipeline.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const HOME_OPS_DIR = join(ROOT, '.home-ops');
const SCAN_RUNNING_PATH = join(HOME_OPS_DIR, 'scan-running.json');
const SCAN_COMPLETE_PATH = join(HOME_OPS_DIR, 'scan-complete.json');
const STALE_WINDOW_MINUTES = 60;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 600_000; // 10 minutes

function fail(message) {
  console.error(`verify-pipeline-write: ${message}`);
  process.exit(1);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForScan() {
  if (!existsSync(SCAN_RUNNING_PATH)) return;

  if (existsSync(SCAN_COMPLETE_PATH)) {
    const runningMtime = statSync(SCAN_RUNNING_PATH).mtimeMs;
    const completeMtime = statSync(SCAN_COMPLETE_PATH).mtimeMs;
    if (completeMtime >= runningMtime) return; // complete marker is from this run
  }

  const runningData = JSON.parse(readFileSync(SCAN_RUNNING_PATH, 'utf8'));
  const { pid } = runningData;

  if (!isPidAlive(pid)) {
    fail(`scan (PID ${pid}) was terminated before completing. Re-run /home-ops scan.`);
  }

  console.log(`verify-pipeline-write: scan (PID ${pid}) still running — waiting up to ${MAX_WAIT_MS / 60000} min...`);
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    if (existsSync(SCAN_COMPLETE_PATH)) {
      console.log('verify-pipeline-write: scan finished, proceeding with pipeline check.');
      return;
    }

    if (!isPidAlive(pid)) {
      fail(`scan process (PID ${pid}) died before completing. Re-run /home-ops scan.`);
    }

    const elapsed = Math.round((Date.now() - (deadline - MAX_WAIT_MS)) / 1000);
    if (elapsed % 30 === 0) {
      console.log(`verify-pipeline-write: still waiting for scan to complete (${elapsed}s elapsed)...`);
    }
  }

  fail(`Timed out after ${MAX_WAIT_MS / 60000} minutes waiting for scan to complete.`);
}

async function main() {
  await waitForScan();

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
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
