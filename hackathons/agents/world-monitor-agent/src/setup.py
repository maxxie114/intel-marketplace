"""
One-time setup: register the World Monitor Agent and payment plan on Nevermined.

Usage:
    poetry run setup
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv, set_key
from payments_py import Payments, PaymentOptions
from payments_py.common.types import (
    AgentAPIAttributes,
    AgentMetadata,
    Endpoint,
    PlanMetadata,
)
from payments_py.plans import get_dynamic_credits_config, get_free_price_config

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_FILE)


def main():
    nvm_api_key = os.environ.get("NVM_API_KEY", "")
    nvm_environment = os.environ.get("NVM_ENVIRONMENT", "sandbox")
    agent_url = os.environ.get("AGENT_URL", "http://localhost:3000")

    if not nvm_api_key:
        print("Error: NVM_API_KEY is required.")
        sys.exit(1)

    existing_agent = os.environ.get("NVM_AGENT_ID", "")
    existing_plan = os.environ.get("NVM_PLAN_ID", "")
    if existing_agent and existing_plan:
        print(f"Already configured:\n  NVM_AGENT_ID = {existing_agent}\n  NVM_PLAN_ID = {existing_plan}")
        answer = input("Re-register? (y/N): ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return

    print(f"\nRegistering World Monitor Agent on Nevermined ({nvm_environment})...\n")

    nvm = Payments.get_instance(
        PaymentOptions(nvm_api_key=nvm_api_key, environment=nvm_environment)
    )

    agent_metadata = AgentMetadata(
        name="World Monitor Agent",
        description=(
            "Real-time world intelligence service. Synthesizes news, social signals, "
            "financial data, and deep research from Apify, EXA, and the Nevermined marketplace. "
            "Credits: news=2, social=3, finance=2, research=3, marketplace=5+"
        ),
        tags=["news", "intelligence", "research", "finance", "social-media", "world-monitor", "apify", "exa"],
    )

    agent_api = AgentAPIAttributes(
        endpoints=[
            Endpoint(verb="POST", url=f"{agent_url}/data"),
        ],
        agent_definition_url=f"{agent_url}/.well-known/agent.json",
    )

    plan_metadata = PlanMetadata(
        name="World Monitor Agent — Intelligence Credits",
        description=(
            "100 credits. Usage: news/web search=2, social signals=3, "
            "financial data=2, deep research=3, marketplace consult=5+"
        ),
    )

    result = nvm.agents.register_agent_and_plan(
        agent_metadata=agent_metadata,
        agent_api=agent_api,
        plan_metadata=plan_metadata,
        price_config=get_free_price_config(),
        credits_config=get_dynamic_credits_config(
            credits_granted=100,
            min_credits_per_request=2,
            max_credits_per_request=20,
        ),
        access_limit="credits",
    )

    agent_id = result.get("agentId", "")
    plan_id = result.get("planId", "")

    if not agent_id or not plan_id:
        print(f"Error: unexpected response: {result}")
        sys.exit(1)

    print(f"\nRegistered!\n  Agent ID: {agent_id}\n  Plan ID:  {plan_id}")

    if not ENV_FILE.exists():
        ENV_FILE.write_text(f"NVM_API_KEY={nvm_api_key}\nNVM_ENVIRONMENT={nvm_environment}\n")

    set_key(str(ENV_FILE), "NVM_AGENT_ID", agent_id)
    set_key(str(ENV_FILE), "NVM_PLAN_ID", plan_id)
    print(f"\nSaved to {ENV_FILE}\nNow run: poetry run web")


if __name__ == "__main__":
    main()
