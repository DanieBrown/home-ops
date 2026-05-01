#!/usr/bin/env node

/**
 * profile-sync-check.mjs -- Validates that the home-ops setup is consistent.
 *
 * Checks:
 * 1. buyer-profile.md exists and is not empty
 * 2. config/profile.yml exists and does not still look like example data
 * 3. modes/_shared.md does not appear to contain hardcoded buyer-specific criteria
 * 4. portals.yml exists for scan mode
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../shared/paths.mjs';

const warnings = [];
const errors = [];

const buyerProfilePath = join(ROOT, 'buyer-profile.md');
if (!existsSync(buyerProfilePath)) {
  errors.push('buyer-profile.md not found in project root. Create it with the buyer criteria and context.');
} else {
  const buyerProfile = readFileSync(buyerProfilePath, 'utf-8');
  if (buyerProfile.trim().length < 150) {
    warnings.push('buyer-profile.md looks short. Make sure it includes search areas, hard requirements, and deal-breakers.');
  }
}

const profilePath = join(ROOT, 'config', 'profile.yml');
if (!existsSync(profilePath)) {
  errors.push('config/profile.yml not found. Copy from config/profile.example.yml and fill in the buyer details.');
} else {
  const profile = readFileSync(profilePath, 'utf-8');
  const requiredMarkers = [
    'price_min:',
    'price_max:',
    'beds_min:',
    'sqft_min:',
  ];

  for (const marker of requiredMarkers) {
    if (!profile.includes(marker)) {
      errors.push(`config/profile.yml is missing required field: ${marker}`);
    }
  }

  if (profile.includes('Jane Smith')) {
    warnings.push('config/profile.yml still appears to contain example data.');
  }
}

const sharedModePath = join(ROOT, 'modes', '_shared.md');
if (existsSync(sharedModePath)) {
  const sharedMode = readFileSync(sharedModePath, 'utf-8');
  const criteriaPattern = /\$\d{3},?\d{3}|\b[345]\+\s*beds?\b|\b\d{4}\+\s*sq\s*ft\b/gi;
  const lines = sharedMode.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) {
      continue;
    }
    if (line.includes('config/profile.yml') || line.includes('buyer-profile.md')) {
      continue;
    }
    const matches = line.match(criteriaPattern);
    if (matches) {
      warnings.push(`modes/_shared.md:${index + 1} may contain hardcoded buyer criteria (${matches[0]}). Prefer reading from config/profile.yml.`);
      break;
    }
  }
}

const portalsPath = join(ROOT, 'portals.yml');
if (!existsSync(portalsPath)) {
  warnings.push('portals.yml not found. Scan mode will not work until platform search URLs are configured.');
}

console.log('\n=== home-ops profile sync check ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('All checks passed.');
} else {
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach((error) => console.log(`  ERROR: ${error}`));
  }
  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach((warning) => console.log(`  WARN: ${warning}`));
  }
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);