import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');
const GROUP_IDS_FILE = path.join(__dirname, 'group-ids.json');

const FALLBACK_GROUPS = [
  '299716057099018',
  'condosalesbyowner',
  '458098031664389',
  '899928066709755',
  '1387566661527073',
  'bangkokpropertybyowner',
  '2204279116481020',
  '1544324185802619',
];

function loadGroupIds() {
  if (fs.existsSync(GROUP_IDS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(GROUP_IDS_FILE, 'utf8'));
      const ids = Object.keys(data);
      if (ids.length > 0) return ids;
    } catch {}
  }
  return FALLBACK_GROUPS;
}

// Words that confirm an agent/agency post
const AGENT_KEYWORDS = [
  'agent', 'broker', 'agency', 'commission', 'co-broke', 'co broke', 'co-agent',
  'ag post', 'agent post', 'welcome agent', 'agents welcome',
  // Known Bangkok real estate agencies
  'property scout', 'propertyscout',
  're/max', 'remax',
  'century 21', 'century21',
  'cbre', 'colliers', 'knight frank', 'jll', 'savills',
  'ddproperty', 'dd property',
  'fazwaz', 'faz waz',
  'hipflat', 'lazudi',
  'thailand property', 'dot property',
  'thaiger property', 'baania',
  'perfect homes', 'plus property',
  'noble estate', 'siam real estate',
];

// Words that confirm it IS an owner post (positive signals)
const OWNER_SIGNALS = [
  'owner post', 'เจ้าของโพส', 'เจ้าของขาย', 'เจ้าของให้เช่า',
  'direct owner', 'ไม่ผ่านนายหน้า', 'no agent', 'by owner',
  'posted by owner', 'owner direct',
];

function isAgentPost(text, imageUrls = []) {
  const lower = text.toLowerCase();

  // Check text for agent keywords
  if (AGENT_KEYWORDS.some(k => lower.includes(k))) return true;

  // Check image URLs/alt text for agency watermarks
  const imgText = imageUrls.join(' ').toLowerCase();
  if (AGENT_KEYWORDS.some(k => imgText.includes(k))) return true;

  return false;
}

function hasOwnerSignal(text) {
  const lower = text.toLowerCase();
  return OWNER_SIGNALS.some(k => lower.includes(k));
}

