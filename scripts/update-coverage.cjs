// Re-scrape forwatt.io supported partners and write data/forwatt-coverage.json.
// Runs in GitHub Actions (and locally). Uses Playwright because the partner grid
// is Blazor-rendered client-side — a plain fetch sees nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { buildCoverage } = require('../lib/coverage.js');

const URL = 'https://www.forwatt.io/';
const SEL = '.logos-partners img, .forwatt-partner-area-flex img';
const OUT = path.join(__dirname, '..', 'data', 'forwatt-coverage.json');

(async () => {
  const dso = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'dso.json'), 'utf8'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector(SEL, { timeout: 30000 }).catch(() => {});
    let srcs = [];
    for (let i = 0; i < 15; i++) { // Blazor paints the grid late and unpredictably
      srcs = await page.$$eval(SEL, els => els.map(e => e.getAttribute('src')));
      if (srcs.length) break;
      await page.waitForTimeout(1000);
    }
    if (!srcs.length) throw new Error('forwatt partner grid did not render');
    const cov = buildCoverage(srcs, dso, URL);
    fs.writeFileSync(OUT, JSON.stringify(cov));
    console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${cov.partners.length} partners, ${cov.matchedVnbIds.length} matched`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
