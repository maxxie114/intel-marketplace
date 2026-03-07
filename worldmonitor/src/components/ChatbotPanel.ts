import { Panel } from './Panel';
import { fetchZeroClickOffers, trackZeroClickImpressions, broadcastSignals } from '@/services/zeroclick';
import type { ZeroClickOffer, ZeroClickSignal } from '@/services/zeroclick';
import { escapeHtml } from '@/utils/sanitize';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

// MCP calls go through Vite server proxy to avoid CORS
const TRINITY_MCP_URL = '/api/mcp/trinity';
const APIFY_MCP_URL = '/api/mcp/apify';

export class ChatbotPanel extends Panel {
  private messages: ChatMessage[] = [];
  private inputEl!: HTMLTextAreaElement;
  private messagesContainer!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private isLoading = false;
  private mcpTools: Array<{ name: string; description: string; source: string }> = [];

  constructor() {
    super({
      id: 'chatbot',
      title: 'AI Assistant',
      className: 'chatbot-panel col-span-2 span-3',
      showCount: false,
      trackActivity: false,
    });

    this.buildChatUI();
    this.addWelcomeMessage();
    this.discoverMCPTools();
  }

  private buildChatUI(): void {
    this.content.innerHTML = '';
    this.content.style.cssText = 'display:flex;flex-direction:column;height:100%;padding:0;overflow:hidden;';

    // Status bar (connection indicators only, no internal labels)
    const statusBar = document.createElement('div');
    statusBar.className = 'chatbot-mcp-status';
    statusBar.innerHTML = `
      <div class="chatbot-mcp-badges">
        <span class="chatbot-mcp-badge trinity" id="trinityBadge">Intelligence</span>
        <span class="chatbot-mcp-badge apify" id="apifyBadge">Search</span>
      </div>
    `;

    // Messages area
    this.messagesContainer = document.createElement('div');
    this.messagesContainer.className = 'chatbot-messages';

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'chatbot-input-area';

    this.inputEl = document.createElement('textarea');
    this.inputEl.className = 'chatbot-input';
    this.inputEl.placeholder = 'Ask about world events, markets, conflicts...';
    this.inputEl.rows = 1;
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'chatbot-send-btn';
    this.sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>`;
    this.sendBtn.addEventListener('click', () => this.handleSend());

    inputArea.appendChild(this.inputEl);
    inputArea.appendChild(this.sendBtn);

    this.content.appendChild(statusBar);
    this.content.appendChild(this.messagesContainer);
    this.content.appendChild(inputArea);

    // Inject styles
    if (!document.getElementById('chatbot-styles')) {
      const style = document.createElement('style');
      style.id = 'chatbot-styles';
      style.textContent = CHATBOT_CSS;
      document.head.appendChild(style);
    }
  }

  private addWelcomeMessage(): void {
    this.addMessage({
      role: 'assistant',
      content: `Welcome to World Monitor AI Assistant. I can help you analyze global events, fetch real-time data, and provide intelligence insights.\n\nTry asking:\n- "What are the latest global conflicts?"\n- "Search for earthquake data"\n- "Find news about AI regulations"\n- "Analyze market trends"`,
      timestamp: new Date(),
    });
  }

  private async discoverMCPTools(): Promise<void> {
    // Discover Trinity MCP tools
    try {
      const trinityTools = await this.callMCP(TRINITY_MCP_URL, null, 'tools/list', {});
      if (trinityTools?.tools) {
        for (const tool of trinityTools.tools) {
          this.mcpTools.push({ name: tool.name, description: tool.description || '', source: 'trinity' });
        }
      }
      // Mark Intelligence as connected if Trinity responds, regardless of tool count
      // (all Trinity tools are admin-only but the intel-chat endpoint works directly)
      this.updateBadge('trinityBadge', true);
    } catch (e) {
      // Fallback: check if /api/intel-chat is reachable
      try {
        const res = await fetch('/api/intel-chat', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        this.updateBadge('trinityBadge', res.status !== 404);
      } catch {
        console.warn('[Chatbot] Trinity MCP discovery failed:', e);
        this.updateBadge('trinityBadge', false);
      }
    }

    // Discover Apify MCP tools
    try {
      const apifyTools = await this.callMCP(APIFY_MCP_URL, null, 'tools/list', {});
      if (apifyTools?.tools) {
        for (const tool of apifyTools.tools) {
          this.mcpTools.push({ name: tool.name, description: tool.description || '', source: 'apify' });
        }
      }
      this.updateBadge('apifyBadge', true, this.mcpTools.filter(t => t.source === 'apify').length);
    } catch (e) {
      console.warn('[Chatbot] Apify MCP discovery failed:', e);
      this.updateBadge('apifyBadge', false);
    }

    console.log(`[Chatbot] Discovered ${this.mcpTools.length} MCP tools:`, this.mcpTools.map(t => t.name));
  }

  private updateBadge(id: string, connected: boolean, toolCount?: number): void {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.classList.toggle('connected', connected);
    badge.classList.toggle('disconnected', !connected);
    if (connected && toolCount !== undefined) {
      badge.textContent += ` (${toolCount})`;
    }
  }

  private async callMCP(url: string, _token: string | null, method: string, params: unknown): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Auth is handled server-side by the MCP proxy

    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'MCP error');
    return json.result;
  }

  private async callTool(source: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const url = source === 'trinity' ? TRINITY_MCP_URL : APIFY_MCP_URL;
    const token = null; // Auth handled server-side

    try {
      const result = await this.callMCP(url, token, 'tools/call', { name: toolName, arguments: args });
      if (result?.content) {
        return result.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      }
      return JSON.stringify(result, null, 2);
    } catch (e: any) {
      return `Error calling ${toolName}: ${e.message}`;
    }
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isLoading) return;

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    this.addMessage({ role: 'user', content: text, timestamp: new Date() });
    this.setLoading(true);

    try {
      const response = await this.processQuery(text);
      this.addMessage({ role: 'assistant', content: response, timestamp: new Date() });

      // Fetch and display contextual ZeroClick offers based on query + response
      this.appendOffers(text, response);
    } catch (e: any) {
      this.addMessage({ role: 'assistant', content: `Error: ${e.message}`, timestamp: new Date() });
    } finally {
      this.setLoading(false);
    }
  }

  /** Tools that expose platform internals — never route user queries to these */
  private static readonly INTERNAL_TOOLS = new Set([
    'list_agents', 'get_agent', 'get_agent_info', 'create_agent', 'rename_agent',
    'delete_agent', 'start_agent', 'stop_agent', 'list_templates',
    'get_credential_status', 'inject_credentials', 'export_credentials',
    'import_credentials', 'get_credential_encryption_key', 'get_agent_ssh_access',
    'deploy_local_agent', 'initialize_github_sync', 'get_chat_history',
    'get_agent_logs', 'deploy_system', 'list_systems', 'restart_system',
    'get_system_manifest', 'get_agent_requirements',
    'list_skills', 'get_skill', 'get_skills_library_status',
    'assign_skill_to_agent', 'set_agent_skills', 'sync_agent_skills', 'get_agent_skills',
    'list_agent_schedules', 'create_agent_schedule', 'get_agent_schedule',
    'update_agent_schedule', 'delete_agent_schedule', 'toggle_agent_schedule',
    'trigger_agent_schedule', 'get_schedule_executions',
    'list_tags', 'get_agent_tags', 'tag_agent', 'untag_agent', 'set_agent_tags',
    'send_notification', 'register_subscription', 'list_subscriptions',
    'assign_subscription', 'clear_agent_subscription', 'get_agent_auth',
    'delete_subscription', 'get_fleet_health', 'get_agent_health',
    'trigger_health_check', 'configure_nevermined', 'get_nevermined_config',
    'toggle_nevermined', 'get_nevermined_payments',
  ]);

  private async callIntelAgent(query: string): Promise<string | null> {
    try {
      const res = await fetch('/api/intel-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: query }),
      });
      if (!res.ok || !res.body) return null;

      // Read SSE stream — keep-alive comments are ignored, data events carry the response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.response && !payload.response.startsWith('Agent returned error')) return payload.response;
            if (payload.error) return null;
          } catch { /* skip malformed */ }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async callApifySearch(query: string): Promise<string | null> {
    try {
      const res = await fetch('/api/apify-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.response || null;
    } catch {
      return null;
    }
  }

  private async processQuery(query: string): Promise<string> {
    const lowerQuery = query.toLowerCase();

    // Help command
    if (lowerQuery.includes('help') || lowerQuery.includes('what can')) {
      return this.getHelpText();
    }

    // Race Trinity intelligence agent and Apify web search in parallel
    // Trinity provides deep analysis; Apify provides fast web results
    const trinityPromise = this.callIntelAgent(query);
    const apifyPromise = this.callApifySearch(query);

    // Wait for both, use Trinity if available, Apify as fallback or supplement
    const [trinityResult, apifyResult] = await Promise.allSettled([trinityPromise, apifyPromise]);

    const trinity = trinityResult.status === 'fulfilled' ? trinityResult.value : null;
    const apify = apifyResult.status === 'fulfilled' ? apifyResult.value : null;

    // If Trinity responded with real content, use it (optionally append search results)
    if (trinity && !trinity.includes("I wasn't able to find")) {
      if (apify) {
        return `${trinity}\n\n---\n**Web Search Results:**\n${apify}`;
      }
      return trinity;
    }

    // If only Apify responded, use it
    if (apify) {
      return apify;
    }

    // If Trinity had a partial response, still return it
    if (trinity) return trinity;

    return `I wasn't able to find relevant information for that query. Here are some things I can help with:\n\n- **Global events** — conflicts, earthquakes, protests\n- **Market data** — stocks, commodities, crypto\n- **Security** — cyber threats, travel advisories\n- **Intelligence** — geopolitical analysis, military activity\n- **Search** — news, research, real-time data\n\nTry rephrasing your question or ask something more specific.`;
  }

