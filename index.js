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
  const { query, autoparse = false, render_js = false } = req.body; // Added render_js support
  if (!query || !query.match(/^https?:\/\/.+/)) {
    return res.status(400).json({ error: 'Please provide a valid URL' });
  }

  // Find a key with available requests
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
    // Construct ScraperAPI URL with autoparse and render_js options
    const apiUrl = `http://api.scraperapi.com?api_key=${keyToUse}&url=${encodeURIComponent(query)}&render=${render_js}&autoparse=${autoparse}`;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124',
      },
      timeout: 30000,
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) throw new Error('Rate limit exceeded');
      if (response.status === 401 || response.status === 403) throw new Error('Invalid API key');
      throw new Error(`ScraperAPI error: ${response.status} - ${errorText}`);
    }
    const data = await response.json(); // Handle JSON response for autoparse
    let html = data.html || await response.text(); // Fallback to raw HTML

    const $ = cheerio.load(html);

    // Initialize result object
    let result = {
      rawHtml: html.slice(0, 2000), // Limit raw HTML to prevent bloat
      title: $('title').text().trim() || 'No title',
      description: $('meta[name="description"]').attr('content')?.trim() || 'No description',
    };

    // Remove unwanted elements for cleaner content
    const unwantedSelectors = ['script', 'style', 'nav', 'footer', '.ad', '.advertisement', '[id*="ad"]', '[class*="ad"]'];
    unwantedSelectors.forEach(sel => $(sel).remove());

    // Extract main content
    const mainContent = $('main, article, #content, .content, .main, body').first();
    if (mainContent.length) {
      // Paragraphs with minimum length
      result.paragraphs = mainContent.find('p')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text.length > 50);

      // Headings (h1, h2, h3)
      result.headings = mainContent.find('h1, h2, h3')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text);

      // Lists
      result.items = mainContent.find('ul, ol')
        .find('li')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(text => text);

      // Images with alt text
      result.images = mainContent.find('img')
        .map((i, el) => {
          const alt = $(el).attr('alt') || 'Image';
          const src = $(el).attr('src');
          return src ? { alt, src } : null;
        })
        .get()
        .filter(img => img);

      // Tables
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

    // Domain-specific extraction
    const urlObj = new URL(query);
    const hostname = urlObj.hostname;
    if (hostname.includes('wikipedia.org')) {
      result.description = $('#mw-content-text .mw-parser-output > p:not(.mw-empty-elt)').first().text().trim() || result.description;
      result.sections = $('#mw-content-text .mw-parser-output > h2').map((i, el) => $(el).text().trim()).get();
    } else if (hostname.includes('amazon')) {
      result.title = $('#productTitle').text().trim() || result.title;
      result.description = $('#feature-bullets').text().trim() || $('#productDescription').text().trim() || result.description;
    }

    // Handle autoparse response from ScraperAPI
    if (autoparse && data.parsed) {
      result.parsed = data.parsed; // Include autoparse data
    }

    // Increment usage count and save
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
