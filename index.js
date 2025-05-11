const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// Load API keys from environment variables
const keys = Object.keys(process.env)
  .filter(key => key.startsWith('API_KEY_'))
  .sort((a, b) => {
    const numA = parseInt(a.replace('API_KEY_', ''), 10);
    const numB = parseInt(b.replace('API_KEY_', ''), 10);
    return numA - numB;
  })
  .map(key => process.env[key]);

if (keys.length === 0) {
  console.error('No API keys found. Add keys as API_KEY_1, API_KEY_2, etc.');
}

let currentKeyIndex = 0;
let usageCounts = keys.map(() => 0);
let lastResetMonth = new Date().getMonth();

// Load saved usage data
if (fs.existsSync('usage.json')) {
  const data = fs.readFileSync('usage.json', 'utf8');
  const parsed = JSON.parse(data);
  currentKeyIndex = parsed.currentKeyIndex;
  usageCounts = parsed.usageCounts.slice(0, keys.length);
  lastResetMonth = parsed.lastResetMonth;
}

// Reset usage counts monthly
const currentMonth = new Date().getMonth();
if (currentMonth !== lastResetMonth) {
  usageCounts = keys.map(() => 0);
  lastResetMonth = currentMonth;
  try {
    fs.writeFileSync('usage.json', JSON.stringify({ currentKeyIndex, usageCounts, lastResetMonth }), 'utf8');
  } catch (error) {
    console.error('Failed to write usage.json:', error.message);
  }
}

app.post('/scrape', async (req, res) => {
  const { query, autoparse = false } = req.body; // Added autoparse support
  if (!query || !query.match(/^https?:\/\/.+/)) {
    return res.status(400).json({ error: 'Please provide a valid URL' });
  }

  // Find a key with available requests
  let keyToUse = null;
  for (let i = 0; i < keys.length; i++) {
    const index = (currentKeyIndex + i) % keys.length; // Improved rotation
    if (usageCounts[index] < 1000) {
      keyToUse = keys[index];
      currentKeyIndex = index;
      break;
    }
  }
  if (!keyToUse) {
    return res.status(429).json({ error: 'All API keys are used up for this month' });
  }

  try {
    const apiUrl = `http://api.scraperapi.com?api_key=${keyToUse}&url=${encodeURIComponent(query)}&render=true`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124',
      },
      timeout: 30000, // Added timeout
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) throw new Error('Rate limit exceeded');
      if (response.status === 401 || response.status === 403) throw new Error('Invalid API key');
      throw new Error(`ScraperAPI error: ${response.status} - ${errorText}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract structured data
    let result = { rawHtml: html.slice(0, 2000) }; // Increased limit
    const urlObj = new URL(query);
    const hostname = urlObj.hostname;

    result.title = $('h1').first().text().trim() || $('title').text().trim() || 'No title';
    result.intro = $('p').filter((i, el) => $(el).text().trim().length > 50).first().text().trim() || 'No intro';
    result.sections = $('h2, h3').map((i, el) => $(el).text().trim()).get().filter(text => text);

    // Domain-specific extraction
    let customData = {};
    if (hostname.includes('wikipedia.org')) {
      customData.intro = $('#mw-content-text .mw-parser-output > p:not(.mw-empty-elt)').first().text().trim() || result.intro;
      customData.sections = $('#mw-content-text .mw-parser-output > h2').map((i, el) => $(el).text().trim()).get();
    } else if (hostname.includes('amazon')) {
      customData.title = $('#productTitle').text().trim() || result.title;
      customData.description = $('#feature-bullets').text().trim() || $('#productDescription').text().trim() || 'No description';
    }

    // Autoparse additional data
    if (autoparse) {
      result.paragraphs = $('p').map((i, el) => $(el).text().trim()).get().filter(text => text.length > 20);
      result.items = $('ul, ol').find('li').map((i, el) => $(el).text().trim()).get().filter(text => text);
    }

    result = { ...result, ...customData };

    usageCounts[currentKeyIndex]++;
    try {
      fs.writeFileSync('usage.json', JSON.stringify({ currentKeyIndex, usageCounts, lastResetMonth }), 'utf8');
    } catch (error) {
      console.error('Failed to write usage.json:', error.message);
    }

    res.json({ result });
  } catch (error) {
    console.error('Scrape error:', error);
    const status = error.message.includes('Rate limit') ? 429 : error.message.includes('Invalid API key') ? 401 : 500;
    res.status(status).json({ error: `Failed to scrape: ${error.message}` });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