  private findBestTool(query: string, tools: typeof this.mcpTools): typeof this.mcpTools[0] | null {
    // Simple keyword matching against tool names and descriptions
    let bestMatch: typeof this.mcpTools[0] | null = null;
    let bestScore = 0;

    for (const tool of tools) {
      const searchText = `${tool.name} ${tool.description}`.toLowerCase();
      const queryWords = query.split(/\s+/);
      let score = 0;
      for (const word of queryWords) {
        if (word.length > 2 && searchText.includes(word)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = tool;
      }
    }

    return bestMatch;
  }

  /** Fields that must never be shown to the user */
  private static readonly REDACTED_KEYS = new Set([
    'container_id', 'port', 'resources', 'base_image_version',
    'owner', 'is_owner', 'is_shared', 'is_system', 'template',
    'runtime', 'github_repo', 'memory_limit', 'cpu_limit',
    'autonomy_enabled', 'read_only_enabled', 'tags',
  ]);

  /** Tool results that expose platform internals and should be blocked entirely */
  private static readonly BLOCKED_TOOLS = new Set([
    'list_agents', 'get_agent', 'get_agent_info', 'get_agent_logs',
    'get_agent_ssh_access', 'get_credential_status', 'export_credentials',
    'import_credentials', 'inject_credentials', 'get_credential_encryption_key',
    'get_fleet_health', 'get_agent_health', 'get_agent_auth',
    'list_subscriptions', 'get_agent_requirements', 'get_nevermined_config',
    'get_nevermined_payments', 'get_system_manifest',
  ]);

  private sanitizeValue(obj: any): any {
    if (Array.isArray(obj)) return obj.map(item => this.sanitizeValue(item));
    if (obj && typeof obj === 'object') {
      const clean: Record<string, any> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (ChatbotPanel.REDACTED_KEYS.has(key)) continue;
        clean[key] = this.sanitizeValue(val);
      }
      return clean;
    }
    return obj;
  }

