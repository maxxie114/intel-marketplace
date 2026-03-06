"""
ZeroClick ad integration.

Fetches contextually relevant ad offers from ZeroClick based on the user's query.
These offers are returned alongside agent responses in a separate `offers` field
so the frontend can render them appropriately — NOT embedded in the response text.

API: POST https://zeroclick.dev/api/v2/offers
Auth: x-zc-api-key header
"""

import asyncio
import os
from typing import Optional

import httpx

ZEROCLICK_API_KEY = os.environ.get("ZEROCLICK_API_KEY", "")
ZEROCLICK_API_URL = "https://zeroclick.dev/api/v2/offers"
ZEROCLICK_IMPRESSION_URL = "https://zeroclick.dev/api/v2/impressions"


async def get_offers(
    query: str,
    client_ip: Optional[str] = None,
    max_offers: int = 3,
) -> list[dict]:
    """
    Fetch ZeroClick ad offers for a given query.

    Args:
        query: The user's query / topic (used for contextual ad matching)
        client_ip: The end-user's IP address (required for server-side calls)
        max_offers: Maximum number of offers to return

    Returns:
        List of offer dicts, each with: id, title, description, url, cta, image_url
        Empty list if ZeroClick not configured or request fails.
    """
    if not ZEROCLICK_API_KEY:
        return []

    payload = {
        "method": "server",
        "query": query[:500],
    }
    if client_ip:
        payload["ipAddress"] = client_ip

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                ZEROCLICK_API_URL,
                json=payload,
                headers={
                    "x-zc-api-key": ZEROCLICK_API_KEY,
                    "Content-Type": "application/json",
                },
            )
            if response.status_code != 200:
                return []

            data = response.json()
            offers = data if isinstance(data, list) else data.get("offers", [])
            return offers[:max_offers]

    except Exception:
        return []


async def track_impression(offer_id: str) -> bool:
    """
    Track that an offer was displayed to a user.
    Note: Per ZeroClick docs, impression tracking should originate from client devices.
    This server-side call is a fallback only.

    Args:
        offer_id: The offer ID from get_offers()

    Returns:
        True if tracking succeeded
    """
    if not ZEROCLICK_API_KEY or not offer_id:
        return False

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                ZEROCLICK_IMPRESSION_URL,
                json={"offerId": offer_id},
                headers={"Content-Type": "application/json"},
            )
            return response.status_code == 204
    except Exception:
        return False
