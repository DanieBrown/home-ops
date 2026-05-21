#!/usr/bin/env node

import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendCommandMemory,
  expiresInDays,
  isArtifactFresh,
  readKnowledgeIndex,
  recordArtifact,
  relativeFromRoot,
  resolveWithinRoot,
  sidecarMetadata,
  upsertAreaKnowledge,
  withSidecarMetadata,
} from '../shared/knowledge-store.mjs';
import { ROOT } from '../shared/paths.mjs';

const dir = mkdtempSync(join(tmpdir(), 'home-ops-knowledge-'));

try {
  const artifactPath = join(dir, 'output', 'geocode', '100-test-dr-apex-nc.json');
  mkdirSync(join(dir, 'output', 'geocode'), { recursive: true });
  writeFileSync(artifactPath, '{"status":"ok"}\n', 'utf8');

  const metadata = sidecarMetadata({
    kind: 'geocode',
    scope: 'property',
    subject: { address: '100 Test Dr', city: 'Apex', state: 'NC' },
    commandId: 'cmd-1',
    generatedAt: '2026-05-20T12:00:00.000Z',
    expiresAt: expiresInDays(1, '2026-05-20T12:00:00.000Z'),
    sourceUrls: ['https://example.test/source'],
    status: 'ok',
  });
  assert.equal(metadata.subjectKey, '100-test-dr-apex-nc');
  assert.equal(isArtifactFresh(metadata, { now: '2026-05-20T12:30:00.000Z' }), true);
  assert.equal(isArtifactFresh(metadata, { now: '2026-05-22T12:30:00.000Z' }), false);

  const merged = withSidecarMetadata({ status: 'reviewed', warnings: ['legacy warning'] }, {
    kind: 'permits',
    subject: { address: '100 Test Dr', city: 'Apex', state: 'NC' },
    commandId: 'cmd-2',
    warnings: ['new warning'],
  });
  assert.equal(merged.status, 'reviewed');
  assert.deepEqual(merged.warnings, ['legacy warning', 'new warning']);

  const indexed = recordArtifact({
    root: dir,
    path: artifactPath,
    kind: 'geocode',
    subject: { address: '100 Test Dr', city: 'Apex', state: 'NC' },
    commandId: 'cmd-1',
    generatedAt: metadata.generatedAt,
    expiresAt: metadata.expiresAt,
    sourceUrls: metadata.sourceUrls,
    status: metadata.status,
  });
  assert.equal(indexed.path, 'output/geocode/100-test-dr-apex-nc.json');

  const command = appendCommandMemory({
    commandId: 'cmd-1',
    command: 'geocode',
    summary: 'looked up a point',
  }, { root: dir });
  assert.equal(command.commandId, 'cmd-1');

  const area = upsertAreaKnowledge({
    root: dir,
    area: { name: 'Apex', county: 'Wake', state: 'NC' },
    facts: { permitSource: 'Wake County' },
    artifactRefs: [relativeFromRoot(artifactPath, { root: dir })],
    sourceUrls: ['https://example.test/wake'],
    commandId: 'cmd-1',
  });
  assert.equal(area.subjectKey, 'apex-wake-nc');
  assert.equal(area.facts.permitSource, 'Wake County');

  const index = readKnowledgeIndex({ root: dir });
  assert.ok(index.artifacts['output/geocode/100-test-dr-apex-nc.json']);
  assert.ok(index.artifacts['output/areas/apex-wake-nc.json']);
  assert.equal(index.areas['apex-wake-nc'].path, 'output/areas/apex-wake-nc.json');

  const commandLog = readFileSync(join(dir, 'output', 'knowledge', 'commands.jsonl'), 'utf8').trim().split('\n');
  assert.equal(commandLog.length, 1);
  assert.equal(JSON.parse(commandLog[0]).summary, 'looked up a point');

  assert.throws(() => resolveWithinRoot(join(dir, '..', 'outside.json'), { root: dir }), /outside repo root/);
  assert.throws(() => recordArtifact({ root: dir, path: join(dir, 'reports', 'bad.json') }), /under output/);

  const resetDryRun = execFileSync(process.execPath, ['scripts/pipeline/reset-search-state.mjs', '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.ok(resetDryRun.includes('Learned output directories preserved: yes'));
  const purgeDryRun = execFileSync(process.execPath, ['scripts/pipeline/reset-search-state.mjs', '--dry-run', '--purge-knowledge'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.ok(purgeDryRun.includes('Learned output files to purge:'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('Knowledge store tests passed.');
