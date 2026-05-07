import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';
import * as line from '@line/bot-sdk';
import { scrapeListings, scrapeFBSearch } from './scraper.js';
import { addListings, searchDB, logSearch, getDBStats, logMissedQuery, logQuickReply, getScoringWeights, logViewingRequest, getViewingRequestCount, getViewingRequests, updateViewingRequestStatus, getAnalyticsReport, getDemandStats, getRecentSearches, getListingById, removeStaleListings, addManualListing, deleteManualListing, getManualListings } from './db.js';
import fs from 'fs';
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

const INQUIRY_KEYWORDS = [
  'bed', 'bedroom', 'bath', 'condo', 'house', 'apartment', 'sqm', 'sqft',
  'budget', 'baht', '฿', 'rent', 'looking for', 'need', 'client',
  'br', 'studio', 'penthouse', 'townhouse', 'villa', 'property',
  'thb', 'k/month', 'per month', 'move in', 'pet', 'bts', 'mrt',
  'คอนโด', 'ห้องนอน', 'เช่า', 'งบ', 'บาท', 'ซื้อ', 'ขาย',
];

function looksLikeInquiry(text) {
  const lower = text.toLowerCase();
  return INQUIRY_KEYWORDS.some(k => lower.includes(k));
}

function extractListingId(url) {
  const m = url?.match(/\/commerce\/listing\/(\d+)/)
         || url?.match(/\/marketplace\/item\/(\d+)/)
         || url?.match(/\/posts\/(\d+)/)
         || url?.match(/story_fbid=(\d+)/);
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
  "buildingName": string | null,
  "features": string[]
}
buildingName = specific building/project name if mentioned (e.g. "Millennium Residence", "Baan Siri", "The Lakes"), otherwise null.
No explanation. No markdown. Just raw JSON.`
      },
      { role: 'user', content: message }
    ]
  });
  try {
    return JSON.parse(completion.choices[0].message.content.trim());
  } catch {
    return { propertyType: null, bedrooms: null, budget: null, location: null, buildingName: null, features: [] };
  }
}

function buildingFoundInResults(buildingName, results) {
  if (!buildingName) return true;
  const words = buildingName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  return results.some(l => {
    const t = ((l.title || '') + ' ' + (l.description || '') + ' ' + (l.location || '')).toLowerCase();
    return words.some(w => t.includes(w));
  });
}

function buildMaxPrice(parsed, multiplier = 1) {
  if (!parsed.budget) return null;
  const num = parsed.budget.replace(/,/g, '').match(/\d+/);
  if (!num) return null;
  let val = parseInt(num[0]);
  if (parsed.budget.toLowerCase().includes('k')) val *= 1000;
  const { budgetCeiling } = getScoringWeights();
  return Math.round(val * budgetCeiling * multiplier);
}

function scoreAndFilter(listings, parsed, maxPrice) {
  const keywords = [
    ...(parsed.features || []),
    parsed.location,
    parsed.propertyType,
    parsed.bedrooms ? `${parsed.bedrooms} bed` : null
  ].filter(Boolean).map(k => k.toLowerCase());

  const budgetNum = maxPrice ? Math.round(maxPrice / 1.5) : null;

  const GARBAGE_TITLES = new Set(['home','notifications','marketplace','groups','watch','menu','log in','sign up','facebook','']);

  // Deduplicate by listingId/URL AND by normalised title+price fingerprint
  const seen = new Set();
  const unique = listings.filter(l => {
    const t = (l.title || '').toLowerCase().trim();
    if (GARBAGE_TITLES.has(t) || t.length < 5) return false;
    const id = l.listingId || l.url || null;
    if (id && seen.has(id)) return false;
    if (id) seen.add(id);
    // Secondary key: title + price prevents cross-source duplicates
    const titleKey = (l.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const priceKey = (l.price || '').replace(/\s/g, '');
    const fingerprint = `${titleKey}||${priceKey}`;
    if (fingerprint !== '||' && seen.has(fingerprint)) return false;
    if (fingerprint !== '||') seen.add(fingerprint);
    return true;
  });

  // Filter out non-property listings (phones, cars, electronics, food, etc.)
  const PROPERTY_KEYWORDS = [
    'condo', 'condominium', 'apartment', 'house', 'villa', 'townhouse', 'studio',
    'bedroom', 'bed', 'bath', 'sqm', 'sq.m', 'floor', 'rent', 'lease', 'furnished',
    'ห้องนอน', 'คอนโด', 'อพาร์ทเมนท์', 'บ้าน', 'ให้เช่า', 'เช่า', 'ชั้น',
    'bts', 'mrt', 'balcony', 'pool', 'gym', 'penthouse', 'flat',
  ];
  const JUNK_KEYWORDS = [
    'iphone', 'ipad', 'samsung', 'laptop', 'macbook', 'tablet', 'phone', 'android',
    'for sale', 'selling', 'sell as', 'ขายมือ', 'มือสอง', 'second hand',
    'car', 'รถ', 'motorcycle', 'bike', 'scooter',
    'food', 'restaurant', 'job', 'hiring', 'vacancy', 'wanted',
    'sailor moon', 'meitu', 'airpods',
    'sofa', 'sofa bed', 'l-shape', 'couch', 'furniture', 'mattress', 'wardrobe', 'appliance',
    // Group/page names that get scraped as listings
    'bangkok expats', 'real estate group', 'property group', 'condo group',
    'join the', 'ai revolution', 'desperately seeking',
    // Agent/broker posts — owner posts only
    'real estate agent', 'property agent', 'rental agent', 'listing agent', 'sales agent',
    'agent fee', 'agency fee', 'real estate broker', 'property broker',
    'customer agent', 'real estate consultant', 'property consultant',
    'specialist in real estate', 'consultant for', 'please contact us', 'for customer',
    'นายหน้า', 'ตัวแทน', 'our team', 'our agency', 'our company',
    // Facebook error / rate-limit pages
    'were misusing this feature', 'going too fast', "this content isn't available",
    'something went wrong', "this page isn't available", 'log in to facebook',
    'link you followed may be broken',
  ];
  const notJunk = unique.filter(l => {
    const text = ((l.title || '') + ' ' + (l.description || '')).toLowerCase();
    if (JUNK_KEYWORDS.some(k => text.includes(k))) return false;
    if (!PROPERTY_KEYWORDS.some(k => text.includes(k))) return false;
    // Minimum realistic Bangkok rent — anything under 3000 is not a rental property
    if (l.priceNum && l.priceNum < 3000) return false;
    return true;
  });

  // Filter out sold/unavailable listings
  const available = notJunk.filter(l => {
    const title = (l.title || '').toLowerCase().trim();
    const desc = (l.description || '').toLowerCase();
    if (/^sold\b/.test(title)) return false;
    if (/\bsold\b/.test(title)) return false;
    if (/\bขายแล้ว\b/.test(desc)) return false;
    if (/\b(no longer available|already rented|not available)\b/.test(desc)) return false;
    return true;
  });

  // Hard bedroom filter — exact match only (client asking for 1 bed shouldn't see 2 beds)
  const filtered = available.filter(l => {
    if (!parsed.bedrooms) return true;
    if (l.bedrooms != null) return l.bedrooms === parsed.bedrooms;
    const text = ((l.title || '') + ' ' + (l.description || '')).toLowerCase();
    const m = text.match(/(\d+)\s*(?:bed(?:room)?s?|ห้องนอน)/i);
    if (m) return parseInt(m[1]) === parsed.bedrooms;
    return true; // unknown bedroom count — keep it
  });

  const scored = filtered.map(l => {
    const text = ((l.title || '') + ' ' + (l.description || '') + ' ' + (l.price || '') + ' ' + (l.location || '')).toLowerCase();
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
    } else if (budgetNum && !priceNum) {
      score -= 2; // penalise no-price listings when agent specified a budget
    }
    const w = getScoringWeights();
    if (!l.photos || l.photos.length === 0) score -= w.photoPenalty;
    if (parsed.location) {
      const locTerms = parsed.location.toLowerCase().split(/[\s,\/]+/).filter(t => t.length > 3);
      const hasLocMatch = locTerms.some(t => text.includes(t));
      if (!hasLocMatch) score -= w.locationPenalty;
    }
    // Penalise low-data listings that can't be evaluated properly
    const dataPoints = (priceNum ? 1 : 0) + (l.bedrooms != null ? 1 : 0) + (l.location ? 1 : 0) + (l.photos?.length ? 1 : 0);
    if (dataPoints <= 1) score -= 3;
    return { ...l, score, priceNum };
  });

  scored.sort((a, b) => b.score - a.score || Math.abs(a.priceNum - (budgetNum || 0)) - Math.abs(b.priceNum - (budgetNum || 0)));
  return scored.map((l, i) => ({ ...l, bestFit: i === 0 && l.score > 0 }));
}

async function llmRerank(listings, originalMessage, parsed) {
  if (listings.length <= 4) return listings;
  const candidates = listings.slice(0, 15).map((l, i) =>
    `[${i}] ${l.title || 'Untitled'} | ${l.price || 'No price'} | ${l.location || 'Bangkok'} | ${l.bedrooms != null ? l.bedrooms + 'BR' : '?BR'}`
  );
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are a Bangkok real estate expert. Given a client search request and a numbered list of property listings, return ONLY a JSON array of the top 4 index numbers ranked best-to-worst match. Example output: [2,0,7,4]. No explanation, no markdown, just the array.' },
        { role: 'user', content: `Client request: "${originalMessage}"\n\nListings:\n${candidates.join('\n')}\n\nBest 4 indices:` },
      ],
    });
    const raw = res.choices[0].message.content.trim();
    const match = raw.match(/\[[\d,\s]+\]/);
    if (match) {
      const indices = JSON.parse(match[0]).slice(0, 4).filter(i => i >= 0 && i < listings.length);
      const picked = new Set(indices);
      return [...indices.map(i => listings[i]), ...listings.filter((_, i) => !picked.has(i))];
    }
  } catch (e) {
    console.log('[RERANK] Error:', e.message);
  }
  return listings;
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

  let dbResults = searchDB(query, { bedrooms: parsed.bedrooms, maxPrice, location: !expandArea ? parsed.location : null });
  let locationRelaxed = false;

  // If location filter wiped everything, retry without it so we always have a base to work from
  if (dbResults.length === 0 && parsed.location && !expandArea) {
    dbResults = searchDB(query, { bedrooms: parsed.bedrooms, maxPrice, location: null });
    locationRelaxed = true;
    console.log(`[FIND] Location filter gave 0 — relaxed to ${dbResults.length} results`);
  }

  let liveResults = [];
  if (dbResults.length < 5) {
    liveResults = await scrapeListings(query, maxPrice);

    // If combined total is still thin, fall back to full FB search (Marketplace + post search)
    if (dbResults.length + liveResults.length < 3) {
      console.log('[FIND] Still thin after group search — falling back to full FB search...');
      const fbResults = await scrapeFBSearch(query, maxPrice);
      liveResults = [...liveResults, ...fbResults];
    }

    const withIds = liveResults.map(l => ({ ...l, listingId: l.listingId || extractListingId(l.url) || null }));
    addListings(withIds.filter(l => l.listingId));
  }

  const all = [...dbResults, ...liveResults];
  const ranked = scoreAndFilter(all, parsed, maxPrice);
  const reranked = await llmRerank(ranked, message, parsed);
  return { ranked: reranked, parsed, query, locationRelaxed };
}

function sanitize(text) {
  if (!text) return '';
  return text
    // Strip all URLs (lin.ee, fb.com, wa.me, bit.ly, etc.) — must come first
    .replace(/https?:\/\/\S+/gi, '')
    // Thai & international phone numbers — allow optional space after country code
    .replace(/(?:\+?66|0)\s?\d[\d\s\-\.]{7,12}\d/g, '')
    .replace(/\b0[689]\d[\d\-\s\.]{7,10}\b/g, '')
    .replace(/\b\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}\b/g, '')
    .replace(/\b\d{10}\b/g, '')
    // Explicit contact prefixes followed by anything on that line
    .replace(/(?:tel|phone|call|whatsapp|wa|wechat|wc|viber|contact|mobile|ติดต่อ|โทร|สนใจ|สอบถาม)\s*[:\-]?\s*[\d\s\+\-\.\(\)]{7,}/gi, '')
    .replace(/(?:tel|phone|call|whatsapp|wa|wechat|wc|viber|contact|mobile|ติดต่อ|โทร|สนใจ|สอบถาม)[^\n]{0,80}/gi, '')
    // LINE, WeChat, social IDs and @ handles — strip entire line when LINE is mentioned
    .replace(/^.*(?:line\s*(?:id|oa)?|ไลน์)[^\n]*/gim, '')
    .replace(/^.*line\s*[:\-][^\n]*/gim, '')
    .replace(/(?:wechat|wc|微信)\s*[:\-]?\s*\S+/gi, '')
    .replace(/@[\w.\-]+/g, '')
    // Solicitation / CTA lines
    .replace(/^.*(?:feel free to|interested[,\s]+(?:please|pls|dm|pm|message|line|call|whatsapp)|reach out|get in touch|don.t hesitate)[^\n]*/gim, '')
    // Emails
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '')
    // Generic ID patterns
    .replace(/\bID\s*:\s*\d+/gi, '')
    .replace(/\bid\s*[:#]\s*[\w\d]+/gi, '')
    // Owner/inbox CTAs
    .replace(/\*{0,3}(?:owner\s*post|เจ้าของ(?:ห้อง)?โพส|posted?\s*by\s*owner)\*{0,3}/gi, '')
    .replace(/\[owner\s*post\]/gi, '')
    .replace(/(?:contact|ติดต่อ|สนใจ)[^\n]{0,60}(?:owner|inbox|ib|me|เจ้าของ)[^\n]*/gi, '')
    .replace(/(?:inbox|ib)\s+(?:or|หรือ)[^\n]*/gi, '')
    .replace(/(?:dm|pm|message)\s+(?:me|us|owner)[^\n]*/gi, '')
    // Agent promo lines — whole line containing these phrases
    .replace(/^.*(?:please contact us|for customer|customer agent|contact our|our agent|our team)[^\n]*/gim, '')
    // "We welcome" phrases — FB post tells that reveal source
    .replace(/^.*we\s+welcome\s+(?:agents?|brokers?|foreigners?|expats?|co[\-\s]?broke)[^\n]*/gim, '')
    .replace(/^.*(?:agents?|foreigners?|expats?)\s+(?:are\s+)?welcome[^\n]*/gim, '')
    .replace(/^.*welcome\s+(?:agents?|co[\-\s]?broke|brokers?)[^\n]*/gim, '')
    // FB engagement bait
    .replace(/^.*(?:like\s+(?:and|&)\s+share|share\s+(?:and|&)\s+like|please\s+share|pls\s+share|share\s+this\s+post)[^\n]*/gim, '')
    .replace(/^.*(?:comment\s+below|drop\s+a\s+comment|leave\s+a\s+comment)[^\n]*/gim, '')
    // Hashtags
    .replace(/#\S+/g, '')
    // Facebook metadata
    .replace(/joined facebook in \d{4}/gi, '')
    .replace(/condo\s*&?\s*property\s*post\s*by\s*owner/gi, '')
    .replace(/\bfacebook\b[^\n]*/gi, '')
    .replace(/posted? (in|to) [^\n]+group[^\n]*/gi, '')
    // Tidy whitespace
    .replace(/[ \t]{2,}/g, ' ')
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
        { role: 'system', content: 'Translate any Thai words in the text to English. Output ONLY the final English text. Do NOT include phrases like "translates to", "translation:", or any preamble. Keep building names, numbers, prices, and proper nouns as-is.' },
        { role: 'user', content: text }
      ]
    });
    let out = res.choices[0].message.content.trim();
    // Strip any preamble the model accidentally includes
    out = out.replace(/^.*?(?:translates?\s+to|translation)\s*:?\s*/i, '').trim();
    return out || text;
  } catch { return text; }
}

function formatPrice(price, priceNum) {
  if (priceNum && priceNum > 0 && priceNum < 500000) {
    return `฿${priceNum.toLocaleString('en-US')} / month`;
  }
  if (price) {
    const m = price.match(/(\d[\d,]*)/);
    if (m) return `฿${parseInt(m[1].replace(/,/g, '')).toLocaleString('en-US')} / month`;
  }
  return 'Price on request';
}

function extractSpecs(description, bedrooms) {
  const text = description || '';
  const sqmMatch = text.match(/(\d+)\s*sq\.?\s*m(?:eter)?s?/i);
  const floorMatch = text.match(/(?:floor|fl\.?|ชั้น)\s*(\d+)|(\d+)(?:st|nd|rd|th)?\s*floor/i);
  const transitMatch = text.match(/(?:BTS|MRT)\s+[\w\s]+?(?=\s*[,.\n\(]|$)/i);
  const sqm = sqmMatch ? sqmMatch[1] : null;
  const floor = floorMatch ? (floorMatch[1] || floorMatch[2]) : null;
  const transit = transitMatch ? transitMatch[0].trim().replace(/\s+/g, ' ').slice(0, 35) : null;
  const parts = [];
  if (bedrooms != null) parts.push(`${bedrooms}BR`);
  if (sqm) parts.push(`${sqm} sqm`);
  if (floor) parts.push(`Floor ${floor}`);
  return { specsLine: parts.join(' · '), transit };
}

async function buildListingBubble(l, index) {
  const photos = (l.photos || []).filter(Boolean);
  const cleanTitle = await translateIfNeeded(sanitize(l.title)) || `Property ${index + 1}`;
  const cleanDesc = await translateIfNeeded(sanitize(l.description));
  const { specsLine, transit } = extractSpecs(cleanDesc, l.bedrooms);
  const formattedPrice = formatPrice(l.price, l.priceNum);
  const listingKey = `r${index}`; // opaque positional key — never expose raw FB ID

  // Hero: single image preferred, 2×2 grid if 2+ photos
  let hero;
  if (photos.length >= 2) {
    const top = photos.slice(0, 4);
    const rows = [];
    for (let i = 0; i < top.length; i += 2) {
      rows.push({
        type: 'box', layout: 'horizontal', spacing: 'xs',
        contents: top.slice(i, i + 2).map(url => ({
          type: 'image', url, flex: 1, aspectRatio: '4:3', aspectMode: 'cover'
        }))
      });
    }
    hero = { type: 'box', layout: 'vertical', spacing: 'xs', contents: rows };
  } else if (photos.length === 1) {
    hero = { type: 'image', url: photos[0], size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
  }

  const cleanLocation = l.location ? await translateIfNeeded(l.location) : null;

  const bodyContents = [];
  if (l.bestFit) bodyContents.push({ type: 'text', text: '⭐ Best Fit', size: 'xs', color: '#4f6ef7', weight: 'bold' });
  bodyContents.push({ type: 'text', text: cleanTitle, weight: 'bold', size: 'lg', wrap: true });
  bodyContents.push({ type: 'text', text: formattedPrice, color: '#2196F3', size: 'md', weight: 'bold' });
  if (specsLine) bodyContents.push({ type: 'text', text: specsLine, size: 'sm', color: '#444444', wrap: true });
  if (transit) bodyContents.push({ type: 'text', text: transit, size: 'sm', color: '#555555', wrap: true });
  if (cleanLocation) bodyContents.push({ type: 'text', text: cleanLocation, size: 'xs', color: '#888888', wrap: true });

  const footerButtons = [
    {
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'message', label: 'View full details', text: `__details__${listingKey}` }
    },
  ];
  if (l.listingId) {
    footerButtons.unshift({
      type: 'button', style: 'primary', color: '#22c55e', height: 'sm',
      action: { type: 'message', label: '📅 Request Viewing', text: `__viewing__${listingKey}` }
    });
  }

  return {
    type: 'bubble',
    hero,
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: bodyContents },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: footerButtons }
  };
}

const QUICK_REPLY_ITEMS = [
  { type: 'action', action: { type: 'message', label: '💰 Cheaper', text: '__cheaper__' } },
  { type: 'action', action: { type: 'message', label: '⬆️ More budget', text: '__more_budget__' } },
  { type: 'action', action: { type: 'message', label: '📍 Wider area', text: '__wider_area__' } },
  { type: 'action', action: { type: 'message', label: '➕ More results', text: '__more_results__' } },
];

async function sendResults(userId, ranked, totalFound, offset = 0) {
  if (!lineClient) return;
  const page = ranked.slice(0, 4);

  try {
    const bubbles = await Promise.all(page.map((l, i) => buildListingBubble(l, offset + i)));
    await lineClient.pushMessage({
      to: userId,
      messages: [
        { type: 'text', text: `Found ${totalFound} matching ${totalFound === 1 ? 'property' : 'properties'} — showing the best ${page.length}:` },
        { type: 'flex', altText: 'Matching Properties', contents: { type: 'carousel', contents: bubbles } },
        { type: 'text', text: 'Refine your search:', quickReply: { items: QUICK_REPLY_ITEMS } }
      ]
    });
    return;
  } catch (e) {
    console.error('[SEND] Flex message failed:', e.message, '— falling back to text');
  }

  // Text fallback if flex fails — must also sanitize and translate
  try {
    const lines = (await Promise.all(page.map(async (l, i) => {
      const title = await translateIfNeeded(sanitize(l.title)) || 'Property';
      const loc = l.location ? await translateIfNeeded(l.location) : null;
      return `${i + 1}. ${title}\n   ${formatPrice(l.price, l.priceNum)}${loc ? '\n   📍 ' + loc : ''}`;
    }))).join('\n\n');
    await lineClient.pushMessage({
      to: userId,
      messages: [
        { type: 'text', text: `Found ${totalFound} properties:\n\n${lines}` },
        { type: 'text', text: 'Refine your search:', quickReply: { items: QUICK_REPLY_ITEMS } }
      ]
    });
  } catch (e2) {
    console.error('[SEND] Text fallback also failed:', e2.message);
  }
}

// LINE webhook
const lineMiddleware = lineConfig.channelSecret
  ? line.middleware(lineConfig)
  : (req, res, next) => next();

app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  console.log('[WH] Received webhook, events:', req.body?.events?.length ?? 0);
  if (!req.body?.events?.length) return;

  for (const event of req.body.events) {
    console.log('[WH] Event type:', event.type, '| message type:', event.message?.type, '| source:', event.source?.type);
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    if (event.source.type !== 'group' && event.source.type !== 'user') continue;

    const text = event.message.text.trim();
    const userId = event.source.userId || event.source.groupId;
    console.log('[WH] Text:', text.slice(0, 80), '| looksLikeInquiry:', looksLikeInquiry(text));

    try {
      // Handle quick reply commands
      const state = userState.get(userId);

      // View full details
      if (text.startsWith('__details__')) {
        const key = text.replace('__details__', '');
        const listing = state?.listingsMap?.[key] || null;
        if (!listing) {
          await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: 'Session expired — please send your search again and then tap View full details.' }] });
          continue;
        }
        const cleanDesc = await translateIfNeeded(sanitize(listing.description));
        const formattedPrice = formatPrice(listing.price, listing.priceNum);
        const rawTitle = (listing.title || '').toLowerCase().trim();
        const GARBAGE = new Set(['home','notifications','marketplace','groups','watch','menu','log in','sign up','facebook','']);
        const title = GARBAGE.has(rawTitle) || rawTitle.length < 5
          ? 'Property'
          : (await translateIfNeeded(sanitize(listing.title)));
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: `📋 ${title}\n${formattedPrice}\n\n${cleanDesc || 'No description available.'}` }]
        });
        continue;
      }

      // Request viewing
      if (text.startsWith('__viewing__')) {
        const key = text.replace('__viewing__', '');
        const listing = state?.listingsMap?.[key] || null;
        const title = listing ? (await translateIfNeeded(sanitize(listing.title))) : 'a property';
        const price = listing ? formatPrice(listing.price, listing.priceNum) : '';
        logViewingRequest(userId, listing || { title, price });
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: `📅 Viewing request received for:\n${title}${price ? '\n' + price : ''}\n\nWe'll be in touch shortly to arrange this.` }]
        });
        if (process.env.OWNER_LINE_ID && lineClient) {
          lineClient.pushMessage({
            to: process.env.OWNER_LINE_ID,
            messages: [{ type: 'text', text: `🔔 New viewing request\nAgent: ${userId}\nProperty: ${title}\n${price}\n\nCheck admin dashboard to action.` }]
          }).catch(() => {});
        }
        continue;
      }

      if (text === '__more_results__' && state) {
        const next = state.allResults.slice(state.offset, state.offset + 4);
        if (!next.length) {
          await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: 'No more results — try a different search.' }] });
          continue;
        }
        const marked = next.map((l, i) => ({ ...l, bestFit: i === 0 }));
        await sendResults(userId, marked, state.allResults.length, state.offset);
        userState.set(userId, { ...state, offset: state.offset + 4 });
        continue;
      }

      if ((text === '__cheaper__' || text === '__more_budget__' || text === '__wider_area__' || text === '__more_results__') && state) {
        logQuickReply(text);
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
        const listingsMap = Object.fromEntries(ranked.map((l, i) => [`r${i}`, l]));
        userState.set(userId, { originalMessage: state.originalMessage, allResults: ranked, offset: 4, listingsMap });
        logSearch({ userId, query, parsed, resultCount: ranked.length, source: 'quick_reply' });
        await sendResults(userId, ranked, ranked.length);
        continue;
      }

      if (!looksLikeInquiry(text)) continue;

      // Reply immediately using replyToken (works without being friends)
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '🔍 Searching for matching properties...' }]
      });

      const { ranked, parsed, query, locationRelaxed } = await findListings(text);

      logSearch({ userId, query, parsed, parsedFull: parsed, resultCount: ranked.length, source: 'new_search' });

      if (!ranked.length) {
        logMissedQuery(query);
        await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: "Nothing found right now for that search — our inventory in that area may be low. Try the Wider Area button or send another search." }] });
        continue;
      }

      const listingsMap = Object.fromEntries(ranked.map((l, i) => [`r${i}`, l]));
      userState.set(userId, { originalMessage: text, allResults: ranked, offset: 4, listingsMap });

      if (locationRelaxed && parsed.location) {
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: `No listings found specifically in ${parsed.location} right now — showing the closest Bangkok matches:` }]
        });
      } else if (parsed.buildingName && !buildingFoundInResults(parsed.buildingName, ranked)) {
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: `Couldn't find any listings for ${parsed.buildingName} specifically — here are the closest matches in the area:` }]
        });
      }

      await sendResults(userId, ranked, ranked.length);

    } catch (err) {
      console.error('LINE handler error:', err.message, err.statusCode || '', err.originalError?.message || '');
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

const QUALITY_LOG = path.join(__dirname, 'quality-log.json');

app.get('/admin', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).send('Unauthorized');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/data', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
  const stats = getDBStats();
  const demand = getDemandStats();
  const report = getAnalyticsReport();
  const recent = getRecentSearches(48).slice(0, 25).map(s => ({
    query: s.query, area: s.area, bedrooms: s.bedrooms,
    budget: s.budget, resultCount: s.resultCount, timestamp: s.timestamp,
  }));
  let qualityLog = [];
  try { if (fs.existsSync(QUALITY_LOG)) qualityLog = JSON.parse(fs.readFileSync(QUALITY_LOG, 'utf8')).slice(-12); } catch {}

  // DB quality metrics
  let dbQuality = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'listings-db.json'), 'utf8'));
    const listings = raw.listings || [];
    const total = listings.length;
    const withPrice = listings.filter(l => l.priceNum && l.priceNum > 0).length;
    const withLocation = listings.filter(l => l.location && l.location.trim().length > 0).length;
    const withBedrooms = listings.filter(l => l.bedrooms != null).length;
    const withPhotos = listings.filter(l => l.photos && l.photos.length > 0).length;
    const ownerConfirmed = listings.filter(l => l.ownerConfirmed).length;
    dbQuality = {
      total,
      withPrice: { count: withPrice, pct: total ? Math.round(withPrice / total * 100) : 0 },
      withLocation: { count: withLocation, pct: total ? Math.round(withLocation / total * 100) : 0 },
      withBedrooms: { count: withBedrooms, pct: total ? Math.round(withBedrooms / total * 100) : 0 },
      withPhotos: { count: withPhotos, pct: total ? Math.round(withPhotos / total * 100) : 0 },
      ownerConfirmed: { count: ownerConfirmed, pct: total ? Math.round(ownerConfirmed / total * 100) : 0 },
    };
  } catch {}

  res.json({ db: stats, demand, report, recent, qualityLog, dbQuality, viewingRequestCount: getViewingRequestCount(), viewingRequests: getViewingRequests().slice(0, 50) });
});

