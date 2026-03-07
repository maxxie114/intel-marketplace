# World Monitor — AI Intelligence Marketplace

Real-time world intelligence as a paid AI service. Combines live news, social signals, financial data, and deep web research into a single autonomous agent that both **sells** intelligence to buyers and **buys** from other agents on the Nevermined marketplace.

**Paid endpoint:** `https://us14.abilityai.dev/api/paid/intel-marketplace-2/chat`

---

## What It Does

- **Sells intelligence** — buyers pay Nevermined credits to query the agent for geopolitical briefings, AI trends, financial data, social signals, and deep research
- **Buys autonomously** — every 30 minutes the agent purchases intelligence from other marketplace sellers and routes queries to the best available seller via the Agent Staffing Agency
- **Real-time data** — powered by Apify (Google News, Twitter/X, Reddit, financial scraping) and EXA (semantic web + news search)
- **Interactive dashboard** — live world map with conflict tracking, market data, aviation, maritime, cyber threats, and an AI chatbot

---

## Architecture

```
Buyer → Nevermined x402 Payment → Trinity Paid Endpoint
                                        ↓
                              FastAPI (port 3000)
                                        ↓
                          Strands Agent (Claude Sonnet)
                          ┌─────────────────────────────┐
                          │  search_news_and_web         │ ← Apify + EXA
                          │  search_social_signals       │ ← Apify Twitter/Reddit
                          │  search_financial_data       │ ← Apify Finance + EXA
                          │  deep_web_research           │ ← EXA semantic search
                          │  consult_marketplace_agents  │ ← Nevermined discovery
                          │  consult_staffing_agency     │ ← Agent Staffing Agency
                          └─────────────────────────────┘

Frontend (Vercel) → /api/intel-chat → Trinity agent → FastAPI
```

---

## Tools

### Nevermined

The agent is registered on the Nevermined sandbox marketplace as both a buyer and a seller.

**Selling:** The FastAPI server uses `payments_py` middleware to verify x402 payment tokens on every request. Buyers order a plan, get an access token, and call the endpoint with a `payment-signature` header.

```python
from payments_py import Payments, PaymentOptions
payments = Payments.get_instance(PaymentOptions(nvm_api_key="YOUR_KEY", environment="sandbox"))
payments.plans.order_plan("3752853475618467090095078814547168619421798970303024103447800626832273878283")
token = payments.x402.get_x402_access_token(plan_id, agent_id)
# POST to https://us14.abilityai.dev/api/paid/intel-marketplace-2/chat
# with header: payment-signature: {token}
```

**Buying:** `scripts/auto_trade.py` discovers active sellers via the Nevermined hackathon discovery API, orders their plans, generates x402 access tokens, and calls their endpoints autonomously. Runs every 30 minutes via Trinity.

**A2A agent card:** `GET /.well-known/agent.json` exposes standard agent capabilities with Nevermined payment extension.

- Plan ID: `3752853475618467090095078814547168619421798970303024103447800626832273878283`
- Agent ID: `63046025305469270040963931107827858539408991598001521799587728626823677599318`

See: `hackathons/agents/world-monitor-agent/src/tools/nvm_discovery.py`, `scripts/auto_trade.py`

---

### Trinity (TrinityOS)

The backend agent runs on Trinity — a managed Claude Code runtime that handles deployment, scheduling, and MCP tool access.

- The FastAPI server (`src/web.py`) runs inside the Trinity container on port 3000
- Trinity exposes the paid endpoint at `https://us14.abilityai.dev/api/paid/intel-marketplace-2/chat`
- Auto-trade is scheduled every 30 minutes via Trinity's cron scheduler (`*/30 * * * *`)
- `CLAUDE.md` provides instructions to the Trinity Claude Code agent for starting the server and running trades

---

### Apify

Apify Actors power all live data scraping. Every paid query triggers actors in parallel with EXA search, then synthesizes results into an AI briefing.

| Tool | Apify Actor | Data |
|------|-------------|------|
| `fetch_news` | Google News scraper | Breaking news, headlines |
| `fetch_tweets` | Twitter/X scraper | Social sentiment, viral topics |
| `fetch_reddit` | Reddit scraper | Community discussion, upvotes |
| `fetch_finance` | Financial data actor | Stock prices, market data |
| `fetch_web_content` | Web content extractor | Full article text |

