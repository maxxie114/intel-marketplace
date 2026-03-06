"""
Agent Staffing Agency integration.

Routes queries to the best working seller on the hackathon marketplace.
Benchmarked 55+ sellers, ~10 actually work. LLM parses plain English,
translates to seller format, and failovers automatically.

Free endpoint: POST /try (1 req/hour)
Paid endpoint: POST /ask (Bearer token, 10 credits/request)

Plan ID:  66865841526873856749601918817346860702290875391909441726439397882859395830112
Agent ID: 4621120870816287494977638753305304144222136554700847503171014504286199563566
"""

import os
import httpx

AGENCY_BASE = "https://noel-argumentatious-tomika.ngrok-free.dev"
AGENCY_PLAN_ID = "66865841526873856749601918817346860702290875391909441726439397882859395830112"
AGENCY_AGENT_ID = "4621120870816287494977638753305304144222136554700847503171014504286199563566"

HEADERS = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
}


async def query_staffing_agency(query: str, use_paid: bool = False) -> dict:
    """
    Send a query to the Agent Staffing Agency.

    Tries the paid /ask endpoint if credentials are available and use_paid=True,
    otherwise falls back to the free /try endpoint.

    Args:
        query: Plain English query (agency LLM routes to best seller)
        use_paid: Whether to use the paid /ask endpoint

    Returns:
        Dict with 'success', 'response', 'seller', 'category', 'error'
    """
    # Try paid endpoint first if requested
    if use_paid:
        nvm_api_key = os.environ.get("NVM_API_KEY", "")
        if nvm_api_key:
            try:
                from payments_py import Payments, PaymentOptions
                payments = Payments.get_instance(
                    PaymentOptions(nvm_api_key=nvm_api_key, environment=os.environ.get("NVM_ENVIRONMENT", "sandbox"))
                )
                balance = payments.plans.get_plan_balance(AGENCY_PLAN_ID)
                if balance.balance >= 10:
                    token = getattr(balance, "access_token", None)
                    if token:
                        async with httpx.AsyncClient(timeout=30.0) as client:
                            resp = await client.post(
                                f"{AGENCY_BASE}/ask",
                                headers={**HEADERS, "Authorization": f"Bearer {token}"},
                                json={"query": query},
                            )
                        if resp.status_code == 200:
                            data = resp.json()
                            return _parse_response(data, paid=True)
            except Exception:
                pass  # Fall through to free endpoint

    # Free /try endpoint
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{AGENCY_BASE}/try",
                headers=HEADERS,
                json={"query": query},
            )

        if resp.status_code == 200:
            data = resp.json()
            return _parse_response(data, paid=False)
        elif resp.status_code == 429:
            return {
                "success": False,
                "error": "Free trial limit reached (1/hour). Buy plan for full access.",
                "response": None,
            }
        else:
            return {
                "success": False,
                "error": f"Agency returned HTTP {resp.status_code}",
                "response": None,
            }
    except Exception as e:
        return {"success": False, "error": str(e), "response": None}


def _parse_response(data: dict, paid: bool) -> dict:
    """Normalize agency response."""
    if data.get("success"):
        return {
            "success": True,
            "response": data.get("response") or data.get("result"),
            "seller": data.get("seller_used") or data.get("seller"),
            "category": data.get("category"),
            "routing": data.get("llm_routing", {}),
            "paid": paid,
        }
    else:
        return {
            "success": False,
            "error": data.get("error", "Unknown error"),
            "sellers_tried": data.get("sellers_tried", 0),
            "routing": data.get("llm_routing", {}),
            "response": None,
        }
