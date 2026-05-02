import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';
import * as line from '@line/bot-sdk';
import { scrapeListings } from './scraper.js';
import { addListings, searchDB, logSearch, getDBStats } from './db.js';
import { runBackgroundScrape } from './background.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = lineConfig.channelAccessToken ? new line.messagingApi.MessagingApiClient(lineConfig) : null;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Per-user state for quick reply follow-ups
const userState = new Map(); // userId → { parsed, query, allResults, offset }

const INQUIRY_KEYWORDS = ['bed', 'bedroom', 'bath', 'condo', 'house', 'apartment', 'sqm', 'budget', 'baht', '฿', 'rent', 'looking for', 'need', 'client'];

function looksLikeInquiry(text) {
  const lower = text.toLowerCase();
  return INQUIRY_KEYWORDS.filter(k => lower.includes(k)).length >= 2;
}

function extractListingId(url) {
  const m = url?.match(/\/commerce\/listing\/(\d+)/) || url?.match(/\/posts\/(\d+)/) || url?.match(/story_fbid=(\d+)/);
  return m ? m[1] : null;
}

async function parseRequirements(message) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `You are a Bangkok real estate parser. Extract property requirements and return ONLY valid JSON:
{
  "propertyType": "condo" | "house" | "apartment" | null,
  "bedrooms": number | null,
  "budget": string | null,
  "location": string | null,
  "features": string[]
}
No explanation. No markdown. Just raw JSON.`
      },
      { role: 'user', content: message }
    ]
  });
  try {
    return JSON.parse(completion.choices[0].message.content.trim());
  } catch {
    return { propertyType: null, bedrooms: null, budget: null, location: null, features: [] };
  }
}

function buildMaxPrice(parsed, multiplier = 1) {
  if (!parsed.budget) return null;
  const num = parsed.budget.replace(/,/g, '').match(/\d+/);
  if (!num) return null;
  let val = parseInt(num[0]);
  if (parsed.budget.toLowerCase().includes('k')) val *= 1000;
  return Math.round(val * 1.5 * multiplier);
}

