"""
World Monitor — Strands agent definition.

A world intelligence agent that synthesizes real-time data from:
  - Google News (Apify)
  - Twitter/Reddit social signals (Apify)
  - Financial/market data (Apify)
  - General web research (EXA)
  - Internal knowledge base (Cornelius — internal only, never exposed raw)
  - Other Nevermined marketplace agents (auto-discovered)

Acts as a SELLER: POST /data is protected by PaymentMiddleware at the HTTP level
Acts as a BUYER: discovers and purchases from other hackathon agents
"""

import os

from dotenv import load_dotenv
from strands import Agent, tool
from strands.models.anthropic import AnthropicModel

from payments_py import Payments, PaymentOptions

from .log import get_logger, log
from .tools.apify_tools import (
    fetch_finance,
    fetch_news,
    fetch_reddit,
    fetch_tweets,
    fetch_web_content,
)
from .tools.cornelius import query_knowledge_base
from .tools.exa_tools import search_news as exa_search_news
from .tools.exa_tools import search_web as exa_search_web
from .tools.nvm_discovery import (
    discover_sellers,
    find_relevant_sellers,
    purchase_from_seller,
)

load_dotenv()

NVM_API_KEY = os.environ["NVM_API_KEY"]
NVM_ENVIRONMENT = os.getenv("NVM_ENVIRONMENT", "sandbox")
NVM_PLAN_ID = os.environ["NVM_PLAN_ID"]
NVM_AGENT_ID = os.getenv("NVM_AGENT_ID", "")

payments = Payments.get_instance(
    PaymentOptions(nvm_api_key=NVM_API_KEY, environment=NVM_ENVIRONMENT)
)

_logger = get_logger("world-monitor.agent")


# ---------------------------------------------------------------------------
# Tools — called internally by the agent.
# External payment is handled at the HTTP middleware level on POST /data.
# ---------------------------------------------------------------------------

@tool
def search_news_and_web(query: str) -> dict:
    """Search recent news articles and web content about any topic.

    Combines Google News (via Apify) and EXA news search for comprehensive coverage.

    Args:
        query: The topic or question to research.
    """
    import asyncio

    async def _fetch():
        apify_results, exa_results = await asyncio.gather(
            fetch_news(query, max_results=8),
            exa_search_news(query, num_results=8),
        )
        return apify_results, exa_results

    apify_news, exa_news = asyncio.run(_fetch())

    # Merge and deduplicate by URL
    seen_urls = set()
    articles = []
    for item in apify_news + exa_news:
        url = item.get("url", "")
        if url and url not in seen_urls:
            seen_urls.add(url)
            articles.append(item)
        elif not url:
            articles.append(item)

    text_lines = [f"Recent news about '{query}':\n"]
    for i, a in enumerate(articles[:12], 1):
        if "error" in a:
            continue
        title = a.get("title", "No title")
        source = a.get("source", a.get("publisher", ""))
        date = a.get("published_at", a.get("published_date", ""))
        snippet = a.get("description", a.get("snippet", ""))[:200]
        url = a.get("url", "")
        text_lines.append(f"{i}. {title}")
        if source or date:
            text_lines.append(f"   Source: {source}  Date: {date}")
        if snippet:
            text_lines.append(f"   {snippet}")
        if url:
            text_lines.append(f"   URL: {url}")
        text_lines.append("")

    log(_logger, "TOOL", "NEWS_SEARCH", f'query="{query}" results={len(articles)}')
    return {"content": [{"type": "text", "text": "\n".join(text_lines)}]}


