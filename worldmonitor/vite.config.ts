import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve, dirname, extname } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';
import pkg from './package.json';
import { VARIANT_META } from './src/config/variant-meta';
import { PROXY_ROUTES, APIFY_ENV_KEYS, CACHE_TTLS, type ProxyRoute } from './src/services/apify-config';

// Load .env.local into process.env before plugins run
const _env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');
for (const [key, val] of Object.entries(_env)) {
  if (!(key in process.env)) process.env[key] = val;
}

const isE2E = process.env.VITE_E2E === '1';
const isDesktopBuild = process.env.VITE_DESKTOP_RUNTIME === '1';

const brotliCompressAsync = promisify(brotliCompress);
const BROTLI_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.wasm']);

function brotliPrecompressPlugin(): Plugin {
  return {
    name: 'brotli-precompress',
    apply: 'build',
    async writeBundle(outputOptions, bundle) {
      const outDir = outputOptions.dir;
      if (!outDir) return;

      await Promise.all(Object.keys(bundle).map(async (fileName) => {
        const extension = extname(fileName).toLowerCase();
        if (!BROTLI_EXTENSIONS.has(extension)) return;

        const sourcePath = resolve(outDir, fileName);
        const compressedPath = `${sourcePath}.br`;
        const sourceBuffer = await readFile(sourcePath);
        if (sourceBuffer.length < 1024) return;

        const compressedBuffer = await brotliCompressAsync(sourceBuffer);
        await mkdir(dirname(compressedPath), { recursive: true });
        await writeFile(compressedPath, compressedBuffer);
      }));
    },
  };
}

const activeVariant = process.env.VITE_VARIANT || 'full';
const activeMeta = VARIANT_META[activeVariant] || VARIANT_META.full;

