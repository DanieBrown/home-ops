import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { OUTPUT_DIR, ROOT } from './paths.mjs';
import { slugify } from './text-utils.mjs';

export const KNOWLEDGE_SCHEMA_VERSION = 1;
export const SIDECAR_SCHEMA_VERSION = 1;
export const KNOWLEDGE_DIR = join(OUTPUT_DIR, 'knowledge');
export const KNOWLEDGE_INDEX_PATH = join(KNOWLEDGE_DIR, 'index.json');
export const COMMAND_LOG_PATH = join(KNOWLEDGE_DIR, 'commands.jsonl');
export const AREAS_DIR = join(OUTPUT_DIR, 'areas');

const DEFAULT_FRESH_DAYS = 90;

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function isoFrom(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

export function expiresInDays(days = DEFAULT_FRESH_DAYS, from = new Date()) {
  const numericDays = Number(days);
  const base = from instanceof Date ? from : new Date(from);
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const safeDays = Number.isFinite(numericDays) ? numericDays : DEFAULT_FRESH_DAYS;
  return new Date(safeBase.getTime() + safeDays * 24 * 60 * 60 * 1000).toISOString();
}

export function makeCommandId(mode = 'command', date = new Date()) {
  const safeMode = slugify(mode) || 'command';
  return `${isoFrom(date).replace(/[:.]/g, '-').replace('T', 't').replace('Z', 'z')}-${safeMode}`;
}

export function subjectKeyForTarget(target = {}) {
  const key = slugify(`${target.address ?? ''}-${target.city ?? ''}-${target.state || 'NC'}`);
  return key || 'unknown-property';
}

export function areaSlug(area = {}) {
  if (typeof area === 'string') return slugify(area) || 'unknown-area';
  const key = slugify(`${area.name ?? area.city ?? ''}-${area.county ?? ''}-${area.state ?? ''}`);
  return key || 'unknown-area';
}

export function resolveWithinRoot(path, { root = ROOT, requireOutput = false } = {}) {
  const absoluteRoot = resolve(root);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(absoluteRoot, path);
  const relPath = relative(absoluteRoot, absolutePath).replace(/\\/g, '/');
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    throw new Error(`Refusing to record artifact outside repo root: ${path}`);
  }
  if (requireOutput && relPath !== 'output' && !relPath.startsWith('output/')) {
    throw new Error(`Knowledge artifacts must live under output/: ${relPath}`);
  }
  return { absolutePath, relPath };
}

export function relativeFromRoot(path, options = {}) {
  return resolveWithinRoot(path, options).relPath;
}

export function sidecarMetadata({
  kind = 'artifact',
  scope = 'property',
  subject = null,
  subjectKey = null,
  commandId = null,
  generatedAt = new Date(),
  expiresAt = null,
  sourceUrls = [],
  status = 'ok',
  warnings = [],
} = {}) {
  const generatedIso = isoFrom(generatedAt);
  let resolvedSubjectKey = subjectKey;
  if (!resolvedSubjectKey && scope === 'area') resolvedSubjectKey = areaSlug(subject ?? {});
  if (!resolvedSubjectKey && subject) resolvedSubjectKey = subjectKeyForTarget(subject);

  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    scope,
    subjectKey: resolvedSubjectKey || slugify(kind) || 'artifact',
    commandId: commandId || makeCommandId(kind, generatedIso),
    generatedAt: generatedIso,
    expiresAt: expiresAt ?? null,
    sourceUrls: normalizeArray(sourceUrls),
    status: status ?? 'ok',
    warnings: normalizeArray(warnings),
  };
}

export function withSidecarMetadata(record = {}, options = {}) {
  const metadata = sidecarMetadata({
    ...options,
    generatedAt: record.generatedAt ?? options.generatedAt,
    status: record.status ?? options.status,
    warnings: [...normalizeArray(record.warnings), ...normalizeArray(options.warnings)],
  });
  return {
    ...record,
    ...metadata,
  };
}

function emptyIndex() {
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    updatedAt: null,
    artifacts: {},
    areas: {},
    lastCommand: null,
  };
}

export function readKnowledgeIndex({ root = ROOT } = {}) {
  const indexPath = resolveWithinRoot(join(root, 'output', 'knowledge', 'index.json'), { root }).absolutePath;
  if (!existsSync(indexPath)) return emptyIndex();
  try {
    return {
      ...emptyIndex(),
      ...JSON.parse(readFileSync(indexPath, 'utf8')),
    };
  } catch {
    return emptyIndex();
  }
}

