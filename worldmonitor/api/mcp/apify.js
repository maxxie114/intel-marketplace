/**
 * Vercel edge function — MCP proxy for Apify.
 *
 * Mirrors the /api/mcp/trinity route but targets the Apify MCP server.
 * Auth uses APIFY_API_KEY env var (set in Vercel project settings).
 */

export const config = { runtime: 'edge' };

const APIFY_MCP_URL = 'https://mcp.apify.com/?tools=docs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
};

async function mcpFetch(body, sessionId, auth) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: auth,
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(APIFY_MCP_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const newSessionId = res.headers.get('mcp-session-id') || sessionId;
  const ct = res.headers.get('content-type') || '';

  let json;
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const dataMatch = text.match(/^data:\s*(.+)$/m);
    json = dataMatch ? JSON.parse(dataMatch[1]) : { result: null };
  } else {
    json = await res.json().catch(() => ({ result: null }));
  }

  return { json, sessionId: newSessionId };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'APIFY_API_KEY not configured' } }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const auth = `Bearer ${apiKey}`;
  const responseHeaders = { ...CORS, 'Content-Type': 'application/json' };

  try {
    const body = await req.text();

    // 1. Initialize session
    const { sessionId } = await mcpFetch(
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'worldmonitor-chat', version: '1.0' },
        },
      },
      null,
      auth,
    );

    // 2. Acknowledge (best-effort)
    if (sessionId) {
      mcpFetch({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId, auth).catch(() => {});
    }

    // 3. Actual request
    const { json } = await mcpFetch(body, sessionId, auth);

    return new Response(JSON.stringify(json), { status: 200, headers: responseHeaders });
  } catch (e) {
    const errBody = JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: e.message },
    });
    return new Response(errBody, { status: 500, headers: responseHeaders });
  }
}
