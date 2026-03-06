"""
World Monitor Agent — Main web server.

Exposes:
  POST /api/chat        — SSE streaming chat
  GET  /api/sellers     — Discovered Nevermined marketplace sellers
  GET  /api/balance     — Nevermined credit balance
  GET  /api/logs/stream — SSE log stream
  GET  /api/offers      — ZeroClick ad offers for a query
  POST /data            — x402 payment-protected data endpoint (for external buyers)
  GET  /health          — Health check
  GET  /.well-known/agent.json — A2A agent card
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from strands.models.anthropic import AnthropicModel

from .log import enable_web_logging, get_logger, log
from .strands_agent import NVM_PLAN_ID, NVM_AGENT_ID, create_agent, payments
from .tools.nvm_discovery import discover_sellers
from .tools.zeroclick import get_offers

PORT = int(os.getenv("PORT", "3000"))

# AnthropicModel auto-reads ANTHROPIC_API_KEY from environment
model = AnthropicModel(
    model_id=os.getenv("MODEL_ID", "claude-sonnet-4-6"),
)
agent = create_agent(model)

# Serialize concurrent chat requests (Strands Agent is not thread-safe)
agent_lock = asyncio.Lock()

# Log broadcast
log_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
_log_subscribers: set[asyncio.Queue] = set()
_log_history: list[dict] = []
_LOG_HISTORY_MAX = 200

_logger = get_logger("world-monitor.web")


async def _log_dispatcher():
    while True:
        entry = await log_queue.get()
        _log_history.append(entry)
        if len(_log_history) > _LOG_HISTORY_MAX:
            _log_history.pop(0)
        dead = []
        for q in _log_subscribers:
            try:
                q.put_nowait(entry)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            _log_subscribers.discard(q)


app = FastAPI(title="World Monitor Agent")


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_log_dispatcher())
    asyncio.create_task(_prefetch_sellers())


async def _prefetch_sellers():
    await asyncio.sleep(5)
    try:
        sellers = await discover_sellers()
        log(_logger, "STARTUP", "DISCOVERY", f"Pre-fetched {len(sellers)} marketplace sellers")
    except Exception:
        pass


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

enable_web_logging(log_queue)


# ---------------------------------------------------------------------------
# A2A Agent Card
# ---------------------------------------------------------------------------

@app.get("/.well-known/agent.json")
async def agent_card():
    """Standard A2A agent card with Nevermined payment extension."""
    base_url = os.getenv("AGENT_URL", f"http://localhost:{PORT}")
    card = {
        "name": "World Monitor Agent",
        "description": (
            "Real-time world intelligence service. Provides news, social signals, "
            "financial data, and deep web research synthesized by AI. "
            "Powered by Apify, EXA, and the Nevermined marketplace."
        ),
        "url": base_url,
        "version": "1.0.0",
        "skills": [
            {
                "id": "news_intelligence",
                "name": "News Intelligence",
                "description": "Latest news from Google News + EXA (2 credits)",
                "tags": ["news", "current events", "media"],
            },
            {
                "id": "social_signals",
                "name": "Social Signals",
                "description": "Twitter/X and Reddit sentiment analysis (3 credits)",
                "tags": ["social media", "sentiment", "twitter", "reddit"],
            },
            {
                "id": "financial_data",
                "name": "Financial Data",
                "description": "Stock prices, market data, financial news (2 credits)",
                "tags": ["finance", "stocks", "markets", "crypto"],
            },
            {
                "id": "deep_research",
                "name": "Deep Web Research",
                "description": "Comprehensive semantic web research (3 credits)",
                "tags": ["research", "analysis", "web"],
            },
        ],
        "capabilities": {
            "streaming": True,
            "pushNotifications": False,
            "extensions": [
                {
                    "uri": "urn:nevermined:payment",
                    "params": {
                        "paymentType": "dynamic",
                        "credits": 2,
                        "planId": NVM_PLAN_ID,
                        "agentId": NVM_AGENT_ID,
                        "costDescription": "Credits vary: news=2, social=3, finance=2, research=3, marketplace=5+",
                    },
                }
            ],
        },
    }
    return JSONResponse(content=card)


# ---------------------------------------------------------------------------
# API endpoints — frontend
# ---------------------------------------------------------------------------

@app.post("/api/chat")
async def chat(request: Request):
    """Stream a chat response from the agent via SSE."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    message = (body.get("message", "") or body.get("prompt", "")).strip()
    if not message:
        return JSONResponse({"error": "Empty message"}, status_code=400)

    client_ip = request.client.host if request.client else None
    log(_logger, "WEB", "CHAT", f'message="{message[:80]}"')

    async def event_generator():
        full_response = ""
        try:
            async with agent_lock:
                async for event in agent.stream_async(message):
                    if "data" in event:
                        chunk = event["data"]
                        full_response += chunk
                        yield {"event": "token", "data": json.dumps({"text": chunk})}
                    elif "current_tool_use" in event:
                        tool_name = event["current_tool_use"].get("name", "")
                        yield {"event": "tool_use", "data": json.dumps({"name": tool_name})}

            # Fetch ZeroClick offers after response
            offers = await get_offers(message, client_ip=client_ip, max_offers=3)

            yield {
                "event": "done",
                "data": json.dumps({"text": full_response, "offers": offers}),
            }
        except Exception as exc:
            log(_logger, "WEB", "CHAT_ERROR", str(exc))
            yield {"event": "error", "data": json.dumps({"error": str(exc)})}

    return EventSourceResponse(event_generator())


