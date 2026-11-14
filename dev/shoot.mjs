import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = process.env.BRAVE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = 'dev/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--force-color-profile=srgb'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/01-empty.png` });

// inspect a real link
await page.fill('#url', process.env.URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await page.press('#url', 'Enter');
await page.waitForSelector('.sheet', { timeout: 60000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/02-result.png` });

// settings
await page.click('.rail-btn[data-view="settings"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/05-settings.png` });

// archive
await page.click('.rail-btn[data-view="archive"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/06-archive.png` });

// narrow layout
await page.setViewportSize({ width: 1080, height: 800 });
await page.click('.rail-btn[data-view="inspect"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/07-narrow.png` });
await page.click('#queueToggle');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/08-narrow-queue.png` });

await browser.close();
console.log(errors.length ? errors.join('\n') : 'no console errors');
