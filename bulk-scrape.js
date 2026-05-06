// One-shot bulk scrape to build the DB fast
// Phase 1: PropertyScout (no Cloudflare, landlord filter)
// Phase 2: Facebook groups + searches via feed DOM extraction (no individual post visits)
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addListings, reprocessListings, getDBStats } from './db.js';
import { scrapeExtraSources } from './scraper-extra.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');

const AGENT_KEYWORDS = [
  'agent', 'broker', 'agency', 'commission', 'co-broke', 'co-agent',
  'ag post', 'agent post', 'welcome agent', 'agents welcome',
  'property scout', 'propertyscout', 're/max', 'remax', 'century 21',
  'cbre', 'colliers', 'knight frank', 'jll', 'savills',
  'ddproperty', 'fazwaz', 'hipflat', 'lazudi', 'dot property', 'baania',
  'were misusing this feature', 'going too fast', "this content isn't available",
  'something went wrong', "this page isn't available", 'log in to facebook',
  'link you followed may be broken', 'notifications', 'marketplace',
];

const GARBAGE_TITLES = new Set(['home', 'notifications', 'marketplace', 'groups', 'watch', 'menu', 'log in', 'sign up', 'facebook', '']);

const LOCATION_KEYWORDS = [
  'Bangkok', 'Sukhumvit', 'Thonglor', 'Asok', 'Silom', 'Sathorn', 'Phrom Phong',
  'Ekkamai', 'On Nut', 'Bearing', 'Nana', 'Ari', 'Ratchada', 'Ladprao', 'Rama', 'Phra Khanong',
  'Narathiwas', 'Rajadamri', 'Ratchadamri', 'Chidlom', 'Ploenchit', 'Wireless', 'Udom Suk',
  'Bang Na', 'Chatuchak', 'Victory Monument', 'Mo Chit', 'Lat Phrao',
];

function isAgentPost(text) {
  const lower = (text || '').toLowerCase();
  return AGENT_KEYWORDS.some(k => lower.includes(k));
}

// Extract listings directly from a rendered feed page — reads article containers, no post visits needed
async function extractFeedListings(page) {
  return page.evaluate(() => {
    const results = [];
    const containers = Array.from(document.querySelectorAll('[role="article"], [data-testid*="post_container"]'));
    const seen = new Set();

    for (const post of containers) {
      const dirAutos = Array.from(post.querySelectorAll('[dir="auto"]'));
      const description = dirAutos
        .map(d => d.innerText?.trim())
        .filter(t => t && t.length > 30)
        .sort((a, b) => b.length - a.length)[0] || '';
      if (!description || seen.has(description.slice(0, 60))) continue;
      seen.add(description.slice(0, 60));

      const imgs = Array.from(post.querySelectorAll('img[src*="scontent"]'))
        .map(i => i.src).filter(s => !s.includes('emoji') && !s.includes('profile_pic')).slice(0, 6);

      const link = post.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]')?.href || '';
      const title = description.split('\n')[0]?.trim().slice(0, 80) || '';

      results.push({ title, description, photos: imgs, link });
    }
    return results;
  });
}

// Parse price/bedrooms/location/ownerConfirmed from description text; generate a stable ID
function enrichListing(raw) {
  const desc = raw.description || '';
  const descLower = desc.toLowerCase();

  const rentMatch = desc.match(/(?:rent(?:al)?|เช่า)[^\n]{0,40}?([\d,]+)\s*(?:baht|บาท|thb|THB)(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i)
                 || desc.match(/([\d,]+)\s*(?:baht|บาท|THB|thb)\s*(?:\/|\s*per\s*)?\s*(?:month|เดือน)/i)
                 || desc.match(/฿\s*([\d,]+)/);
  const price = rentMatch ? rentMatch[1].replace(/,/g, '') + ' THB/month' : '';
  const priceNum = price ? parseInt(price.replace(/[^0-9]/g, '')) : 0;

  const bedMatch = desc.match(/(\d+)\s*(?:bed(?:room)?s?|ห้องนอน)/i) || desc.match(/(\d+)\s*(?:br|bdr)\b/i);
  const bedrooms = /\b(?:studio|สตูดิโอ)\b/i.test(desc) ? 0 : (bedMatch ? parseInt(bedMatch[1]) : null);

  const lines = desc.split('\n');
  const location = lines.find(t => LOCATION_KEYWORDS.some(k => t.includes(k)) && t.length < 80) || '';

  const ownerSignals = ['owner post', 'เจ้าของโพส', 'direct owner', 'ไม่ผ่านนายหน้า', 'no agent', 'by owner', 'posted by owner'];
  const ownerConfirmed = ownerSignals.some(s => descLower.includes(s));

  // Stable ID from description fingerprint (avoids pfbid/numeric ID issues)
  const listingId = 'fb_' + Buffer.from(desc.slice(0, 60)).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);

  return { ...raw, price, priceNum, bedrooms, location, ownerConfirmed, listingId, source: 'facebook', url: raw.link || '' };
}

function filterAndEnrich(rawListings, seenDescriptions) {
  const out = [];
  for (const r of rawListings) {
    const fingerprint = r.description.slice(0, 60);
    if (seenDescriptions.has(fingerprint)) continue;
    seenDescriptions.add(fingerprint);
    if (!r.description || r.description.length < 30) continue;
    if (isAgentPost(r.description + ' ' + r.title)) continue;
    if (/^sold\b/i.test(r.title)) continue;
    const titleLower = (r.title || '').toLowerCase().trim();
    if (GARBAGE_TITLES.has(titleLower) || titleLower.length < 5) continue;
    out.push(enrichListing(r));
  }
  return out;
}

