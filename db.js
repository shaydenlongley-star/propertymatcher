import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'listings-db.json');
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');
const MISSED_QUERIES_FILE = path.join(__dirname, 'missed-queries.json');
const WEIGHTS_FILE = path.join(__dirname, 'scoring-weights.json');

let _db = null;
let _analytics = null;

function getDB() {
  if (!_db) {
    _db = fs.existsSync(DB_FILE)
      ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
      : { listings: [] };
  }
  return _db;
}

function getAnalytics() {
  if (!_analytics) {
    _analytics = fs.existsSync(ANALYTICS_FILE)
      ? JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'))
      : { searches: [] };
  }
  return _analytics;
}

function extractPriceFromText(text) {
  if (!text) return 0;
  const t = text.replace(/,/g, '');
  const patterns = [
    // Thai: ราคา X บาท/เดือน or ให้เช่า X บาท
    /(?:ราคา|ให้เช่า|เช่า)[^\d]{0,10}([\d]+)\s*(?:บาท|thb|฿)/i,
    // rent/rental X baht/THB/฿ per month
    /(?:rent|rental)[^\d]{0,10}([\d]+)\s*(?:baht|thb|฿)(?:[^\d]{0,10}(?:month|เดือน))?/i,
    // ฿ X /month or ฿X
    /฿\s*([\d]+)(?:\s*\/\s*(?:month|mo|เดือน))?/i,
    // X THB/month or X baht/month
    /([\d]+)\s*(?:thb|baht|บาท)\s*(?:\/|\s*per\s*)?\s*(?:month|mo|เดือน)/i,
    // X /month
    /([\d]+)\s*\/\s*(?:month|mo)\b/i,
    // Xk/month or Xk per month (e.g. 25k/month)
    /([\d]+)k\s*(?:\/|\s*per\s*)?\s*(?:month|mo)\b/i,
    // Plain X THB or X baht (last resort)
    /([\d]+)\s*(?:thb|baht|บาท)/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      let val = parseInt(m[1]);
      if (p.source.includes('k\\s*')) val *= 1000;
      if (val >= 3000 && val <= 500000) return val;
    }
  }
  return 0;
}

function extractBedroomsFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(?:studio|สตูดิโอ)\b/.test(t)) return 0;
  const patterns = [
    /(\d+)\s*(?:bed(?:room)?s?|ห้องนอน|นอน\b|br\b|bdr)/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const n = parseInt(m[1]);
      if (n >= 0 && n <= 6) return n;
    }
  }
  return null;
}

function extractLocationFromText(text) {
  if (!text) return '';
  const BKK_AREAS = [
    'Sukhumvit', 'Silom', 'Sathorn', 'Thonglor', 'Ekkamai', 'Asok', 'Asoke',
    'Phrom Phong', 'On Nut', 'Nana', 'Ari', 'Ratchada', 'Ladprao', 'Bearing',
    'Udom Suk', 'Phra Khanong', 'Bang Na', 'Narathiwas', 'Chit Lom', 'Siam',
    'Ratchadamri', 'Sala Daeng', 'Lumpini', 'Pratunam', 'Klong Toei', 'Chatuchak',
    'Victory Monument', 'Mo Chit', 'Lat Phrao', 'Don Mueang', 'Minburi',
    'Rama 9', 'Rama 4', 'Rama 3', 'Rajadamri', 'Langsuan', 'Wireless Road',
    'Ploenchit', 'Chidlom',
  ];
  const t = text;
  for (const area of BKK_AREAS) {
    const re = new RegExp(area, 'i');
    if (re.test(t)) return area;
  }
  // Try BTS/MRT station mention
  const transitM = t.match(/(?:BTS|MRT)\s+([\w\s]+?)(?:\s*station|\s*,|\s*\n|$)/i);
  if (transitM) return transitM[0].trim().slice(0, 40);
  return '';
}

