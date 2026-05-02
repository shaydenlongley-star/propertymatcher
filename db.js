import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'listings-db.json');
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');

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

export function addListings(newListings) {
  const db = getDB();
  const existingIds = new Set(db.listings.map(l => l.listingId).filter(Boolean));
  let added = 0;

  for (const l of newListings) {
    if (!l.listingId || existingIds.has(l.listingId)) continue;
    existingIds.add(l.listingId);
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

export function searchDB(query, filters = {}) {
  const db = getDB();
  const { bedrooms, maxPrice } = filters;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days

  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  return db.listings
    .filter(l => {
      if (!l.addedAt || new Date(l.addedAt).getTime() < cutoff) return false;
      if (bedrooms && l.bedrooms != null && l.bedrooms < bedrooms) return false;
      if (maxPrice && l.priceNum && l.priceNum < 500000 && l.priceNum > maxPrice) return false;
      const text = ((l.title || '') + ' ' + (l.description || '') + ' ' + (l.location || '')).toLowerCase();
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

export function logSearch({ userId, query, parsed, resultCount, source }) {
  const a = getAnalytics();
  a.searches.push({
    timestamp: new Date().toISOString(),
    userId, query, source,
    area: parsed?.location,
    bedrooms: parsed?.bedrooms,
    budget: parsed?.budget,
    resultCount,
  });
  if (a.searches.length > 10000) a.searches = a.searches.slice(-5000);
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