// All FB groups to hit
const ALL_GROUPS = [
  '299716057099018', 'condosalesbyowner', '458098031664389',
  'bkkrealestatenetwork', 'prakard', '1965252317136254',
  '175356699802854', '828001787348618', 'renthub',
  '2157264477895406', 'bangkokpropertybyowner', 'condorentbangkok',
  '1387566661527073', 'bangkokrentals', '477698275659092',
  'ThailandPropertyForRent', 'condosuccessbangkok', '2100819700177509',
];

// FB search queries to run (broad + area-specific)
const FB_SEARCHES = [
  'condo rent Bangkok owner',
  'apartment rent Bangkok owner',
  'condo for rent Sukhumvit owner',
  'condo for rent Thonglor owner',
  'condo for rent Asok owner',
  'condo for rent Silom owner',
  'condo for rent Sathorn owner',
  'condo for rent Phrom Phong owner',
  'condo for rent On Nut owner',
  'condo for rent Bearing owner',
  'condo for rent Ekkamai owner',
  'condo for rent Ari owner',
  'condo for rent Ratchada owner',
  'condo for rent Ladprao owner',
  'condo for rent Nana owner',
  'คอนโดให้เช่า เจ้าของ กรุงเทพ',
  'ให้เช่าคอนโด สุขุมวิท เจ้าของ',
  'ให้เช่าคอนโด ทองหล่อ เจ้าของ',
  '1 bedroom condo rent Bangkok owner',
  '2 bedroom condo rent Bangkok owner',
  '3 bedroom condo rent Bangkok owner',
  'studio condo rent Bangkok owner',
];

async function scrapeFBGroup(page, group, seenDescriptions) {
  try {
    await page.goto(`https://www.facebook.com/groups/${group}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await page.waitForTimeout(900);
    }
    const raw = await extractFeedListings(page);
    const listings = filterAndEnrich(raw, seenDescriptions);
    process.stdout.write(`  Group ${group}: ${raw.length} posts → ${listings.length} listings\n`);
    return listings;
  } catch (e) {
    process.stdout.write(`  Group ${group}: error — ${e.message.slice(0, 60)}\n`);
    return [];
  }
}

async function scrapeFBSearch(page, query, seenDescriptions) {
  try {
    const q = encodeURIComponent(query);
    await page.goto(`https://www.facebook.com/search/posts/?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await page.waitForTimeout(800);
    }
    const raw = await extractFeedListings(page);
    const listings = filterAndEnrich(raw, seenDescriptions);
    if (listings.length > 0) process.stdout.write(`  Search "${query}": ${listings.length} listings\n`);
    return listings;
  } catch {
    return [];
  }
}

async function run() {
  const startTime = Date.now();
  let totalAdded = 0;

  console.log('\n━━━ PHASE 1: PropertyScout (owner landlord listings) ━━━');
  try {
    const extra = await scrapeExtraSources();
    const added = addListings(extra);
    totalAdded += added;
    console.log(`Phase 1 done: ${extra.length} scraped, ${added} added to DB\n`);
  } catch (e) {
    console.log('Phase 1 error:', e.message);
  }

  if (!fs.existsSync(SESSION_FILE)) {
    console.log('No FB session file — skipping Facebook scraping');
  } else {
    let browser;
    try {
      console.log('━━━ PHASE 2: Facebook groups + searches ━━━');
      // headless: false required — Facebook blocks headless with login walls
      browser = await chromium.launch({ headless: false, args: ['--window-position=9999,9999', '--no-sandbox'] });
      const context = await browser.newContext({ storageState: SESSION_FILE });
      const page = await context.newPage();

      await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      if (await page.$('input[name="email"]')) {
        console.log('⚠ FB session expired — skipping Facebook scrape');
        await browser.close();
      } else {
        const seenDescriptions = new Set();
        const allListings = [];

        // Groups aggregate feed
        try {
          await page.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3000);
          for (let i = 0; i < 8; i++) { await page.evaluate(() => window.scrollBy(0, 3000)); await page.waitForTimeout(900); }
          const raw = await extractFeedListings(page);
          const listings = filterAndEnrich(raw, seenDescriptions);
          allListings.push(...listings);
          console.log(`  Groups feed: ${raw.length} posts → ${listings.length} listings`);
        } catch (e) { console.log('  Feed error:', e.message); }

        // Individual groups
        console.log(`\n  Scraping ${ALL_GROUPS.length} groups...`);
        for (const group of ALL_GROUPS) {
          const listings = await scrapeFBGroup(page, group, seenDescriptions);
          allListings.push(...listings);
        }

        // Targeted searches
        console.log(`\n  Running ${FB_SEARCHES.length} targeted searches...`);
        for (const query of FB_SEARCHES) {
          const listings = await scrapeFBSearch(page, query, seenDescriptions);
          allListings.push(...listings);
        }

        await context.storageState({ path: SESSION_FILE });
        await browser.close();

        console.log(`\n  Total FB listings extracted: ${allListings.length}`);
        const added = addListings(allListings);
        totalAdded += added;
        console.log(`Phase 2 done: ${allListings.length} extracted, ${added} new added to DB`);
      }
    } catch (e) {
      console.error('FB scrape error:', e.message);
      if (browser) await browser.close().catch(() => {});
    }
  }

  // Fill missing price/bedroom/location fields on existing listings
  console.log('\n━━━ PHASE 3: Reprocessing DB to fill missing fields ━━━');
  const fixed = reprocessListings();
  console.log(`Fixed ${fixed} listings with missing data`);

  const stats = getDBStats();
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✓ Bulk scrape complete in ${elapsed}s`);
  console.log(`  DB: ${stats.total} total listings`);
  console.log(`  New this run: ${totalAdded}`);
}

run().catch(console.error);
