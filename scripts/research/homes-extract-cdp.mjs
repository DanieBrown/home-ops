#!/usr/bin/env node
/**
 * Temporary CDP-direct homes.com listing extractor.
 * Attaches to the hosted Chrome session via Playwright CDP, navigates to the
 * listing URL, then extracts structured data and visible body text.
 */

import { chromium } from 'playwright';

const URL_TO_SCRAPE = process.argv[2] || '';
if (!URL_TO_SCRAPE) {
  console.error('Usage: node homes-extract-cdp.mjs <url>');
  process.exit(1);
}

(async () => {
  let browser = null;
  let page = null;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
      timeout: 20000,
      isLocal: true,
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error('No default context in hosted session');

    page = await context.newPage();
    console.log('Navigating to:', URL_TO_SCRAPE);
    await page.goto(URL_TO_SCRAPE, { waitUntil: 'domcontentloaded', timeout: 35000 });
    // Give React/hydration time to settle
    await page.waitForTimeout(5000);

    const data = await page.evaluate(() => {
      const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
        .filter(Boolean);

      let nextData = null;
      const nd = document.querySelector('script#__NEXT_DATA__');
      if (nd) { try { nextData = JSON.parse(nd.textContent); } catch {} }

      return {
        title: document.title,
        url: location.href,
        metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
        bodyText: (document.body?.innerText || '').slice(0, 8000),
        jsonLd,
        hasNextData: !!nextData,
        nextDataKeys: nextData ? Object.keys(nextData.props?.pageProps || {}).slice(0, 20) : [],
      };
    });

    console.log('\n=== PAGE TITLE ===');
    console.log(data.title);
    console.log('\n=== URL ===');
    console.log(data.url);
    console.log('\n=== META DESCRIPTION ===');
    console.log(data.metaDescription);
    console.log('\n=== JSON-LD count:', data.jsonLd?.length, '===');
    if (data.jsonLd?.length) {
      console.log(JSON.stringify(data.jsonLd, null, 2).slice(0, 4000));
    }
    console.log('\n=== NEXT_DATA present:', data.hasNextData, 'keys:', data.nextDataKeys.join(', '), '===');
    console.log('\n=== BODY TEXT (first 5000 chars) ===');
    console.log(data.bodyText?.slice(0, 5000));

    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
})();
