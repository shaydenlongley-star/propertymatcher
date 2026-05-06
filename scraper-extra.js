// Scrapes owner-only listings from DDProperty and Hipflat (no login required)
// Uses __NEXT_DATA__ JSON extraction (reliable for Next.js apps) + DOM fallback
import { chromium } from 'playwright';

const AGENT_KEYWORDS = [
  'agent', 'broker', 'agency', 'commission', 'co-broke', 'co-agent',
  'property scout', 'propertyscout', 're/max', 'remax', 'century 21',
  'cbre', 'colliers', 'knight frank', 'jll', 'savills',
  'ddproperty', 'fazwaz', 'hipflat', 'lazudi', 'dot property', 'baania',
];

function isAgentText(text) {
  const lower = (text || '').toLowerCase();
  return AGENT_KEYWORDS.some(k => lower.includes(k));
}

function extractPriceNum(raw) {
  if (!raw) return 0;
  const t = String(raw).replace(/,/g, '');
  // Already a number
  if (typeof raw === 'number' && raw >= 3000 && raw <= 500000) return raw;
  const m = t.match(/([\d]+)\s*(?:THB|฿|baht)/i)
          || t.match(/฿\s*([\d]+)/)
          || t.match(/([\d]+)\s*\/\s*(?:month|mo)/i)
          || t.match(/^([\d]+)$/);
  if (m) {
    const n = parseInt(m[1]);
    if (n >= 3000 && n <= 500000) return n;
    // Might be in thousands — e.g. "25" meaning 25k
    if (n >= 3 && n <= 500) return n * 1000;
  }
  return 0;
}

