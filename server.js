import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';
import * as line from '@line/bot-sdk';
import { scrapeListings } from './scraper.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// LINE client
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = lineConfig.channelAccessToken ? new line.messagingApi.MessagingApiClient(lineConfig) : null;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Property inquiry keywords — only respond to relevant messages
const INQUIRY_KEYWORDS = ['bed', 'bedroom', 'bath', 'condo', 'house', 'apartment', 'sqm', 'budget', 'baht', '฿', 'rent', 'looking for', 'need', 'client'];

function looksLikeInquiry(text) {
  const lower = text.toLowerCase();
  return INQUIRY_KEYWORDS.filter(k => lower.includes(k)).length >= 2;
}

async function parseAndSearch(message) {
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

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content.trim());
  } catch {
    parsed = { propertyType: null, bedrooms: null, budget: null, location: null, features: [] };
  }

  const queryParts = [];
  if (parsed.propertyType) queryParts.push(parsed.propertyType);
  if (parsed.bedrooms) queryParts.push(`${parsed.bedrooms} bedroom`);
  if (parsed.location) queryParts.push(parsed.location);
  if (queryParts.length === 0) queryParts.push('condo Bangkok');

  const query = queryParts.join(' ');

  let maxPrice = null;
  if (parsed.budget) {
    const num = parsed.budget.replace(/,/g, '').match(/\d+/);
    if (num) {
      let val = parseInt(num[0]);
      if (parsed.budget.toLowerCase().includes('k')) val *= 1000;
      maxPrice = val + 5000;
    }
  }

  const listings = await scrapeListings(query, maxPrice);

  const keywords = [
    ...(parsed.features || []),
    parsed.location,
    parsed.propertyType,
    parsed.bedrooms ? `${parsed.bedrooms} bed` : null
  ].filter(Boolean).map(k => k.toLowerCase());

  const budgetNum = maxPrice ? maxPrice - 5000 : null;

  const scored = listings.map(l => {
    const text = (l.title + ' ' + (l.description || '') + ' ' + l.price).toLowerCase();
    let score = 0;
    keywords.forEach(k => { if (text.includes(k)) score += 1; });
    if (parsed.bedrooms) {
      const m = text.match(/(\d+)\s*(bed|bedroom)/i);
      if (m) score += parseInt(m[1]) === parsed.bedrooms ? 3 : -2;
    }
    const priceNum = parseInt((l.price || '').replace(/[^0-9]/g, ''));
    if (budgetNum && priceNum) {
      if (priceNum <= budgetNum) score += 2;
      if (priceNum <= budgetNum && priceNum >= budgetNum * 0.7) score += 1;
    }
    return { ...l, score, priceNum: priceNum || 0 };
  });

  scored.sort((a, b) => b.score - a.score || Math.abs(a.priceNum - (budgetNum || 0)) - Math.abs(b.priceNum - (budgetNum || 0)));
  return scored.map((l, i) => ({ ...l, bestFit: i === 0 && l.score > 0 }));
}

// Build LINE flex message for a property listing
function buildListingBubble(l, index) {
  const photo = l.photos?.[0];
  return {
    type: 'bubble',
    hero: photo ? {
      type: 'image',
      url: photo,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover'
    } : undefined,
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        ...(l.bestFit ? [{
          type: 'text',
          text: '⭐ Best Fit',
          size: 'xs',
          color: '#4f6ef7',
          weight: 'bold'
        }] : []),
        {
          type: 'text',
          text: l.title || `Property ${index + 1}`,
          weight: 'bold',
          size: 'md',
          wrap: true
        },
        {
          type: 'text',
          text: l.price || 'Price on request',
          color: '#4f6ef7',
          size: 'sm',
          weight: 'bold'
        },
        ...(l.location ? [{
          type: 'text',
          text: `📍 ${l.location}`,
          size: 'xs',
          color: '#888888',
          wrap: true
        }] : []),
        ...(l.description ? [{
          type: 'text',
          text: l.description.slice(0, 150) + (l.description.length > 150 ? '…' : ''),
          size: 'xs',
          color: '#aaaaaa',
          wrap: true
        }] : [])
      ]
    }
  };
}

// LINE webhook
const lineMiddleware = lineConfig.channelSecret
  ? line.middleware(lineConfig)
  : (req, res, next) => next();

app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    if (event.source.type !== 'group') continue;

    const text = event.message.text;
    const userId = event.source.userId;

    if (!looksLikeInquiry(text)) continue;

    try {
      const listings = await parseAndSearch(text);
      if (!listings.length) {
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: 'I searched for matching properties but couldn\'t find any results right now. Please try again shortly.' }]
        });
        continue;
      }

      const bubbles = listings.slice(0, 4).map((l, i) => buildListingBubble(l, i));

      await lineClient.pushMessage({
        to: userId,
        messages: [
          { type: 'text', text: `Hi! I found ${listings.length} matching properties for your client 🏠\nHere are the best matches:` },
          { type: 'flex', altText: 'Matching Properties', contents: { type: 'carousel', contents: bubbles } }
        ]
      });
    } catch (err) {
      console.error('LINE handler error:', err.message);
    }
  }
});

// Demo web UI endpoint
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/search', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });
  try {
    // Parse requirements first so we can return them to the UI
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

    let parsed;
    try { parsed = JSON.parse(completion.choices[0].message.content.trim()); }
    catch { parsed = { propertyType: null, bedrooms: null, budget: null, location: null, features: [] }; }

    const queryParts = [];
    if (parsed.propertyType) queryParts.push(parsed.propertyType);
    if (parsed.bedrooms) queryParts.push(`${parsed.bedrooms} bedroom`);
    if (parsed.location) queryParts.push(parsed.location);
    if (queryParts.length === 0) queryParts.push('condo Bangkok');
    const query = queryParts.join(' ');

    const listings = await parseAndSearch(message);
    res.json({ parsed, query, listings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('Server running → http://localhost:3000');
});
