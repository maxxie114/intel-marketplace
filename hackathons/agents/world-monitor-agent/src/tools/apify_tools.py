"""
Apify actor integrations for world data scraping.

Actors used:
  - lhotanok/google-news-scraper   — Google News articles
  - apidojo/tweet-scraper          — Twitter/X posts
  - trudax/reddit-scraper          — Reddit posts & comments
  - automation-lab/yahoo-finance-scraper — Stock & market data
  - apify/rag-web-browser          — General web content extraction
"""

import asyncio
import os
from typing import Any

from apify_client import ApifyClient

APIFY_API_KEY = os.environ.get("APIFY_API_KEY", "")

# Actor IDs
ACTOR_GOOGLE_NEWS = "lhotanok/google-news-scraper"
ACTOR_TWEET = "apidojo/tweet-scraper"
ACTOR_REDDIT = "trudax/reddit-scraper"
ACTOR_YAHOO_FINANCE = "automation-lab/yahoo-finance-scraper"
ACTOR_RAG_WEB = "apify/rag-web-browser"


def _get_client() -> ApifyClient:
    if not APIFY_API_KEY:
        raise RuntimeError("APIFY_API_KEY not set")
    return ApifyClient(APIFY_API_KEY)


def _run_actor_sync(actor_id: str, run_input: dict, max_items: int = 20) -> list[dict]:
    """Run an Apify actor synchronously and return dataset items."""
    client = _get_client()
    run = client.actor(actor_id).call(run_input=run_input, timeout_secs=60)
    if not run:
        return []
    items = list(
        client.dataset(run["defaultDatasetId"]).iterate_items(limit=max_items)
    )
    return items


async def _run_actor(actor_id: str, run_input: dict, max_items: int = 20) -> list[dict]:
    """Run an Apify actor asynchronously."""
    return await asyncio.to_thread(_run_actor_sync, actor_id, run_input, max_items)


# ---------------------------------------------------------------------------
# Google News
# ---------------------------------------------------------------------------

async def fetch_news(query: str, max_results: int = 10) -> list[dict]:
    """Fetch news articles from Google News via Apify."""
    run_input = {
        "query": query,
        "maxItems": max_results,
        "language": "en",
        "country": "US",
    }
    try:
        items = await _run_actor(ACTOR_GOOGLE_NEWS, run_input, max_items=max_results)
        results = []
        for item in items:
            results.append({
                "title": item.get("title", ""),
                "description": item.get("description", item.get("snippet", "")),
                "url": item.get("url", item.get("link", "")),
                "source": item.get("source", item.get("publisher", {}).get("title", "")),
                "published_at": item.get("publishedAt", item.get("date", "")),
            })
        return results
    except Exception as e:
        return [{"error": f"Google News fetch failed: {e}"}]


# ---------------------------------------------------------------------------
# Twitter / X
# ---------------------------------------------------------------------------

async def fetch_tweets(query: str, max_results: int = 20) -> list[dict]:
    """Fetch recent tweets from X/Twitter via Apify."""
    run_input = {
        "searchTerms": [query],
        "maxItems": max_results,
        "queryType": "Latest",
        "lang": "en",
    }
    try:
        items = await _run_actor(ACTOR_TWEET, run_input, max_items=max_results)
        results = []
        for item in items:
            results.append({
                "text": item.get("text", item.get("fullText", "")),
                "author": item.get("author", {}).get("userName", ""),
                "likes": item.get("likeCount", 0),
                "retweets": item.get("retweetCount", 0),
                "created_at": item.get("createdAt", ""),
                "url": item.get("url", ""),
            })
        return results
    except Exception as e:
        return [{"error": f"Twitter fetch failed: {e}"}]


# ---------------------------------------------------------------------------
# Reddit
# ---------------------------------------------------------------------------

async def fetch_reddit(query: str, max_results: int = 20) -> list[dict]:
    """Fetch Reddit posts via Apify."""
    run_input = {
        "searches": [query],
        "maxItems": max_results,
        "type": "posts",
        "sort": "top",
    }
    try:
        items = await _run_actor(ACTOR_REDDIT, run_input, max_items=max_results)
        results = []
        for item in items:
            results.append({
                "title": item.get("title", ""),
                "text": item.get("text", item.get("selftext", ""))[:500],
                "subreddit": item.get("subreddit", ""),
                "score": item.get("score", item.get("ups", 0)),
                "num_comments": item.get("numComments", item.get("num_comments", 0)),
                "url": item.get("url", ""),
                "created_at": item.get("createdAt", ""),
            })
        return results
    except Exception as e:
        return [{"error": f"Reddit fetch failed: {e}"}]


# ---------------------------------------------------------------------------
# Yahoo Finance
# ---------------------------------------------------------------------------

async def fetch_finance(ticker_or_query: str, max_results: int = 10) -> list[dict]:
    """Fetch stock/market data via Apify Yahoo Finance scraper."""
    run_input = {
        "symbols": [ticker_or_query.upper()],
        "proxy": {"useApifyProxy": True},
    }
    try:
        items = await _run_actor(ACTOR_YAHOO_FINANCE, run_input, max_items=max_results)
        results = []
        for item in items:
            results.append({
                "symbol": item.get("symbol", ""),
                "name": item.get("shortName", item.get("longName", "")),
                "price": item.get("regularMarketPrice", item.get("price", {}).get("regularMarketPrice")),
                "change_pct": item.get("regularMarketChangePercent", ""),
                "market_cap": item.get("marketCap", ""),
                "summary": item.get("longBusinessSummary", "")[:300] if item.get("longBusinessSummary") else "",
            })
        return results
    except Exception as e:
        return [{"error": f"Finance fetch failed: {e}"}]


# ---------------------------------------------------------------------------
# General Web / RAG Browser
# ---------------------------------------------------------------------------

async def fetch_web_content(url_or_query: str) -> dict[str, Any]:
    """Fetch and extract web content via Apify RAG browser."""
    run_input = {
        "query": url_or_query,
        "maxResults": 3,
    }
    try:
        items = await _run_actor(ACTOR_RAG_WEB, run_input, max_items=3)
        if not items:
            return {"content": "", "sources": []}
        combined = []
        sources = []
        for item in items:
            content = item.get("text", item.get("markdown", item.get("content", "")))
            url = item.get("url", "")
            if content:
                combined.append(content[:800])
            if url:
                sources.append(url)
        return {"content": "\n\n---\n\n".join(combined), "sources": sources}
    except Exception as e:
        return {"error": f"Web fetch failed: {e}", "content": "", "sources": []}
