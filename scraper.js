import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');

// Owner-only Bangkok property groups (public, 15k+ members)
const OWNER_GROUPS = [
  'condoandpropertypostbyowner',
  'condosalesbyowner',
  'condorentalbyowner',
  'condobangkokforrent',
  'bangkokpropertyrentals',
  'realestatebangkokowner'
];

// Search terms to filter out agent posts
const AGENT_KEYWORDS = ['agent', 'broker', 'agency', 'commission', 'co-broke', 'co broke'];

function isAgentPost(text) {
  const lower = text.toLowerCase();
  return AGENT_KEYWORDS.some(k => lower.includes(k));
}

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

  const allPostUrls = [];

  // Search each owner group
  for (const group of OWNER_GROUPS) {
    if (allPostUrls.length >= 6) break;
    try {
      const groupSearchUrl = `https://www.facebook.com/groups/${group}/search/?q=${encodeURIComponent(query)}`;
      await page.goto(groupSearchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const urls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/groups/"][href*="/posts/"]'));
        const seen = new Set();
        const results = [];
        for (const link of links) {
          const href = link.href.split('?')[0];
          if (!seen.has(href) && href.includes('/posts/')) {
            seen.add(href);
            results.push(href);
          }
          if (results.length >= 2) break;
        }
        return results;
      });

      allPostUrls.push(...urls);
    } catch {
      // skip failed group
    }
  }

  // Fallback to Facebook group search if no results from direct group search
  if (allPostUrls.length === 0) {
    try {
      const searchUrl = `https://www.facebook.com/search/posts/?q=${encodeURIComponent(query + ' owner Bangkok condo')}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);

      const urls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/groups/"][href*="/posts/"]'));
        const seen = new Set();
        const results = [];
        for (const link of links) {
          const href = link.href.split('?')[0];
          if (!seen.has(href)) { seen.add(href); results.push(href); }
          if (results.length >= 4) break;
        }
        return results;
      });

      allPostUrls.push(...urls);
    } catch {}
  }

  // Visit each post and extract details
  const listings = [];
  for (const url of allPostUrls.slice(0, 4)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      const detail = await page.evaluate(() => {
        // Post text
        const postEl = document.querySelector('[data-ad-comet-preview="message"], [data-testid="post_message"]');
        const description = postEl?.innerText?.trim() || document.querySelector('[dir="auto"]')?.innerText?.trim() || '';

        // Price from text
        const priceMatch = description.match(/฿[\d,]+|[\d,]+\s*(baht|บาท|thb)/i) ||
                           description.match(/[\d,]{4,}/);
        const price = priceMatch ? priceMatch[0] : '';

        // Title — first line of post
        const title = description.split('\n')[0]?.trim().slice(0, 80) || 'Property listing';

        // Photos
        const imgs = Array.from(document.querySelectorAll('img[src*="scontent"]'))
          .map(img => img.src)
          .filter(src => !src.includes('emoji') && !src.includes('profile') && !src.includes('sticker'))
          .slice(0, 4);

        // Location hints
        const allSpans = Array.from(document.querySelectorAll('span, div'));
        const locationKeywords = ['Bangkok', 'Sukhumvit', 'Thonglor', 'Asok', 'Silom', 'Sathorn', 'Phrom Phong', 'Ekkamai', 'On Nut', 'Bearing'];
        const location = allSpans.map(s => s.innerText?.trim()).find(t =>
          locationKeywords.some(k => t?.includes(k)) && t.length < 60
        ) || '';

        return { title, price, description, photos: imgs, location };
      });

      // Filter out agent posts
      if (isAgentPost(detail.description)) continue;

      // Apply price filter
      if (maxPrice && detail.price) {
        const priceNum = parseInt(detail.price.replace(/[^0-9]/g, ''));
        if (priceNum && priceNum > maxPrice) continue;
      }

      if (detail.title || detail.description) listings.push(detail);
    } catch {
      // skip failed posts
    }
  }

  await context.storageState({ path: SESSION_FILE });
  await browser.close();

  return listings;
}