app.get('/admin/manual-listings', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
  res.json(getManualListings());
});

app.post('/admin/listing', express.json(), (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
  const { title, price, priceNum, bedrooms, location, description, ownerContact, photos } = req.body;
  if (!title && !description) return res.status(400).json({ error: 'title or description required' });
  const id = addManualListing({ title, price, priceNum, bedrooms, location, description, ownerContact, photos });
  res.json({ ok: true, listingId: id });
});

app.delete('/admin/listing/:id', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
  const ok = deleteManualListing(req.params.id);
  res.json({ ok });
});

// Upload a fresh FB session JSON (paste from browser export — no SSH needed)
app.post('/admin/session', express.json({ limit: '2mb' }), (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
  const session = req.body;
  if (!session || (!session.cookies && !Array.isArray(session))) return res.status(400).json({ error: 'Invalid session JSON' });
  const SESSION_FILE = path.join(__dirname, 'fb-session.json');
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
  console.log('[ADMIN] FB session refreshed via admin upload');
  res.json({ ok: true, message: 'Session saved — next scrape will use it' });
});

app.post('/admin/viewing-status', express.json(), (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
  const { timestamp, status } = req.body;
  if (!timestamp || !status) return res.status(400).json({ error: 'Missing fields' });
  updateViewingRequestStatus(timestamp, status);
  res.json({ ok: true });
});

