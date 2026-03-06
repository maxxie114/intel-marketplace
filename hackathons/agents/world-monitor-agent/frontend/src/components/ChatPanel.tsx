import { useRef, useEffect, useState } from "react";
import { Send, Wrench, Globe } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/api";

interface ChatPanelProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingText: string;
  currentTool: string;
  onSend: (message: string) => void;
}

const TOOL_LABELS: Record<string, string> = {
  search_news_and_web: "Searching news & web",
  search_social_signals: "Scanning social signals",
  search_financial_data: "Fetching financial data",
  deep_web_research: "Conducting deep research",
  consult_marketplace_agents: "Consulting marketplace agents",
  enrich_from_knowledge_base: "Enriching from knowledge base",
};

export default function ChatPanel({
  messages,
  isStreaming,
  streamingText,
  currentTool,
  onSend,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingText]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setInput("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col flex-1 h-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4 max-w-3xl mx-auto">
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-500 to-teal-400 flex items-center justify-center mb-4 shadow-lg">
                <Globe className="h-7 w-7 text-white" />
              </div>
              <h2 className="text-lg font-semibold mb-2">World Monitor Agent</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Ask me about current world events, markets, social trends, or any topic.
                I synthesize news, social signals, and financial data in real time.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 justify-center">
                {[
                  "What's happening in global markets today?",
                  "Latest AI news this week",
                  "Bitcoin price and crypto sentiment",
                  "Most discussed topics on Reddit right now",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => onSend(q)}
                    className="text-xs px-3 py-1.5 rounded-full border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-blue-50 text-foreground border border-blue-100"
                    : "bg-card border text-foreground"
                }`}
              >
                {msg.toolUse && (
                  <div className="flex items-center gap-1.5 mb-1.5 text-xs text-muted-foreground">
                    <Wrench className="h-3 w-3" />
                    <span>{TOOL_LABELS[msg.toolUse] ?? msg.toolUse}</span>
                  </div>
                )}
                {msg.text}
              </div>
            </div>
          ))}

          {isStreaming && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed bg-card border text-foreground">
                {currentTool && (
                  <div className="flex items-center gap-1.5 mb-1.5 text-xs text-muted-foreground">
                    <Wrench className="h-3 w-3 animate-spin" />
                    <span>{TOOL_LABELS[currentTool] ?? currentTool}...</span>
                  </div>
                )}
                {streamingText && (
                  <span className="whitespace-pre-wrap">{streamingText}</span>
                )}
                <span className="inline-block w-2 h-4 bg-primary/60 ml-0.5 animate-pulse" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about world events, markets, trends..."
            rows={1}
            className="flex-1 resize-none rounded-xl border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[40px] max-h-[120px]"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <Button
            onClick={handleSubmit}
            disabled={!input.trim() || isStreaming}
            size="icon"
            className="h-10 w-10 rounded-xl shrink-0 bg-gradient-to-r from-blue-500 to-teal-400 hover:opacity-90 border-0 shadow-md"
          >
            <Send className="h-4 w-4 text-white" />
          </Button>
        </div>
      </div>
    </div>
  );
}