// Deep-search an object for a key (handles nested JSON with unknown structure)
function deepFind(obj, keys, maxDepth = 5) {
  if (!obj || typeof obj !== 'object' || maxDepth === 0) return undefined;
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  for (const val of Object.values(obj)) {
    const found = deepFind(val, keys, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Extract a listings array from __NEXT_DATA__ by trying common key paths
function extractListingsFromNextData(nextData) {
  if (!nextData) return null;
  // Common paths across DDProperty, Hipflat, etc.
  const listingKeys = ['listings', 'results', 'items', 'properties', 'units', 'data'];
  const found = deepFind(nextData?.props?.pageProps, listingKeys, 6);
  if (Array.isArray(found) && found.length > 0) return found;
  return null;
}

// Normalise a raw listing object from __NEXT_DATA__ into our format
function normaliseNextDataListing(item, source, idPrefix) {
  const title = item.name || item.title || item.projectName || item.building || '';
  const priceRaw = item.price || item.priceMonthly || item.monthlyPrice || item.rentPrice || item.rent || 0;
  const priceNum = extractPriceNum(priceRaw);
  const beds = item.bedrooms || item.bedroom || item.beds || item.numBedroom || null;
  const bedrooms = beds === 'Studio' || beds === 0 ? 0 : parseInt(beds) || null;
  const location = item.address || item.area || item.district || item.location || item.suburb || '';
  const img = item.photos?.[0]?.url || item.images?.[0]?.url || item.photo || item.image || item.coverPhoto || '';
  const url = item.url || item.link || item.listingUrl || '';
  const isPrivate = (item.listingType || item.type || '').toLowerCase().includes('owner')
                 || (item.listingType || item.type || '').toLowerCase().includes('private');
  const rawId = item.id || item.listingId || item.propertyId || item.unitId || '';

  if (!title || isAgentText(title + ' ' + location)) return null;
  if (!priceNum && !title) return null;

  return {
    title,
    price: priceNum ? `${priceNum} THB/month` : String(priceRaw),
    priceNum,
    location: String(location).slice(0, 60),
    url: url.startsWith('http') ? url : '',
    photos: img ? [img] : [],
    bedrooms,
    description: `${title}. ${location}. ${priceNum ? priceNum + ' THB/month' : priceRaw}. ${bedrooms != null ? bedrooms + ' bedroom' : ''}`.trim(),
    ownerConfirmed: isPrivate,
    source,
    listingId: idPrefix + '_' + (rawId || Math.random().toString(36).slice(2, 8)),
  };
}

async function scrapeDDProperty(browser) {
  const listings = [];
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  try {
    console.log('[EXTRA] Scraping DDProperty...');
    // listing_type=owner restricts to private/owner-listed properties only
    await page.goto(
      'https://www.ddproperty.com/en/property-for-rent?freetext=Bangkok&listing_type=owner&property_type_code[]=CONDO&property_type_code[]=APT&bedroom[]=1&bedroom[]=2&bedroom[]=3',
      { waitUntil: 'domcontentloaded', timeout: 35000 }
    );
    await page.waitForTimeout(4000);

    // Strategy 1: __NEXT_DATA__ JSON (most reliable for Next.js apps)
    const nextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
      } catch { return null; }
    });

    const jsonListings = extractListingsFromNextData(nextData);
    if (jsonListings) {
      console.log(`[EXTRA] DDProperty: found ${jsonListings.length} listings via __NEXT_DATA__`);
      for (const item of jsonListings.slice(0, 60)) {
        const l = normaliseNextDataListing(item, 'ddproperty', 'ddp');
        if (l) listings.push(l);
      }
    }

    // Strategy 2: DOM extraction (fallback if JSON approach yields nothing)
    if (listings.length === 0) {
      console.log('[EXTRA] DDProperty: falling back to DOM extraction');
      const items = await page.evaluate(() => {
        const results = [];
        // Try multiple possible card selectors
        const selectors = [
          '[data-automation-id="listing-card"]',
          '[class*="ListingCard"]',
          '[class*="listing-card"]',
          'article[class]',
          '[class*="PropertyCard"]',
        ];
        let cards = [];
        for (const sel of selectors) {
          cards = Array.from(document.querySelectorAll(sel));
          if (cards.length > 2) break;
        }

        for (const card of cards.slice(0, 50)) {
          const allText = card.innerText || '';
          // Skip agent-labeled cards
          if (/\b(agent|broker|agency)\b/i.test(allText) &&
              !/\b(private|owner|by owner)\b/i.test(allText)) continue;

          // Title: try data attribute, then headings
          const title = card.querySelector('[data-automation-id*="title"], [data-testid*="title"], h2, h3')?.innerText?.trim()
                     || card.querySelector('a[href*="/property-for-rent/"] span')?.innerText?.trim()
                     || '';
          // Price: look for THB or ฿
          const priceEl = card.querySelector('[data-automation-id*="price"], [class*="price"], [class*="Price"]');
          const price = priceEl?.innerText?.trim() || '';
          // Location
          const locEl = card.querySelector('[data-automation-id*="location"], [class*="location"], [class*="Location"], [class*="address"]');
          const location = locEl?.innerText?.trim() || '';
          // Link
          const link = card.querySelector('a[href*="/property-for-rent/"], a[href*="/en/"]')?.href || '';
          // Photo
          const img = card.querySelector('img[src*="http"]:not([src*="icon"]):not([src*="logo"])')?.src || '';
          // Beds
          const bedText = card.querySelector('[data-automation-id*="bed"], [class*="bed"], [class*="Bed"]')?.innerText?.trim() || '';
          // Private label
          const isPrivate = /private|by owner|\bowner\b/i.test(allText);

          if (title || link) results.push({ title, price, location, link, img, bedText, isPrivate });
        }
        return results;
      });

      for (const item of items) {
        if (!item.title || isAgentText(item.title + ' ' + item.location)) continue;
        const priceNum = extractPriceNum(item.price);
        const bedMatch = item.bedText.match(/(\d+)/);
        const bedrooms = /studio/i.test(item.bedText) ? 0 : (bedMatch ? parseInt(bedMatch[1]) : null);
        const idMatch = item.link.match(/(\d{5,})/);
        listings.push({
          title: item.title,
          price: priceNum ? `${priceNum} THB/month` : item.price,
          priceNum,
          location: item.location.slice(0, 60),
          url: item.link,
          photos: item.img ? [item.img] : [],
          bedrooms,
          description: `${item.title}. ${item.location}. ${item.price}. ${item.bedText}`.trim(),
          ownerConfirmed: item.isPrivate,
          source: 'ddproperty',
          listingId: 'ddp_' + (idMatch?.[1] || Math.random().toString(36).slice(2, 8)),
        });
      }
    }

    // Strategy 3: network intercept — some sites load listings via XHR
    // (already fetched above; if still 0, the site is blocking us)
    if (listings.length === 0) {
      console.log('[EXTRA] DDProperty: 0 results — may be bot-blocked');
    } else {
      console.log(`[EXTRA] DDProperty: ${listings.length} owner listings`);
    }
  } catch (e) {
    console.log('[EXTRA] DDProperty error:', e.message);
  } finally {
    await page.close();
  }
  return listings;
}

