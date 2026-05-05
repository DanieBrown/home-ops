#!/usr/bin/env node
/**
 * Unit tests for extract-listing-details.mjs pure helper functions.
 * Run: node scripts/tests/test-extract-parsers.mjs
 */
import assert from 'node:assert/strict';
import { pickJsonLdResidence, fromJsonLdResidence, normalizeListingStatus } from '../research/extract-listing-details.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// pickJsonLdResidence — @graph handling
// ---------------------------------------------------------------------------

test('@graph: finds SingleFamilyResidence inside @graph wrapper', () => {
  const items = [{
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'Listing page' },
      {
        '@type': 'SingleFamilyResidence',
        numberOfBedrooms: 5,
        floorSize: { value: 3716, unitText: 'SQFT' },
        address: { streetAddress: '4404 Clarkdale Ct', addressLocality: 'Fuquay Varina', addressRegion: 'NC', postalCode: '27526' },
      },
    ],
  }];
  const result = pickJsonLdResidence(items);
  assert.ok(result, 'should find a residence item');
  assert.equal(result['@type'], 'SingleFamilyResidence');
  assert.equal(result.numberOfBedrooms, 5);
});

test('@graph: returns null when @graph has no residence type', () => {
  const items = [{
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage' },
      { '@type': 'Organization', name: 'Realty Co' },
    ],
  }];
  const result = pickJsonLdResidence(items);
  assert.equal(result, null);
});

// Regression: flat @type items must still work
test('flat @type: finds SingleFamilyResidence without @graph wrapper', () => {
  const items = [
    { '@type': 'WebPage', name: 'Listing page' },
    { '@type': 'SingleFamilyResidence', numberOfBedrooms: 3, address: { streetAddress: '1 Main St' } },
  ];
  const result = pickJsonLdResidence(items);
  assert.ok(result);
  assert.equal(result.numberOfBedrooms, 3);
});

test('flat @type: returns null when nothing matches', () => {
  const result = pickJsonLdResidence([{ '@type': 'WebPage' }]);
  assert.equal(result, null);
});

test('empty array: returns null', () => {
  assert.equal(pickJsonLdResidence([]), null);
});

// ---------------------------------------------------------------------------
// fromJsonLdResidence — listingAgent + daysOnMarket
// ---------------------------------------------------------------------------

test('fromJsonLdResidence: extracts listingAgent from offers.offeredBy array', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main St', addressLocality: 'Raleigh', addressRegion: 'NC', postalCode: '27601' },
    offers: [{ price: 500000, availability: 'InStock', offeredBy: [{ name: 'Jane Smith' }] }],
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.listingAgent, 'Jane Smith');
});

test('fromJsonLdResidence: extracts listingAgent from offers.offeredBy object (non-array)', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main St', addressLocality: 'Raleigh', addressRegion: 'NC' },
    offers: { price: 400000, offeredBy: { name: 'Bob Jones' } },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.listingAgent, 'Bob Jones');
});

test('fromJsonLdResidence: no crash when offeredBy is absent', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main', addressLocality: 'Raleigh', addressRegion: 'NC' },
    offers: { price: 300000 },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.listingAgent, null);
});

test('fromJsonLdResidence: computes daysOnMarket from datePosted', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const item = {
    '@type': 'SingleFamilyResidence',
    datePosted: twoDaysAgo,
    address: { streetAddress: '123 Main', addressLocality: 'Raleigh', addressRegion: 'NC' },
  };
  const result = fromJsonLdResidence(item);
  assert.ok(
    result.daysOnMarket >= 1 && result.daysOnMarket <= 3,
    `expected ~2 days, got ${result.daysOnMarket}`
  );
});

test('fromJsonLdResidence: daysOnMarket is null when datePosted absent', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main', addressLocality: 'Raleigh', addressRegion: 'NC' },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.daysOnMarket, null);
});

// ---------------------------------------------------------------------------
// fromJsonLdResidence — mainEntity unwrap (homes.com pattern)
// ---------------------------------------------------------------------------

test('fromJsonLdResidence: reads beds/baths/sqft from mainEntity when present', () => {
  const item = {
    '@type': 'RealEstateListing',
    address: { streetAddress: '4404 Clarkdale Ct', addressLocality: 'Fuquay Varina', addressRegion: 'NC', postalCode: '27526' },
    offers: [{ price: 750000, availability: 'https://schema.org/InStock' }],
    mainEntity: {
      '@type': 'SingleFamilyResidence',
      numberOfBedrooms: 5,
      numberOfBathroomsTotal: 4,
      floorSize: { value: 3716, unitText: 'SQFT' },
      yearBuilt: 2023,
    },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.beds, 5);
  assert.equal(result.baths, 4);
  assert.equal(result.sqftFinished, 3716);
  assert.equal(result.yearBuilt, 2023);
  assert.equal(result.price, 750000);
});

test('fromJsonLdResidence: falls back to item fields when mainEntity absent', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    numberOfBedrooms: 3,
    floorSize: { value: 1800, unitText: 'SQFT' },
    address: { streetAddress: '1 Main St', addressLocality: 'Raleigh', addressRegion: 'NC' },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.beds, 3);
  assert.equal(result.sqftFinished, 1800);
});

// ---------------------------------------------------------------------------
// normalizeListingStatus — InStock handling
// ---------------------------------------------------------------------------

test('normalizeListingStatus: InStock schema.org URL → active', () => {
  const result = normalizeListingStatus('https://schema.org/InStock');
  assert.equal(result, 'active');
});

test('normalizeListingStatus: in-stock string → active', () => {
  const result = normalizeListingStatus('in-stock');
  assert.equal(result, 'active');
});

test('normalizeListingStatus: sold body text → sold', () => {
  const result = normalizeListingStatus('', 'This property has been sold.');
  assert.equal(result, 'sold');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
