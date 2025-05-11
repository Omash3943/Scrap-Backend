const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const cheerio = require('cheerio');

const app = express();

// Enable CORS for your frontend domains
app.use(cors({
  origin: ['http://localhost:2435', 'https://josyvine.github.io/trio-chatbot'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Load API keys from environment variables
const keys = Object.keys(process.env)
  .filter(key => key.startsWith('API_KEY_'))
  .sort((a, b) => parseInt(a.replace('API_KEY_', '')) - parseInt(b.replace('API_KEY_', '')))
  .map(key => process.env[key]);

if (keys.length === 0) {
  console.error('No API keys found. Add keys as API_KEY_1, API_KEY_2, etc. in Render environment variables.');
}

// Initialize API key usage tracking
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

// POST /scrape endpoint
app.post('/scrape', async (req, res) => {
  const { query, autoparse = false, render_js = false } = req.body;

  // Validate URL
  if (!query || !query.match(/^https?:\/\/[^\s/$.?#].[^\s]*$/)) {
    return res.status(400).json({ error: 'Please provide a valid URL' });
  }

  // Select API key
  let keyToUse = null;
  for (let i = 0; i < keys.length; i++) {
    const index = (currentKeyIndex + i) % keys.length;
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
    // Adjust parameters for specific sites
    const isWikipedia = query.includes('wikipedia.org');
    const isAmazon = query.includes('amazon.');
    const adjustedAutoparse = isWikipedia ? false : autoparse;
    let apiUrl = `http://api.scraperapi.com?api_key=${keyToUse}&url=${encodeURIComponent(query)}&render=${render_js}&autoparse=${adjustedAutoparse}`;
    if (isAmazon) {
      apiUrl += '&premium=true&country_code=in';
    }

    // Fetch from ScraperAPI
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124',
      },
      timeout: 60000,
    });

    // Handle errors
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`ScraperAPI failed: Status ${response.status}, Error: ${errorText}`);
      if (response.status === 429) throw new Error('Rate limit exceeded');
      if (response.status === 401 || response.status === 403) throw new Error('Invalid API key');
      throw new Error(`ScraperAPI error: ${response.status} - ${errorText}`);
    }

    // Parse response
    const contentType = response.headers.get('content-type');
    let data;
    let html;
    if (contentType.includes('application/json')) {
      data = await response.json();
      if (data.parsed) {
        result = { ...result, ...data.parsed }; // Use parsed data for Amazon
      }
      html = data.html || '';
    } else {
      html = await response.text();
      data = { html };
    }

    // Parse HTML with Cheerio
    const $ = cheerio.load(html);
    let result = {
      rawHtml: html.slice(0, 2000),
      title: $('title').text().trim() || 'No title',
      description: $('meta[name="description"]').attr('content')?.trim() || 'No description',
    };

    // Remove unwanted elements
    const unwantedSelectors = ['script', 'style', 'nav', 'footer', '.ad', '.advertisement', '[id*="ad"]', '[class*="ad"]'];
    unwantedSelectors.forEach(sel => $(sel).remove());

    // Extract content
    const mainContent = $('main, article, #content, .content, .main, #mw-content-text, body').first();
    if (mainContent.length) {
      result.paragraphs = mainContent.find('p')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text.length > 50);
      result.headings = mainContent.find('h1, h2, h3')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text);
      result.items = mainContent.find('ul, ol')
        .find('li')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text);
      result.images = mainContent.find('img')
        .map((i, el) => {
          const alt = $(el).attr('alt') || 'Image';
          const src = $(el).attr('src');
          return src ? { alt, src } : null;
        })
        .get()
        .filter(img => img);
      result.tables = mainContent.find('table')
        .map((i, table) => {
          const rows = $(table).find('tr')
            .map((i, row) => $(row).find('td, th')
              .map((i, cell) => $(cell).text().trim())
              .get()
              .join(' | ')
            )
            .get();
          return rows.length ? rows.join('\n') : null;
        })
        .get()
        .filter(table => table);
    }

    // Update usage count
    usageCounts[currentKeyIndex]++;
    try {
      fs.writeFileSync('usage.json', JSON.stringify({ currentKeyIndex, usageCounts, lastResetMonth }), 'utf8');
    } catch (error) {
      console.error('Failed to write usage.json:', error.message);
    }

    // Send response
    res.json({ result });
  } catch (error) {
    console.error('Scrape error:', error);
    const status = error.message.includes('Rate limit') ? 429 : error.message.includes('Invalid API key') ? 401 : 500;
    res.status(status).json({ error: `Failed to scrape: ${error.message}` });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