function htmlVariantPlugin(): Plugin {
  return {
    name: 'html-variant',
    transformIndexHtml(html) {
      let result = html
        .replace(/<title>.*?<\/title>/, `<title>${activeMeta.title}</title>`)
        .replace(/<meta name="title" content=".*?" \/>/, `<meta name="title" content="${activeMeta.title}" />`)
        .replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${activeMeta.description}" />`)
        .replace(/<meta name="keywords" content=".*?" \/>/, `<meta name="keywords" content="${activeMeta.keywords}" />`)
        .replace(/<link rel="canonical" href=".*?" \/>/, `<link rel="canonical" href="${activeMeta.url}" />`)
        .replace(/<meta name="application-name" content=".*?" \/>/, `<meta name="application-name" content="${activeMeta.siteName}" />`)
        .replace(/<meta property="og:url" content=".*?" \/>/, `<meta property="og:url" content="${activeMeta.url}" />`)
        .replace(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${activeMeta.title}" />`)
        .replace(/<meta property="og:description" content=".*?" \/>/, `<meta property="og:description" content="${activeMeta.description}" />`)
        .replace(/<meta property="og:site_name" content=".*?" \/>/, `<meta property="og:site_name" content="${activeMeta.siteName}" />`)
        .replace(/<meta name="subject" content=".*?" \/>/, `<meta name="subject" content="${activeMeta.subject}" />`)
        .replace(/<meta name="classification" content=".*?" \/>/, `<meta name="classification" content="${activeMeta.classification}" />`)
        .replace(/<meta name="twitter:url" content=".*?" \/>/, `<meta name="twitter:url" content="${activeMeta.url}" />`)
        .replace(/<meta name="twitter:title" content=".*?" \/>/, `<meta name="twitter:title" content="${activeMeta.title}" />`)
        .replace(/<meta name="twitter:description" content=".*?" \/>/, `<meta name="twitter:description" content="${activeMeta.description}" />`)
        .replace(/"name": "World Monitor"/, `"name": "${activeMeta.siteName}"`)
        .replace(/"alternateName": "WorldMonitor"/, `"alternateName": "${activeMeta.siteName.replace(' ', '')}"`)
        .replace(/"url": "https:\/\/worldmonitor\.app\/"/, `"url": "${activeMeta.url}"`)
        .replace(/"description": "Real-time global intelligence dashboard with live news, markets, military tracking, infrastructure monitoring, and geopolitical data."/, `"description": "${activeMeta.description}"`)
        .replace(/"featureList": \[[\s\S]*?\]/, `"featureList": ${JSON.stringify(activeMeta.features, null, 8).replace(/\n/g, '\n      ')}`);

      // Theme-color meta — warm cream for happy variant
      if (activeVariant === 'happy') {
        result = result.replace(
          /<meta name="theme-color" content=".*?" \/>/,
          '<meta name="theme-color" content="#FAFAF5" />'
        );
      }

      // Desktop builds: inject build-time variant into the inline script so data-variant is set
      // before CSS loads. Web builds always use 'full' — runtime hostname detection handles variants.
      if (activeVariant !== 'full') {
        result = result.replace(
          /if\(v\)document\.documentElement\.dataset\.variant=v;/,
          `v='${activeVariant}';document.documentElement.dataset.variant=v;`
        );
      }

      // Desktop CSP: inject localhost wildcard for dynamic sidecar port.
      // Web builds intentionally exclude localhost to avoid exposing attack surface.
      if (isDesktopBuild) {
        result = result
          .replace(
            /connect-src 'self' https: http:\/\/localhost:5173/,
            "connect-src 'self' https: http://localhost:5173 http://127.0.0.1:*"
          )
          .replace(
            /frame-src 'self'/,
            "frame-src 'self' http://127.0.0.1:*"
          );
      }

      // Desktop builds: replace favicon paths with variant-specific subdirectory.
      // Web builds use 'full' favicons in HTML; runtime JS swaps them per hostname.
      if (activeVariant !== 'full') {
        result = result
          .replace(/\/favico\/favicon/g, `/favico/${activeVariant}/favicon`)
          .replace(/\/favico\/apple-touch-icon/g, `/favico/${activeVariant}/apple-touch-icon`)
          .replace(/\/favico\/android-chrome/g, `/favico/${activeVariant}/android-chrome`)
          .replace(/\/favico\/og-image/g, `/favico/${activeVariant}/og-image`);
      }

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Unified Apify data plugin — replaces all individual proxy rules and plugins.
// All external data fetching goes through Apify REST API (one token).
//
// Tiered approach:
//   1. If an Apify actor ID is configured for the category → read from Apify dataset
//   2. Fallback → direct HTTP fetch (same behavior as original proxies)
//
// Either way, all data flows through this single plugin.
// ---------------------------------------------------------------------------

const APIFY_BASE = 'https://api.apify.com/v2';

interface ApifyCacheEntry {
  data: string;
  contentType: string;
  timestamp: number;
}

const apifyCache = new Map<string, ApifyCacheEntry>();

function apifyCacheGet(key: string, ttlMs: number): ApifyCacheEntry | null {
  const entry = apifyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    apifyCache.delete(key);
    return null;
  }
  return entry;
}

function apifyCacheSet(key: string, data: string, contentType: string): void {
  if (apifyCache.size > 500) {
    const oldest = [...apifyCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 100; i++) apifyCache.delete(oldest[i][0]);
  }
  apifyCache.set(key, { data, contentType, timestamp: Date.now() });
}

/** Fetch data from an Apify actor's last run dataset */
async function fetchFromApifyDataset(actorId: string, token: string): Promise<string> {
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs/last/dataset/items?token=${token}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Apify actor ${actorId}: HTTP ${res.status}`);
  return res.text();
}

/** Direct HTTP fetch (fallback when no Apify actor configured) */
async function fetchDirect(url: string, contentType: string): Promise<{ data: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (contentType === 'application/xml') {
      headers['Accept'] = 'application/rss+xml, application/xml, text/xml, */*';
    } else {
      headers['Accept'] = 'application/json, */*';
    }
    const resp = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    const data = await resp.text();
    const respContentType = resp.headers.get('content-type') || contentType;
    return { data, contentType: respContentType };
  } finally {
    clearTimeout(timer);
  }
}

function apifyPlugin(): Plugin {
  const APIFY_TOKEN = process.env.VITE_APIFY_TOKEN || '';
  const FRED_API_KEY = process.env.FRED_API_KEY || '';

  // Build a set of configured Apify actor IDs per category
  const actorMap = new Map<string, string>();
  for (const [cat, envKey] of Object.entries(APIFY_ENV_KEYS)) {
    const val = process.env[envKey];
    if (val) actorMap.set(cat, val);
  }

  if (APIFY_TOKEN) {
    console.log(`[Apify] Token configured. Actors: ${actorMap.size > 0 ? [...actorMap.entries()].map(([k, v]) => `${k}=${v}`).join(', ') : 'none (using direct HTTP fallback)'}`);
  } else {
    console.log('[Apify] No VITE_APIFY_TOKEN set — using direct HTTP for all data.');
  }

  /** Resolve a request URL to a target URL using proxy routes */
  function resolveProxyRoute(reqUrl: string): { route: ProxyRoute; targetUrl: string } | null {
    // Sort by prefix length descending for most specific match
    for (const route of PROXY_ROUTES) {
      if (reqUrl.startsWith(route.prefix)) {
        const rewritten = route.rewrite(reqUrl);
        return { route, targetUrl: route.target + rewritten };
      }
    }
    return null;
  }

  return {
    name: 'apify-unified',
    configureServer(server) {
      // --- MCP Proxy: forwards client-side MCP calls to remote servers (avoids CORS) ---
      // Session IDs are managed server-side per MCP target; SSE responses are parsed to plain JSON.
      const mcpSessions: Record<string, string> = {};

      async function mcpFetch(mcpUrl: string, body: string, authHeader: string | null, sessionId: string | null): Promise<{ status: number; json: any; sessionId: string | null }> {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        };
        if (authHeader) headers['Authorization'] = authHeader;
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;

        const mcpRes = await fetch(mcpUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
        const newSessionId = mcpRes.headers.get('mcp-session-id') || sessionId;
        const ct = mcpRes.headers.get('content-type') || '';

        let json: any;
        if (ct.includes('text/event-stream')) {
          // Parse SSE: extract the JSON from the last "data:" line
          const text = await mcpRes.text();
          const dataLines = text.split('\n').filter(l => l.startsWith('data: ') || l.startsWith('data:'));
          const lastData = dataLines.length > 0 ? dataLines[dataLines.length - 1].replace(/^data:\s?/, '') : null;
          json = lastData ? JSON.parse(lastData) : { error: { code: -32000, message: 'No data in SSE response' } };
        } else {
          json = await mcpRes.json();
        }
        return { status: mcpRes.status, json, sessionId: newSessionId };
      }

      async function ensureSession(target: string, mcpUrl: string, auth: string | null): Promise<string | null> {
        if (mcpSessions[target]) return mcpSessions[target];
        const initBody = JSON.stringify({
          jsonrpc: '2.0', id: Date.now(),
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'worldmonitor', version: '1.0' } },
        });
        const { sessionId } = await mcpFetch(mcpUrl, initBody, auth, null);
        if (sessionId) mcpSessions[target] = sessionId;
        return sessionId;
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/mcp/')) return next();

        const target = req.url.startsWith('/api/mcp/trinity') ? 'trinity' : req.url.startsWith('/api/mcp/apify') ? 'apify' : null;
        if (!target) return next();

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        const body = Buffer.concat(chunks).toString();

        const mcpUrl = target === 'trinity'
          ? 'https://mcp-us14.abilityai.dev/mcp'
          : 'https://mcp.apify.com/?tools=docs';
        const auth = target === 'trinity'
          ? 'Bearer trinity_mcp_sa-ZnRklsQGjN4LZyO6ylxIts9p5ODH82CQwcRREFdo'
          : null;

        try {
          // Ensure we have an active session
          let sessionId = await ensureSession(target, mcpUrl, auth);

          let result = await mcpFetch(mcpUrl, body, auth, sessionId);

          // If session expired, re-initialize and retry once
          if (result.status === 400 || result.json?.error?.message?.includes('session')) {
            delete mcpSessions[target];
            sessionId = await ensureSession(target, mcpUrl, auth);
            result = await mcpFetch(mcpUrl, body, auth, sessionId);
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(result.json));
        } catch (err: any) {
          console.error(`[MCP Proxy] ${target} error:`, err.message);
          delete mcpSessions[target];
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null }));
        }
      });

      // --- Handle /api/intel-chat (proxy to Trinity agent) ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/intel-chat') || req.method !== 'POST') return next();

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const message = (body.message || body.query || '').trim();

        if (!message) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing message' }));
          return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const keepAlive = setInterval(() => {
          try { res.write(': keep-alive\n\n'); } catch {}
        }, 5000);

        try {
          const upstream = await fetch('https://us14.abilityai.dev/api/agents/intel-marketplace-2/chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer trinity_mcp_sa-ZnRklsQGjN4LZyO6ylxIts9p5ODH82CQwcRREFdo',
            },
            body: JSON.stringify({ message }),
            signal: AbortSignal.timeout(55_000),
          });

          let response: string;
          if (upstream.ok) {
            const data = await upstream.json().catch(() => ({})) as Record<string, any>;
            response = ((data.response || data.message || '') as string).trim();
            if (!response) response = JSON.stringify(data);
          } else {
            response = `Agent returned error ${upstream.status}. Please try again.`;
          }

          res.write(`data: ${JSON.stringify({ response })}\n\n`);
        } catch (e: any) {
          res.write(`data: ${JSON.stringify({ error: e.message || 'Request failed' })}\n\n`);
        } finally {
          clearInterval(keepAlive);
          res.end();
        }
      });

      // --- Handle /api/apify-search (web search via Apify Google Search Scraper) ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/apify-search') || req.method !== 'POST') return next();

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const query = (body.query || body.message || '').trim();

        if (!query) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing query' }));
          return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        try {
          const actorUrl = `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
          const upstream = await fetch(actorUrl, {
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

          if (!upstream.ok) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: `Apify returned ${upstream.status}` }));
            return;
          }

          const items = await upstream.json().catch(() => []) as any[];
          const results: Array<{ title: string; url: string; description: string }> = [];
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

          let response = '';
          if (results.length > 0) {
            response = `Here's what I found for "${query}":\n\n`;
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              response += `**${i + 1}. ${r.title}**\n${r.description}\n${r.url}\n\n`;
            }
          } else {
            response = `No search results found for "${query}".`;
          }

          res.end(JSON.stringify({ response, results }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message || 'Search failed' }));
        }
      });

      // --- Handle /api/rss-proxy (used by the client for RSS feeds) ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/rss-proxy')) return next();

        const url = new URL(req.url, 'http://localhost');
        const feedUrl = url.searchParams.get('url');
        if (!feedUrl) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing url parameter' }));
          return;
        }

        const cacheKey = `rss:${feedUrl}`;
        const ttl = CACHE_TTLS['rss'] || 300_000;
        const cached = apifyCacheGet(cacheKey, ttl);
        if (cached) {
          res.setHeader('Content-Type', cached.contentType);
          res.setHeader('X-Apify-Source', 'cache');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(cached.data);
          return;
        }

        try {
          // If RSS Apify actor is configured, use it; otherwise direct fetch
          const rssActorId = actorMap.get('rss');
          let data: string;
          if (APIFY_TOKEN && rssActorId) {
            data = await fetchFromApifyDataset(rssActorId, APIFY_TOKEN);
          } else {
            const result = await fetchDirect(feedUrl, 'application/xml');
            data = result.data;
          }
          apifyCacheSet(cacheKey, data, 'application/xml');
          res.setHeader('Content-Type', 'application/xml');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Apify-Source', APIFY_TOKEN && rssActorId ? 'apify' : 'direct');
          res.end(data);
        } catch (error: any) {
          console.error('[Apify RSS]', feedUrl, error.message);
          res.statusCode = error.name === 'AbortError' ? 504 : 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch feed' }));
        }
      });

      // --- Handle /api/polymarket ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/polymarket')) return next();

        const url = new URL(req.url, 'http://localhost');
        const endpoint = url.searchParams.get('endpoint') || 'markets';
        const closed = ['true', 'false'].includes(url.searchParams.get('closed') ?? '') ? url.searchParams.get('closed') : 'false';
        const order = ['volume', 'liquidity', 'startDate', 'endDate', 'spread'].includes(url.searchParams.get('order') ?? '') ? url.searchParams.get('order') : 'volume';
        const ascending = ['true', 'false'].includes(url.searchParams.get('ascending') ?? '') ? url.searchParams.get('ascending') : 'false';
        const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(100, rawLimit));
        const params = new URLSearchParams({ closed: closed!, order: order!, ascending: ascending!, limit: String(limit) });
        if (endpoint === 'events') {
          const tag = (url.searchParams.get('tag') ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 100);
          if (tag) params.set('tag_slug', tag);
        }

        const gammaUrl = `https://gamma-api.polymarket.com/${endpoint === 'events' ? 'events' : 'markets'}?${params}`;
        const cacheKey = `polymarket:${gammaUrl}`;
        const cached = apifyCacheGet(cacheKey, CACHE_TTLS['prediction'] || 120_000);
        if (cached) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Apify-Source', 'cache');
          res.end(cached.data);
          return;
        }

        res.setHeader('Content-Type', 'application/json');
        try {
          const polyActorId = actorMap.get('polymarket');
          let data: string;
          if (APIFY_TOKEN && polyActorId) {
            data = await fetchFromApifyDataset(polyActorId, APIFY_TOKEN);
          } else {
            const result = await fetchDirect(gammaUrl, 'application/json');
            data = result.data;
          }
          apifyCacheSet(cacheKey, data, 'application/json');
          res.setHeader('Cache-Control', 'public, max-age=120');
          res.setHeader('X-Apify-Source', APIFY_TOKEN && polyActorId ? 'apify' : 'direct');
          res.end(data);
        } catch {
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end('[]');
        }
      });

      // --- Handle /api/youtube/live ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/youtube/live')) return next();

        const url = new URL(req.url, 'http://localhost');
        const channel = url.searchParams.get('channel');
        if (!channel) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing channel parameter' }));
          return;
        }

        try {
          const ytActorId = actorMap.get('youtube');
          if (APIFY_TOKEN && ytActorId) {
            const data = await fetchFromApifyDataset(ytActorId, APIFY_TOKEN);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.end(data);
            return;
          }

          // Direct fetch fallback
          const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
          const liveUrl = `https://www.youtube.com/${channelHandle}/live`;
          const ytRes = await fetch(liveUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            redirect: 'follow',
          });

          let videoId: string | null = null;
          if (ytRes.ok) {
            const html = await ytRes.text();
            const detailsIdx = html.indexOf('"videoDetails"');
            if (detailsIdx !== -1) {
              const block = html.substring(detailsIdx, detailsIdx + 5000);
              const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
              const liveMatch = block.match(/"isLive"\s*:\s*true/);
              if (vidMatch && liveMatch) videoId = vidMatch[1];
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end(JSON.stringify({ videoId, isLive: videoId !== null, channel }));
        } catch (error) {
          console.error('[Apify YouTube]', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch', videoId: null }));
        }
      });

      // --- Handle /api/fred-data (special rewrite with API key) ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/fred-data')) return next();

        const url = new URL(req.url, 'http://localhost');
        const seriesId = url.searchParams.get('series_id');
        const start = url.searchParams.get('observation_start');
        const end = url.searchParams.get('observation_end');
        const fredUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=10${start ? `&observation_start=${start}` : ''}${end ? `&observation_end=${end}` : ''}`;

        const cacheKey = `fred:${seriesId}`;
        const cached = apifyCacheGet(cacheKey, CACHE_TTLS['economic'] || 1_800_000);
        if (cached) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Apify-Source', 'cache');
          res.end(cached.data);
          return;
        }

        try {
          const econActorId = actorMap.get('economic');
          let data: string;
          if (APIFY_TOKEN && econActorId) {
            data = await fetchFromApifyDataset(econActorId, APIFY_TOKEN);
          } else {
            const result = await fetchDirect(fredUrl, 'application/json');
            data = result.data;
          }
          apifyCacheSet(cacheKey, data, 'application/json');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Apify-Source', APIFY_TOKEN && econActorId ? 'apify' : 'direct');
          res.end(data);
        } catch (error: any) {
          console.error('[Apify FRED]', error.message);
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch FRED data' }));
        }
      });

      // --- Handle ALL /api/* and /rss/* proxy routes ---
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        // Skip routes already handled above and sebuf routes (handled next)
        if (req.url.startsWith('/api/rss-proxy')) return next();
        if (req.url.startsWith('/api/polymarket')) return next();
        if (req.url.startsWith('/api/youtube/live')) return next();
        if (req.url.startsWith('/api/fred-data')) return next();
        if (/^\/api\/[a-z-]+\/v1\//.test(req.url)) return next(); // sebuf handled below

        const resolved = resolveProxyRoute(req.url);
        if (!resolved) return next();

        const { route, targetUrl } = resolved;
        const contentType = route.contentType || 'application/json';
        const cacheKey = `proxy:${targetUrl}`;
        const ttl = CACHE_TTLS[route.category] || 300_000;

        const cached = apifyCacheGet(cacheKey, ttl);
        if (cached) {
          res.setHeader('Content-Type', cached.contentType);
          res.setHeader('X-Apify-Source', 'cache');
          if (contentType === 'application/xml') res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(cached.data);
          return;
        }

        try {
          const actorId = actorMap.get(route.category);
          let data: string;
          let actualContentType = contentType;

          if (APIFY_TOKEN && actorId) {
            data = await fetchFromApifyDataset(actorId, APIFY_TOKEN);
            res.setHeader('X-Apify-Source', 'apify');
          } else {
            const result = await fetchDirect(targetUrl, contentType);
            data = result.data;
            actualContentType = result.contentType;
            res.setHeader('X-Apify-Source', 'direct');
          }

          apifyCacheSet(cacheKey, data, actualContentType);
          res.setHeader('Content-Type', actualContentType);
          res.setHeader('Cache-Control', 'public, max-age=300');
          if (contentType === 'application/xml') res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(data);
        } catch (error: any) {
          console.error(`[Apify Proxy] ${targetUrl}:`, error.message);
          res.statusCode = error.name === 'AbortError' ? 504 : 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch' }));
        }
      });
    },
  };
}

/**
 * Vite dev server plugin for sebuf API routes.
 *
 * Intercepts requests matching /api/{domain}/v1/* and routes them through
 * the same handler pipeline as the Vercel catch-all gateway. When an Apify
 * actor is configured for a domain, data is fetched from Apify instead.
 */
function sebufApiPlugin(): Plugin {
  // Cache router across requests (H-13 fix). Invalidated by Vite's module graph on HMR.
  let cachedRouter: Awaited<ReturnType<typeof buildRouter>> | null = null;
  let cachedCorsMod: any = null;

  async function buildRouter() {
    const [
      routerMod, corsMod, errorMod,
      seismologyServerMod, seismologyHandlerMod,
      wildfireServerMod, wildfireHandlerMod,
      climateServerMod, climateHandlerMod,
      predictionServerMod, predictionHandlerMod,
      displacementServerMod, displacementHandlerMod,
      aviationServerMod, aviationHandlerMod,
      researchServerMod, researchHandlerMod,
      unrestServerMod, unrestHandlerMod,
      conflictServerMod, conflictHandlerMod,
      maritimeServerMod, maritimeHandlerMod,
      cyberServerMod, cyberHandlerMod,
      economicServerMod, economicHandlerMod,
      infrastructureServerMod, infrastructureHandlerMod,
      marketServerMod, marketHandlerMod,
      newsServerMod, newsHandlerMod,
      intelligenceServerMod, intelligenceHandlerMod,
      militaryServerMod, militaryHandlerMod,
      positiveEventsServerMod, positiveEventsHandlerMod,
      givingServerMod, givingHandlerMod,
      tradeServerMod, tradeHandlerMod,
      supplyChainServerMod, supplyChainHandlerMod,
      naturalServerMod, naturalHandlerMod,
    ] = await Promise.all([
        import('./server/router'),
        import('./server/cors'),
        import('./server/error-mapper'),
        import('./src/generated/server/worldmonitor/seismology/v1/service_server'),
        import('./server/worldmonitor/seismology/v1/handler'),
        import('./src/generated/server/worldmonitor/wildfire/v1/service_server'),
        import('./server/worldmonitor/wildfire/v1/handler'),
        import('./src/generated/server/worldmonitor/climate/v1/service_server'),
        import('./server/worldmonitor/climate/v1/handler'),
        import('./src/generated/server/worldmonitor/prediction/v1/service_server'),
        import('./server/worldmonitor/prediction/v1/handler'),
        import('./src/generated/server/worldmonitor/displacement/v1/service_server'),
        import('./server/worldmonitor/displacement/v1/handler'),
        import('./src/generated/server/worldmonitor/aviation/v1/service_server'),
        import('./server/worldmonitor/aviation/v1/handler'),
        import('./src/generated/server/worldmonitor/research/v1/service_server'),
        import('./server/worldmonitor/research/v1/handler'),
        import('./src/generated/server/worldmonitor/unrest/v1/service_server'),
        import('./server/worldmonitor/unrest/v1/handler'),
        import('./src/generated/server/worldmonitor/conflict/v1/service_server'),
        import('./server/worldmonitor/conflict/v1/handler'),
        import('./src/generated/server/worldmonitor/maritime/v1/service_server'),
        import('./server/worldmonitor/maritime/v1/handler'),
        import('./src/generated/server/worldmonitor/cyber/v1/service_server'),
        import('./server/worldmonitor/cyber/v1/handler'),
        import('./src/generated/server/worldmonitor/economic/v1/service_server'),
        import('./server/worldmonitor/economic/v1/handler'),
        import('./src/generated/server/worldmonitor/infrastructure/v1/service_server'),
        import('./server/worldmonitor/infrastructure/v1/handler'),
        import('./src/generated/server/worldmonitor/market/v1/service_server'),
        import('./server/worldmonitor/market/v1/handler'),
        import('./src/generated/server/worldmonitor/news/v1/service_server'),
        import('./server/worldmonitor/news/v1/handler'),
        import('./src/generated/server/worldmonitor/intelligence/v1/service_server'),
        import('./server/worldmonitor/intelligence/v1/handler'),
        import('./src/generated/server/worldmonitor/military/v1/service_server'),
        import('./server/worldmonitor/military/v1/handler'),
        import('./src/generated/server/worldmonitor/positive_events/v1/service_server'),
        import('./server/worldmonitor/positive-events/v1/handler'),
        import('./src/generated/server/worldmonitor/giving/v1/service_server'),
        import('./server/worldmonitor/giving/v1/handler'),
        import('./src/generated/server/worldmonitor/trade/v1/service_server'),
        import('./server/worldmonitor/trade/v1/handler'),
        import('./src/generated/server/worldmonitor/supply_chain/v1/service_server'),
        import('./server/worldmonitor/supply-chain/v1/handler'),
        import('./src/generated/server/worldmonitor/natural/v1/service_server'),
        import('./server/worldmonitor/natural/v1/handler'),
      ]);

    const serverOptions = { onError: errorMod.mapErrorToResponse };
    const allRoutes = [
      ...seismologyServerMod.createSeismologyServiceRoutes(seismologyHandlerMod.seismologyHandler, serverOptions),
      ...wildfireServerMod.createWildfireServiceRoutes(wildfireHandlerMod.wildfireHandler, serverOptions),
      ...climateServerMod.createClimateServiceRoutes(climateHandlerMod.climateHandler, serverOptions),
      ...predictionServerMod.createPredictionServiceRoutes(predictionHandlerMod.predictionHandler, serverOptions),
      ...displacementServerMod.createDisplacementServiceRoutes(displacementHandlerMod.displacementHandler, serverOptions),
      ...aviationServerMod.createAviationServiceRoutes(aviationHandlerMod.aviationHandler, serverOptions),
      ...researchServerMod.createResearchServiceRoutes(researchHandlerMod.researchHandler, serverOptions),
      ...unrestServerMod.createUnrestServiceRoutes(unrestHandlerMod.unrestHandler, serverOptions),
      ...conflictServerMod.createConflictServiceRoutes(conflictHandlerMod.conflictHandler, serverOptions),
      ...maritimeServerMod.createMaritimeServiceRoutes(maritimeHandlerMod.maritimeHandler, serverOptions),
      ...cyberServerMod.createCyberServiceRoutes(cyberHandlerMod.cyberHandler, serverOptions),
      ...economicServerMod.createEconomicServiceRoutes(economicHandlerMod.economicHandler, serverOptions),
      ...infrastructureServerMod.createInfrastructureServiceRoutes(infrastructureHandlerMod.infrastructureHandler, serverOptions),
      ...marketServerMod.createMarketServiceRoutes(marketHandlerMod.marketHandler, serverOptions),
      ...newsServerMod.createNewsServiceRoutes(newsHandlerMod.newsHandler, serverOptions),
      ...intelligenceServerMod.createIntelligenceServiceRoutes(intelligenceHandlerMod.intelligenceHandler, serverOptions),
      ...militaryServerMod.createMilitaryServiceRoutes(militaryHandlerMod.militaryHandler, serverOptions),
      ...positiveEventsServerMod.createPositiveEventsServiceRoutes(positiveEventsHandlerMod.positiveEventsHandler, serverOptions),
      ...givingServerMod.createGivingServiceRoutes(givingHandlerMod.givingHandler, serverOptions),
      ...tradeServerMod.createTradeServiceRoutes(tradeHandlerMod.tradeHandler, serverOptions),
      ...supplyChainServerMod.createSupplyChainServiceRoutes(supplyChainHandlerMod.supplyChainHandler, serverOptions),
      ...naturalServerMod.createNaturalServiceRoutes(naturalHandlerMod.naturalHandler, serverOptions),
    ];
    cachedCorsMod = corsMod;
    return routerMod.createRouter(allRoutes);
  }

  return {
    name: 'sebuf-api',
    configureServer(server) {
      // Invalidate cached router on HMR updates to server/ files
      server.watcher.on('change', (file) => {
        if (file.includes('/server/') || file.includes('/src/generated/server/')) {
          cachedRouter = null;
        }
      });

      server.middlewares.use(async (req, res, next) => {
        // Only intercept sebuf routes: /api/{domain}/v1/* (domain may contain hyphens)
        if (!req.url || !/^\/api\/[a-z-]+\/v1\//.test(req.url)) {
          return next();
        }

        try {
          // Build router once, reuse across requests (H-13 fix)
          if (!cachedRouter) {
            cachedRouter = await buildRouter();
          }
          const router = cachedRouter;
          const corsMod = cachedCorsMod;

          // Convert Connect IncomingMessage to Web Standard Request
          const port = server.config.server.port || 3000;
          const url = new URL(req.url, `http://localhost:${port}`);

          // Read body for POST requests
          let body: string | undefined;
          if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            body = Buffer.concat(chunks).toString();
          }

          // Extract headers from IncomingMessage
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(', ');
            }
          }

          const webRequest = new Request(url.toString(), {
            method: req.method,
            headers,
            body: body || undefined,
          });

          const corsHeaders = corsMod.getCorsHeaders(webRequest);

          // OPTIONS preflight
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end();
            return;
          }

          // Origin check
          if (corsMod.isDisallowedOrigin(webRequest)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: 'Origin not allowed' }));
            return;
          }

          // Route matching
          const matchedHandler = router.match(webRequest);
          if (!matchedHandler) {
            const allowed = router.allowedMethods(new URL(webRequest.url).pathname);
            if (allowed.length > 0) {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Allow', allowed.join(', '));
            } else {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
            }
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: res.statusCode === 405 ? 'Method not allowed' : 'Not found' }));
            return;
          }

          // Execute handler
          const response = await matchedHandler(webRequest);

          // Write response
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          for (const [key, value] of Object.entries(corsHeaders)) {
            res.setHeader(key, value);
          }
          res.end(await response.text());
        } catch (err) {
          console.error('[sebuf-api] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    },
  };
}

