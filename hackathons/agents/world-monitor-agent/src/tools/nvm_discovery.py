"""
Nevermined discovery + purchase integration.

Discovers other hackathon agents via the Nevermined hackathon discovery API,
then autonomously purchases intelligence from relevant sellers to enrich answers.

Discovery API: GET https://nevermined.ai/hackathon/register/api/discover
Auth: x-nvm-api-key header
"""

import asyncio
import os
from typing import Optional

import httpx

from payments_py import Payments, PaymentOptions
from payments_py.x402.resolve_scheme import resolve_scheme
from payments_py.x402.types import X402TokenOptions

NVM_DISCOVERY_API_KEY = os.environ.get("NVM_DISCOVERY_API_KEY", os.environ.get("NVM_API_KEY", ""))
NVM_ENVIRONMENT = os.environ.get("NVM_ENVIRONMENT", "sandbox")
NVM_PLAN_ID = os.environ.get("NVM_PLAN_ID", "")
NVM_AGENT_ID = os.environ.get("NVM_AGENT_ID", "")

DISCOVERY_BASE = "https://nevermined.ai/hackathon/register/api/discover"

# Cache discovered sellers in memory
_seller_cache: list[dict] = []
_cache_valid = False


async def discover_sellers(
    category: Optional[str] = None,
    force_refresh: bool = False,
) -> list[dict]:
    """
    Discover hackathon seller agents via Nevermined discovery API.

    Args:
        category: Optional category filter (e.g. "AI/ML", "DeFi", "News")
        force_refresh: Force re-fetch even if cached

    Returns:
        List of seller dicts with: name, teamName, category, description,
        keywords, servicesSold, pricing, planIds, nvmAgentId, endpointUrl
    """
    global _seller_cache, _cache_valid

    if _cache_valid and not force_refresh and _seller_cache:
        if category:
            return [s for s in _seller_cache if category.lower() in s.get("category", "").lower()]
        return _seller_cache

    if not NVM_DISCOVERY_API_KEY:
        return []

    try:
        params = {"side": "sell"}
        if category:
            params["category"] = category

        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                DISCOVERY_BASE,
                params=params,
                headers={"x-nvm-api-key": NVM_DISCOVERY_API_KEY},
            )
            if response.status_code != 200:
                return []

            data = response.json()
            sellers = data.get("sellers", data if isinstance(data, list) else [])
            _seller_cache = sellers
            _cache_valid = True
            return sellers

    except Exception:
        return []


async def find_relevant_sellers(query: str, max_sellers: int = 3) -> list[dict]:
    """
    Find sellers relevant to a query by keyword matching.

    Args:
        query: The user's query
        max_sellers: Maximum number of relevant sellers to return

    Returns:
        List of matching seller dicts
    """
    sellers = await discover_sellers()
    if not sellers:
        return []

    query_lower = query.lower()
    scored = []

    for seller in sellers:
        score = 0
        # Match against keywords
        for kw in seller.get("keywords", []):
            if kw.lower() in query_lower or any(w in kw.lower() for w in query_lower.split()):
                score += 2
        # Match against description
        desc = seller.get("description", "").lower()
        for word in query_lower.split():
            if len(word) > 3 and word in desc:
                score += 1
        # Match against services sold
        for svc in seller.get("servicesSold", []):
            if any(w in svc.lower() for w in query_lower.split() if len(w) > 3):
                score += 2
        if score > 0:
            scored.append((score, seller))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [s for _, s in scored[:max_sellers]]


def _get_x402_token(payments: Payments, plan_id: str, agent_id: str) -> Optional[str]:
    """Generate an x402 access token for purchasing from a seller."""
    try:
        scheme = resolve_scheme(payments, plan_id)
        token_options = X402TokenOptions(scheme=scheme)
        token_result = payments.x402.get_x402_access_token(
            plan_id=plan_id,
            agent_id=agent_id or None,
            token_options=token_options,
        )
        return token_result.get("accessToken")
    except Exception:
        return None


async def purchase_from_seller(
    seller: dict,
    query: str,
    payments: Payments,
) -> dict:
    """
    Purchase intelligence from a discovered seller agent via x402 HTTP.

    Args:
        seller: Seller dict from discover_sellers()
        query: The query to send to the seller
        payments: Payments instance (buyer credentials)

    Returns:
        Dict with 'status', 'response', 'credits_used', 'seller_name'
    """
    endpoint = seller.get("endpointUrl", "")
    plan_ids = seller.get("planIds", [])
    agent_id = seller.get("nvmAgentId", "")

    if not endpoint or not plan_ids:
        return {
            "status": "error",
            "response": "Seller has no endpoint or plan",
            "credits_used": 0,
            "seller_name": seller.get("name", "unknown"),
        }

    plan_id = plan_ids[0]

    try:
        # Generate x402 access token in a thread (synchronous SDK call)
        access_token = await asyncio.to_thread(_get_x402_token, payments, plan_id, agent_id)

        if not access_token:
            return {
                "status": "error",
                "response": "Could not generate payment token",
                "credits_used": 0,
                "seller_name": seller.get("name", "unknown"),
            }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{endpoint.rstrip('/')}/data",
                json={"query": query},
                headers={
                    "payment-signature": access_token,
                    "Content-Type": "application/json",
                },
            )

            if response.status_code == 200:
                data = response.json()
                return {
                    "status": "success",
                    "response": data.get("response", str(data)),
                    "credits_used": data.get("credits_used", 0),
                    "seller_name": seller.get("name", "unknown"),
                }
            elif response.status_code == 402:
                return {
                    "status": "payment_required",
                    "response": "Insufficient credits for this seller",
                    "credits_used": 0,
                    "seller_name": seller.get("name", "unknown"),
                }
            else:
                return {
                    "status": "error",
                    "response": f"Seller returned HTTP {response.status_code}",
                    "credits_used": 0,
                    "seller_name": seller.get("name", "unknown"),
                }

    except Exception as e:
        return {
            "status": "error",
            "response": str(e),
            "credits_used": 0,
            "seller_name": seller.get("name", "unknown"),
        }
