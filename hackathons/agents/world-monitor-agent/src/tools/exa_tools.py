"""
EXA search integration — general web search and news search.

EXA provides high-quality semantic search over the web with full content extraction.
Used as the primary web search engine (instead of DuckDuckGo).
"""

import asyncio
import os
from typing import Optional

EXA_API_KEY = os.environ.get("EXA_API_KEY", "")


def _get_exa():
    """Lazy import to avoid import error if exa-py not installed."""
    try:
        from exa_py import Exa
    except ImportError:
        raise RuntimeError("exa-py not installed. Run: pip install exa-py")
    if not EXA_API_KEY:
        raise RuntimeError("EXA_API_KEY not set")
    return Exa(EXA_API_KEY)


def _search_web_sync(
    query: str,
    num_results: int = 10,
    search_type: str = "auto",
    include_domains: Optional[list[str]] = None,
) -> list[dict]:
    """Run EXA web search synchronously."""
    exa = _get_exa()
    kwargs = {
        "num_results": num_results,
        "type": search_type,
        "use_autoprompt": True,
        "text": {"max_characters": 1000},
    }
    if include_domains:
        kwargs["include_domains"] = include_domains

    response = exa.search_and_contents(query, **kwargs)
    results = []
    for r in response.results:
        results.append({
            "title": r.title or "",
            "url": r.url or "",
            "snippet": (r.text or "")[:500],
            "published_date": getattr(r, "published_date", "") or "",
            "author": getattr(r, "author", "") or "",
        })
    return results


def _search_news_sync(query: str, num_results: int = 10) -> list[dict]:
    """Run EXA news search synchronously."""
    exa = _get_exa()
    response = exa.search_and_contents(
        query,
        num_results=num_results,
        type="auto",
        use_autoprompt=True,
        text={"max_characters": 800},
        category="news",
    )
    results = []
    for r in response.results:
        results.append({
            "title": r.title or "",
            "url": r.url or "",
            "snippet": (r.text or "")[:500],
            "published_date": getattr(r, "published_date", "") or "",
            "source": _extract_domain(r.url or ""),
        })
    return results


def _extract_domain(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc
    except Exception:
        return ""


async def search_web(query: str, num_results: int = 10) -> list[dict]:
    """Semantic web search via EXA."""
    try:
        return await asyncio.to_thread(_search_web_sync, query, num_results)
    except Exception as e:
        return [{"error": f"EXA web search failed: {e}"}]


async def search_news(query: str, num_results: int = 10) -> list[dict]:
    """News-focused search via EXA."""
    try:
        return await asyncio.to_thread(_search_news_sync, query, num_results)
    except Exception as e:
        return [{"error": f"EXA news search failed: {e}"}]
