import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');

const OWNER_GROUPS = [
  '299716057099018',    // CONDO & PROPERTY POST BY OWNER (22K)
  'condosalesbyowner',  // Condo sales by owner (116K)
  '458098031664389',    // Condo rental by Owner (77K)
  '899928066709755',    // ซื้อ ขาย บ้าน ที่ดิน เจ้าของขายเอง (169K)
  '1387566661527073',   // Bangkok Condo For Rent/Sale by Owner
  'bangkokpropertybyowner',
  '2204279116481020',   // Bangkok Property Owner Post
  '1544324185802619',   // Condo Bangkok By Owner
];

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

  // Verify login
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const emailField = await page.$('input[name="email"]');
  if (emailField) {
    console.log('Not logged in — run node login.js first');
    await browser.close();
    return [];
  }

  const allPostUrls = [];

  for (const group of OWNER_GROUPS) {
    if (allPostUrls.length >= 6) break;
    try {
      const groupSearchUrl = `https://www.facebook.com/groups/${group}/search/?q=${encodeURIComponent(query)}`;
      console.log(`Searching: ${groupSearchUrl}`);
      await page.goto(groupSearchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);

      const urls = await page.evaluate(() => {
        const seen = new Set();
        const results = [];
        const links = Array.from(document.querySelectorAll('a[href]'));

        for (const link of links) {
          const href = link.href;
          // Facebook group posts now appear as /commerce/listing/ or /groups/.../posts/ or ?post_id=
          const isPost = (
            href.includes('/commerce/listing/') ||
            href.includes('/posts/') ||
            href.includes('/permalink/') ||
            (href.includes('/groups/') && href.includes('post_id='))
          );
          if (!isPost) continue;

          const clean = href.split('?')[0];
          if (!seen.has(clean)) {
            seen.add(clean);
            results.push(href); // keep query params for post_id case
          }
          if (results.length >= 3) break;
        }
        return results;
      });

      console.log(`  Found ${urls.length} post links`);
      allPostUrls.push(...urls);
    } catch (e) {
      console.log(`  Error searching group ${group}:`, e.message);
    }
  }

  // Fallback: Facebook-wide group search if we don't have enough results
  if (allPostUrls.length < 4) {
    try {
      const fbSearch = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(query + ' owner Bangkok')}`;
      console.log(`Fallback search: ${fbSearch}`);
      await page.goto(fbSearch, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      const urls = await page.evaluate(() => {
        const seen = new Set();
        const results = [];
        for (const link of document.querySelectorAll('a[href]')) {
          const href = link.href;
          const isPost = href.includes('/commerce/listing/') || href.includes('/posts/') || href.includes('/permalink/');
          if (!isPost) continue;
          const clean = href.split('?')[0];
          if (!seen.has(clean)) { seen.add(clean); results.push(href); }
          if (results.length >= 4) break;
        }
        return results;
      });

      console.log(`  Fallback found ${urls.length} links`);
      allPostUrls.push(...urls);
    } catch (e) {
      console.log('Fallback search error:', e.message);
    }
  }

  // Visit each listing and extract details
  const listings = [];
  for (const url of allPostUrls.slice(0, 5)) {
    try {
      console.log(`Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const detail = await page.evaluate(() => {
        const titleEl = document.querySelector('h1');

        // Get main description
        const allDivs = Array.from(document.querySelectorAll('[dir="auto"]'));
        const description = allDivs
          .map(d => d.innerText?.trim())
          .filter(t => t && t.length > 30)
          .sort((a, b) => b.length - a.length)[0] || '';

        // Prefer rental price (per month) over sale price
        const rentMatch = description.match(/(?:rent(?:al)?|เช่า)[^\n]{0,40}?([\d,]+)\s*(?:baht|บาท|thb|THB)(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i)
                       || description.match(/([\d,]+)\s*(?:baht|บาท|THB|thb)\s*(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i)
                       || description.match(/(?:month(?:ly)?|เดือน)[^\n]{0,10}?:?\s*([\d,]+)/i);
        const saleMatch = description.match(/(?:sell(?:ing)?|sale|ขาย)[^\n]{0,40}?([\d,.]+)\s*(?:million|M|ล้าน|baht|บาท)/i)
                       || description.match(/([\d,]+,000,000|[5-9]\d{2},\d{3})\s*(?:baht|บาท)?/i);

        let price = '';
        let isSaleOnly = false;
        if (rentMatch) {
          price = rentMatch[1].replace(/,/g, '') + ' THB/month';
        } else if (saleMatch) {
          price = saleMatch[0].trim();
          isSaleOnly = true;
        } else {
          const anyPrice = description.match(/฿[\d,]+|[\d,]{5,}\s*(?:baht|บาท|THB)/i);
          price = anyPrice ? anyPrice[0].trim() : '';
        }

        // Bedroom count
        const bedMatch = description.match(/(\d+)\s*(?:bed(?:room)?s?|ห้องนอน)/i);
        const bedrooms = bedMatch ? parseInt(bedMatch[1]) : null;

        const title = titleEl?.innerText?.trim().slice(0, 80) ||
                      description.split('\n')[0]?.trim().slice(0, 80) ||
                      'Property listing';

        const imgs = Array.from(document.querySelectorAll('img'))
          .map(img => img.src)
          .filter(src => src.includes('scontent') && !src.includes('emoji') && !src.includes('profile_pic'))
          .slice(0, 4);

        const locationKeywords = ['Bangkok', 'Sukhumvit', 'Thonglor', 'Asok', 'Silom', 'Sathorn', 'Phrom Phong', 'Ekkamai', 'On Nut', 'Bearing', 'Nana', 'Ari', 'Ratchada'];
        const textNodes = Array.from(document.querySelectorAll('span, div, p'))
          .map(el => el.innerText?.trim()).filter(t => t);
        const location = textNodes.find(t =>
          locationKeywords.some(k => t?.includes(k)) && t.length < 80
        ) || '';

        return { title, price, description, photos: imgs, location, bedrooms, isSaleOnly };
      });

      if (isAgentPost(detail.description)) {
        console.log('  Skipping agent post');
        continue;
      }

      if (maxPrice && detail.price) {
        const priceNum = parseInt(detail.price.replace(/[^0-9]/g, ''));
        // Skip price filter for obvious sale prices (>500k) — agent asked for rent budget
        if (priceNum && priceNum > maxPrice && priceNum < 500000) {
          console.log(`  Skipping — rental price ${priceNum} > max ${maxPrice}`);
          continue;
        }
      }

      if (detail.title || detail.description) {
        console.log(`  Added: ${detail.title}`);
        listings.push({ ...detail, url });
      }
    } catch (e) {
      console.log(`  Error visiting post:`, e.message);
    }
  }

  await context.storageState({ path: SESSION_FILE });
  await browser.close();

  return listings;
}
