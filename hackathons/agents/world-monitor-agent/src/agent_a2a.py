"""
World Monitor Agent — A2A seller server.

Runs the agent as an A2A-compliant seller with:
  - Standard agent card at /.well-known/agent.json
  - JSON-RPC message endpoint with Nevermined payment validation
  - Auto-registration with a buyer marketplace (optional)

Usage:
    poetry run agent-a2a
    poetry run agent-a2a --buyer-url http://localhost:8000
"""

import argparse
import asyncio
import datetime
import os
import sys
import threading
import time
from uuid import uuid4

import httpx
from dotenv import load_dotenv
from strands import Agent
from strands.models.anthropic import AnthropicModel

from a2a.server.agent_execution.agent_executor import AgentExecutor
from a2a.server.events.event_queue import EventQueue
from a2a.types import (
    AgentSkill,
    Message,
    Role,
    Task,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)

from payments_py import Payments, PaymentOptions
from payments_py.a2a.agent_card import build_payment_agent_card
from payments_py.a2a.server import PaymentsA2AServer
from payments_py.a2a.payments_request_handler import PaymentsRequestHandler

from .log import get_logger, log
from .strands_agent import NVM_PLAN_ID, NVM_AGENT_ID, create_agent, payments

load_dotenv()

NVM_API_KEY = os.environ["NVM_API_KEY"]
NVM_ENVIRONMENT = os.getenv("NVM_ENVIRONMENT", "sandbox")
A2A_PORT = int(os.getenv("A2A_PORT", "9000"))

_logger = get_logger("world-monitor.a2a")

CREDIT_MAP = {
    "search_news_and_web": 2,
    "search_social_signals": 3,
    "search_financial_data": 2,
    "deep_web_research": 3,
    "consult_marketplace_agents": 5,
    "enrich_from_knowledge_base": 0,
}

SKILLS = [
    AgentSkill(
        id="news_intelligence",
        name="News Intelligence",
        description="Latest news from Google News + EXA (2 credits)",
        tags=["news", "current events", "media"],
    ),
    AgentSkill(
        id="social_signals",
        name="Social Signals",
        description="Twitter/X and Reddit sentiment (3 credits)",
        tags=["social media", "sentiment", "twitter", "reddit"],
    ),
    AgentSkill(
        id="financial_data",
        name="Financial Data",
        description="Stock prices, market data, financial news (2 credits)",
        tags=["finance", "stocks", "markets"],
    ),
    AgentSkill(
        id="deep_research",
        name="Deep Web Research",
        description="Comprehensive semantic web research (3 credits)",
        tags=["research", "analysis"],
    ),
]


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _make_status_event(
    task_id: str,
    context_id: str,
    state: TaskState,
    text: str,
    credits_used: int | None = None,
    final: bool = True,
) -> TaskStatusUpdateEvent:
    metadata = {}
    if credits_used is not None:
        metadata["creditsUsed"] = credits_used
    return TaskStatusUpdateEvent(
        task_id=task_id,
        context_id=context_id,
        status=TaskStatus(
            state=state,
            message=Message(
                message_id=str(uuid4()),
                role=Role.agent,
                parts=[{"kind": "text", "text": text}],
                task_id=task_id,
                context_id=context_id,
            ),
            timestamp=_now_iso(),
        ),
        metadata=metadata or None,
        final=final,
    )


