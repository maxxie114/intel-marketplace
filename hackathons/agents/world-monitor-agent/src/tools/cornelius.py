"""
Cornelius knowledge base integration — INTERNAL USE ONLY.

Queries the Cornelius (intel-marketplace) Trinity agent for internal knowledge.
Results are used to ENRICH agent responses, but raw Cornelius data is NEVER
returned directly to clients or exposed via any API endpoint.

Security contract:
- This module is only called from within the agent's reasoning process
- The agent system prompt explicitly forbids quoting raw KB entries
- No API endpoint should forward Cornelius results verbatim
"""

import asyncio
import os
from typing import Optional

import httpx

CORNELIUS_URL = os.environ.get("CORNELIUS_URL", "").rstrip("/")


async def query_knowledge_base(query: str, max_results: int = 5) -> dict:
    """
    Query the Cornelius knowledge base for internal context.

    Returns synthesized insights from the internal knowledge base.
    This data must NEVER be forwarded raw to any external client.

    Args:
        query: The search query for the knowledge base
        max_results: Maximum number of relevant notes to retrieve

    Returns:
        Dict with 'insights' (synthesized context) and 'found' (bool)
    """
    if not CORNELIUS_URL:
        return {
            "found": False,
            "insights": "",
            "note": "Internal knowledge base not configured",
        }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Try the Trinity agent chat endpoint first
            response = await client.post(
                f"{CORNELIUS_URL}/api/chat",
                json={
                    "message": (
                        f"Search the knowledge base for: {query}\n\n"
                        f"Provide a concise synthesis of the most relevant insights "
                        f"(max {max_results} key points). Do not quote verbatim — "
                        f"synthesize the key ideas."
                    )
                },
                timeout=30.0,
            )
            if response.status_code == 200:
                data = response.json()
                text = data.get("response", data.get("text", ""))
                return {
                    "found": bool(text),
                    "insights": text[:2000],  # cap size
                }

            # Fallback: try generic /search endpoint
            response = await client.post(
                f"{CORNELIUS_URL}/search",
                json={"query": query, "limit": max_results},
                timeout=20.0,
            )
            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [])
                if results:
                    # Summarize results — never return raw content
                    titles = [r.get("title", "") for r in results if r.get("title")]
                    return {
                        "found": True,
                        "insights": f"Found {len(results)} relevant knowledge base entries covering: {', '.join(titles[:5])}",
                    }

    except Exception as e:
        pass

    return {
        "found": False,
        "insights": "",
        "note": "Knowledge base query returned no results",
    }
