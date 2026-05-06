import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addListings, getDemandStats, getRecentSearches } from './db.js';
import { scrapeExtraSources } from './scraper-extra.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');
const GROUP_IDS_FILE = path.join(__dirname, 'group-ids.json');

const FALLBACK_GROUPS = [
  '299716057099018', 'condosalesbyowner', '458098031664389',
  '899928066709755', '1387566661527073', 'bangkokpropertybyowner',
  'bangkokrentals', 'condorentbangkok', 'ThailandPropertyForRent',
];

function loadGroupIds() {
  if (fs.existsSync(GROUP_IDS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(GROUP_IDS_FILE, 'utf8'));
      const ids = Object.keys(data);
      if (ids.length > 0) { console.log(`[BG] Loaded ${ids.length} group IDs`); return ids; }
    } catch {}
  }
  return FALLBACK_GROUPS;
}

const AGENT_KEYWORDS = [
  'agent', 'broker', 'agency', 'commission', 'co-broke', 'co-agent',
  'ag post', 'agent post', 'welcome agent', 'agents welcome',
  'property scout', 'propertyscout', 're/max', 'remax', 'century 21',
  'cbre', 'colliers', 'knight frank', 'jll', 'savills',
  'ddproperty', 'fazwaz', 'hipflat', 'lazudi', 'dot property', 'baania',
  'were misusing this feature', 'going too fast', "this content isn't available",
  'something went wrong', "this page isn't available", 'log in to facebook',
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

// Extract listings from a rendered FB feed page without visiting individual posts
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

// Enrich a raw feed listing with parsed price/bedrooms/location/ID
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

function matchesSearch(listing, search) {
  const p = search.parsedFull;
  if (!p) return false;

  if (p.bedrooms && listing.bedrooms != null && listing.bedrooms !== p.bedrooms) return false;

  if (p.budget && listing.priceNum) {
    const budgetNum = parseInt((p.budget || '').replace(/[^0-9]/g, ''));
    if (budgetNum && listing.priceNum < 500000 && listing.priceNum > budgetNum * 1.6) return false;
  }

  if (p.location) {
    const locTerms = p.location.toLowerCase().split(/[\s,\/]+/).filter(t => t.length > 3);
    const text = ((listing.title || '') + ' ' + (listing.description || '') + ' ' + (listing.location || '')).toLowerCase();
    if (locTerms.length > 0 && !locTerms.some(t => text.includes(t))) return false;
  }

  return true;
}

export async function runBackgroundScrape(onSessionExpired, onProactiveMatch) {
  // Always run PropertyScout (no login, no Cloudflare)
  try {
    console.log('[BG] Scraping PropertyScout...');
    const extraListings = await scrapeExtraSources();
    if (extraListings.length > 0) {
      addListings(extraListings);
      console.log(`[BG] PropertyScout: +${extraListings.length} listings`);
    }
  } catch (e) {
    console.log('[BG] PropertyScout error:', e.message);
  }

  if (!fs.existsSync(SESSION_FILE)) {
    console.log('[BG] No session file — skipping Facebook scrape');
    return;
  }

  await runFacebookScrape(onSessionExpired, onProactiveMatch);
}

async function runFacebookScrape(onSessionExpired, onProactiveMatch) {
  console.log('[BG] Starting Facebook scrape...');
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

    const OWNER_GROUPS = loadGroupIds();
    const seenDescriptions = new Set();
    const allListings = [];

    // 1. Groups aggregate feed
    try {
      console.log('[BG] Scraping groups feed...');
      await page.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => window.scrollBy(0, 3000));
        await page.waitForTimeout(1200);
      }
      const raw = await extractFeedListings(page);
      const listings = filterAndEnrich(raw, seenDescriptions);
      allListings.push(...listings);
      console.log(`[BG]  Feed: ${raw.length} posts → ${listings.length} listings`);
    } catch (e) { console.log('[BG] Feed error:', e.message); }

    // 2. Specific owner groups
    for (const group of OWNER_GROUPS) {
      try {
        await page.goto(`https://www.facebook.com/groups/${group}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 2500));
          await page.waitForTimeout(900);
        }
        const raw = await extractFeedListings(page);
        const listings = filterAndEnrich(raw, seenDescriptions);
        allListings.push(...listings);
        console.log(`[BG]  Group ${group}: ${raw.length} posts → ${listings.length} listings`);
      } catch (e) { console.log(`[BG] Error in group ${group}:`, e.message); }
    }

    // 3. Demand-driven targeted searches
    try {
      const demand = getDemandStats();
      const topAreas = demand.topAreas.slice(0, 3).map(a => a.area);
      const topBeds = demand.topBedrooms.slice(0, 2).map(b => b.beds);
      console.log(`[BG] Demand-driven scraping: areas=${topAreas.join(',')} beds=${topBeds.join(',')}`);

      for (const area of topAreas) {
        for (const beds of topBeds.length ? topBeds : [1, 2]) {
          const q = encodeURIComponent(`${beds} bedroom condo rent ${area}`);
          try {
            await page.goto(`https://www.facebook.com/search/posts/?q=${q}`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);
            for (let i = 0; i < 2; i++) { await page.evaluate(() => window.scrollBy(0, 2500)); await page.waitForTimeout(900); }
            const raw = await extractFeedListings(page);
            const listings = filterAndEnrich(raw, seenDescriptions);
            allListings.push(...listings);
            if (listings.length > 0) console.log(`[BG]  Demand search "${beds}BR ${area}": ${listings.length} listings`);
          } catch {}
        }
      }
    } catch (e) { console.log('[BG] Demand scrape error:', e.message); }

    await context.storageState({ path: SESSION_FILE });
    await browser.close();

    const added = addListings(allListings);
    console.log(`[BG] Facebook done — ${allListings.length} extracted, ${added} new added`);

    // 4. Proactive matching — check new listings against recent searches
    if (onProactiveMatch && allListings.length > 0) {
      try {
        const recentSearches = getRecentSearches(48);
        const alertsSent = new Set();

        for (const listing of allListings) {
          for (const search of recentSearches) {
            const alertKey = `${search.userId}:${listing.listingId}`;
            if (alertsSent.has(alertKey)) continue;
            if (matchesSearch(listing, search)) {
              alertsSent.add(alertKey);
              await onProactiveMatch(search.userId, [listing], search.query);
            }
          }
        }
        if (alertsSent.size > 0) console.log(`[BG] Sent ${alertsSent.size} proactive alerts`);
      } catch (e) { console.log('[BG] Proactive match error:', e.message); }
    }

  } catch (e) {
    console.error('[BG] Scrape error:', e.message);
    if (browser) await browser.close().catch(() => {});
  }
}