app.listen(3000, () => {
  console.log('Server running → http://localhost:3000');
  const stats = getDBStats();
  console.log(`DB: ${stats.total} listings cached (last updated: ${stats.lastUpdated || 'never'})`);

  const onSessionExpired = () => {
    console.warn('⚠️  Facebook session expired — run node login.js');
    if (lineClient && process.env.OWNER_LINE_ID) {
      lineClient.pushMessage({
        to: process.env.OWNER_LINE_ID,
        messages: [{ type: 'text', text: '⚠️ Facebook session expired. Run node login.js to refresh.' }]
      }).catch(() => {});
    }
  };

  const onProactiveMatch = async (userId, listings, originalQuery) => {
    if (!lineClient) return;
    try {
      const bubbles = await Promise.all(listings.slice(0, 2).map((l, i) => buildListingBubble(l, i)));
      await lineClient.pushMessage({
        to: userId,
        messages: [
          { type: 'text', text: `🔔 New listing just found matching your search for "${originalQuery.slice(0, 60)}":` },
          { type: 'flex', altText: 'New Matching Property', contents: { type: 'carousel', contents: bubbles } },
        ],
      });
      console.log(`[ALERT] Proactive match sent to ${userId}`);
    } catch (e) {
      console.log('[ALERT] Push failed:', e.message);
    }
  };

  const scrapeWithNotify = () => runBackgroundScrape(onSessionExpired, null);
  scrapeWithNotify();
  setInterval(scrapeWithNotify, 30 * 60 * 1000); // every 30 min — keeps FB session alive longer

  // Purge listings older than 30 days every 6 hours
  setInterval(() => removeStaleListings(30), 6 * 60 * 60 * 1000);
});