  private formatResponse(toolName: string, result: string): string {
    // Block responses from internal platform tools entirely
    if (ChatbotPanel.BLOCKED_TOOLS.has(toolName)) {
      return 'Here is what I found based on your query. Let me know if you need more details.';
    }

    try {
      const parsed = JSON.parse(result);
      const sanitized = this.sanitizeValue(parsed);

      if (Array.isArray(sanitized)) {
        const items = sanitized.slice(0, 10);
        const formatted = items.map((item: any, i: number) => {
          if (item.title && item.link) {
            return `${i + 1}. **${item.title}**\n   ${item.link}${item.description ? `\n   ${item.description}` : ''}`;
          }
          if (item.name && item.status) {
            return `${i + 1}. **${item.name}** — ${item.status}`;
          }
          // Avoid dumping raw JSON with internal fields
          const display = typeof item === 'string' ? item : (item.title || item.name || item.text || JSON.stringify(item));
          return `${i + 1}. ${display}`;
        }).join('\n\n');
        return `**Results** (${sanitized.length} items):\n\n${formatted}`;
      }
      // For objects, show a clean summary instead of raw JSON
      if (typeof sanitized === 'object' && sanitized !== null) {
        const summary = sanitized.title || sanitized.name || sanitized.message || sanitized.text;
        if (summary) return String(summary);
      }
      const json = JSON.stringify(sanitized, null, 2).slice(0, 2000);
      return `\`\`\`json\n${json}\n\`\`\``;
    } catch {
      const truncated = result.length > 3000 ? result.slice(0, 3000) + '...' : result;
      return truncated;
    }
  }

