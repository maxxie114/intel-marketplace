# World Monitor — AI Intelligence Marketplace

Real-time world intelligence as a paid AI service. Combines live news, social signals, financial data, and deep web research into a single autonomous agent that both **sells** intelligence to buyers and **buys** from other agents on the Nevermined marketplace.

**Live demo:** [intel-marketplace-cibt.vercel.app](https://intel-marketplace-cibt.vercel.app)
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

## Sponsor Track Coverage

### Ability / TrinityOS + Nevermined — *Buy/Sell Services* ($2,000)

Full Nevermined x402 payment integration on both sides:

- **Selling:** Agent registered on Nevermined sandbox with Plan ID and Agent ID. Trinity handles x402 payment verification at the `/api/paid/intel-marketplace-2/chat` endpoint. Buyers purchase credits and call the agent — each query costs credits and settles on-chain.
- **Buying:** `scripts/auto_trade.py` discovers active sellers via the Nevermined hackathon discovery API, orders plans, generates x402 access tokens, and calls seller endpoints autonomously. Scheduled every 30 minutes via Trinity.
- **A2A agent card:** `GET /.well-known/agent.json` exposes standard agent capabilities with Nevermined payment extension.

```python
# Example: buy from our agent
from payments_py import Payments, PaymentOptions
payments = Payments.get_instance(PaymentOptions(nvm_api_key="YOUR_KEY", environment="sandbox"))
payments.plans.order_plan("3752853475618467090095078814547168619421798970303024103447800626832273878283")
token = payments.x402.get_x402_access_token(plan_id, agent_id)
# POST to https://us14.abilityai.dev/api/paid/intel-marketplace-2/chat
# with header: payment-signature: {token}
```

**Nevermined credentials:**
- Plan ID: `3752853475618467090095078814547168619421798970303024103447800626832273878283`
- Agent ID: `63046025305469270040963931107827858539408991598001521799587728626823677599318`

---

### Apify — *Real-Time Web Data* ($600+ + AirPods)

Apify Actors power all live data scraping in the backend agent:

| Tool | Apify Actor | Data |
|------|-------------|------|
| `fetch_news` | Google News scraper | Breaking news, headlines |
| `fetch_tweets` | Twitter/X scraper | Social sentiment, viral topics |
| `fetch_reddit` | Reddit scraper | Community discussion, upvotes |
| `fetch_finance` | Financial data actor | Stock prices, market data |
| `fetch_web_content` | Web content extractor | Full article text |

Every paid buyer query triggers Apify actors in parallel with EXA search, then synthesizes the results into an AI briefing. The dashboard also surfaces real-time data from Apify through the chatbot.

See: `hackathons/agents/world-monitor-agent/src/tools/apify_tools.py`

---

### ZeroClick — *AI-Native Ads + Nevermined* ($2,000)

ZeroClick contextual ads are integrated into the chatbot response flow:

- After every AI response, the chatbot analyzes the semantic domain (finance, conflict, crypto, travel, etc.) and fetches contextual product offers via the ZeroClick API
- Offers are displayed as sponsored cards beneath the AI response
- Click signals and impressions are tracked and broadcast back to ZeroClick
- Semantic mapping covers 14 domains: stocks, crypto, commodities, cybersecurity, natural disasters, conflict/defense, travel, AI tools, climate, trade, politics, health, real estate, maritime

See: `worldmonitor/src/components/ChatbotPanel.ts` — `appendOffers()`, `SEMANTIC_MAP`

---

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