export function writeKnowledgeIndex(index, { root = ROOT } = {}) {
  const indexPath = resolveWithinRoot(join(root, 'output', 'knowledge', 'index.json'), { root }).absolutePath;
  ensureDir(dirname(indexPath));
  const next = {
    ...emptyIndex(),
    ...(index ?? {}),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function isArtifactFresh(metadata, { now = new Date() } = {}) {
  if (!metadata || metadata.status === 'stale') return false;
  if (!metadata.expiresAt) return true;
  const expires = new Date(metadata.expiresAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(expires) && Number.isFinite(nowMs) && expires > nowMs;
}

export function recordArtifact({
  path,
  kind = 'artifact',
  scope = 'property',
  subject = null,
  subjectKey = null,
  commandId = null,
  generatedAt = new Date(),
  expiresAt = null,
  sourceUrls = [],
  status = 'ok',
  warnings = [],
  root = ROOT,
} = {}) {
  if (!path) throw new Error('recordArtifact requires path');
  const { relPath } = resolveWithinRoot(path, { root, requireOutput: true });
  const metadata = sidecarMetadata({
    kind,
    scope,
    subject,
    subjectKey,
    commandId,
    generatedAt,
    expiresAt,
    sourceUrls,
    status,
    warnings,
  });
  const index = readKnowledgeIndex({ root });
  index.artifacts[relPath] = {
    ...metadata,
    kind,
    path: relPath,
    fresh: isArtifactFresh(metadata),
    indexedAt: new Date().toISOString(),
  };
  if (scope === 'area') {
    index.areas[metadata.subjectKey] = {
      path: relPath,
      updatedAt: metadata.generatedAt,
    };
  }
  return writeKnowledgeIndex(index, { root }).artifacts[relPath];
}

export function appendCommandMemory(record = {}, { root = ROOT } = {}) {
  const commandId = record.commandId || makeCommandId(record.command ?? record.mode ?? 'command');
  const entry = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    commandId,
    generatedAt: record.generatedAt ?? new Date().toISOString(),
    ...record,
    commandId,
  };
  const commandPath = resolveWithinRoot(join(root, 'output', 'knowledge', 'commands.jsonl'), { root }).absolutePath;
  ensureDir(dirname(commandPath));
  appendFileSync(commandPath, `${JSON.stringify(entry)}\n`, 'utf8');

  const index = readKnowledgeIndex({ root });
  index.lastCommand = {
    commandId,
    generatedAt: entry.generatedAt,
    command: entry.command ?? entry.mode ?? null,
  };
  writeKnowledgeIndex(index, { root });
  return entry;
}

export function upsertAreaKnowledge({
  area,
  facts = {},
  artifactRefs = [],
  sourceUrls = [],
  commandId = null,
  generatedAt = new Date(),
  expiresAt = expiresInDays(DEFAULT_FRESH_DAYS, generatedAt),
  status = 'ok',
  warnings = [],
  root = ROOT,
} = {}) {
  const slug = areaSlug(area);
  const areaPath = resolveWithinRoot(join(root, 'output', 'areas', `${slug}.json`), {
    root,
    requireOutput: true,
  }).absolutePath;
  const existing = existsSync(areaPath)
    ? JSON.parse(readFileSync(areaPath, 'utf8'))
    : {};
  const metadata = sidecarMetadata({
    kind: 'area',
    scope: 'area',
    subject: area,
    subjectKey: slug,
    commandId,
    generatedAt,
    expiresAt,
    sourceUrls: [...normalizeArray(existing.sourceUrls), ...normalizeArray(sourceUrls)],
    status,
    warnings: [...normalizeArray(existing.warnings), ...normalizeArray(warnings)],
  });
  const record = {
    ...existing,
    ...metadata,
    area,
    facts: {
      ...(existing.facts ?? {}),
      ...(facts ?? {}),
    },
    artifactRefs: [...new Set([...normalizeArray(existing.artifactRefs), ...normalizeArray(artifactRefs)])],
  };
  ensureDir(dirname(areaPath));
  writeFileSync(areaPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  recordArtifact({
    path: areaPath,
    kind: 'area',
    scope: 'area',
    subject: area,
    subjectKey: slug,
    commandId: record.commandId,
    generatedAt: record.generatedAt,
    expiresAt: record.expiresAt,
    sourceUrls: record.sourceUrls,
    status: record.status,
    warnings: record.warnings,
    root,
  });
  return record;
}

export function summarizeKnowledgeIndex(index = readKnowledgeIndex()) {
  const artifacts = Object.values(index.artifacts ?? {});
  const freshCount = artifacts.filter((entry) => entry.fresh !== false && isArtifactFresh(entry)).length;
  const staleCount = artifacts.length - freshCount;
  return {
    artifactCount: artifacts.length,
    areaCount: Object.keys(index.areas ?? {}).length,
    freshCount,
    staleCount,
    updatedAt: index.updatedAt ?? null,
  };
}