function scoreAndFilter(listings, parsed, maxPrice) {
  const keywords = [
    ...(parsed.features || []),
    parsed.location,
    parsed.propertyType,
    parsed.bedrooms ? `${parsed.bedrooms} bed` : null
  ].filter(Boolean).map(k => k.toLowerCase());

  const budgetNum = maxPrice ? Math.round(maxPrice / 1.5) : null;

  // Deduplicate by listingId or URL
  const seen = new Set();
  const unique = listings.filter(l => {
    const id = l.listingId || l.url || l.title;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Hard bedroom filter
  const filtered = unique.filter(l => {
    if (!parsed.bedrooms) return true;
    if (l.bedrooms != null) return l.bedrooms >= parsed.bedrooms;
    const text = ((l.title || '') + ' ' + (l.description || '')).toLowerCase();
    const m = text.match(/(\d+)\s*(?:bed(?:room)?s?|ห้องนอน)/i);
    if (m) return parseInt(m[1]) >= parsed.bedrooms;
    return true; // unknown bedroom count — keep it
  });

  const scored = filtered.map(l => {
    const text = ((l.title || '') + ' ' + (l.description || '') + ' ' + (l.price || '')).toLowerCase();
    let score = 0;
    keywords.forEach(k => { if (text.includes(k)) score += 1; });
    if (l.ownerConfirmed) score += 3;
    if (parsed.bedrooms) {
      const beds = l.bedrooms ?? parseInt((text.match(/(\d+)\s*(?:bed|bedroom)/i) || [])[1]);
      if (beds) score += beds === parsed.bedrooms ? 3 : -1;
    }
    const priceNum = l.priceNum || parseInt((l.price || '').replace(/[^0-9]/g, '')) || 0;
    if (budgetNum && priceNum && priceNum < 500000) {
      if (priceNum <= budgetNum) score += 2;
      if (priceNum <= budgetNum && priceNum >= budgetNum * 0.7) score += 1;
    }
    return { ...l, score, priceNum };
  });

  scored.sort((a, b) => b.score - a.score || Math.abs(a.priceNum - (budgetNum || 0)) - Math.abs(b.priceNum - (budgetNum || 0)));
  return scored.map((l, i) => ({ ...l, bestFit: i === 0 && l.score > 0 }));
}

async function findListings(message, options = {}) {
  const { budgetMultiplier = 1, expandArea = false } = options;

  const parsed = await parseRequirements(message);

  const queryParts = [];
  if (parsed.propertyType) queryParts.push(parsed.propertyType);
  if (parsed.bedrooms) queryParts.push(`${parsed.bedrooms} bedroom`);
  if (!expandArea && parsed.location) queryParts.push(parsed.location);
  if (queryParts.length === 0) queryParts.push('condo Bangkok');
  const query = queryParts.join(' ');

  const maxPrice = buildMaxPrice(parsed, budgetMultiplier);

  // Check DB first
  let dbResults = searchDB(query, { bedrooms: parsed.bedrooms, maxPrice });

  let liveResults = [];
  if (dbResults.length < 3) {
    // Live scrape as fallback
    liveResults = await scrapeListings(query, maxPrice);
    // Store new listings in DB
    const withIds = liveResults.map(l => ({ ...l, listingId: extractListingId(l.url) }));
    addListings(withIds);
  }

  const all = [...dbResults, ...liveResults];
  const ranked = scoreAndFilter(all, parsed, maxPrice);
  return { ranked, parsed, query };
}

function sanitize(text) {
  if (!text) return '';
  return text
    .replace(/(?:\+?66|0)\d[\d\s\-]{7,12}\d/g, '')
    .replace(/\b0[689]\d[\d\-\s]{7,10}\b/g, '')
    .replace(/(?:line\s*(?:id|oa)?|ไลน์|line\s*:)\s*[@\w.\-]+/gi, '')
    .replace(/@[\w.\-]+/g, '')
    .replace(/\bID\s*:\s*\d+/gi, '')
    .replace(/\bid\s*[:#]\s*[\w\d]+/gi, '')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '')
    .replace(/\*{0,3}(?:owner\s*post|เจ้าของ(?:ห้อง)?โพส|posted?\s*by\s*owner)\*{0,3}/gi, '')
    .replace(/\[owner\s*post\]/gi, '')
    .replace(/(?:contact|ติดต่อ|สนใจ)[^\n]{0,60}(?:owner|inbox|ib|me|เจ้าของ)[^\n]*/gi, '')
    .replace(/(?:inbox|ib)\s+(?:or|หรือ)[^\n]*/gi, '')
    .replace(/#\S+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasThai(text) { return /[฀-๿]/.test(text); }

async function translateIfNeeded(text) {
  if (!text || !hasThai(text)) return text;
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Translate the following Thai/mixed text to natural English. Keep property details (sizes, prices, building names) as-is. Return only the translated text, nothing else.' },
        { role: 'user', content: text }
      ]
    });
    return res.choices[0].message.content.trim();
  } catch { return text; }
}

async function buildListingBubble(l, index) {
  const photo = l.photos?.[0];
  const cleanTitle = await translateIfNeeded(sanitize(l.title)) || `Property ${index + 1}`;
  const cleanDesc = await translateIfNeeded(sanitize(l.description));
  const snippet = cleanDesc.slice(0, 150) + (cleanDesc.length > 150 ? '…' : '');

  return {
    type: 'bubble',
    hero: photo ? { type: 'image', url: photo, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' } : undefined,
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        ...(l.bestFit ? [{ type: 'text', text: '⭐ Best Fit', size: 'xs', color: '#4f6ef7', weight: 'bold' }] : []),
        { type: 'text', text: cleanTitle, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: l.price || 'Price on request', color: '#4f6ef7', size: 'sm', weight: 'bold' },
        ...(l.location ? [{ type: 'text', text: `📍 ${l.location}`, size: 'xs', color: '#888888', wrap: true }] : []),
        ...(snippet ? [{ type: 'text', text: snippet, size: 'xs', color: '#aaaaaa', wrap: true }] : [])
      ]
    }
  };
}

const QUICK_REPLY_ITEMS = [
  { type: 'action', action: { type: 'message', label: '💰 Cheaper', text: '__cheaper__' } },
  { type: 'action', action: { type: 'message', label: '⬆️ More budget', text: '__more_budget__' } },
  { type: 'action', action: { type: 'message', label: '📍 Wider area', text: '__wider_area__' } },
  { type: 'action', action: { type: 'message', label: '➕ More results', text: '__more_results__' } },
];

async function sendResults(userId, ranked, totalFound) {
  if (!lineClient) return;
  const page = ranked.slice(0, 4);
  const bubbles = await Promise.all(page.map((l, i) => buildListingBubble(l, i)));

  await lineClient.pushMessage({
    to: userId,
    messages: [
      {
        type: 'text',
        text: `Found ${totalFound} matching ${totalFound === 1 ? 'property' : 'properties'} — showing the best ${page.length}:`
      },
      {
        type: 'flex',
        altText: 'Matching Properties',
        contents: { type: 'carousel', contents: bubbles }
      },
      {
        type: 'text',
        text: 'Refine your search:',
        quickReply: { items: QUICK_REPLY_ITEMS }
      }
    ]
  });
}

// LINE webhook
const lineMiddleware = lineConfig.channelSecret
  ? line.middleware(lineConfig)
  : (req, res, next) => next();

app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  if (!req.body?.events?.length) return;

  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    if (event.source.type !== 'group' && event.source.type !== 'user') continue;

    const text = event.message.text.trim();
    const userId = event.source.userId || event.source.groupId;

    try {
      // Handle quick reply commands
      const state = userState.get(userId);

      if (text === '__more_results__' && state) {
        const next = state.allResults.slice(state.offset, state.offset + 4);
        if (!next.length) {
          await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: 'No more results — try a different search.' }] });
          continue;
        }
        const marked = next.map((l, i) => ({ ...l, bestFit: i === 0 }));
        await sendResults(userId, marked, state.allResults.length);
        userState.set(userId, { ...state, offset: state.offset + 4 });
        continue;
      }

      if ((text === '__cheaper__' || text === '__more_budget__' || text === '__wider_area__') && state) {
        await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: '🔍 Searching...' }] });
        const opts = {
          budgetMultiplier: text === '__cheaper__' ? 0.7 : text === '__more_budget__' ? 1.5 : 1,
          expandArea: text === '__wider_area__',
        };
        const { ranked, parsed, query } = await findListings(state.originalMessage, opts);
        if (!ranked.length) {
          await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: "Couldn't find anything with those criteria. Try adjusting your search." }] });
          continue;
        }
        userState.set(userId, { originalMessage: state.originalMessage, allResults: ranked, offset: 4 });
        logSearch({ userId, query, parsed, resultCount: ranked.length, source: 'quick_reply' });
        await sendResults(userId, ranked, ranked.length);
        continue;
      }

      if (!looksLikeInquiry(text)) continue;

      // Send searching message immediately
      await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: '🔍 Searching for matching properties...' }] });

      const { ranked, parsed, query } = await findListings(text);

      logSearch({ userId, query, parsed, resultCount: ranked.length, source: 'new_search' });

      if (!ranked.length) {
        await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: "I searched but couldn't find matching properties right now. Try adjusting the budget or area." }] });
        continue;
      }

      userState.set(userId, { originalMessage: text, allResults: ranked, offset: 4 });
      await sendResults(userId, ranked, ranked.length);

    } catch (err) {
      console.error('LINE handler error:', err.message);
    }
  }
});

// Demo web UI
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/search', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });
  try {
    const { ranked, parsed, query } = await findListings(message);
    res.json({ parsed, query, listings: ranked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/stats', (req, res) => {
  res.json(getDBStats());
});

app.listen(3000, () => {
  console.log('Server running → http://localhost:3000');
  const stats = getDBStats();
  console.log(`DB: ${stats.total} listings cached (last updated: ${stats.lastUpdated || 'never'})`);

  // Background scrape: run now then every 4 hours
  const scrapeWithNotify = () => runBackgroundScrape(() => {
    // Session expired callback — ping owner on LINE
    if (lineClient && process.env.OWNER_LINE_ID) {
      lineClient.pushMessage({
        to: process.env.OWNER_LINE_ID,
        messages: [{ type: 'text', text: '⚠️ Facebook session expired. Run `node login.js` to refresh it.' }]
      }).catch(() => {});
    } else {
      console.warn('⚠️  Facebook session expired — run node login.js');
    }
  });

  scrapeWithNotify();
  setInterval(scrapeWithNotify, 4 * 60 * 60 * 1000);
});