  private getHelpText(): string {
    const trinityTools = this.mcpTools.filter(t => t.source === 'trinity');
    const apifyTools = this.mcpTools.filter(t => t.source === 'apify');

    const trinityConnected = trinityTools.length > 0;
    const apifyConnected = apifyTools.length > 0;

    let text = '## What I Can Help With\n\n';
    text += '- **Global events** — conflicts, earthquakes, protests, natural disasters\n';
    text += '- **Market data** — stocks, commodities, crypto, ETFs\n';
    text += '- **Security** — cyber threats, travel advisories, military activity\n';
    text += '- **Intelligence** — geopolitical analysis, country risk, sanctions\n';
    text += '- **Search & research** — news, data, web scraping\n\n';

    text += '**Example queries:**\n';
    text += '- "What are the latest conflicts in the Middle East?"\n';
    text += '- "Search for AI regulation news"\n';
    text += '- "Analyze current market trends"\n';
    text += '- "Find cybersecurity threats this week"\n\n';

    text += `**Status:** ${trinityConnected ? 'Trinity connected' : 'Trinity offline'}${apifyConnected ? ', Apify connected' : ', Apify offline'}`;

    return text;
  }

  /**
   * Detect the semantic domain of a conversation to build a contextual
   * ZeroClick query and broadcast intent signals for better offer matching.
   */
  private static readonly SEMANTIC_MAP: Array<{
    patterns: RegExp;
    query: (ctx: string) => string;
    signal: ZeroClickSignal;
  }> = [
    {
      patterns: /\b(stock|market|trading|invest|portfolio|etf|s&p|nasdaq|dow|bull|bear|dividend)\b/i,
      query: (ctx) => `best ${ctx.includes('portfolio') ? 'portfolio management' : 'stock trading'} platform for investors`,
      signal: { category: 'interest', confidence: 0.9, subject: 'financial trading and investment tools', sentiment: 'positive' },
    },
    {
      patterns: /\b(crypto|bitcoin|btc|ethereum|eth|blockchain|defi|nft|wallet|solana)\b/i,
      query: (ctx) => `best ${ctx.includes('wallet') ? 'crypto wallet' : 'cryptocurrency exchange'} platform`,
      signal: { category: 'interest', confidence: 0.9, subject: 'cryptocurrency and blockchain', sentiment: 'positive' },
    },
    {
      patterns: /\b(gold|silver|oil|crude|commodit|natural gas|copper|platinum|precious metal)\b/i,
      query: () => 'best commodities trading platform precious metals investment',
      signal: { category: 'interest', confidence: 0.85, subject: 'commodities and precious metals trading', sentiment: 'positive' },
    },
    {
      patterns: /\b(cyber|hack|breach|ransomware|malware|phishing|vulnerability|zero-?day|infosec)\b/i,
      query: () => 'best cybersecurity software endpoint protection VPN',
      signal: { category: 'problem', confidence: 0.85, subject: 'cybersecurity threats and protection', sentiment: 'concerned' },
    },
    {
      patterns: /\b(earthquake|tsunami|volcano|hurricane|tornado|flood|wildfire|disaster|fema)\b/i,
      query: (ctx) => `best ${ctx.includes('wildfire') ? 'wildfire' : 'earthquake'} emergency preparedness kit supplies`,
      signal: { category: 'interest', confidence: 0.8, subject: 'emergency preparedness and disaster response', sentiment: 'concerned' },
    },
    {
      patterns: /\b(conflict|war|military|defense|missile|drone|troops|army|navy|airforce|nato)\b/i,
      query: () => 'best tactical gear outdoor equipment survival tools',
      signal: { category: 'interest', confidence: 0.75, subject: 'defense technology and tactical equipment', sentiment: 'neutral' },
    },
    {
      patterns: /\b(flight|aviation|airport|airline|travel|trip|booking|hotel|visa)\b/i,
      query: () => 'best travel deals flight booking hotel discount',
      signal: { category: 'purchase_intent', confidence: 0.85, subject: 'travel and flight booking', sentiment: 'positive' },
    },
    {
      patterns: /\b(ai|artificial intelligence|machine learning|llm|gpt|claude|chatbot|neural)\b/i,
      query: () => 'best AI tools productivity software automation',
      signal: { category: 'interest', confidence: 0.9, subject: 'AI and machine learning tools', sentiment: 'positive' },
    },
    {
      patterns: /\b(climate|emission|carbon|renewable|solar|wind|green energy|sustainability|ev)\b/i,
      query: () => 'best sustainable products solar panels green energy solutions',
      signal: { category: 'interest', confidence: 0.8, subject: 'sustainability and clean energy', sentiment: 'positive' },
    },
    {
      patterns: /\b(trade|tariff|sanction|export|import|supply chain|shipping|logistics|wto)\b/i,
      query: () => 'best supply chain management logistics software',
      signal: { category: 'business_context', confidence: 0.8, subject: 'international trade and supply chain', sentiment: 'neutral' },
    },
    {
      patterns: /\b(election|politics|government|legislation|regulation|policy|congress|parliament)\b/i,
      query: () => 'best news subscription political analysis platform',
      signal: { category: 'interest', confidence: 0.7, subject: 'political news and analysis', sentiment: 'neutral' },
    },
    {
      patterns: /\b(health|pandemic|virus|covid|vaccine|who|disease|outbreak|hospital)\b/i,
      query: () => 'best health monitoring wellness products',
      signal: { category: 'interest', confidence: 0.8, subject: 'health and wellness', sentiment: 'concerned' },
    },
    {
      patterns: /\b(real estate|housing|property|mortgage|rent|construction)\b/i,
      query: () => 'best real estate investment platform property tools',
      signal: { category: 'interest', confidence: 0.85, subject: 'real estate and property investment', sentiment: 'positive' },
    },
    {
      patterns: /\b(maritime|ship|port|vessel|cargo|piracy|strait|canal)\b/i,
      query: () => 'best marine navigation equipment maritime tools',
      signal: { category: 'interest', confidence: 0.75, subject: 'maritime shipping and navigation', sentiment: 'neutral' },
    },
  ];

