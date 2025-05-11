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
  console.error('No API keys found in environment variables. Please add keys as API_KEY_1, API_KEY_2, etc.');
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
  fs.writeFileSync('usage.json', JSON.stringify({ currentKeyIndex, usageCounts, lastResetMonth }), 'utf8');
}

app.post('/scrape', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Please provide a URL to scrape' });
  }

  // Find a key with available requests
  let keyToUse = null;
  for (let i = currentKeyIndex; i < keys.length; i++) {
    if (usageCounts[i] < 1000) {
      keyToUse = keys[i];
      currentKeyIndex = i;
      break;
    }
  }
  if (!keyToUse) {
    return res.status(429).json({ error: 'All API keys are used up for this month' });
  }

  try {
    // Fetch with JavaScript rendering enabled
    const apiUrl = `http://api.scraperapi.com?api_key=${keyToUse}&url=${encodeURIComponent(query)}&render=true`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`ScraperAPI error: ${response.statusText}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract structured data
    const title = $('h1').first().text().trim() || $('title').text().trim() || 'No title';
    const intro = $('p').filter((i, el) => $(el).text().trim().length > 50).first().text().trim() || 'No intro';
    const sections = $('h2, h3').map((i, el) => $(el).text().trim()).get().filter(text => text);

    // Domain-specific extraction
    let customData = {};
    const urlObj = new URL(query);
    if (urlObj.hostname.includes('wikipedia.org')) {
      customData.intro = $('#mw-content-text .mw-parser-output > p:not(.mw-empty-elt)').first().text().trim() || intro;
      customData.sections = $('#mw-content-text .mw-parser-output > h2').map((i, el) => $(el).text().trim()).get();
    } else if (urlObj.hostname.includes('amazon')) {
      customData.title = $('#productTitle').text().trim() || title;
      customData.description = $('#feature-bullets').text().trim() || $('#productDescription').text().trim() || 'No description';
    }

    usageCounts[currentKeyIndex]++;
    fs.writeFileSync('usage.json', JSON.stringify({ currentKeyIndex, usageCounts, lastResetMonth }), 'utf8');

    res.json({
      result: {
        rawHtml: html.slice(0, 1000), // Limit for debugging
        title: customData.title || title,
        intro: customData.intro || intro,
        sections: customData.sections || sections
      }
    });
  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: `Failed to scrape: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
