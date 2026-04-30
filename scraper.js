import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');

export async function scrapeListings(query, maxPrice = null) {
  const browser = await chromium.launch({ headless: false });

  const contextOptions = fs.existsSync(SESSION_FILE)
    ? { storageState: SESSION_FILE }
    : {};

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Check login state
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const isLoggedOut = await page.$('input[name="email"]');
  if (isLoggedOut) {
    console.log('\n👉 Please log into Facebook in the browser window that just opened.');
    console.log('Waiting up to 2 minutes for login...\n');
    await page.waitForURL('https://www.facebook.com/', { timeout: 120000 });
    await page.waitForTimeout(2000);
    await context.storageState({ path: SESSION_FILE });
    console.log('Session saved — future searches will skip login.\n');
  }

  const priceParam = maxPrice ? `&maxPrice=${maxPrice}` : '';
  const searchUrl = `https://www.facebook.com/marketplace/bangkok/search/?query=${encodeURIComponent(query)}${priceParam}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Collect listing URLs from search results
  const listingUrls = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
    const seen = new Set();
    const urls = [];
    for (const link of links) {
      const href = link.href.split('?')[0];
      if (!seen.has(href)) { seen.add(href); urls.push(href); }
      if (urls.length >= 4) break;
    }
    return urls;
  });

  // Visit each listing and scrape details + photos
  const listings = [];
  for (const url of listingUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      const detail = await page.evaluate(() => {
        // Title
        const h1 = document.querySelector('h1');
        const title = h1?.innerText?.trim() || '';

        // Price
        const allSpans = Array.from(document.querySelectorAll('span'));
        const price = allSpans.map(s => s.innerText?.trim()).find(t => /฿|baht|\d{4,}/i.test(t)) || '';

        // Description
        const descEl = document.querySelector('[data-testid="marketplace-pdp-description"] span, [class*="description"] span');
        const description = descEl?.innerText?.trim() || '';

        // Photos — grab scontent CDN images
        const imgs = Array.from(document.querySelectorAll('img[src*="scontent"]'))
          .map(img => img.src)
          .filter(src => src.includes('scontent') && !src.includes('emoji') && !src.includes('profile'))
          .slice(0, 4);

        // Location
        const locSpans = allSpans.map(s => s.innerText?.trim()).filter(t =>
          t.includes('Bangkok') || t.includes('Sukhumvit') || t.includes('Thonglor') ||
          t.includes('Asok') || t.includes('Silom') || t.includes('Sathorn') || t.includes('Phrom Phong')
        );
        const location = locSpans[0] || '';

        return { title, price, description, photos: imgs, location };
      });

      if (detail.title || detail.price) listings.push(detail);
    } catch {
      // skip failed pages
    }
  }

  await context.storageState({ path: SESSION_FILE });
  await browser.close();

  return listings;
}
