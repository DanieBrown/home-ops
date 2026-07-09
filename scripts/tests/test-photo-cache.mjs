#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePhotoBuffers } from '../research/extract-listing-details.mjs';

const root = mkdtempSync(join(tmpdir(), 'photo-test-'));
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const localPaths = await savePhotoBuffers('100-test-dr-apex-nc', [onePixelPng, null, onePixelPng], { root });
assert.equal(localPaths.length, 2);
assert.equal(localPaths[0], 'output/listings/photos/100-test-dr-apex-nc/photo-1.jpg');
assert.equal(localPaths[1], 'output/listings/photos/100-test-dr-apex-nc/photo-3.jpg');
assert.ok(existsSync(join(root, localPaths[0])));
assert.ok(existsSync(join(root, localPaths[1])));

const empty = await savePhotoBuffers('100-test-dr-apex-nc', [null, undefined], { root });
assert.deepEqual(empty, []);

rmSync(root, { recursive: true, force: true });
console.log('test-photo-cache: all assertions passed');
