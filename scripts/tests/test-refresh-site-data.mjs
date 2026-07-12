#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  hostnameMatchesDomains,
  parseRefreshArgs,
  urlMatchesPlatform,
} from '../browser/refresh-site-data.mjs';

assert.equal(hostnameMatchesDomains('www.realtor.com', ['realtor.com']), true);
assert.equal(hostnameMatchesDomains('.realtor.com', ['realtor.com']), true);
assert.equal(hostnameMatchesDomains('notrealtor.com', ['realtor.com']), false);
assert.equal(urlMatchesPlatform('https://www.realtor.com/realestateandhomes-search/Apex_NC', 'realtor'), true);
assert.equal(urlMatchesPlatform('https://www.redfin.com/city/35711/NC/Apex', 'realtor'), false);
assert.equal(urlMatchesPlatform('not-a-url', 'realtor'), false);

const parsed = parseRefreshArgs(['--relator', '--profile', 'test-profile', '--no-open']);
assert.deepEqual([...parsed.selectedPlatforms], ['realtor']);
assert.equal(parsed.profileName, 'test-profile');
assert.equal(parsed.noOpen, true);

assert.throws(
  () => parseRefreshArgs([]),
  /Choose at least one portal flag/,
);

console.log('test-refresh-site-data: all assertions passed');
