// scripts/shared/paths.mjs
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const _ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ROOT               = _ROOT;
export const LISTINGS_FILE      = join(_ROOT, 'data', 'listings.md');
export const PIPELINE_FILE      = join(_ROOT, 'data', 'pipeline.md');
export const SHORTLIST_PATH     = join(_ROOT, 'data', 'shortlist.md');
export const SCAN_HISTORY_PATH  = join(_ROOT, 'data', 'scan-history.tsv');
export const PROFILE_PATH       = join(_ROOT, 'config', 'profile.yml');
export const PORTALS_PATH       = join(_ROOT, 'portals.yml');
export const STATES_FILE        = join(_ROOT, 'templates', 'states.yml');
export const REPORTS_DIR        = join(_ROOT, 'reports');
export const OUTPUT_DIR         = join(_ROOT, 'output');
export const BATCH_DIR          = join(_ROOT, 'batch', 'tracker-additions');
export const MERGED_BATCH_DIR   = join(_ROOT, 'batch', 'tracker-additions', 'merged');
export const HOME_OPS_DIR       = join(_ROOT, '.home-ops');
