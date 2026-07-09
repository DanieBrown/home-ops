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