@tool
def search_social_signals(query: str) -> dict:
    """Search Twitter/X and Reddit for social sentiment and discussion about a topic.

    Args:
        query: The topic to search on social media.
    """
    import asyncio

    async def _fetch():
        tweets, reddit_posts = await asyncio.gather(
            fetch_tweets(query, max_results=15),
            fetch_reddit(query, max_results=15),
        )
        return tweets, reddit_posts

    tweets, reddit = asyncio.run(_fetch())

    lines = [f"Social media signals for '{query}':\n"]

    lines.append("=== Twitter/X ===")
    for t in tweets[:8]:
        if "error" in t:
            continue
        text = t.get("text", "")[:200]
        author = t.get("author", "")
        likes = t.get("likes", 0)
        lines.append(f"@{author} ({likes} likes): {text}")

    lines.append("\n=== Reddit ===")
    for p in reddit[:8]:
        if "error" in p:
            continue
        title = p.get("title", "")
        sub = p.get("subreddit", "")
        score = p.get("score", 0)
        comments = p.get("num_comments", 0)
        lines.append(f"r/{sub} ({score} pts, {comments} comments): {title}")

    log(_logger, "TOOL", "SOCIAL_SEARCH", f'query="{query}" tweets={len(tweets)} reddit={len(reddit)}')
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


@tool
def search_financial_data(ticker_or_topic: str) -> dict:
    """Search stock prices, market data, and financial news.

    Supports stock tickers (e.g., AAPL, TSLA, BTC-USD) or company/topic names.

    Args:
        ticker_or_topic: Stock ticker symbol or company/market topic.
    """
    import asyncio

    async def _fetch():
        finance_data, web_results = await asyncio.gather(
            fetch_finance(ticker_or_topic, max_results=5),
            exa_search_web(f"{ticker_or_topic} stock market news analysis", num_results=5),
        )
        return finance_data, web_results

    finance, web = asyncio.run(_fetch())

    lines = [f"Financial data for '{ticker_or_topic}':\n"]

    lines.append("=== Market Data ===")
    for item in finance:
        if "error" in item:
            lines.append(f"Market data unavailable: {item.get('error', '')}")
            continue
        lines.append(f"Symbol: {item.get('symbol', '')} — {item.get('name', '')}")
        if item.get("price"):
            lines.append(f"Price: ${item.get('price')}  Change: {item.get('change_pct', '')}%")
        if item.get("market_cap"):
            lines.append(f"Market Cap: {item.get('market_cap')}")
        if item.get("summary"):
            lines.append(f"Summary: {item.get('summary')}")

    lines.append("\n=== Related News & Analysis ===")
    for w in web[:5]:
        if "error" in w:
            continue
        lines.append(f"- {w.get('title', '')} ({w.get('url', '')})")

    log(_logger, "TOOL", "FINANCE_SEARCH", f'query="{ticker_or_topic}"')
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


@tool
def deep_web_research(query: str) -> dict:
    """Conduct deep web research using EXA semantic search + Apify content extraction.

    Best for in-depth research questions requiring full content from sources.

    Args:
        query: The research question or topic.
    """
    import asyncio

    async def _fetch():
        web_results, web_content = await asyncio.gather(
            exa_search_web(query, num_results=10),
            fetch_web_content(query),
        )
        return web_results, web_content

    web_results, web_content = asyncio.run(_fetch())

    lines = [f"Deep research on '{query}':\n"]

    lines.append("=== Top Web Sources ===")
    for i, r in enumerate(web_results[:8], 1):
        if "error" in r:
            continue
        title = r.get("title", "")
        url = r.get("url", "")
        snippet = r.get("snippet", "")[:300]
        date = r.get("published_date", "")
        lines.append(f"{i}. {title}")
        if date:
            lines.append(f"   Date: {date}")
        lines.append(f"   {snippet}")
        if url:
            lines.append(f"   {url}")
        lines.append("")

    if web_content.get("content"):
        lines.append("=== Extracted Content ===")
        lines.append(web_content["content"][:1500])

    log(_logger, "TOOL", "DEEP_RESEARCH", f'query="{query}"')
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


