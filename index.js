const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// Dynamically load all API keys from environment variables that start with API_KEY_
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

// Load saved usage data if it exists
if (fs.existsSync('usage.json')) {
  const data = fs.readFileSync('usage.json', 'utf8');
  const parsed = JSON.parse(data);
  currentKeyIndex = parsed.currentKeyIndex;
  usageCounts = parsed.usageCounts.slice(0, keys.length); // Adjust for current key count
  lastResetMonth = parsed.lastResetMonth;
}

// Reset usage counts every new month
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

  // Find a key that still has requests left
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
    const apiUrl = `http://api.scraperapi.com?api_key=${keyToUse}&url=${encodeURIComponent(query)}`;
    const response = await fetch(apiUrl);
    const html = await response.text();
    const $ = cheerio.load(html);
    const textContent = $('body').text().replace(/\s+/g, ' ').trim();
    usageCounts[currentKeyIndex]++;
    fs.writeFileSync('usage.json', JSON.stringify({ currentKeyIndex, usageCounts, lastResetMonth }), 'utf8');
    res.json({ result: textContent });
  } catch (error) {
    res.status(500).json({ error: 'Something went wrong while scraping' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
