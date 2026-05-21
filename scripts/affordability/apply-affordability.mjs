#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import YAML from 'yaml';
import { buildProfilePatchPreview, formatMoney, roundDown } from './affordability-core.mjs';
import { PROFILE_PATH, ROOT } from '../shared/paths.mjs';

const DEFAULT_INPUT = join(ROOT, 'output', 'affordability', 'latest.json');
const BUYER_PROFILE_PATH = join(ROOT, 'buyer-profile.md');
const PROFILE_MODE_PATH = join(ROOT, 'modes', '_profile.md');

const HELP_TEXT = `Usage:
  node scripts/affordability/apply-affordability.mjs --input output/affordability/latest.json
  node scripts/affordability/apply-affordability.mjs --input output/affordability/latest.json --dry-run

Options:
  --input    Affordability result JSON. Defaults to output/affordability/latest.json.
  --dry-run  Print the patch preview without writing files.
  --help     Show this help text.`;

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--input') {
      options.input = resolve(ROOT, argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`Input file not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readYaml(path) {
  if (!existsSync(path)) return {};
  return YAML.parse(readFileSync(path, 'utf8')) ?? {};
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

export function applyPatchToProfile(profile, result) {
  const patch = result.profile_patch_preview ?? buildProfilePatchPreview(profile, result);
  const next = structuredClone(profile ?? {});
  const search = ensureObject(next, 'search');
  const hard = ensureObject(search, 'hard_requirements');
  const financial = ensureObject(next, 'financial');

  hard.price_min = patch.search.hard_requirements.price_min;
  hard.price_max = patch.search.hard_requirements.price_max;

  financial.down_payment_pct = patch.financial.down_payment_pct;
  financial.closing_cost_pct_min = patch.financial.closing_cost_pct_min;
  financial.closing_cost_pct_max = patch.financial.closing_cost_pct_max;
  financial.loan_term_years = patch.financial.loan_term_years;
  financial.housing_payment_pct = patch.financial.housing_payment_pct;
  financial.rate_assumption_pct = patch.financial.rate_assumption_pct;
  financial.rate_source = patch.financial.rate_source;

  return next;
}

function affordabilityNote(result) {
  const selected = result.selected;
  const comparisonLine = result.comparison
    ? `\n- Comparison-only ${result.comparison.term_years}-year ceiling: ${formatMoney(result.comparison.recommended_price_max)}.`
    : '';
  return [
    '<!-- home-ops-afford:start -->',
    '## Affordability Snapshot',
    '',
    `- Conservative profile range: ${formatMoney(result.recommended_price_min)} to ${formatMoney(result.recommended_price_max)}.`,
    `- Basis: ${selected.term_years}-year fixed, ${selected.assumptions.housingPaymentPct}% take-home payment cap, ${selected.assumptions.downPaymentPct}% down, ${selected.assumptions.closingCostPctMin}-${selected.assumptions.closingCostPctMax}% closing-cost planning, and ${selected.assumptions.rateAssumptionPct}% rate assumption.`,
    `- Binding constraint: ${selected.constraint === 'cash_available' ? 'cash available for down payment and closing costs' : `${selected.assumptions.housingPaymentPct}% debt-adjusted monthly housing-payment cap`}.`,
    '- Raw income, debt, cash, and exact credit-score inputs are intentionally not stored in the buyer profile.',
    `${comparisonLine}`,
    '<!-- home-ops-afford:end -->',
    '',
  ].join('\n').replace(/\n\n\n+/g, '\n\n');
}

function profileModeNote(result) {
  const selected = result.selected;
  return [
    '<!-- home-ops-afford:start -->',
    '## Affordability Heuristic',
    '',
    `Use ${formatMoney(result.recommended_price_min)} to ${formatMoney(result.recommended_price_max)} as the current conservative price range unless the buyer explicitly revises affordability.`,
    `Financial fit should assume ${selected.term_years}-year fixed financing, a ${selected.assumptions.housingPaymentPct}% take-home payment cap, ${selected.assumptions.downPaymentPct}% down, ${selected.assumptions.closingCostPctMin}-${selected.assumptions.closingCostPctMax}% closing costs, and the saved profile rate assumption.`,
    'Do not infer raw income, cash, or credit score from this note; those inputs were used only for the local affordability calculation.',
    '',
    '<!-- home-ops-afford:end -->',
    '',
  ].join('\n');
}

function replaceMarkedSection(content, note) {
  const trimmedContent = String(content ?? '').trimEnd();
  const pattern = /<!-- home-ops-afford:start -->[\s\S]*?<!-- home-ops-afford:end -->\n?/;
  if (pattern.test(trimmedContent)) {
    return `${trimmedContent.replace(pattern, note.trimEnd())}\n`;
  }
  return `${trimmedContent}${trimmedContent ? '\n\n' : ''}${note.trimEnd()}\n`;
}

export function applyAffordabilityToFiles({
  result,
  profilePath = PROFILE_PATH,
  buyerProfilePath = BUYER_PROFILE_PATH,
  profileModePath = PROFILE_MODE_PATH,
  dryRun = false,
} = {}) {
  if (!result?.selected) throw new Error('Affordability result is missing selected scenario data.');
  const profile = readYaml(profilePath);
  const nextProfile = applyPatchToProfile(profile, result);
  const serializedProfile = `# Home-Ops Profile Configuration\n# Updated by affordability wizard\n\n${YAML.stringify(nextProfile)}`;

  const buyerProfile = existsSync(buyerProfilePath) ? readFileSync(buyerProfilePath, 'utf8') : '';
  const nextBuyerProfile = replaceMarkedSection(buyerProfile, affordabilityNote(result));

  const profileMode = existsSync(profileModePath) ? readFileSync(profileModePath, 'utf8') : '';
  const nextProfileMode = replaceMarkedSection(profileMode, profileModeNote(result));

  const changedFiles = [profilePath, buyerProfilePath, profileModePath];
  if (!dryRun) {
    writeFileSync(profilePath, serializedProfile, 'utf8');
    writeFileSync(buyerProfilePath, nextBuyerProfile, 'utf8');
    writeFileSync(profileModePath, nextProfileMode, 'utf8');
  }

  return {
    changedFiles,
    profile: nextProfile,
    profilePatch: result.profile_patch_preview ?? buildProfilePatchPreview(profile, result),
    searchPriceMin: nextProfile.search?.hard_requirements?.price_min ?? roundDown(result.recommended_price_max * 0.85),
    searchPriceMax: nextProfile.search?.hard_requirements?.price_max ?? result.recommended_price_max,
  };
}

function printApplySummary(summary, dryRun) {
  console.log('\n=== home-ops affordability profile update ===\n');
  console.log(dryRun ? 'Dry run only. No files were changed.' : 'Profile files updated.');
  console.log(`Price range: ${formatMoney(summary.searchPriceMin)} to ${formatMoney(summary.searchPriceMax)}`);
  console.log('Files:');
  summary.changedFiles.forEach((file) => console.log(`- ${file}`));
  console.log('');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }
  const result = readJson(options.input);
  const summary = applyAffordabilityToFiles({ result, dryRun: options.dryRun });
  printApplySummary(summary, options.dryRun);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