See: `hackathons/agents/world-monitor-agent/src/tools/apify_tools.py`

---

### EXA

EXA provides semantic web search and news search used alongside Apify for deeper research queries. Used in `deep_web_research` and `search_financial_data` tools when Apify scraping isn't sufficient.

See: `hackathons/agents/world-monitor-agent/src/tools/exa_tools.py`

---

### Agent Staffing Agency

The `consult_staffing_agency` tool routes queries to the Agent Staffing Agency — a service that benchmarks 55+ marketplace sellers and forwards queries to the best available one. Used for crypto, DeFi, marketing, and social analysis queries.

- Free `/try` endpoint (1 request/hour), paid `/ask` endpoint
- Integrated as a Strands tool in `src/strands_agent.py`

See: `hackathons/agents/world-monitor-agent/src/tools/staffing_agency.py`

---

### ZeroClick

ZeroClick contextual ads are injected into the chatbot response flow on the frontend.

- After every AI response, the chatbot maps the semantic domain (finance, conflict, crypto, travel, etc.) to one of 14 categories and fetches contextual product offers via the ZeroClick API
- Offers are displayed as sponsored cards beneath the AI response
- Click signals and impressions are tracked and sent back to ZeroClick

See: `worldmonitor/src/components/ChatbotPanel.ts` — `appendOffers()`, `SEMANTIC_MAP`

---

## Stack

| Layer | Technology |
|-------|-----------|
| Agent framework | AWS Strands SDK |
| LLM | Claude Sonnet 4.6 (Anthropic) |
| Payments | Nevermined x402 |
| Deployment | Trinity (TrinityOS) |
| Web data | Apify Actors |
| Search | EXA semantic search |
| Dashboard | World Monitor (Vite + TypeScript) |
| Frontend hosting | Vercel |
| Ads | ZeroClick |

---

## Repository Structure

```
intel-marketplace/
├── hackathons/agents/world-monitor-agent/   # Backend intelligence agent
│   ├── src/
│   │   ├── web.py                           # FastAPI server (seller endpoint)
│   │   ├── strands_agent.py                 # Strands agent + tools
│   │   └── tools/
│   │       ├── apify_tools.py               # Apify news/social/finance scrapers
│   │       ├── exa_tools.py                 # EXA semantic search
│   │       ├── nvm_discovery.py             # Nevermined marketplace buyer
│   │       ├── staffing_agency.py           # Agent Staffing Agency integration
│   │       └── zeroclick.py                 # ZeroClick ad integration
│   ├── scripts/
│   │   └── auto_trade.py                    # Autonomous marketplace buyer
│   └── CLAUDE.md                            # Trinity agent instructions
├── worldmonitor/                            # Frontend dashboard
│   ├── src/components/ChatbotPanel.ts       # AI chatbot with ZeroClick ads
│   └── api/
│       ├── intel-chat.js                    # Proxy to Trinity agent (SSE streaming)
│       └── mcp/
│           ├── trinity.js                   # Trinity MCP proxy
│           └── apify.js                     # Apify MCP proxy
├── nevermined-purchaser/                    # Test buyer client
│   └── pay_and_call.py                      # CLI to purchase from any agent
└── template.yaml                            # Trinity deployment config
```

---

## Running Locally

```bash
# Backend agent
cd hackathons/agents/world-monitor-agent
cp .env.example .env   # fill in NVM_API_KEY, APIFY_API_KEY, EXA_API_KEY, ANTHROPIC_API_KEY
poetry install
poetry run python -m src.web
# → http://localhost:3000

# Test a purchase
cd nevermined-purchaser
python3 pay_and_call.py call \
  --url https://us14.abilityai.dev/api/paid/intel-marketplace-2/chat \
  --message "What are the latest AI trends?" \
  --plan-id 3752853475618467090095078814547168619421798970303024103447800626832273878283 \
  --agent-id 63046025305469270040963931107827858539408991598001521799587728626823677599318

# Run auto-trade (buy from other agents)
cd hackathons/agents/world-monitor-agent
python3 scripts/auto_trade.py --max-sellers 5
```

---

## Team

Built at the Nevermined AI Agent Hackathon 2026.
