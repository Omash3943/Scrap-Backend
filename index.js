const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

async function scrapeWithFetch(url) {
    try {
        const response = await fetch(url, { timeout: 10000 });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const html = await response.text();
        const $ = cheerio.load(html);

        const title = $('title').text() || 'No title';
        const description = $('meta[name="description"]').attr('content') || '';
        const headings = $('h1, h2, h3').map((i, el) => $(el).text().trim()).get();
        const paragraphs = $('p').map((i, el) => $(el).text().trim()).get().filter(p => p.length > 20);
        const items = $('li').map((i, el) => $(el).text().trim()).get().filter(i => i.length > 10);
        const images = $('img').map((i, el) => ({
            src: $(el).attr('src') || '',
            alt: $(el).attr('alt') || ''
        })).get().filter(img => img.src);
        const tables = $('table').map((i, el) => {
            const rows = $(el).find('tr').map((j, row) => {
                return $(row).find('td, th').map((k, cell) => $(cell).text().trim()).get().join(' | ');
            }).get();
            return rows.join('\n');
        }).get();

        return {
            title,
            description,
            headings,
            paragraphs,
            items,
            images,
            tables,
            rawHtml: html
        };
    } catch (error) {
        console.error('Fetch Scraper Error:', error.message);
        throw new Error('Failed to scrape with fetch: ' + error.message);
    }
}

async function scrapeWithScraperAPI(url, autoparse, render_js) {
    try {
        const apiUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&autoparse=${autoparse}&render_js=${render_js}`;
        const response = await fetch(apiUrl, { timeout: 15000 });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        return data;
    } catch (error) {
        console.error('ScraperAPI Error:', error.message);
        throw new Error('ScraperAPI failed: ' + error.message);
    }
}

app.post('/scrape', async (req, res) => {
    const { query, autoparse = true, render_js = true } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        let result;
        if (SCRAPER_API_KEY) {
            result = await scrapeWithScraperAPI(query, autoparse, render_js);
        } else {
            result = await scrapeWithFetch(query);
        }
        res.json({ result });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Invalid URL or scraping failed' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
