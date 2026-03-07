/**
 * Vercel Edge function — streaming proxy to the World Monitor intelligence agent.
 *
 * Uses SSE (text/event-stream) so the browser connection stays alive while
 * the agent thinks. Sends ": keep-alive" comments every 5s to prevent
 * proxy/browser timeouts, then streams the final response as a data event.
 *
 * Client should consume this as an EventSource or fetch stream.
 */

export const config = { runtime: 'edge' };

const AGENT_URL = 'https://us14.abilityai.dev/api/agents/intel-marketplace-2/chat';
const AGENT_AUTH = 'Bearer trinity_mcp_sa-ZnRklsQGjN4LZyO6ylxIts9p5ODH82CQwcRREFdo';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const text = ((body.message || body.query) ?? '').trim();
  if (!text) {
    return new Response(JSON.stringify({ error: 'Missing message' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send SSE keep-alive comments every 5s while the agent is thinking
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keep-alive\n\n')); } catch {}
      }, 5000);

      try {
        const upstream = await fetch(AGENT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: AGENT_AUTH,
          },
          body: JSON.stringify({ message: text }),
          signal: AbortSignal.timeout(55_000),
        });

        let response;
        if (upstream.ok) {
          const data = await upstream.json().catch(() => ({}));
          response = (data.response || data.message || '').trim();
          if (!response) response = JSON.stringify(data);
        } else {
          response = `Agent returned error ${upstream.status}. Please try again.`;
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ response })}\n\n`),
        );
      } catch (e) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: e.message || 'Request failed' })}\n\n`),
        );
      } finally {
        clearInterval(keepAlive);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
