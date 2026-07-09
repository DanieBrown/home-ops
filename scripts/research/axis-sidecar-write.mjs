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
