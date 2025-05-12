const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(':memory:', (err) => {
    if (err) {
        console.error('Database error:', err.message);
    } else {
        console.log('Connected to SQLite database');
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            api TEXT,
            name TEXT,
            history TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS api_keys (
            user_id TEXT,
            api TEXT,
            key TEXT,
            PRIMARY KEY (user_id, api)
        )`);
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

async function scrapeWithAxios(url) {
    try {
        const { data: html } = await axios.get(url, { timeout: 10000 });
        const dom = new JSDOM(html);
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

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
            rawHtml: html,
            readableContent: article ? article.textContent : ''
        };
    } catch (error) {
        console.error('Axios Scraper Error:', error.message);
        throw new Error('Failed to scrape with Axios: ' + error.message);
    }
}

async function scrapeWithScraperAPI(url, autoparse, render_js) {
    try {
        const apiUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&autoparse=${autoparse}&render_js=${render_js}`;
        const { data } = await axios.get(apiUrl, { timeout: 15000 });
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
            result = await scrapeWithAxios(query);
        }
        res.json({ result });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Invalid URL or scraping failed' });
    }
});

app.get('/sessions/:api', (req, res) => {
    const { api } = req.params;
    db.all('SELECT * FROM sessions WHERE api = ?', [api], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows.map(row => ({
            id: row.id,
            name: row.name,
            history: JSON.parse(row.history || '[]')
        })));
    });
});

app.post('/sessions/:api', (req, res) => {
    const { api } = req.params;
    const { id, name, history } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: 'ID and name are required' });
    }
    db.run('INSERT OR REPLACE INTO sessions (id, api, name, history) VALUES (?, ?, ?, ?)',
        [id, api, name, JSON.stringify(history || [])],
        (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        });
});

app.delete('/sessions/:api/:id', (req, res) => {
    const { api, id } = req.params;
    db.run('DELETE FROM sessions WHERE api = ? AND id = ?', [api, id], (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

app.post('/api_keys', (req, res) => {
    const { user_id, api, key } = req.body;
    if (!user_id || !api || !key) {
        return res.status(400).json({ error: 'user_id, api, and key are required' });
    }
    db.run('INSERT OR REPLACE INTO api_keys (user_id, api, key) VALUES (?, ?, ?)',
        [user_id, api, key],
        (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        });
});

app.get('/api_keys/:user_id/:api', (req, res) => {
    const { user_id, api } = req.params;
    db.get('SELECT key FROM api_keys WHERE user_id = ? AND api = ?', [user_id, api], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'API key not found' });
        }
        res.json({ key: row.key });
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
