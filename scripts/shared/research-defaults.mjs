import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import { ROOT } from './paths.mjs';

export const RESEARCH_DEFAULTS_PATH = join(ROOT, 'templates', 'research-defaults.yml');

export function readResearchDefaults(path = RESEARCH_DEFAULTS_PATH) {
  if (!existsSync(path)) return {};
  return YAML.parse(readFileSync(path, 'utf8')) ?? {};
}

export function stateResearchDefaults(path = RESEARCH_DEFAULTS_PATH) {
  return readResearchDefaults(path).states ?? {};
}

export function compileConfiguredPatterns(entries = []) {
  return entries
    .map((entry) => {
      if (entry instanceof RegExp) return entry;
      if (typeof entry === 'string') return new RegExp(entry, 'i');
      if (!entry?.pattern) return null;
      return new RegExp(entry.pattern, entry.flags ?? 'i');
    })
    .filter(Boolean);
}

export function compileConfiguredPattern(entry) {
  return compileConfiguredPatterns([entry])[0] ?? /$a/;
}
