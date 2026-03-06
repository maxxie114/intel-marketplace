import { useState, useEffect, useCallback } from "react";
import {
  fetchSellers,
  streamChat,
  connectLogStream,
  type IntelSeller,
  type LogEntry,
  type ChatMessage,
  type ZeroClickOffer,
} from "./api";
import ChatPanel from "./components/ChatPanel";
import MarketplaceSidebar from "./components/MarketplaceSidebar";
import ActivityLog from "./components/ActivityLog";
import OffersBar from "./components/OffersBar";

const MAX_LOGS = 200;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sellers, setSellers] = useState<IntelSeller[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [currentTool, setCurrentTool] = useState("");
  const [pendingOffers, setPendingOffers] = useState<ZeroClickOffer[]>([]);

  // Poll marketplace sellers every 10 seconds
  useEffect(() => {
    const load = () => fetchSellers().then(setSellers).catch(() => {});
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  // Connect log stream
  useEffect(() => {
    const disconnect = connectLogStream((entry) => {
      setLogs((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.timestamp === entry.timestamp &&
          last.action === entry.action &&
          last.message === entry.message
        ) {
          return prev;
        }
        const next = [...prev, entry];
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
      });
    });
    return disconnect;
  }, []);

  const handleSend = useCallback(async (message: string) => {
    setMessages((prev) => [...prev, { role: "user", text: message }]);
    setIsStreaming(true);
    setStreamingText("");
    setCurrentTool("");
    setPendingOffers([]);

    let lastToolUsed = "";

    await streamChat(message, {
      onToken: (text) => setStreamingText((prev) => prev + text),
      onToolUse: (name) => {
        setCurrentTool(name);
        lastToolUsed = name;
      },
      onDone: (fullText, offers) => {
        setMessages((prev) => [
          ...prev,
          {
            role: "agent",
            text: fullText,
            toolUse: lastToolUsed || undefined,
            offers: offers.length > 0 ? offers : undefined,
          },
        ]);
        if (offers.length > 0) {
          setPendingOffers(offers);
        }
        setIsStreaming(false);
        setStreamingText("");
        setCurrentTool("");
        fetchSellers().then(setSellers).catch(() => {});
      },
      onError: (error) => {
        setMessages((prev) => [
          ...prev,
          { role: "agent", text: `Error: ${error}` },
        ]);
        setIsStreaming(false);
        setStreamingText("");
        setCurrentTool("");
      },
    });
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0">
        {/* Marketplace sidebar */}
        <div className="w-[280px] shrink-0">
          <MarketplaceSidebar sellers={sellers} />
        </div>

        {/* Chat + offers */}
        <div className="flex flex-col flex-1 min-w-0">
          <ChatPanel
            messages={messages}
            isStreaming={isStreaming}
            streamingText={streamingText}
            currentTool={currentTool}
            onSend={handleSend}
          />
          {pendingOffers.length > 0 && (
            <OffersBar offers={pendingOffers} onDismiss={() => setPendingOffers([])} />
          )}
        </div>
      </div>

      {/* Activity log */}
      <div className="h-[180px] shrink-0 border-t">
        <ActivityLog logs={logs} />
      </div>
    </div>
  );
}
