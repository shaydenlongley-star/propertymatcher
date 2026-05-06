// Scrapes owner-only listings from DDProperty and Hipflat
import { chromium } from 'playwright';

const AGENT_KEYWORDS = [
  'agent', 'broker', 'agency', 'commission', 'co-broke',
  'property scout', 'propertyscout', 're/max', 'remax', 'century 21',
  'cbre', 'colliers', 'knight frank', 'jll', 'savills',
  'ddproperty', 'fazwaz', 'hipflat', 'lazudi', 'dot property',
];

function isAgentText(text) {
  const lower = (text || '').toLowerCase();
  return AGENT_KEYWORDS.some(k => lower.includes(k));
}

function extractPriceNum(text) {
  if (!text) return 0;
  const t = text.replace(/,/g, '');
  const m = t.match(/([\d]+)\s*(?:THB|฿|baht)/i)
          || t.match(/฿\s*([\d]+)/)
          || t.match(/([\d]+)\s*\/\s*(?:month|mo)/i);
  if (m) {
    const n = parseInt(m[1]);
    // DDProperty sometimes shows yearly or total price — skip those
    if (n >= 3000 && n <= 500000) return n;
  }
  return 0;
}

// DDProperty: use listing_type=owner to only get owner/private listings
async function scrapeDDProperty(browser) {
  const listings = [];
  const page = await browser.newPage();
  try {
    console.log('[EXTRA] Scraping DDProperty (owner listings)...');
    // listing_type=owner restricts to private/owner-listed properties
    await page.goto(
      'https://www.ddproperty.com/en/property-for-rent?freetext=Bangkok&listing_type=owner&property_type_code[]=CONDO&property_type_code[]=APT',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForTimeout(3500);

    const items = await page.evaluate(() => {
      const results = [];
      // DDProperty uses data-automation-id on listing cards
      const cards = Array.from(document.querySelectorAll('[data-automation-id="listing-card"]'));
      // Fallback: any article or div with a prominent link to a listing URL
      const fallback = cards.length ? cards : Array.from(document.querySelectorAll('article, [class*="ListingCard"], [class*="listing-card"]'));

      for (const card of fallback.slice(0, 40)) {
        const title = (
          card.querySelector('[data-automation-id="listing-title"], h2, h3, [class*="title"]')?.innerText || ''
        ).trim();
        const priceEl = card.querySelector('[data-automation-id="listing-price"], [class*="price"]');
        const price = priceEl?.innerText?.trim() || '';
        const locationEl = card.querySelector('[data-automation-id="listing-location"], [class*="location"], [class*="address"]');
        const location = locationEl?.innerText?.trim() || '';
        const link = card.querySelector('a[href*="/property-for-rent/"]')?.href
                  || card.querySelector('a')?.href || '';
        const img = card.querySelector('img[src*="http"]')?.src || '';
        const bedsEl = card.querySelector('[data-automation-id="listing-bedroom"], [class*="bed"]');
        const beds = bedsEl?.innerText?.trim() || '';
        // Check for agent badge — DDProperty marks private listings "Private" or "By Owner"
        const badges = Array.from(card.querySelectorAll('[class*="badge"], [class*="tag"], [class*="label"]'))
          .map(b => b.innerText?.trim().toLowerCase()).join(' ');
        const isPrivate = badges.includes('private') || badges.includes('owner') || badges.includes('by owner');
        const isAgent = badges.includes('agent') || badges.includes('agency') || badges.includes('broker');
        if (isAgent) continue;

        if (title && link) results.push({ title, price, location, link, img, beds, isPrivate });
      }
      return results;
    });

    for (const item of items) {
      if (isAgentText(item.title + ' ' + item.location)) continue;
      const priceNum = extractPriceNum(item.price);
      const bedMatch = item.beds.match(/(\d+)/);
      const bedrooms = /studio/i.test(item.beds) ? 0 : (bedMatch ? parseInt(bedMatch[1]) : null);
      const listingIdMatch = item.link.match(/(\d{6,})/);
      listings.push({
        title: item.title,
        price: priceNum ? `${priceNum} THB/month` : item.price,
        priceNum,
        location: item.location,
        url: item.link,
        photos: item.img ? [item.img] : [],
        bedrooms,
        description: `${item.title}. ${item.location}. ${item.price}. ${item.beds}`,
        ownerConfirmed: item.isPrivate,
        source: 'ddproperty',
        listingId: 'ddp_' + (listingIdMatch?.[1] || Math.random().toString(36).slice(2)),
      });
    }
    console.log(`[EXTRA] DDProperty: ${listings.length} owner listings`);
  } catch (e) {
    console.log('[EXTRA] DDProperty error:', e.message);
  } finally {
    await page.close();
  }
  return listings;
}

// Hipflat: filter by "Private" listings only
async function scrapeHipflat(browser) {
  const listings = [];
  const page = await browser.newPage();
  try {
    console.log('[EXTRA] Scraping Hipflat (owner listings)...');
    await page.goto('https://www.hipflat.com/en/search/rent?type=condo&place=bangkok', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.waitForTimeout(3500);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = Array.from(document.querySelectorAll('[class*="UnitCard"], [class*="ListingCard"], [class*="property-card"]'));
      for (const card of cards.slice(0, 40)) {
        const title = card.querySelector('h2, h3, [class*="title"], [class*="name"]')?.innerText?.trim() || '';
        const price = card.querySelector('[class*="price"]')?.innerText?.trim() || '';
        const location = card.querySelector('[class*="location"], [class*="address"], [class*="area"]')?.innerText?.trim() || '';
        const link = card.querySelector('a[href]')?.href || '';
        const img = card.querySelector('img[src*="http"]')?.src || '';
        const details = card.querySelector('[class*="detail"], [class*="spec"], [class*="info"]')?.innerText?.trim() || '';
        // Detect agent label
        const allText = card.innerText?.toLowerCase() || '';
        const isAgent = /\bagent\b|\bbroker\b|\bagency\b/.test(allText);
        const isPrivate = /\bprivate\b|\bby owner\b|\bowner\b/.test(allText);
        if (isAgent) continue;
        if (title && link) results.push({ title, price, location, link, img, details, isPrivate });
      }
      return results;
    });

    for (const item of items) {
      if (isAgentText(item.title + ' ' + item.location)) continue;
      const priceNum = extractPriceNum(item.price);
      const bedMatch = (item.details + item.title).match(/(\d+)\s*(?:bed|BR)/i);
      const bedrooms = /studio/i.test(item.details + item.title) ? 0 : (bedMatch ? parseInt(bedMatch[1]) : null);
      const listingIdMatch = item.link.match(/(\d{5,})/);
      listings.push({
        title: item.title,
        price: priceNum ? `${priceNum} THB/month` : item.price,
        priceNum,
        location: item.location,
        url: item.link.startsWith('http') ? item.link : 'https://www.hipflat.com' + item.link,
        photos: item.img ? [item.img] : [],
        bedrooms,
        description: `${item.title}. ${item.location}. ${item.price}. ${item.details}`,
        ownerConfirmed: item.isPrivate,
        source: 'hipflat',
        listingId: 'hf_' + (listingIdMatch?.[1] || Math.random().toString(36).slice(2)),
      });
    }
    console.log(`[EXTRA] Hipflat: ${listings.length} listings (excl. agents)`);
  } catch (e) {
    console.log('[EXTRA] Hipflat error:', e.message);
  } finally {
    await page.close();
  }
  return listings;
}

export async function scrapeExtraSources() {
  const browser = await chromium.launch({ headless: true });
  try {
    const [ddp, hf] = await Promise.all([
      scrapeDDProperty(browser),
      scrapeHipflat(browser),
    ]);
    return [...ddp, ...hf];
  } finally {
    await browser.close();
  }
}
