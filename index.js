const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

app.use(cors({ origin: '*' })); // Allow chatbot requests from any domain
app.use(express.json({ limit: '10mb' })); // Handle larger payloads

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Direct scraping with fetch and cheerio (fallback)
async function scrapeWithFetch(url) {
    try {
        const response = await fetch(url, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatbotScraper/1.0)' }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const html = await response.text();
        const $ = cheerio.load(html);

        const title = $('title').text().trim() || 'Untitled';
        const description = $('meta[name="description"]').attr('content')?.trim() || '';
        const paragraphs = $('p')
            .map((i, el) => $(el).text().trim())
            .get()
            .filter(p => p.length > 20); // Match chatbot's filtering
        const images = $('img')
            .map((i, el) => {
                const src = $(el).attr('src') || '';
                const alt = $(el).attr('alt') || 'Image';
                return src ? { src: new URL(src, url).href, alt } : null; // Resolve relative URLs
            })
            .get()
            .filter(img => img !== null);

        return {
            title,
            description,
            paragraphs,
            images
        };
    } catch (error) {
        console.error(`[scrapeWithFetch] Error scraping ${url}: ${error.message}`);
        throw new Error(`Failed to scrape with fetch: ${error.message}`);
    }
}

// ScraperAPI integration (primary for #queries)
async function scrapeWithScraperAPI(url, autoparse = true, render_js = true) {
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

        // Transform to chatbot's expected format
        return {
            title: data.title || 'Untitled',
            description: data.description || '',
            paragraphs: (data.paragraphs || []).filter(p => p.length > 20),
            images: (data.images || []).map(img => ({
                src: img.src || '',
                alt: img.alt || 'Image'
            }))
        };
    } catch (error) {
        console.error(`[scrapeWithScraperAPI] Error scraping ${url}: ${error.message}`);
        throw new Error(`ScraperAPI failed: ${error.message}`);
    }
}

// Spider scraping with ScraperAPI for search results or listings
async function scrapeSpiderWithScraperAPI(url, query, autoparse = true, render_js = true) {
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

        let results = [];
        if (data.organic_results) {
            // For search engines
            results = data.organic_results.map(result => ({
                headline: result.title,
                snippet: result.snippet,
                link: result.link
            }));
        } else if (data.products) {
            // For e-commerce sites
            results = [{
                products: data.products.map(product => ({
                    name: product.name,
                    price: product.price,
                    image: product.image,
                    link: product.link
                }))
            }];
        } else {
            // Fallback: extract paragraphs or other content
            const $ = cheerio.load(data.html);
            const paragraphs = $('p')
                .map((i, el) => $(el).text().trim())
                .get()
                .filter(p => p.length > 20);
            results = paragraphs.map(p => ({ snippet: p }));
        }

        // Extract images if available
        const images = data.images ? data.images.map(img => ({ src: img.src, alt: img.alt || 'Image' })) : [];

        return { results, images };
    } catch (error) {
        console.error(`[scrapeSpiderWithScraperAPI] Error scraping ${url}: ${error.message}`);
        throw new Error(`ScraperAPI spider scrape failed: ${error.message}`);
    }
}

// Scrape endpoint for single URL (handles both DeepSearch modes)
app.post('/scrape', async (req, res) => {
    const { query, autoparse = true, render_js = true, deepSearch = false } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'A valid URL is required in the "query" field' });
    }

    try {
        // Validate URL format
        new URL(query);
    } catch (_) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    console.log(`[scrape] Processing request for URL: ${query} (DeepSearch: ${deepSearch})`);

    try {
        let result;
        if (SCRAPER_API_KEY) {
            console.log('[scrape] Using ScraperAPI');
            result = await scrapeWithScraperAPI(query, autoparse, render_js);
        } else {
            console.log('[scrape] Using direct fetch (fallback)');
            result = await scrapeWithFetch(query);
        }
        res.json({ result });
    } catch (error) {
        console.error(`[scrape] Failed for ${query}: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Spider scrape endpoint for handling search results or listings
app.post('/scrape-spider', async (req, res) => {
    const { query, url, spider, autoparse = true, render_js = true } = req.body;

    if (!url || !query) {
        return res.status(400).json({ error: 'Both "url" and "query" are required' });
    }

    try {
        new URL(url);
    } catch (_) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    console.log(`[scrape-spider] Processing request for URL: ${url}, query: ${query}`);

    try {
        let result;
        if (SCRAPER_API_KEY) {
            console.log('[scrape-spider] Using ScraperAPI');
            result = await scrapeSpiderWithScraperAPI(url, query, autoparse, render_js);
        } else {
            console.log('[scrape-spider] ScraperAPI key missing');
            throw new Error('ScraperAPI key is required for spider scraping');
        }
        res.json({ results: result.results, images: result.images });
    } catch (error) {
        console.error(`[scrape-spider] Failed for ${url}: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(`[server] Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
