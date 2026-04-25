#!/usr/bin/env node

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { readSessionState } from '../browser/browser-session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILE_NAME = 'chrome-host';

const TEST_URLS = [
  ['short, no path segments', 'https://www.homes.com/apex-nc/'],
  ['short + path segments', 'https://www.homes.com/apex-nc/resale/4-to-5-bedroom/'],
  ['long, no path segments', 'https://www.homes.com/apex-nc/houses-for-sale/'],
  ['long + path segments', 'https://www.homes.com/apex-nc/houses-for-sale/resale/4-to-5-bedroom/'],
];

async function probe(context, label, url) {
  const page = await context.newPage();
  console.log(`\n=== ${label} ===`);
  console.log(`request URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.log(`  navigation failed: ${err.message.split('\n')[0]}`);
    return;
  }
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  const title = await page.title();
  const listingsHeader = await page.evaluate(() => {
    const h1 = document.querySelector('h1, h2, [class*="result"], [class*="count"]');
    return h1 ? (h1.innerText || '').slice(0, 120) : '';
  });
  const status404 = await page.evaluate(() => /not\s*found|404|sorry/i.test(document.body.innerText || ''));
  console.log(`  final URL: ${finalUrl}`);
  console.log(`  title:     ${title}`);
  console.log(`  header:    ${listingsHeader}`);
  console.log(`  404-ish:   ${status404}`);
  await page.close();
}

async function main() {
  const session = await readSessionState(ROOT, PROFILE_NAME);
  if (!session?.data?.cdpUrl) throw new Error('No hosted session.');
  const browser = await chromium.connectOverCDP(session.data.cdpUrl, { timeout: 30000, isLocal: true });
  const context = browser.contexts()[0];

  for (const [label, url] of TEST_URLS) {
    await probe(context, label, url);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