  /** Generic fallback marker — if the AI response is the canned fallback,
   *  only match semantics against the user query (the fallback text contains
   *  every domain keyword and would always match the same bucket). */
  private static readonly FALLBACK_MARKER = "I wasn't able to find relevant information";

  private async appendOffers(userQuery: string, aiResponse: string): Promise<void> {
    try {
      const isFallback = aiResponse.includes(ChatbotPanel.FALLBACK_MARKER);

      // Match semantics against user query first; include AI response only
      // when it's a real (non-fallback) answer
      const queryCtx = userQuery.toLowerCase();
      const fullCtx = isFallback ? queryCtx : `${queryCtx} ${aiResponse.toLowerCase()}`;

      // 1. Try matching user query against semantic domains
      const queryMatched = ChatbotPanel.SEMANTIC_MAP.filter(s => s.patterns.test(queryCtx));

      // 2. If nothing matched the query alone, try the AI response too
      const matched = queryMatched.length > 0
        ? queryMatched
        : ChatbotPanel.SEMANTIC_MAP.filter(s => s.patterns.test(fullCtx));

      let offerQuery: string;
      const signals: ZeroClickSignal[] = [];

      if (matched.length > 0) {
        offerQuery = matched[0]!.query(fullCtx);
        for (const m of matched) signals.push(m.signal);
      } else {
        // No domain match — pass the user's natural language query directly
        // to ZeroClick (its API already does semantic matching)
        offerQuery = userQuery.replace(/[?!.]/g, '').trim();
      }

      // Broadcast signals for better future offer matching (fire-and-forget)
      if (signals.length > 0) broadcastSignals(signals);

      console.log(`[ZeroClick] query="${offerQuery}" (matched=${matched.length}, fallback=${isFallback})`);
      const offers = await fetchZeroClickOffers(offerQuery, 3);
      if (offers.length === 0) return;

      trackZeroClickImpressions(offers.map(o => o.id));

      const offersEl = document.createElement('div');
      offersEl.className = 'chatbot-offers';
      offersEl.innerHTML = `
        <div class="chatbot-offers-label">Sponsored</div>
        <div class="chatbot-offers-list">
          ${offers.map(o => this.renderOfferCard(o)).join('')}
        </div>
      `;
      this.messagesContainer.appendChild(offersEl);
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    } catch {
      // Silent fail — offers are non-critical
    }
  }