export function reprocessListings() {
  const db = getDB();
  let fixed = 0;
  for (const l of db.listings) {
    const text = (l.title || '') + ' ' + (l.description || '');
    let changed = false;
    // Re-extract price if missing
    if (!l.priceNum || l.priceNum === 0) {
      const p = extractPriceFromText(text);
      if (p) { l.priceNum = p; l.price = `${p} THB/month`; changed = true; }
    }
    // Re-extract bedrooms if missing
    if (l.bedrooms == null) {
      const b = extractBedroomsFromText(text);
      if (b != null) { l.bedrooms = b; changed = true; }
    }
    // Re-extract location if missing or garbage
    if (!l.location || l.location.length > 60 || /(?:property|real estate|expat|group|posted|owner post)/i.test(l.location)) {
      const loc = extractLocationFromText(text);
      l.location = loc || ''; // clear garbage even if we can't find a better one
      changed = true;
    }
    if (changed) fixed++;
  }
  _db = db;
  db.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  console.log(`[DB] Reprocessed ${db.listings.length} listings — fixed ${fixed}`);
  return fixed;
}

function stripContactInfo(text) {
  if (!text) return text;
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(?:\+?66|0)\s?\d[\d\s\-\.]{7,12}\d/g, '')
    .replace(/\b0[689]\d[\d\-\s\.]{7,10}\b/g, '')
    .replace(/\b\d{10}\b/g, '')
    .replace(/(?:line\s*(?:id|oa)?|ไลน์|line\s*:)\s*[@\w.\-]+/gi, '')
    .replace(/(?:wechat|wc|微信)\s*[:\-]?\s*\S+/gi, '')
    .replace(/@[\w.\-]+/g, '')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '')
    .replace(/(?:tel|phone|call|whatsapp|wa|contact|mobile|ติดต่อ|โทร)[^\n]{0,80}/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function addListings(newListings) {
  const db = getDB();
  const existingIds = new Set(db.listings.map(l => l.listingId).filter(Boolean));
  let added = 0;

  const JUNK = ['iphone','ipad','samsung','laptop','macbook','tablet','android','meitu','airpods','for sale','selling','sell as','second hand','sailor moon','motorcycle','scooter','restaurant','hiring','vacancy','bangkok expats','join the ai','desperately seeking','real estate group','sofa','sofa bed','l-shape','couch','furniture','mattress','wardrobe','appliance','real estate agent','property agent','rental agent','listing agent','agent fee','agency fee','real estate broker','property broker','customer agent','real estate consultant','property consultant','specialist in real estate','consultant for','please contact us','for customer','นายหน้า','ตัวแทน','our team','our agency','our company','were misusing this feature','going too fast','this content isn\'t available','something went wrong','this page isn\'t available','log in to facebook','link you followed may be broken'];
  const PROP = ['condo','apartment','house','villa','studio','bedroom','bed','sqm','rent','lease','furnished','ห้องนอน','คอนโด','อพาร์ทเมนท์','บ้าน','ให้เช่า','เช่า','bts','mrt','flat','floor'];
  // Garbage exact titles from FB error/notification pages
  const GARBAGE_TITLES = new Set(['home', 'notifications', 'marketplace', 'groups', 'watch', 'menu', 'log in', 'sign up', 'facebook']);

  for (let l of newListings) {
    if (!l.listingId || existingIds.has(l.listingId)) continue;
    // Reject FB error pages saved as listings
    const rawTitle = (l.title || '').toLowerCase().trim();
    if (GARBAGE_TITLES.has(rawTitle) || rawTitle.length < 5) continue;
    const text = ((l.title||'') + ' ' + (l.description||'')).toLowerCase();
    if (JUNK.some(k => text.includes(k))) continue;
    if (!PROP.some(k => text.includes(k))) continue;
    if (l.priceNum && l.priceNum < 3000) continue;
    existingIds.add(l.listingId);
    // Strip contact info from description before storing
    if (l.description) l = { ...l, description: stripContactInfo(l.description) };
    // Enrich on ingest
    if (!l.priceNum || l.priceNum === 0) { const p = extractPriceFromText(text); if (p) { l = { ...l, priceNum: p, price: `${p} THB/month` }; } }
    if (l.bedrooms == null) { const b = extractBedroomsFromText(text); if (b != null) l = { ...l, bedrooms: b }; }
    if (!l.location || l.location.length > 60) { const loc = extractLocationFromText(text); if (loc) l = { ...l, location: loc }; }
    db.listings.push({ ...l, addedAt: new Date().toISOString() });
    added++;
  }

  // Keep only newest 5000
  if (db.listings.length > 5000) db.listings = db.listings.slice(-5000);
  db.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  if (added > 0) console.log(`DB: +${added} new listings (total ${db.listings.length})`);
  return added;
}

const BANGKOK_SIGNALS = [
  'bangkok', 'กรุงเทพ', 'sukhumvit', 'สุขุมวิท', 'silom', 'สีลม', 'sathorn', 'สาทร',
  'thonglor', 'ทองหล่อ', 'ekkamai', 'เอกมัย', 'asok', 'อโศก', 'phrom phong', 'พร้อมพงษ์',
  'on nut', 'อ่อนนุช', 'nana', 'นานา', 'ari', 'อารีย์', 'ratchada', 'รัชดา',
  'ladprao', 'ลาดพร้าว', 'bearing', 'udom suk', 'victory monument', 'chatuchak', 'จตุจักร',
  'siam', 'สยาม', 'chit lom', 'ชิดลม', 'ratchadamri', 'sala daeng', 'lumpini', 'ลุมพินี',
  'rama ', 'pratunam', 'klong toei', 'คลองเตย', 'phra khanong', 'พระโขนง', 'bang na', 'บางนา',
  'narathiwas', 'nonthaburi', 'นนทบุรี', 'pathum thani', 'ปทุมธานี', 'samut prakan', 'สมุทรปราการ',
  'lat krabang', 'lat phrao', 'min buri', 'don mueang', 'bts', 'mrt', 'รถไฟฟ้า',
  '10110', '10120', '10130', '10140', '10150', '10160', '10170',
  '10200', '10210', '10230', '10240', '10260', '10310', '10400', '10500', '10600',
];

const NON_BANGKOK = ['phuket', 'ภูเก็ต', 'pattaya', 'พัทยา', 'chiangmai', 'chiang mai', 'เชียงใหม่',
  'hua hin', 'หัวหิน', 'khon kaen', 'ขอนแก่น', 'kata', 'karon', 'samui', 'สมุย'];

export function searchDB(query, filters = {}) {
  const db = getDB();
  const { bedrooms, maxPrice, location } = filters;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const locTerms = location
    ? location.toLowerCase().split(/[\s,\/\-]+/).filter(t => t.length > 3)
    : [];

  return db.listings
    .filter(l => {
      if (!l.addedAt || new Date(l.addedAt).getTime() < cutoff) return false;
      if (bedrooms && l.bedrooms != null && l.bedrooms !== bedrooms) return false;
      if (maxPrice && l.priceNum && l.priceNum < 500000 && l.priceNum > maxPrice) return false;
      const text = ((l.title || '') + ' ' + (l.description || '') + ' ' + (l.location || '')).toLowerCase();
      // Hard reject: clearly non-Bangkok
      if (NON_BANGKOK.some(k => text.includes(k))) return false;
      // Hard location requirement: if agent specified an area, listing MUST mention it
      if (locTerms.length > 0 && !locTerms.some(t => text.includes(t))) return false;
      return terms.some(t => text.includes(t));
    })
    .map(l => {
      const text = ((l.title || '') + ' ' + (l.description || '')).toLowerCase();
      let score = terms.filter(t => text.includes(t)).length;
      if (l.ownerConfirmed) score += 3;
      if (bedrooms && l.bedrooms === bedrooms) score += 3;
      return { ...l, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function getDBStats() {
  const db = getDB();
  return { total: db.listings.length, lastUpdated: db.lastUpdated };
}

export function getRecentSearches(hours = 48) {
  const a = getAnalytics();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return a.searches.filter(s => s.userId && new Date(s.timestamp).getTime() > cutoff && s.parsedFull);
}

export function logSearch({ userId, query, parsed, parsedFull, resultCount, source }) {
  const a = getAnalytics();
  a.searches.push({
    timestamp: new Date().toISOString(),
    userId, query, source,
    area: parsed?.location,
    bedrooms: parsed?.bedrooms,
    budget: parsed?.budget,
    parsedFull: parsedFull || parsed,
    resultCount,
  });
  if (a.searches.length > 10000) a.searches = a.searches.slice(-5000);
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(a));
}

export function logMissedQuery(query) {
  let data = {};
  if (fs.existsSync(MISSED_QUERIES_FILE)) { try { data = JSON.parse(fs.readFileSync(MISSED_QUERIES_FILE, 'utf8')); } catch {} }
  data[query] = (data[query] || 0) + 1;
  fs.writeFileSync(MISSED_QUERIES_FILE, JSON.stringify(data, null, 2));
}

export function getMissedQueries() {
  if (!fs.existsSync(MISSED_QUERIES_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(MISSED_QUERIES_FILE, 'utf8'));
    return Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([q]) => q);
  } catch { return []; }
}

export function clearMissedQuery(query) {
  if (!fs.existsSync(MISSED_QUERIES_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(MISSED_QUERIES_FILE, 'utf8'));
    delete data[query];
    fs.writeFileSync(MISSED_QUERIES_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

export function removeStaleListings(daysOld = 14) {
  const db = getDB();
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const before = db.listings.length;
  db.listings = db.listings.filter(l => !l.addedAt || new Date(l.addedAt).getTime() > cutoff);
  const removed = before - db.listings.length;
  if (removed > 0) {
    _db = db;
    db.lastUpdated = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    console.log(`[DB] Removed ${removed} stale listings (${db.listings.length} remaining)`);
  }
  return removed;
}

export function deduplicateByPhotos() {
  const db = getDB();
  const seenPhotos = new Set();
  const before = db.listings.length;
  db.listings = db.listings.filter(l => {
    if (!l.photos?.length) return true;
    const key = l.photos[0];
    if (seenPhotos.has(key)) return false;
    seenPhotos.add(key);
    return true;
  });
  const removed = before - db.listings.length;
  if (removed > 0) {
    _db = db;
    db.lastUpdated = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    console.log(`[DB] Removed ${removed} photo duplicates`);
  }
  return removed;
}

export function getDemandStats() {
  const a = getAnalytics();
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = a.searches.filter(s => new Date(s.timestamp) > since);
  const areas = {}, beds = {};
  for (const s of recent) {
    if (s.area) areas[s.area] = (areas[s.area] || 0) + 1;
    if (s.bedrooms) beds[s.bedrooms] = (beds[s.bedrooms] || 0) + 1;
  }
  return {
    topAreas: Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([area, count]) => ({ area, count })),
    topBedrooms: Object.entries(beds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([b, count]) => ({ beds: +b, count })),
  };
}

export function getScoringWeights() {
  if (fs.existsSync(WEIGHTS_FILE)) { try { return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch {} }
  return { budgetCeiling: 1.5, locationPenalty: 5, ownerBonus: 3, bedroomBonus: 3, photoPenalty: 2 };
}

export function saveScoringWeights(weights) {
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(weights, null, 2));
  console.log('[DB] Scoring weights updated:', weights);
}

export function logQuickReply(action) {
  const a = getAnalytics();
  if (!a.quickReplies) a.quickReplies = {};
  a.quickReplies[action] = (a.quickReplies[action] || 0) + 1;
  _analytics = a;
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(a));
}

export function getAnalyticsReport() {
  const a = getAnalytics();
  const last30 = a.searches.filter(s => new Date(s.timestamp) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const areas = {};
  const budgets = [];
  for (const s of last30) {
    if (s.area) areas[s.area] = (areas[s.area] || 0) + 1;
    if (s.budget) budgets.push(parseInt(s.budget));
  }
  const topAreas = Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const avgBudget = budgets.length ? Math.round(budgets.reduce((a, b) => a + b, 0) / budgets.length) : null;
  return { totalSearches: last30.length, topAreas, avgBudget };
}

export function logViewingRequest(userId, listing) {
  const a = getAnalytics();
  if (!a.viewingRequests) a.viewingRequests = [];
  a.viewingRequests.push({
    timestamp: new Date().toISOString(),
    userId,
    propertyTitle: listing.title || '',
    propertyPrice: listing.price || '',
    propertyLocation: listing.location || '',
    propertyDescription: listing.description || '',
    propertyUrl: listing.url || '',
    listingId: listing.listingId || '',
    source: listing.source || 'facebook',
    status: 'pending',
  });
  if (a.viewingRequests.length > 1000) a.viewingRequests = a.viewingRequests.slice(-1000);
  _analytics = a;
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(a));
}

export function getViewingRequests() {
  const a = getAnalytics();
  return (a.viewingRequests || []).slice().reverse(); // newest first
}

export function getListingById(listingId) {
  const db = getDB();
  return db.listings.find(l => l.listingId === listingId) || null;
}

export function getViewingRequestCount() {
  const a = getAnalytics();
  return (a.viewingRequests || []).length;
}

export function updateViewingRequestStatus(timestamp, status) {
  const a = getAnalytics();
  if (!a.viewingRequests) return;
  const req = a.viewingRequests.find(r => r.timestamp === timestamp);
  if (req) req.status = status;
  _analytics = a;
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(a));
}

export function addManualListing(data) {
  const db = getDB();
  const listingId = 'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const text = ((data.title || '') + ' ' + (data.description || '')).toLowerCase();
  let priceNum = data.priceNum || extractPriceFromText(text);
  let bedrooms = data.bedrooms != null ? data.bedrooms : extractBedroomsFromText(text);
  let location = data.location || extractLocationFromText(text) || '';

  const safeL = {
    listingId,
    title: data.title || '',
    description: stripContactInfo(data.description || ''),
    price: priceNum ? `${priceNum} THB/month` : (data.price || ''),
    priceNum: priceNum || 0,
    bedrooms: bedrooms != null ? bedrooms : null,
    location,
    photos: Array.isArray(data.photos) ? data.photos.filter(Boolean) : [],
    ownerConfirmed: true,
    source: 'manual',
    addedAt: new Date().toISOString(),
  };

  // Owner contact stored in analytics ONLY — never leaks into search results
  if (data.ownerContact) {
    const a = getAnalytics();
    if (!a.ownerContacts) a.ownerContacts = {};
    a.ownerContacts[listingId] = { contact: data.ownerContact, addedAt: safeL.addedAt };
    _analytics = a;
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(a));
  }

  db.listings.push(safeL);
  _db = db;
  db.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  console.log(`[DB] Manual listing added: ${safeL.title} (${listingId})`);
  return listingId;
}

export function deleteManualListing(listingId) {
  const db = getDB();
  const before = db.listings.length;
  db.listings = db.listings.filter(l => l.listingId !== listingId);
  if (db.listings.length === before) return false;
  _db = db;
  db.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  const a = getAnalytics();
  if (a.ownerContacts?.[listingId]) {
    delete a.ownerContacts[listingId];
    _analytics = a;
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(a));
  }
  console.log(`[DB] Deleted listing ${listingId}`);
  return true;
}

export function getManualListings() {
  const db = getDB();
  const a = getAnalytics();
  return db.listings
    .filter(l => l.source === 'manual')
    .map(l => ({ ...l, ownerContact: a.ownerContacts?.[l.listingId]?.contact || null }));
}
}
