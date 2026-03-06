"""
Auto-trading script for the World Monitor Agent.

Discovers active sellers on the Nevermined hackathon marketplace,
purchases intelligence from them, and logs all transactions.

Usage:
    python3 scripts/auto_trade.py [--query QUERY] [--max-sellers N] [--dry-run]

Examples:
    python3 scripts/auto_trade.py
    python3 scripts/auto_trade.py --query "AI industry trends"
    python3 scripts/auto_trade.py --max-sellers 2 --dry-run
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Allow running from repo root or scripts/ dir
script_dir = Path(__file__).parent
agent_dir = script_dir.parent
sys.path.insert(0, str(agent_dir))

from dotenv import load_dotenv
load_dotenv(agent_dir / ".env")
load_dotenv()  # fallback to cwd

import httpx
from payments_py import Payments, PaymentOptions
from payments_py.x402.resolve_scheme import resolve_scheme
from payments_py.x402.types import X402TokenOptions

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NVM_API_KEY = os.environ.get("NVM_API_KEY", "")
NVM_ENVIRONMENT = os.environ.get("NVM_ENVIRONMENT", "sandbox")
NVM_PLAN_ID = os.environ.get("NVM_PLAN_ID", "")
NVM_DISCOVERY_API_KEY = os.environ.get("NVM_DISCOVERY_API_KEY", NVM_API_KEY)

DISCOVERY_URL = "https://nevermined.ai/hackathon/register/api/discover"
LOG_FILE = agent_dir / "logs" / "auto_trade.jsonl"

DEFAULT_QUERIES = [
    "What are the latest AI and technology news?",
    "What are current cryptocurrency market trends?",
    "What are the most important global events today?",
]


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _log(record: dict):
    record["timestamp"] = datetime.utcnow().isoformat() + "Z"
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(record) + "\n")
    print(f"[{record['timestamp']}] {record.get('event', 'LOG')} — {record.get('message', '')}")


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

async def discover_sellers() -> list[dict]:
    """Fetch active sellers from the hackathon discovery API."""
    if not NVM_DISCOVERY_API_KEY:
        print("WARNING: NVM_DISCOVERY_API_KEY not set — skipping discovery")
        return []

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                DISCOVERY_URL,
                params={"side": "sell"},
                headers={"x-nvm-api-key": NVM_DISCOVERY_API_KEY},
            )
            if resp.status_code != 200:
                print(f"Discovery API returned HTTP {resp.status_code}")
                return []
            data = resp.json()
            sellers = data.get("sellers", data if isinstance(data, list) else [])
            print(f"Discovered {len(sellers)} sellers")
            return sellers
    except Exception as e:
        print(f"Discovery failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Payment token
# ---------------------------------------------------------------------------

def _get_token(payments: Payments, plan_id: str, agent_id: str) -> str | None:
    try:
        scheme = resolve_scheme(payments, plan_id)
        token_options = X402TokenOptions(scheme=scheme)
        result = payments.x402.get_x402_access_token(
            plan_id=plan_id,
            agent_id=agent_id or None,
            token_options=token_options,
        )
        return result.get("accessToken")
    except Exception as e:
        print(f"  Token error: {e}")
        return None


# ---------------------------------------------------------------------------
# Purchase
# ---------------------------------------------------------------------------

async def purchase_from_seller(
    seller: dict,
    query: str,
    payments: Payments,
    dry_run: bool = False,
) -> dict:
    """Send a paid query to a seller agent."""
    name = seller.get("name", "unknown")
    endpoint = seller.get("endpointUrl", "").rstrip("/")
    plan_ids = seller.get("planIds", [])
    agent_id = seller.get("nvmAgentId", "")

    if not endpoint or not plan_ids:
        _log({"event": "SKIP", "seller": name, "message": "No endpoint or planId"})
        return {"status": "skip", "seller": name}

    plan_id = plan_ids[0]

    print(f"\n  Seller: {name}")
    print(f"  Endpoint: {endpoint}")
    print(f"  Plan: {plan_id[:20]}...")

    if dry_run:
        _log({"event": "DRY_RUN", "seller": name, "endpoint": endpoint, "query": query})
        return {"status": "dry_run", "seller": name}

    # Get x402 token
    token = await asyncio.to_thread(_get_token, payments, plan_id, agent_id)
    if not token:
        _log({"event": "ERROR", "seller": name, "message": "Failed to get payment token"})
        return {"status": "error", "seller": name, "error": "no token"}

    # Call seller endpoint
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{endpoint}/data",
                json={"query": query},
                headers={
                    "payment-signature": token,
                    "Content-Type": "application/json",
                },
            )

        if resp.status_code == 200:
            data = resp.json()
            response_text = data.get("response", str(data))[:500]
            _log({
                "event": "PURCHASE_SUCCESS",
                "seller": name,
                "query": query,
                "response_preview": response_text,
                "credits_used": data.get("credits_used", "?"),
            })
            print(f"  SUCCESS — Response: {response_text[:120]}...")
            return {"status": "success", "seller": name, "response": response_text}

        elif resp.status_code == 402:
            _log({"event": "PAYMENT_REQUIRED", "seller": name, "message": "Insufficient credits"})
            print(f"  PAYMENT_REQUIRED — need more credits")
            return {"status": "payment_required", "seller": name}

        else:
            _log({"event": "ERROR", "seller": name, "message": f"HTTP {resp.status_code}", "body": resp.text[:200]})
            print(f"  ERROR — HTTP {resp.status_code}: {resp.text[:100]}")
            return {"status": "error", "seller": name, "error": f"HTTP {resp.status_code}"}

    except Exception as e:
        _log({"event": "ERROR", "seller": name, "message": str(e)})
        print(f"  EXCEPTION: {e}")
        return {"status": "error", "seller": name, "error": str(e)}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def run(query: str, max_sellers: int, dry_run: bool):
    print(f"\n=== World Monitor Auto-Trade ===")
    print(f"Query: {query}")
    print(f"Max sellers: {max_sellers}")
    print(f"Dry run: {dry_run}")
    print(f"Environment: {NVM_ENVIRONMENT}\n")

    if not NVM_API_KEY:
        print("ERROR: NVM_API_KEY not set")
        sys.exit(1)

    payments = Payments.get_instance(
        PaymentOptions(nvm_api_key=NVM_API_KEY, environment=NVM_ENVIRONMENT)
    )

    sellers = await discover_sellers()
    if not sellers:
        print("No sellers found. Exiting.")
        return

    # Limit
    sellers = sellers[:max_sellers]

    _log({
        "event": "AUTO_TRADE_START",
        "message": f"Trading with {len(sellers)} sellers",
        "query": query,
        "dry_run": dry_run,
    })

    results = []
    for seller in sellers:
        result = await purchase_from_seller(seller, query, payments, dry_run=dry_run)
        results.append(result)

    # Summary
    success = sum(1 for r in results if r["status"] == "success")
    print(f"\n=== Summary ===")
    print(f"Sellers contacted: {len(results)}")
    print(f"Successful purchases: {success}")

    _log({
        "event": "AUTO_TRADE_DONE",
        "sellers_contacted": len(results),
        "successful": success,
        "results": [{"seller": r["seller"], "status": r["status"]} for r in results],
    })


def main():
    parser = argparse.ArgumentParser(description="World Monitor auto-trade script")
    parser.add_argument("--query", default=None, help="Query to send to sellers")
    parser.add_argument("--max-sellers", type=int, default=3, help="Max sellers to contact")
    parser.add_argument("--dry-run", action="store_true", help="Discover without buying")
    args = parser.parse_args()

    query = args.query or DEFAULT_QUERIES[0]
    asyncio.run(run(query, args.max_sellers, args.dry_run))


if __name__ == "__main__":
    main()