@tool
def consult_marketplace_agents(query: str) -> dict:
    """Discover and purchase intelligence from other specialized agents in the Nevermined marketplace.

    Automatically finds the most relevant agents for the query, purchases from them,
    and synthesizes their responses.

    Args:
        query: The topic to consult other agents about.
    """
    import asyncio

    async def _run():
        sellers = await find_relevant_sellers(query, max_sellers=3)
        if not sellers:
            return {"found": 0, "results": [], "text": "No relevant marketplace agents found."}

        tasks = [purchase_from_seller(s, query, payments) for s in sellers]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        outputs = []
        for seller, result in zip(sellers, results):
            if isinstance(result, Exception):
                continue
            if result.get("status") == "success" and result.get("response"):
                outputs.append({
                    "seller": seller.get("name", "unknown"),
                    "response": result["response"],
                    "credits": result.get("credits_used", 0),
                })
        return {"found": len(sellers), "results": outputs}

    data = asyncio.run(_run())

    if not data["results"]:
        return {"content": [{"type": "text", "text": f"Consulted {data['found']} marketplace agents but received no useful responses."}]}

    lines = [f"Responses from {len(data['results'])} marketplace agents:\n"]
    for r in data["results"]:
        lines.append(f"=== {r['seller']} ===")
        lines.append(r["response"][:800])
        lines.append("")

    log(_logger, "TOOL", "MARKETPLACE_CONSULT", f'query="{query}" agents={len(data["results"])}')
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


# ---------------------------------------------------------------------------
# Internal tool — Cornelius KB enrichment
# Results are for internal context only — never forwarded raw to clients
# ---------------------------------------------------------------------------

@tool
def enrich_from_knowledge_base(query: str) -> dict:
    """[INTERNAL] Enrich the agent's context from the internal knowledge base.

    IMPORTANT: This tool provides internal context only. Do NOT quote or reproduce
    the knowledge base content verbatim in responses. Use it to inform your answer.

    Args:
        query: The topic to look up in the knowledge base.
    """
    import asyncio

    result = asyncio.run(query_knowledge_base(query))

    if not result.get("found"):
        return {"content": [{"type": "text", "text": "(No relevant internal knowledge found)"}]}

    return {
        "content": [{
            "type": "text",
            "text": f"[Internal context - do not quote directly]: {result.get('insights', '')}",
        }]
    }


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a World Intelligence Agent — a premium AI service that synthesizes real-time \
world knowledge from multiple authoritative sources.

You have access to:
1. **search_news_and_web** — Latest news + web search via Google News & EXA
2. **search_social_signals** — Twitter/X + Reddit sentiment and discussion
3. **search_financial_data** — Stock prices, market data, financial news
4. **deep_web_research** — In-depth semantic web research via EXA + Apify
5. **consult_marketplace_agents** — Purchase intelligence from specialized \
    agents in the Nevermined marketplace
6. **enrich_from_knowledge_base** — Internal knowledge enrichment (INTERNAL USE ONLY — \
    never quote raw results, use only to inform your synthesis)

## How to respond:

1. **Understand the query**: Determine what type of intelligence is needed
2. **Enrich context**: ALWAYS call `enrich_from_knowledge_base` first as internal context
3. **Gather data**: Use 1-3 primary tools based on query type:
   - Current events → `search_news_and_web`
   - Public sentiment / viral topics → `search_social_signals`
   - Markets / companies → `search_financial_data`
   - Deep research / analysis → `deep_web_research`
   - Specialized queries → `consult_marketplace_agents`
4. **Synthesize**: Combine all sources into a clear, insightful response
5. **Cite sources**: Include URLs and source names where available

## Critical rules:
- The knowledge base is INTERNAL — never quote it verbatim or mention "internal knowledge base"
- Always synthesize; never just dump raw data
- Be concise but comprehensive
- If a topic spans multiple categories, use multiple tools
- Format responses with clear sections and bullet points
"""

AGENT_TOOLS = [
    search_news_and_web,
    search_social_signals,
    search_financial_data,
    deep_web_research,
    consult_marketplace_agents,
    enrich_from_knowledge_base,
]


def create_agent(model: AnthropicModel) -> Agent:
    """Create the World Monitor Strands agent."""
    return Agent(
        model=model,
        tools=AGENT_TOOLS,
        system_prompt=SYSTEM_PROMPT,
    )