// Shared extraction logic — works for both group posts and marketplace items
async function scrapeDetailFromPage(page) {
  return page.evaluate(() => {
    const allDivs = Array.from(document.querySelectorAll('[dir="auto"]'));
    const description = allDivs.map(d => d.innerText?.trim()).filter(t => t && t.length > 20).sort((a, b) => b.length - a.length)[0] || '';

    const rentMatch = description.match(/([\d,]+)\s*(?:baht|บาท|THB|thb)\s*(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i)
                   || description.match(/(?:rent|เช่า)[^\n]{0,40}?([\d,]+)/i);
    const price = rentMatch ? rentMatch[1].replace(/,/g, '') + ' THB/month' : '';
    const priceNum = price ? parseInt(price.replace(/[^0-9]/g, '')) : 0;

    const bedMatch = description.match(/(\d+)\s*(?:bed(?:room)?s?|ห้องนอน)/i);
    const bedrooms = bedMatch ? parseInt(bedMatch[1]) : null;

    const titleEl = document.querySelector('h1');
    const title = titleEl?.innerText?.trim().slice(0, 80) || description.split('\n')[0]?.trim().slice(0, 80) || '';

    const imgs = Array.from(document.querySelectorAll('img'))
      .map(img => img.src)
      .filter(src => src.includes('scontent') && !src.includes('emoji') && !src.includes('profile_pic'))
      .slice(0, 6);

    const locationKeywords = ['Sukhumvit','Thonglor','Asok','Silom','Sathorn','Phrom Phong','Ekkamai',
      'On Nut','Bearing','Nana','Ari','Ratchada','Phra Khanong','Rama 9','Ladprao','Chatuchak','Bang Na'];
    const allText = Array.from(document.querySelectorAll('span,div,p')).map(el => el.innerText?.trim()).filter(Boolean);
    const location = allText.find(t => locationKeywords.some(k => t?.includes(k)) && t.length < 80) || '';

    const ownerSignals = ['owner post','เจ้าของโพส','direct owner','ไม่ผ่านนายหน้า','no agent','by owner'];
    const ownerConfirmed = ownerSignals.some(s => description.toLowerCase().includes(s));

    return { title, price, priceNum, description, photos: imgs, location, bedrooms, ownerConfirmed };
  });
}

// Full Facebook search fallback — Marketplace + post search
export async function scrapeFBSearch(query, maxPrice = null) {
  const browser = await chromium.launch({ headless: false, args: ['--window-position=9999,9999'] });
  const contextOptions = fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {};
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  if (await page.$('input[name="email"]')) { await browser.close(); return []; }

  const allUrls = [];

  // 1. Facebook Marketplace — Bangkok rentals
  try {
    const mktQ = encodeURIComponent(query + ' rent Bangkok');
    await page.goto(`https://www.facebook.com/marketplace/search/?query=${mktQ}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);
    const mktUrls = await page.evaluate(() => {
      const seen = new Set(), results = [];
      for (const a of document.querySelectorAll('a[href]')) {
        if (!a.href.includes('/marketplace/item/')) continue;
        const clean = a.href.split('?')[0];
        if (!seen.has(clean)) { seen.add(clean); results.push(clean); }
        if (results.length >= 8) break;
      }
      return results;
    });
    console.log(`[FBSEARCH] Marketplace: ${mktUrls.length} results`);
    allUrls.push(...mktUrls);
  } catch (e) { console.log('[FBSEARCH] Marketplace error:', e.message); }

  // 2. FB post search — broader net across all public posts
  try {
    const postQ = encodeURIComponent(query + ' Bangkok condo rent owner');
    await page.goto(`https://www.facebook.com/search/posts/?q=${postQ}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);
    const postUrls = await page.evaluate(() => {
      const seen = new Set(), results = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href.includes('/posts/') && !href.includes('/permalink/') && !href.includes('/commerce/listing/')) continue;
        const clean = href.split('?')[0];
        if (!seen.has(clean)) { seen.add(clean); results.push(href); }
        if (results.length >= 8) break;
      }
      return results;
    });
    console.log(`[FBSEARCH] Post search: ${postUrls.length} results`);
    allUrls.push(...postUrls);
  } catch (e) { console.log('[FBSEARCH] Post search error:', e.message); }

  const AGENT_KW = ['agent','broker','agency','commission','นายหน้า','ตัวแทน','customer agent',
    'please contact us','our team','our agency','real estate consultant','consultant for','for customer'];

  const listings = [];
  for (const url of [...new Set(allUrls)].slice(0, 8)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const detail = await scrapeDetailFromPage(page);

      const text = (detail.title + ' ' + detail.description).toLowerCase();
      if (AGENT_KW.some(k => text.includes(k))) { console.log('[FBSEARCH] Skipping agent post'); continue; }
      if (!detail.title && !detail.description) continue;
      if (maxPrice && detail.priceNum && detail.priceNum < 500000 && detail.priceNum > maxPrice) continue;

      console.log(`[FBSEARCH] Found: ${detail.title?.slice(0, 50)}`);
      listings.push({ ...detail, url });
    } catch (e) { console.log('[FBSEARCH] Error visiting:', e.message); }
  }

  await context.storageState({ path: SESSION_FILE });
  await browser.close();
  return listings;
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
  const OWNER_GROUPS = loadGroupIds();

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
          .slice(0, 6);

        const locationKeywords = ['Bangkok', 'Sukhumvit', 'Thonglor', 'Asok', 'Silom', 'Sathorn', 'Phrom Phong', 'Ekkamai', 'On Nut', 'Bearing', 'Nana', 'Ari', 'Ratchada'];
        const textNodes = Array.from(document.querySelectorAll('span, div, p'))
          .map(el => el.innerText?.trim()).filter(t => t);
        const location = textNodes.find(t =>
          locationKeywords.some(k => t?.includes(k)) && t.length < 80
        ) || '';

        return { title, price, description, photos: imgs, location, bedrooms, isSaleOnly };
      });

      if (isAgentPost(detail.description, detail.photos)) {
        console.log('  Skipping agent post');
        continue;
      }

      // Boost score for confirmed owner posts (used in server.js ranking)
      detail.ownerConfirmed = hasOwnerSignal(detail.description);

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
