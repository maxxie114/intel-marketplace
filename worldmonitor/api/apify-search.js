/**
 * Vercel Edge function — Apify web search proxy.
 *
 * Uses Apify's Google Search Results Scraper to fetch real-time web results
 * for user queries. Returns a summarized list of search results.
 */

export const config = { runtime: 'edge' };

const APIFY_TOKEN = process.env.VITE_APIFY_TOKEN || process.env.APIFY_API_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  if (!APIFY_TOKEN) {
    return new Response(
      JSON.stringify({ error: 'APIFY_API_KEY not configured' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const query = ((body.query || body.message) ?? '').trim();
  if (!query) {
    return new Response(JSON.stringify({ error: 'Missing query' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Use Apify's Google Search Results Scraper (synchronous run)
    const actorUrl = `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

    const res = await fetch(actorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: query,
        maxPagesPerQuery: 1,
        resultsPerPage: 5,
        languageCode: 'en',
        countryCode: 'us',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      // Fallback: try the web scraper for a direct search
      return new Response(
        JSON.stringify({ error: `Apify returned ${res.status}` }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const items = await res.json().catch(() => []);

    // Extract organic results
    const results = [];
    for (const item of items) {
      if (item.organicResults) {
        for (const r of item.organicResults.slice(0, 8)) {
          results.push({
            title: r.title || '',
            url: r.url || r.link || '',
            description: r.description || r.snippet || '',
          });
        }
      }
    }

    // Format as readable text
    let response = '';
    if (results.length > 0) {
      response = `Here's what I found for "${query}":\n\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        response += `**${i + 1}. ${r.title}**\n${r.description}\n${r.url}\n\n`;
      }
    } else {
      response = `No search results found for "${query}". Try rephrasing your query.`;
    }

    return new Response(
      JSON.stringify({ response, results }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message || 'Search failed' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
}