// RSS proxy allowlist — used by apifyPlugin rss-proxy handler.
const RSS_PROXY_ALLOWED_DOMAINS = new Set([
  'feeds.bbci.co.uk', 'www.theguardian.com', 'feeds.npr.org', 'news.google.com',
  'www.aljazeera.com', 'rss.cnn.com', 'hnrss.org', 'feeds.arstechnica.com',
  'www.theverge.com', 'www.cnbc.com', 'feeds.marketwatch.com', 'www.defenseone.com',
  'breakingdefense.com', 'www.bellingcat.com', 'techcrunch.com', 'huggingface.co',
  'www.technologyreview.com', 'rss.arxiv.org', 'export.arxiv.org',
  'www.federalreserve.gov', 'www.sec.gov', 'www.whitehouse.gov', 'www.state.gov',
  'www.defense.gov', 'home.treasury.gov', 'www.justice.gov', 'tools.cdc.gov',
  'www.fema.gov', 'www.dhs.gov', 'www.thedrive.com', 'krebsonsecurity.com',
  'finance.yahoo.com', 'thediplomat.com', 'venturebeat.com', 'foreignpolicy.com',
  'www.ft.com', 'openai.com', 'www.reutersagency.com', 'feeds.reuters.com',
  'asia.nikkei.com', 'www.cfr.org', 'www.csis.org', 'www.politico.com',
  'www.brookings.edu', 'layoffs.fyi', 'www.defensenews.com', 'www.militarytimes.com',
  'taskandpurpose.com', 'news.usni.org', 'www.oryxspioenkop.com', 'www.gov.uk',
  'www.foreignaffairs.com', 'www.atlanticcouncil.org',
  // Tech variant
  'www.zdnet.com', 'www.techmeme.com', 'www.darkreading.com', 'www.schneier.com',
  'rss.politico.com', 'www.anandtech.com', 'www.tomshardware.com', 'www.semianalysis.com',
  'feed.infoq.com', 'thenewstack.io', 'devops.com', 'dev.to', 'lobste.rs', 'changelog.com',
  'seekingalpha.com', 'news.crunchbase.com', 'www.saastr.com', 'feeds.feedburner.com',
  'www.producthunt.com', 'www.axios.com', 'api.axios.com', 'github.blog', 'githubnext.com',
  'mshibanami.github.io', 'www.engadget.com', 'news.mit.edu', 'dev.events',
  'www.ycombinator.com', 'a16z.com', 'review.firstround.com', 'www.sequoiacap.com',
  'www.nfx.com', 'www.aaronsw.com', 'bothsidesofthetable.com', 'www.lennysnewsletter.com',
  'stratechery.com', 'www.eu-startups.com', 'tech.eu', 'sifted.eu', 'www.techinasia.com',
  'kr-asia.com', 'techcabal.com', 'disrupt-africa.com', 'lavca.org', 'contxto.com',
  'inc42.com', 'yourstory.com', 'pitchbook.com', 'www.cbinsights.com', 'www.techstars.com',
  // Regional & international
  'english.alarabiya.net', 'www.arabnews.com', 'www.timesofisrael.com', 'www.haaretz.com',
  'www.scmp.com', 'kyivindependent.com', 'www.themoscowtimes.com', 'feeds.24.com',
  'feeds.capi24.com', 'www.france24.com', 'www.euronews.com', 'www.lemonde.fr',
  'rss.dw.com', 'www.africanews.com', 'www.lasillavacia.com', 'www.channelnewsasia.com',
  'www.thehindu.com', 'news.un.org', 'www.iaea.org', 'www.who.int', 'www.cisa.gov',
  'www.crisisgroup.org',
  // Think tanks
  'rusi.org', 'warontherocks.com', 'www.aei.org', 'responsiblestatecraft.org',
  'www.fpri.org', 'jamestown.org', 'www.chathamhouse.org', 'ecfr.eu', 'www.gmfus.org',
  'www.wilsoncenter.org', 'www.lowyinstitute.org', 'www.mei.edu', 'www.stimson.org',
  'www.cnas.org', 'carnegieendowment.org', 'www.rand.org', 'fas.org',
  'www.armscontrol.org', 'www.nti.org', 'thebulletin.org', 'www.iss.europa.eu',
  // Economic & Food Security
  'www.fao.org', 'worldbank.org', 'www.imf.org',
  // Regional locale feeds
  'www.hurriyet.com.tr', 'tvn24.pl', 'www.polsatnews.pl', 'www.rp.pl', 'meduza.io',
  'novayagazeta.eu', 'www.bangkokpost.com', 'vnexpress.net', 'www.abc.net.au',
  'news.ycombinator.com',
  // Finance variant
  'www.coindesk.com', 'cointelegraph.com',
  // Happy variant — positive news sources
  'www.goodnewsnetwork.org', 'www.positive.news', 'reasonstobecheerful.world',
  'www.optimistdaily.com', 'www.sunnyskyz.com', 'www.huffpost.com',
  'www.sciencedaily.com', 'feeds.nature.com', 'www.livescience.com', 'www.newscientist.com',
]);