class WorldMonitorExecutor(AgentExecutor):
    def __init__(self, agent: Agent):
        self._agent = agent
        self._log = get_logger("world-monitor.executor")

    async def execute(self, context, event_queue: EventQueue) -> None:
        task_id = context.task_id or str(uuid4())
        context_id = context.context_id or str(uuid4())

        if not getattr(context, "current_task", None):
            await event_queue.enqueue_event(
                Task(
                    id=task_id,
                    context_id=context_id,
                    status=TaskStatus(state=TaskState.submitted, timestamp=_now_iso()),
                    history=[],
                )
            )

        await event_queue.enqueue_event(
            _make_status_event(task_id, context_id, TaskState.working, "Gathering world intelligence...", final=False)
        )

        user_text = self._extract_text(context) or "Hello"
        log(self._log, "EXECUTOR", "RECEIVED", f'query="{user_text[:80]}" task={task_id[:8]}')

        msg_offset = len(self._agent.messages)
        try:
            result = await asyncio.to_thread(self._agent, user_text)
            response_text = str(result)
        except Exception as exc:
            log(self._log, "EXECUTOR", "FAILED", str(exc))
            await event_queue.enqueue_event(
                _make_status_event(task_id, context_id, TaskState.failed, f"Error: {exc}", credits_used=0)
            )
            return

        credits_used = self._calc_credits(self._agent.messages[msg_offset:])
        log(self._log, "EXECUTOR", "COMPLETED", f"credits={credits_used}")

        await event_queue.enqueue_event(
            _make_status_event(task_id, context_id, TaskState.completed, response_text, credits_used=credits_used)
        )

    async def cancel(self, context, event_queue: EventQueue) -> None:
        task_id = getattr(context, "task_id", None) or str(uuid4())
        context_id = getattr(context, "context_id", None) or str(uuid4())
        await event_queue.enqueue_event(
            _make_status_event(task_id, context_id, TaskState.canceled, "Cancelled.", credits_used=0)
        )

    @staticmethod
    def _extract_text(context) -> str:
        message = getattr(context, "message", None)
        if not message:
            return ""
        parts = getattr(message, "parts", [])
        fragments = []
        for part in parts:
            if hasattr(part, "root"):
                part = part.root
            if hasattr(part, "text"):
                fragments.append(part.text)
            elif isinstance(part, dict) and part.get("kind") == "text":
                fragments.append(part.get("text", ""))
        return "".join(fragments)

    def _calc_credits(self, messages: list) -> int:
        total = 0
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    name = block.get("name", "")
                    total += CREDIT_MAP.get(name, 1)
        return max(total, 1)


def _register_with_buyer(buyer_url: str, agent_url: str):
    time.sleep(2)
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid4()),
        "method": "message/send",
        "params": {
            "message": {
                "messageId": str(uuid4()),
                "role": "user",
                "parts": [{"kind": "text", "text": agent_url}],
            }
        },
    }
    for attempt in range(1, 4):
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.post(buyer_url, json=payload)
            if resp.status_code == 200:
                log(_logger, "REGISTER", "SUCCESS", f"registered with {buyer_url}")
                return
        except Exception as exc:
            log(_logger, "REGISTER", "FAILED", f"attempt {attempt}: {exc}")
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description="World Monitor Agent — A2A Mode")
    parser.add_argument("--port", type=int, default=A2A_PORT)
    parser.add_argument("--buyer-url", default=os.getenv("BUYER_URL", ""))
    args = parser.parse_args()

    port = args.port
    buyer_url = args.buyer_url

    model = AnthropicModel(
        model_id=os.getenv("MODEL_ID", "claude-sonnet-4-6"),
    )
    agent = create_agent(model)
    executor = WorldMonitorExecutor(agent)

    base_url = os.getenv("AGENT_URL", f"http://localhost:{port}")

    base_card = {
        "name": "World Monitor Agent",
        "description": (
            "Real-time world intelligence: news, social signals, financial data, "
            "and deep research synthesized by AI. Powered by Apify, EXA, and Nevermined marketplace."
        ),
        "url": base_url,
        "version": "1.0.0",
        "skills": [s.model_dump() for s in SKILLS],
        "capabilities": {"streaming": True, "pushNotifications": False},
    }

    agent_card = build_payment_agent_card(
        base_card,
        {
            "paymentType": "dynamic",
            "credits": 2,
            "planId": NVM_PLAN_ID,
            "agentId": NVM_AGENT_ID,
            "costDescription": "Credits vary: news=2, social=3, finance=2, research=3, marketplace=5+",
        },
    )

    log(_logger, "SERVER", "STARTUP", f"A2A port={port} plan={NVM_PLAN_ID}")

    if buyer_url:
        t = threading.Thread(
            target=_register_with_buyer, args=(buyer_url, base_url), daemon=True
        )
        t.start()

    from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore

    handler = PaymentsRequestHandler(
        agent_card=agent_card,
        task_store=InMemoryTaskStore(),
        agent_executor=executor,
        payments_service=payments,
    )
    executor.handler = handler

    result = PaymentsA2AServer.start(
        agent_card=agent_card,
        executor=executor,
        payments_service=payments,
        port=port,
        custom_request_handler=handler,
    )

    asyncio.run(result.server.serve())


if __name__ == "__main__":
    main()