async function scrapeHipflat(browser) {
  const listings = [];
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  try {
    console.log('[EXTRA] Scraping Hipflat...');
    await page.goto('https://www.hipflat.com/en/search/rent?type=condo&place=bangkok', {
      waitUntil: 'domcontentloaded', timeout: 35000
    });
    await page.waitForTimeout(4000);

    // Strategy 1: __NEXT_DATA__
    const nextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
      } catch { return null; }
    });

    const jsonListings = extractListingsFromNextData(nextData);
    if (jsonListings) {
      console.log(`[EXTRA] Hipflat: found ${jsonListings.length} listings via __NEXT_DATA__`);
      for (const item of jsonListings.slice(0, 60)) {
        const l = normaliseNextDataListing(item, 'hipflat', 'hf');
        if (l) listings.push(l);
      }
    }

    // Strategy 2: DOM fallback
    if (listings.length === 0) {
      console.log('[EXTRA] Hipflat: falling back to DOM extraction');
      const items = await page.evaluate(() => {
        const results = [];
        const selectors = [
          '[class*="UnitCard"]', '[class*="ListingCard"]', '[class*="PropertyCard"]',
          '[class*="listing-card"]', '[class*="property-card"]', 'article[class]',
        ];
        let cards = [];
        for (const sel of selectors) {
          cards = Array.from(document.querySelectorAll(sel));
          if (cards.length > 2) break;
        }

        for (const card of cards.slice(0, 50)) {
          const allText = card.innerText || '';
          if (/\b(agent|broker|agency)\b/i.test(allText) &&
              !/\b(private|owner|by owner)\b/i.test(allText)) continue;

          const title = card.querySelector('h2, h3, [class*="title"], [class*="name"]')?.innerText?.trim() || '';
          const price = card.querySelector('[class*="price"], [class*="Price"]')?.innerText?.trim() || '';
          const location = card.querySelector('[class*="location"], [class*="area"], [class*="address"]')?.innerText?.trim() || '';
          const link = card.querySelector('a[href]')?.href || '';
          const img = card.querySelector('img[src*="http"]:not([src*="icon"])')?.src || '';
          const details = card.querySelector('[class*="detail"], [class*="spec"], [class*="info"], [class*="attr"]')?.innerText?.trim() || '';
          const isPrivate = /private|by owner|\bowner\b/i.test(allText);
          if (title && link) results.push({ title, price, location, link, img, details, isPrivate });
        }
        return results;
      });

      for (const item of items) {
        if (!item.title || isAgentText(item.title + ' ' + item.location)) continue;
        const priceNum = extractPriceNum(item.price);
        const bedMatch = (item.details + item.title).match(/(\d+)\s*(?:bed|BR)/i);
        const bedrooms = /studio/i.test(item.details + item.title) ? 0 : (bedMatch ? parseInt(bedMatch[1]) : null);
        const idMatch = item.link.match(/(\d{5,})/);
        listings.push({
          title: item.title,
          price: priceNum ? `${priceNum} THB/month` : item.price,
          priceNum,
          location: item.location.slice(0, 60),
          url: item.link.startsWith('http') ? item.link : 'https://www.hipflat.com' + item.link,
          photos: item.img ? [item.img] : [],
          bedrooms,
          description: `${item.title}. ${item.location}. ${item.price}. ${item.details}`.trim(),
          ownerConfirmed: item.isPrivate,
          source: 'hipflat',
          listingId: 'hf_' + (idMatch?.[1] || Math.random().toString(36).slice(2, 8)),
        });
      }
    }

    if (listings.length === 0) console.log('[EXTRA] Hipflat: 0 results');
    else console.log(`[EXTRA] Hipflat: ${listings.length} listings (excl. agents)`);
  } catch (e) {
    console.log('[EXTRA] Hipflat error:', e.message);
  } finally {
    await page.close();
  }
  return listings;
}