  private renderOfferCard(offer: ZeroClickOffer): string {
    const priceHtml = offer.price?.amount
      ? `<span class="chatbot-offer-price">${escapeHtml(offer.price.currency)} ${escapeHtml(offer.price.amount)}</span>`
      : '';
    return `<a href="${escapeHtml(offer.clickUrl)}" target="_blank" rel="noopener" class="chatbot-offer-card">
      <img src="${escapeHtml(offer.imageUrl)}" alt="${escapeHtml(offer.title)}" class="chatbot-offer-img" loading="lazy" />
      <div class="chatbot-offer-info">
        <span class="chatbot-offer-brand">${escapeHtml(offer.brand.name)}</span>
        <span class="chatbot-offer-title">${escapeHtml(offer.title)}</span>
        <div class="chatbot-offer-bottom">
          ${priceHtml}
          <span class="chatbot-offer-cta">${escapeHtml(offer.cta)}</span>
        </div>
      </div>
    </a>`;
  }

  private addMessage(msg: ChatMessage): void {
    this.messages.push(msg);

    const msgEl = document.createElement('div');
    msgEl.className = `chatbot-message chatbot-message-${msg.role}`;

    const avatar = document.createElement('div');
    avatar.className = 'chatbot-avatar';
    avatar.textContent = msg.role === 'user' ? 'U' : 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'chatbot-bubble';
    bubble.innerHTML = this.renderMarkdown(msg.content);

    const time = document.createElement('div');
    time.className = 'chatbot-time';
    time.textContent = msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.appendChild(avatar);
    const wrapper = document.createElement('div');
    wrapper.className = 'chatbot-bubble-wrapper';
    wrapper.appendChild(bubble);
    wrapper.appendChild(time);
    msgEl.appendChild(wrapper);

    this.messagesContainer.appendChild(msgEl);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private renderMarkdown(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');
  }

  private setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.sendBtn.disabled = loading;
    this.inputEl.disabled = loading;

    // Remove existing loading indicator
    const existing = this.messagesContainer.querySelector('.chatbot-loading');
    if (existing) existing.remove();

    if (loading) {
      const loader = document.createElement('div');
      loader.className = 'chatbot-message chatbot-message-assistant chatbot-loading';
      loader.innerHTML = `
        <div class="chatbot-avatar">AI</div>
        <div class="chatbot-bubble-wrapper">
          <div class="chatbot-bubble">
            <div class="chatbot-typing">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      `;
      this.messagesContainer.appendChild(loader);
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }
}

const CHATBOT_CSS = `
.chatbot-panel {
  min-height: 500px !important;
}

.chatbot-mcp-status {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-hover, rgba(255,255,255,0.03));
}

.chatbot-mcp-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chatbot-mcp-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.chatbot-mcp-badge.connected {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.chatbot-mcp-badge.disconnected {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.chatbot-mcp-badge.trinity { order: 1; }
.chatbot-mcp-badge.apify { order: 2; }

.chatbot-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chatbot-message {
  display: flex;
  gap: 8px;
  max-width: 90%;
}

.chatbot-message-user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.chatbot-message-assistant {
  align-self: flex-start;
}

.chatbot-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.chatbot-message-user .chatbot-avatar {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
}

.chatbot-message-assistant .chatbot-avatar {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.chatbot-bubble-wrapper {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chatbot-bubble {
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.chatbot-message-user .chatbot-bubble {
  background: rgba(59, 130, 246, 0.15);
  color: var(--text);
  border-bottom-right-radius: 4px;
}

.chatbot-message-assistant .chatbot-bubble {
  background: var(--surface-hover, rgba(255,255,255,0.05));
  color: var(--text);
  border-bottom-left-radius: 4px;
}

.chatbot-bubble code {
  background: rgba(0,0,0,0.3);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}

.chatbot-bubble pre {
  background: rgba(0,0,0,0.4);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 4px 0;
}

.chatbot-bubble pre code {
  background: none;
  padding: 0;
}

.chatbot-bubble h3, .chatbot-bubble h4 {
  margin: 8px 0 4px;
  font-size: 14px;
}

.chatbot-bubble ul {
  margin: 4px 0;
  padding-left: 16px;
}

.chatbot-bubble li {
  margin: 2px 0;
}

.chatbot-time {
  font-size: 10px;
  color: var(--text-muted, #666);
  padding: 0 4px;
}

.chatbot-message-user .chatbot-time {
  text-align: right;
}

.chatbot-input-area {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-hover, rgba(255,255,255,0.03));
  align-items: flex-end;
}

.chatbot-input {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 120px;
}

.chatbot-input:focus {
  border-color: rgba(59, 130, 246, 0.5);
}

.chatbot-input::placeholder {
  color: var(--text-muted, #666);
}

.chatbot-send-btn {
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 8px;
  color: #60a5fa;
  cursor: pointer;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s;
}

.chatbot-send-btn:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.35);
}

.chatbot-send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chatbot-typing {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}

.chatbot-typing span {
  width: 6px;
  height: 6px;
  background: var(--text-muted, #666);
  border-radius: 50%;
  animation: chatbot-bounce 1.2s infinite;
}

.chatbot-typing span:nth-child(2) { animation-delay: 0.2s; }
.chatbot-typing span:nth-child(3) { animation-delay: 0.4s; }

@keyframes chatbot-bounce {
  0%, 80%, 100% { transform: translateY(0); }
  40% { transform: translateY(-8px); }
}

.chatbot-offers {
  padding: 4px 12px 8px;
  max-width: 90%;
  align-self: flex-start;
}

.chatbot-offers-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  opacity: 0.4;
  margin-bottom: 6px;
  padding-left: 36px;
}

.chatbot-offers-list {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.chatbot-offer-card {
  display: flex;
  flex-direction: column;
  width: 160px;
  min-width: 160px;
  border-radius: 8px;
  background: var(--surface-hover, rgba(255,255,255,0.05));
  border: 1px solid rgba(255,255,255,0.06);
  text-decoration: none;
  color: inherit;
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}

.chatbot-offer-card:hover {
  border-color: rgba(59, 130, 246, 0.3);
  background: rgba(59, 130, 246, 0.05);
}

.chatbot-offer-img {
  width: 100%;
  height: 90px;
  object-fit: cover;
}

.chatbot-offer-info {
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chatbot-offer-brand {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.5;
}

.chatbot-offer-title {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chatbot-offer-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
}

.chatbot-offer-price {
  font-size: 12px;
  font-weight: 700;
  color: #4fc3f7;
}

.chatbot-offer-cta {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  font-weight: 600;
}
`;
