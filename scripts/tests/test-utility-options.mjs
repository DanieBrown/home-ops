#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { loadUtilityOptionsForReport } from '../reports/briefing-pdf.mjs';
import {
  buildUtilityOptionsRecord,
  estimateElectric,
  estimateGasMonthly,
  estimateTieredUsage,
  estimateWaterSewer,
} from '../research/utility-options-core.mjs';

const hollySpringsRate = {
  waterAccess: 18.46,
  sewerAccess: 19.25,
  waterTiers: [
    { upToGallons: 2000, ratePerThousand: 6.12 },
    { upToGallons: 5000, ratePerThousand: 7.97 },
    { upToGallons: 9000, ratePerThousand: 9.81 },
    { upToGallons: Infinity, ratePerThousand: 11.65 },
  ],
  sewerRatePerThousand: 8.38,
};

assert.equal(estimateTieredUsage(5000, hollySpringsRate.waterTiers), 36.15);
assert.equal(estimateWaterSewer(hollySpringsRate, 5000), 115.76);
assert.equal(estimateWaterSewer({ waterAccess: null, sewerAccess: null }, 5000), null);
assert.equal(estimateElectric({ customerCharge: 12, energyRate: 0.1 }, 1000), 112);
assert.equal(estimateGasMonthly(30, { baseCharge: 10, ratePerTherm: 1.25 }), 47.5);

const record = await buildUtilityOptionsRecord(
  {
    address: '100 Utility Test Dr',
    city: 'Holly Springs',
    state: 'NC',
    relativePath: 'reports/100-utility-test.md',
    sections: { 'Quick Take': 'Includes gas fireplace and gas cooktop.' },
    content: 'Includes gas fireplace and gas cooktop.',
  },
  {},
  {
    skipNetwork: true,
    geocodeRecord: null,
    listing: { description: 'Gas range and tankless gas water heater.' },
  },
);

assert.equal(record.address, '100 Utility Test Dr');
assert.equal(record.providers.waterSewer[0].name, 'Town of Holly Springs Water/Sewer');
assert.equal(record.providers.waterSewer[0].estimateMonthly.typical, 115.76);
assert.equal(record.providers.naturalGas[0].serviceStatus, 'likely');
assert.equal(record.monthlyEstimate.includedServices.includes('internet (Spectrum Internet Premier)'), false);
assert.equal(record.selectedInternetPlan, null);
assert.ok(record.warnings.some((warning) => /internet/i.test(warning)));

const reportedInternetRecord = await buildUtilityOptionsRecord(
  {
    address: '200 Reported Fiber Way',
    city: 'Holly Springs',
    state: 'NC',
    relativePath: 'reports/200-reported-fiber.md',
    sections: {},
    content: '',
  },
  {},
  {
    geocodeRecord: { lat: 35.6, lng: -78.8 },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        providers: [
          { name: 'Spectrum', technology: 'Fiber', max_download_mbps: 1000, max_upload_mbps: 500 },
          { name: 'AT&T', technology: 'Fiber', max_download_mbps: 5000, max_upload_mbps: 5000 },
        ],
      }),
    }),
  },
);

assert.equal(reportedInternetRecord.providers.internet.find((provider) => provider.name === 'Spectrum')?.serviceStatus, 'reported');
assert.equal(reportedInternetRecord.providers.internet.find((provider) => provider.name === 'AT&T Fiber / Internet Air')?.plans[0]?.downloadMbps, 5000);
assert.equal(reportedInternetRecord.selectedInternetPlan.provider, 'Spectrum');
assert.ok(reportedInternetRecord.monthlyEstimate.includedServices.some((service) => service.startsWith('internet')));

const utilitiesDir = join(ROOT, 'output', 'utilities');
mkdirSync(utilitiesDir, { recursive: true });
const report = {
  address: '999 Utility Sidecar Ln',
  city: 'Testville',
  state: 'NC',
};
const sidecarPath = join(utilitiesDir, `${slugify(`${report.address}-${report.city}-${report.state}`)}.json`);
writeFileSync(sidecarPath, `${JSON.stringify({
  address: report.address,
  city: 'Wrongville',
  state: report.state,
  providers: {},
  monthlyEstimate: {},
}, null, 2)}\n`, 'utf8');

try {
  const companion = loadUtilityOptionsForReport(report);
  assert.equal(companion.data, null);
  assert.equal(companion.mismatch, true);
  assert.match(companion.mismatchMessage, /does not match/i);
} finally {
  if (existsSync(sidecarPath)) rmSync(sidecarPath);
}

console.log('utility options tests passed');
