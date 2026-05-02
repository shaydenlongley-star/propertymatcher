import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addListings } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');

const OWNER_GROUPS = [
  '299716057099018',
  'condosalesbyowner',
  '458098031664389',
  '899928066709755',
  '1387566661527073',
  'bangkokpropertybyowner',
];

const AGENT_KEYWORDS = [
  'agent', 'broker', 'agency', 'commission', 'co-broke', 'co-agent',
  'ag post', 'agent post', 'welcome agent', 'agents welcome',
  'property scout', 'propertyscout', 're/max', 'remax', 'century 21',
  'cbre', 'colliers', 'knight frank', 'jll', 'savills',
  'ddproperty', 'fazwaz', 'hipflat', 'lazudi', 'dot property', 'baania',
];

const OWNER_SIGNALS = [
  'owner post', 'เจ้าของโพส', 'เจ้าของขาย', 'เจ้าของให้เช่า',
  'direct owner', 'ไม่ผ่านนายหน้า', 'no agent', 'by owner', 'posted by owner',
];

function isAgentPost(text, imgs = []) {
  const lower = (text + ' ' + imgs.join(' ')).toLowerCase();
  return AGENT_KEYWORDS.some(k => lower.includes(k));
}

function extractListingId(url) {
  const m = url.match(/\/commerce\/listing\/(\d+)/) ||
            url.match(/\/posts\/(\d+)/) ||
            url.match(/story_fbid=(\d+)/);
  return m ? m[1] : null;
}

export async function runBackgroundScrape(onSessionExpired) {
  if (!fs.existsSync(SESSION_FILE)) {
    console.log('[BG] No session file — skipping');
    return;
  }

  console.log('[BG] Starting background scrape...');
  let browser;

  try {
    browser = await chromium.launch({ headless: false, args: ['--window-position=9999,9999'] });
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();

    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    if (await page.$('input[name="email"]')) {
      console.log('[BG] Session expired');
      await browser.close();
      if (onSessionExpired) onSessionExpired();
      return;
    }

    const seenIds = new Set();
    const allListings = [];

    for (const group of OWNER_GROUPS) {
      try {
        console.log(`[BG] Scraping group ${group}...`);
        await page.goto(`https://www.facebook.com/groups/${group}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
        await page.evaluate(() => window.scrollBy(0, 2000));
        await page.waitForTimeout(2000);

        const urls = await page.evaluate(() => {
          const seen = new Set();
          const results = [];
          for (const link of document.querySelectorAll('a[href]')) {
            const href = link.href;
            const isPost = href.includes('/commerce/listing/') || href.includes('/posts/') || href.includes('/permalink/');
            if (!isPost) continue;
            const clean = href.split('?')[0];
            if (!seen.has(clean)) { seen.add(clean); results.push(href); }
            if (results.length >= 12) break;
          }
          return results;
        });

        console.log(`[BG]  ${urls.length} links found`);

        for (const url of urls.slice(0, 10)) {
          const listingId = extractListingId(url);
          if (listingId && seenIds.has(listingId)) { console.log(`[BG]  Duplicate skipped`); continue; }
          if (listingId) seenIds.add(listingId);

          try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2500);

            const detail = await page.evaluate(() => {
              const allDivs = Array.from(document.querySelectorAll('[dir="auto"]'));
              const description = allDivs
                .map(d => d.innerText?.trim())
                .filter(t => t && t.length > 30)
                .sort((a, b) => b.length - a.length)[0] || '';

              const rentMatch = description.match(/(?:rent(?:al)?|เช่า)[^\n]{0,40}?([\d,]+)\s*(?:baht|บาท|thb|THB)(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i)
                             || description.match(/([\d,]+)\s*(?:baht|บาท|THB|thb)\s*(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i);
              const price = rentMatch ? rentMatch[1].replace(/,/g, '') + ' THB/month' : '';
              const priceNum = price ? parseInt(price.replace(/[^0-9]/g, '')) : 0;

              const bedMatch = description.match(/(\d+)\s*(?:bed(?:room)?s?|ห้องนอน)/i);
              const bedrooms = bedMatch ? parseInt(bedMatch[1]) : null;

              const titleEl = document.querySelector('h1');
              const title = titleEl?.innerText?.trim().slice(0, 80) || description.split('\n')[0]?.trim().slice(0, 80) || '';

              const imgs = Array.from(document.querySelectorAll('img'))
                .map(img => img.src)
                .filter(src => src.includes('scontent') && !src.includes('emoji') && !src.includes('profile_pic'))
                .slice(0, 4);

              const locationKeywords = ['Bangkok', 'Sukhumvit', 'Thonglor', 'Asok', 'Silom', 'Sathorn', 'Phrom Phong', 'Ekkamai', 'On Nut', 'Bearing', 'Nana', 'Ari', 'Ratchada', 'Ladprao', 'Rama', 'Phra Khanong', 'Narathiwas', 'Rajadamri', 'Ratchadamri'];
              const textNodes = Array.from(document.querySelectorAll('span, div, p')).map(el => el.innerText?.trim()).filter(Boolean);
              const location = textNodes.find(t => locationKeywords.some(k => t?.includes(k)) && t.length < 80) || '';

              const ownerSignals = ['owner post', 'เจ้าของโพส', 'direct owner', 'ไม่ผ่านนายหน้า', 'no agent', 'by owner'];
              const ownerConfirmed = ownerSignals.some(s => description.toLowerCase().includes(s));

              return { title, price, priceNum, description, photos: imgs, location, bedrooms, ownerConfirmed };
            });

            if (isAgentPost(detail.description, detail.photos)) { console.log(`[BG]  Agent post skipped`); continue; }
            if (!detail.title && !detail.description) continue;

            allListings.push({ ...detail, listingId, url });
            console.log(`[BG]  Saved: ${detail.title?.slice(0, 50)}`);
          } catch { /* skip */ }
        }
      } catch (e) {
        console.log(`[BG] Error in group ${group}:`, e.message);
      }
    }

    await context.storageState({ path: SESSION_FILE });
    await browser.close();
    addListings(allListings);
    console.log(`[BG] Done — ${allListings.length} listings processed`);

  } catch (e) {
    console.error('[BG] Scrape error:', e.message);
    if (browser) await browser.close().catch(() => {});
  }
}
