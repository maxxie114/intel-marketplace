#!/usr/bin/env python3
"""
One-off script to buy intelligence from AdAgent Studio and find VentureOS.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

script_dir = Path(__file__).parent
agent_dir = script_dir.parent
sys.path.insert(0, str(agent_dir))

from dotenv import load_dotenv
load_dotenv(agent_dir / ".env")

import httpx
from payments_py import Payments, PaymentOptions
from payments_py.x402.resolve_scheme import resolve_scheme
from payments_py.x402.types import X402TokenOptions

NVM_API_KEY = os.environ["NVM_API_KEY"]
NVM_ENVIRONMENT = os.environ.get("NVM_ENVIRONMENT", "sandbox")

ADAGENT_PLAN_ID = "113089740642859930050035139352101319051193174315257289563931060717559157186017"
ADAGENT_AGENT_ID = "23914165245228865506529334228547597361447900285168247629778996230188006229083"
ADAGENT_ENDPOINT = "https://adagent-studio-seven.vercel.app/api/run-campaign"

VENTUREOS_PLAN_ID = "111170158828988238621952181742530314080625763674353484735897795140598444477539"
VENTUREOS_AGENT_ID = "4429152986716600970080823140864865244582281074406443132410950218441100767135"

DISCOVERY_URL = "https://nevermined.ai/hackathon/register/api/discover"


def get_token(payments, plan_id, agent_id):
    try:
        try:
            payments.plans.order_plan(plan_id)
            print(f"  Ordered plan {plan_id[:20]}...")
        except Exception as e:
            print(f"  Plan order (may already be subscribed): {e}")

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


async def buy_adagent(payments):
    print("\n=== Buying from AdAgent Studio ===")
    token = await asyncio.to_thread(get_token, payments, ADAGENT_PLAN_ID, ADAGENT_AGENT_ID)
    if not token:
        print("FAILED: Could not get token")
        return

    body = {
        "brand": "World Monitor Intelligence",
        "goal": "Increase awareness of our real-time AI intelligence marketplace that sells geopolitical briefings and market data",
        "audience": "AI developers, enterprise buyers, and intelligence analysts interested in real-time world data",
        "budget": 15.0,
    }

    headers = {
        "payment-signature": token,
        "Content-Type": "application/json",
    }

    print(f"  Calling {ADAGENT_ENDPOINT}...")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(ADAGENT_ENDPOINT, json=body, headers=headers)
    print(f"  Status: {resp.status_code}")
    try:
        data = resp.json()
        print(f"  Response: {json.dumps(data, indent=2)[:1000]}")
    except Exception:
        print(f"  Raw: {resp.text[:500]}")


async def find_ventureos():
    print("\n=== Finding VentureOS endpoint ===")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            DISCOVERY_URL,
            params={"side": "sell"},
            headers={"x-nvm-api-key": NVM_API_KEY},
        )
    if resp.status_code != 200:
        print(f"Discovery API error: {resp.status_code}")
        return None

    data = resp.json()
    sellers = data.get("sellers", data if isinstance(data, list) else [])

    for s in sellers:
        name = s.get("name", "")
        agent_id = s.get("nvmAgentId", "")
        if "venture" in name.lower() or agent_id == VENTUREOS_AGENT_ID:
            print(f"  Found: {name}")
            print(f"  Full record: {json.dumps(s, indent=2)}")
            return s

    print("  VentureOS not found by name or agent ID. Showing all seller names:")
    for s in sellers[:20]:
        print(f"    - {s.get('name', '?')} | endpoint: {s.get('endpointUrl', '?')}")
    return None


async def buy_ventureos(payments, endpoint):
    print(f"\n=== Buying from VentureOS at {endpoint} ===")
    token = await asyncio.to_thread(get_token, payments, VENTUREOS_PLAN_ID, VENTUREOS_AGENT_ID)
    if not token:
        print("FAILED: Could not get token")
        return

    body = {
        "idea": "An AI-powered real-time intelligence marketplace where agents buy and sell world intelligence data including geopolitical briefings, financial signals, and social sentiment analysis",
    }

    headers = {
        "payment-signature": token,
        "Content-Type": "application/json",
    }

    print(f"  Calling {endpoint}...")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(endpoint, json=body, headers=headers)
    print(f"  Status: {resp.status_code}")
    try:
        data = resp.json()
        print(f"  Response: {json.dumps(data, indent=2)[:1000]}")
    except Exception:
        print(f"  Raw: {resp.text[:500]}")


async def main():
    payments = Payments.get_instance(
        PaymentOptions(nvm_api_key=NVM_API_KEY, environment=NVM_ENVIRONMENT)
    )

    # Buy from AdAgent Studio
    await buy_adagent(payments)

    # Find VentureOS real endpoint
    ventureos = await find_ventureos()
    if ventureos:
        endpoint = ventureos.get("endpointUrl", "")
        if endpoint and endpoint.startswith("http"):
            await buy_ventureos(payments, endpoint)
        else:
            print(f"\nVentureOS endpoint is not a full URL: '{endpoint}'")
            print("Cannot buy — need their real deployment URL")


if __name__ == "__main__":
    asyncio.run(main())
