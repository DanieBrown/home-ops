#!/usr/bin/env node

/**
 * update-system.mjs — Safe system-layer updater for home-ops
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// System layer paths — ONLY these files get updated
const SYSTEM_PATHS = [
  'modes/_shared.md',
  'modes/_profile.template.md',
  'modes/evaluate.md',
  'modes/compare.md',
  'modes/scan.md',
  'modes/deep.md',
  'modes/tracker.md',
  'CLAUDE.md',
  'AGENTS.md',
  'doctor.mjs',
  'merge-tracker.mjs',
  'verify-pipeline.mjs',
  'dedup-tracker.mjs',
  'normalize-statuses.mjs',
  'profile-sync-check.mjs',
  'check-liveness.mjs',
  'update-system.mjs',
  'dashboard/',
  'templates/',
  'fonts/',
  '.claude/skills/',
  'docs/',
  'VERSION',
  'DATA_CONTRACT.md',
  'CONTRIBUTING.md',
  'README.md',
  'LICENSE',
  'CITATION.cff',
  '.github/',
  'package.json',
];

// User layer paths — NEVER touch these (safety check)
const USER_PATHS = [
  'buyer-profile.md',
  'config/profile.yml',
  'modes/_profile.md',
  'portals.yml',
  'data/',
  'reports/',
  'output/',
  'batch/tracker-additions/',
];

function localVersion() {
  const vPath = join(ROOT, 'VERSION');
  return existsSync(vPath) ? readFileSync(vPath, 'utf-8').trim() : '0.0.0';
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }).trim();
}

function normalizeRemoteLabel(value) {
  return value?.trim() || null;
}

function getUpstreamConfig() {
  const envFetchTarget = normalizeRemoteLabel(process.env.HOME_OPS_UPSTREAM_FETCH_TARGET);
  const envRepo = normalizeRemoteLabel(process.env.HOME_OPS_UPSTREAM_REPO);
  const envVersionUrl = normalizeRemoteLabel(process.env.HOME_OPS_UPSTREAM_VERSION_URL);
  const envReleasesApi = normalizeRemoteLabel(process.env.HOME_OPS_UPSTREAM_RELEASES_API);

  if (envFetchTarget || envRepo || envVersionUrl || envReleasesApi) {
    return {
      fetchTarget: envFetchTarget || envRepo,
      repo: envRepo || envFetchTarget,
      versionUrl: envVersionUrl,
      releasesApi: envReleasesApi,
    };
  }

  try {
    const remoteUrl = git('remote get-url upstream');
    return {
      fetchTarget: 'upstream',
      repo: remoteUrl,
      versionUrl: null,
      releasesApi: null,
    };
  } catch {
    return null;
  }
}

// ── CHECK ───────────────────────────────────────────────────────

async function check() {
  // Respect dismiss flag
  if (existsSync(join(ROOT, '.update-dismissed'))) {
    console.log(JSON.stringify({ status: 'dismissed' }));
    return;
  }

  const local = localVersion();
  const upstream = getUpstreamConfig();

  if (!upstream) {
    console.log(JSON.stringify({
      status: 'disabled',
      local,
      reason: 'No upstream configured. Add a git remote named upstream or set HOME_OPS_UPSTREAM_FETCH_TARGET and HOME_OPS_UPSTREAM_VERSION_URL.',
    }));
    return;
  }

  if (!upstream.versionUrl) {
    console.log(JSON.stringify({
      status: 'disabled',
      local,
      reason: 'Upstream is configured, but no VERSION endpoint was provided.',
    }));
    return;
  }

  let remote;

  try {
    const res = await fetch(upstream.versionUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    remote = (await res.text()).trim();
  } catch {
    console.log(JSON.stringify({ status: 'offline', local }));
    return;
  }

  if (compareVersions(local, remote) >= 0) {
    console.log(JSON.stringify({ status: 'up-to-date', local, remote }));
    return;
  }

  // Fetch changelog metadata when a release endpoint is provided
  let changelog = '';
  if (upstream.releasesApi) {
    try {
      const res = await fetch(upstream.releasesApi);
      if (res.ok) {
        const release = await res.json();
        changelog = release.body || '';
      }
    } catch {
      // No changelog available, that's OK
    }
  }

  console.log(JSON.stringify({
    status: 'update-available',
    local,
    remote,
    upstream: upstream.repo,
    changelog: changelog.slice(0, 500),
  }));
}

// ── APPLY ───────────────────────────────────────────────────────

async function apply() {
  const local = localVersion();
  const upstream = getUpstreamConfig();

  if (!upstream) {
    console.error('No upstream configured. Add a git remote named upstream or set HOME_OPS_UPSTREAM_FETCH_TARGET and HOME_OPS_UPSTREAM_VERSION_URL.');
    process.exit(1);
  }

  // Check for lock
  const lockFile = join(ROOT, '.update-lock');
  if (existsSync(lockFile)) {
    console.error('Update already in progress (.update-lock exists). If stuck, delete it manually.');
    process.exit(1);
  }

  // Create lock
  writeFileSync(lockFile, new Date().toISOString());

  try {
    // 1. Backup: create branch
    const backupBranch = `backup-pre-update-${local}-${Date.now()}`;
    try {
      git(`branch ${backupBranch}`);
      console.log(`Backup branch created: ${backupBranch}`);
    } catch {
      console.log(`Backup branch already exists (${backupBranch}), continuing...`);
    }

    // 2. Fetch from canonical repo
    console.log('Fetching latest from upstream...');
    git(`fetch ${upstream.fetchTarget} main`);

    // 3. Checkout system files only
    console.log('Updating system files...');
    const updated = [];
    for (const path of SYSTEM_PATHS) {
      try {
        git(`checkout FETCH_HEAD -- ${path}`);
        updated.push(path);
      } catch {
        // File may not exist in remote (new additions), skip
      }
    }

    // 4. Validate: check NO user files were touched
    let userFileTouched = false;
    try {
      const status = git('status --porcelain');
      for (const line of status.split('\n')) {
        if (!line.trim()) continue;
        const file = line.slice(3);
        for (const userPath of USER_PATHS) {
          if (file.startsWith(userPath)) {
            console.error(`SAFETY VIOLATION: User file was modified: ${file}`);
            userFileTouched = true;
          }
        }
      }
    } catch {
      // git status failed, skip validation
    }

    if (userFileTouched) {
      console.error('Aborting: user files were touched. Rolling back...');
      git('reset --hard HEAD');
      unlinkSync(lockFile);
      process.exit(1);
    }

    // 5. Install any new dependencies
    try {
      execSync('npm install --silent', { cwd: ROOT, timeout: 60000 });
    } catch {
      console.log('npm install skipped (may need manual run)');
    }

    // 6. Commit the update
    const remote = localVersion(); // Re-read after checkout updated VERSION
    try {
      git('add .');
      git(`commit -m "chore: auto-update system files to v${remote}"`);
    } catch {
      // Nothing to commit (already up to date)
    }

    // 7. Clean up dismiss flag if it exists
    const dismissFile = join(ROOT, '.update-dismissed');
    if (existsSync(dismissFile)) unlinkSync(dismissFile);

    console.log(`\nUpdate complete: v${local} → v${remote}`);
    console.log(`Updated ${updated.length} system paths.`);
    console.log(`Rollback available: node update-system.mjs rollback`);

  } finally {
    // Remove lock
    if (existsSync(lockFile)) unlinkSync(lockFile);
  }
}

// ── ROLLBACK ────────────────────────────────────────────────────

function rollback() {
  const local = localVersion();

  // Find most recent backup branch
  try {
    const branches = git('branch --list "backup-pre-update-*"');
    const branchList = branches.split('\n').map(b => b.trim().replace('* ', '')).filter(Boolean);

    if (branchList.length === 0) {
      console.error('No backup branches found. Nothing to rollback.');
      process.exit(1);
    }

    const latest = branchList[branchList.length - 1];
    console.log(`Rolling back to: ${latest}`);

    // Checkout system files from backup branch
    for (const path of SYSTEM_PATHS) {
      try {
        git(`checkout ${latest} -- ${path}`);
      } catch {
        // File may not have existed in backup
      }
    }

    git('add .');
    git(`commit -m "chore: rollback system files from ${latest}"`);

    console.log(`Rollback complete. System files restored from ${latest}.`);
    console.log('Your buyer profile, tracker, and reports were not affected.');
  } catch (err) {
    console.error('Rollback failed:', err.message);
    process.exit(1);
  }
}

// ── DISMISS ─────────────────────────────────────────────────────

function dismiss() {
  writeFileSync(join(ROOT, '.update-dismissed'), new Date().toISOString());
  console.log('Update check dismissed. Run "node update-system.mjs check" or say "check for updates" to re-enable.');
}

// ── MAIN ────────────────────────────────────────────────────────

const cmd = process.argv[2] || 'check';

switch (cmd) {
  case 'check': await check(); break;
  case 'apply': await apply(); break;
  case 'rollback': rollback(); break;
  case 'dismiss': dismiss(); break;
  default:
    console.log('Usage: node update-system.mjs [check|apply|rollback|dismiss]');
    process.exit(1);
}
