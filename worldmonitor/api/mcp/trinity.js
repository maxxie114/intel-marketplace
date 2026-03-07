/**
 * Vercel edge function — MCP proxy for Trinity.
 *
 * The Vite dev server handles /api/mcp/trinity in development via a
 * configureServer middleware. On Vercel (production) that middleware doesn't
 * run, so we need this serverless route.
 *
 * Flow per request (MCP is stateless-per-request here):
 *   1. POST initialize  → obtain a session ID
 *   2. POST notifications/initialized (optional, best-effort)
 *   3. POST the actual method (tools/list, tools/call, …)
 *   4. Return JSON result
 */

export const config = { runtime: 'edge' };

const TRINITY_MCP_URL = 'https://mcp-us14.abilityai.dev/mcp';
const TRINITY_AUTH = 'Bearer trinity_mcp_sa-ZnRklsQGjN4LZyO6ylxIts9p5ODH82CQwcRREFdo';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
};

async function mcpFetch(body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: TRINITY_AUTH,
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(TRINITY_MCP_URL, {
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
    );

    // 2. Acknowledge (best-effort, don't fail if it errors)
    if (sessionId) {
      mcpFetch({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId).catch(() => {});
    }

    // 3. Actual request
    const { json } = await mcpFetch(body, sessionId);

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