@app.get("/api/sellers")
async def get_sellers():
    """Return discovered Nevermined marketplace sellers."""
    sellers = await discover_sellers()
    # Return safe subset — no wallet addresses
    safe = [
        {
            "name": s.get("name", ""),
            "teamName": s.get("teamName", ""),
            "category": s.get("category", ""),
            "description": s.get("description", ""),
            "keywords": s.get("keywords", []),
            "servicesSold": s.get("servicesSold", []),
            "pricing": s.get("pricing", {}),
            "endpointUrl": s.get("endpointUrl", ""),
        }
        for s in sellers
    ]
    return JSONResponse(content=safe)


@app.get("/api/balance")
async def get_balance():
    """Check Nevermined credit balance."""
    try:
        result = payments.plans.get_plan_balance(NVM_PLAN_ID)
        return JSONResponse(content={
            "balance": result.balance,
            "isSubscriber": result.is_subscriber,
            "plan_id": NVM_PLAN_ID,
        })
    except Exception as e:
        return JSONResponse(content={"balance": None, "error": str(e)})


@app.get("/api/offers")
async def get_ad_offers(request: Request, q: str = ""):
    """Fetch ZeroClick ad offers for a query."""
    if not q:
        return JSONResponse(content=[])
    client_ip = request.client.host if request.client else None
    offers = await get_offers(q, client_ip=client_ip)
    return JSONResponse(content=offers)


@app.get("/api/logs/stream")
async def log_stream(request: Request):
    """Stream log entries via SSE."""
    sub_queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    _log_subscribers.add(sub_queue)

    async def event_generator():
        try:
            for entry in _log_history:
                yield {"event": "log", "data": json.dumps(entry)}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    entry = await asyncio.wait_for(sub_queue.get(), timeout=15.0)
                    yield {"event": "log", "data": json.dumps(entry)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        finally:
            _log_subscribers.discard(sub_queue)

    return EventSourceResponse(event_generator())


# ---------------------------------------------------------------------------
# x402 payment-protected endpoint — for external Nevermined buyers
# ---------------------------------------------------------------------------

@app.post("/data")
async def data_endpoint(request: Request):
    """Payment-protected world intelligence endpoint (x402).

    External agents pay Nevermined credits to query this endpoint.
    The PaymentMiddleware handles token verification automatically.
    """
    try:
        body = await request.json()
        query = (body.get("query", "") or body.get("message", "")).strip()
        if not query:
            return JSONResponse({"error": "Empty query"}, status_code=400)

        log(_logger, "DATA", "QUERY", f'"{query[:80]}"')

        result = await asyncio.to_thread(agent, query)
        response_text = str(result)

        return JSONResponse(content={
            "response": response_text,
            "agent": "world-monitor",
        })
    except Exception as e:
        log(_logger, "DATA", "ERROR", str(e))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return JSONResponse({"status": "ok", "agent": "world-monitor"})


@app.get("/ping")
async def ping():
    return {"status": "ok"}



def main():
    import uvicorn
    log(_logger, "WEB", "STARTUP", f"port={PORT}")
    print(f"World Monitor Agent running on http://localhost:{PORT}")
    print(f"  Chat:     POST /api/chat")
    print(f"  Data:     POST /data  (x402 protected)")
    print(f"  Sellers:  GET  /api/sellers")
    print(f"  Balance:  GET  /api/balance")
    print(f"  Health:   GET  /health")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