// rssProxyPlugin and youtubeLivePlugin replaced by apifyPlugin() above.

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    htmlVariantPlugin(),
    apifyPlugin(),
    sebufApiPlugin(),
    brotliPrecompressPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,

      includeAssets: [
        'favico/favicon.ico',
        'favico/apple-touch-icon.png',
        'favico/favicon-32x32.png',
      ],

      manifest: {
        name: `${activeMeta.siteName} - ${activeMeta.subject}`,
        short_name: activeMeta.shortName,
        description: activeMeta.description,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0a0f0a',
        background_color: '#0a0f0a',
        categories: activeMeta.categories,
        icons: [
          { src: '/favico/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        globPatterns: ['**/*.{js,css,ico,png,svg,woff2}'],
        globIgnores: ['**/ml*.js', '**/onnx*.wasm', '**/locale-*.js'],
        // globe.gl + three.js grows main bundle past the 2 MiB default limit
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,

        runtimeCaching: [
          {
            urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
              sameOrigin && /^\/api\//.test(url.pathname),
            handler: 'NetworkOnly',
            method: 'GET',
          },
          {
            urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
              sameOrigin && /^\/api\//.test(url.pathname),
            handler: 'NetworkOnly',
            method: 'POST',
          },
          {
            urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
              sameOrigin && /^\/rss\//.test(url.pathname),
            handler: 'NetworkOnly',
            method: 'GET',
          },
          {
            urlPattern: ({ url }: { url: URL }) =>
              url.pathname.endsWith('.pmtiles') ||
              url.hostname.endsWith('.r2.dev') ||
              url.hostname === 'build.protomaps.com',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pmtiles-ranges',
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/protomaps\.github\.io\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'protomaps-assets',
              expiration: { maxEntries: 100, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-css',
              expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-woff',
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/assets\/locale-.*\.js$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'locale-files',
              expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'images',
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },

      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      child_process: resolve(__dirname, 'src/shims/child-process.ts'),
      'node:child_process': resolve(__dirname, 'src/shims/child-process.ts'),
      '@loaders.gl/worker-utils/dist/lib/process-utils/child-process-proxy.js': resolve(
        __dirname,
        'src/shims/child-process-proxy.ts'
      ),
    },
  },
  build: {
    // Geospatial bundles (maplibre/deck) are expected to be large even when split.
    // Raise warning threshold to reduce noisy false alarms in CI.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      onwarn(warning, warn) {
        // onnxruntime-web ships a minified browser bundle that intentionally uses eval.
        // Keep build logs focused by filtering this known third-party warning only.
        if (
          warning.code === 'EVAL'
          && typeof warning.id === 'string'
          && warning.id.includes('/onnxruntime-web/dist/ort-web.min.js')
        ) {
          return;
        }

        warn(warning);
      },
      input: {
        main: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        liveChannels: resolve(__dirname, 'live-channels.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/@xenova/transformers/')) {
              return 'transformers';
            }
            if (id.includes('/onnxruntime-web/')) {
              return 'onnxruntime';
            }
            if (id.includes('/maplibre-gl/') || id.includes('/pmtiles/') || id.includes('/@protomaps/basemaps/')) {
              return 'maplibre';
            }
            if (
              id.includes('/@deck.gl/')
              || id.includes('/@luma.gl/')
              || id.includes('/@loaders.gl/')
              || id.includes('/@math.gl/')
              || id.includes('/h3-js/')
            ) {
              return 'deck-stack';
            }
            if (id.includes('/d3/')) {
              return 'd3';
            }
            if (id.includes('/topojson-client/')) {
              return 'topojson';
            }
            if (id.includes('/i18next')) {
              return 'i18n';
            }
            if (id.includes('/@sentry/')) {
              return 'sentry';
            }
          }
          if (id.includes('/src/components/') && id.endsWith('Panel.ts')) {
            return 'panels';
          }
          // Give lazy-loaded locale chunks a recognizable prefix so the
          // service worker can exclude them from precache (en.json is
          // statically imported into the main bundle).
          const localeMatch = id.match(/\/locales\/(\w+)\.json$/);
          if (localeMatch && localeMatch[1] !== 'en') {
            return `locale-${localeMatch[1]}`;
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3000,
    open: !isE2E,
    hmr: isE2E ? false : undefined,
    watch: {
      ignored: [
        '**/test-results/**',
        '**/playwright-report/**',
        '**/.playwright-mcp/**',
      ],
    },
    // All proxy routes replaced by apifyPlugin() above.
    // Apify plugin handles /api/*, /rss/*, with actor datasets or direct HTTP fallback.
    proxy: {
      // AISStream WebSocket — kept as proxy since WebSocket can't go through Apify
      '/ws/aisstream': {
        target: 'wss://stream.aisstream.io',
        changeOrigin: true,
        ws: true,
        rewrite: (path: string) => path.replace(/^\/ws\/aisstream/, ''),
      },
    },
  },
});