// Baania — Thai property portal with owner listings
async function scrapeBaania(browser) {
  const listings = [];
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  try {
    console.log('[EXTRA] Scraping Baania...');
    await page.goto('https://www.baania.com/en/property/for-rent/condo/bangkok', {
      waitUntil: 'domcontentloaded', timeout: 35000
    });
    await page.waitForTimeout(4000);

    // Try __NEXT_DATA__ first
    const nextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
      } catch { return null; }
    });

    const jsonListings = extractListingsFromNextData(nextData);
    if (jsonListings) {
      console.log(`[EXTRA] Baania: found ${jsonListings.length} via __NEXT_DATA__`);
      for (const item of jsonListings.slice(0, 60)) {
        const l = normaliseNextDataListing(item, 'baania', 'ban');
        if (l) listings.push(l);
      }
    }

    // DOM fallback
    if (listings.length === 0) {
      const items = await page.evaluate(() => {
        const results = [];
        const cards = Array.from(document.querySelectorAll('[class*="card"], [class*="Card"], article')).slice(0, 50);
        for (const card of cards) {
          const allText = card.innerText || '';
          if (allText.length < 20) continue;
          if (/\b(agent|broker|agency)\b/i.test(allText)) continue;
          const title = card.querySelector('h2, h3, [class*="title"], [class*="name"]')?.innerText?.trim() || '';
          const price = card.querySelector('[class*="price"], [class*="Price"]')?.innerText?.trim() || '';
          const location = card.querySelector('[class*="location"], [class*="area"], [class*="address"]')?.innerText?.trim() || '';
          const link = card.querySelector('a[href]')?.href || '';
          const img = card.querySelector('img[src*="http"]')?.src || '';
          if (title && link) results.push({ title, price, location, link, img });
        }
        return results;
      });

      for (const item of items) {
        if (!item.title || isAgentText(item.title + ' ' + item.location)) continue;
        const priceNum = extractPriceNum(item.price);
        const bedMatch = item.title.match(/(\d+)\s*(?:bed|BR)/i);
        const bedrooms = /studio/i.test(item.title) ? 0 : (bedMatch ? parseInt(bedMatch[1]) : null);
        const idMatch = item.link.match(/(\d{5,})/);
        listings.push({
          title: item.title,
          price: priceNum ? `${priceNum} THB/month` : item.price,
          priceNum,
          location: item.location.slice(0, 60),
          url: item.link.startsWith('http') ? item.link : 'https://www.baania.com' + item.link,
          photos: item.img ? [item.img] : [],
          bedrooms,
          description: `${item.title}. ${item.location}. ${item.price}`.trim(),
          ownerConfirmed: false,
          source: 'baania',
          listingId: 'ban_' + (idMatch?.[1] || Math.random().toString(36).slice(2, 8)),
        });
      }
    }

    if (listings.length > 0) console.log(`[EXTRA] Baania: ${listings.length} listings`);
    else console.log('[EXTRA] Baania: 0 results');
  } catch (e) {
    console.log('[EXTRA] Baania error:', e.message);
  } finally {
    await page.close();
  }
  return listings;
}

export async function scrapeExtraSources() {
  const browser = await chromium.launch({ headless: true });
  try {
    const [ddp, hf, ban] = await Promise.all([
      scrapeDDProperty(browser),
      scrapeHipflat(browser),
      scrapeBaania(browser),
    ]);
    const all = [...ddp, ...hf, ...ban];
    console.log(`[EXTRA] Total: ${all.length} listings from external sources`);
    return all;
  } finally {
    await browser.close();
  }
}
