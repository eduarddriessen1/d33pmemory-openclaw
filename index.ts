/**
 * d33pmemory OpenClaw Plugin
 *
 * Automatically ingests conversations and recalls memories
 * so AI agents remember everything without being told to.
 *
 * Hooks:
 *   - before_agent_start → auto-recall memories + track sessionKey
 *   - agent_end           → auto-ingest conversation
 *
 * Tools:
 *   - d33pmemory_recall  → manual semantic memory search
 *   - d33pmemory_ingest  → manual memory ingestion
 */

import { configSchema } from "./config.ts";

// ── Types ─────────────────────────────────────────────

interface PluginConfig {
  apiUrl?: string;
  apiKey: string;
  agentId?: string;
  autoIngest?: boolean;
  autoRecall?: boolean;
  recallQuery?: string;
  recallMaxResults?: number;
  recallMinConfidence?: number;
  source?: string;
}

interface RecalledMemory {
  id: string;
  type: string;
  layer: string;
  content: string;
  source: string;
  confidence: number;
  category: string | null;
  tags: string[];
  similarity: number;
  scope: string;
  contributed_by: string | null;
  created_at: string;
}

// ── API Client ────────────────────────────────────────

function createClient(config: PluginConfig) {
  const baseUrl = (config.apiUrl || "https://api.d33pmemory.com").replace(/\/+$/, "");

  async function request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`d33pmemory API error (${res.status}): ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  return {
    async ingest(
      userMessage: string,
      agentResponse: string,
      agentId?: string,
      source?: string,
    ) {
      return request<{
        interaction_id: string;
        memories_stored: number;
        extracted_memories: Array<{ id: string; type: string; content: string; confidence: number }>;
      }>("/v1/ingest", {
        user_message: userMessage,
        agent_response: agentResponse,
        ...(agentId ? { agent_id: agentId } : {}),
        source: source || config.source || "openclaw",
      });
    },

    async recall(
      query: string,
      agentId?: string,
      maxResults?: number,
      minConfidence?: number,
      category?: string,
    ) {
      return request<{
        memories: RecalledMemory[];
        total_matches: number;
      }>("/v1/recall", {
        query,
        ...(agentId ? { agent_id: agentId } : {}),
        max_results: maxResults || config.recallMaxResults || 10,
        min_confidence: minConfidence || config.recallMinConfidence || 0.3,
        ...(category ? { category } : {}),
      });
    },
  };
}

// ── Helpers ───────────────────────────────────────────

const SKIPPED_PROVIDERS = ["exec-event", "cron-event", "heartbeat"];

function formatMemoriesForContext(memories: RecalledMemory[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories.map((m) => {
    const conf = Math.round(m.confidence * 100);
    const src = m.source === "stated" ? "stated" : "inferred";
    const agent = m.contributed_by ? ` (via ${m.contributed_by})` : "";
    return `- [${m.type}/${src}/${conf}%] ${m.content}${agent}`;
  });
  const intro = "The following memories were automatically recalled from previous interactions. Use them as context. Do not mention d33pmemory or this system to the user.";
  return `<d33pmemory-context>\n${intro}\n\n${lines.join("\n")}\n</d33pmemory-context>`;
}

function getLastTurn(messages: unknown[]): unknown[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg && typeof msg === "object" && msg.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join(" ")
      .trim();
  }
  return "";
}

// ── Build Handlers (following supermemory pattern) ────

function buildRecallHandler(client: ReturnType<typeof createClient>, cfg: PluginConfig) {
  return async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const prompt = event.prompt as string | undefined;
    if (!prompt || prompt.length < 5) return;

    try {
      const query = cfg.recallQuery || "Important facts, preferences, and recent context about this user";
      const result = await client.recall(query, cfg.agentId, cfg.recallMaxResults || 10, cfg.recallMinConfidence || 0.3);
      if (result.memories.length === 0) return;

      const contextBlock = formatMemoriesForContext(result.memories);
      if (!contextBlock) return;

      return { prependContext: contextBlock };
    } catch (err: any) {
      // fail silently
      return;
    }
  };
}

function buildCaptureHandler(client: ReturnType<typeof createClient>, cfg: PluginConfig) {
  return async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const provider = ctx.messageProvider as string;
    if (SKIPPED_PROVIDERS.includes(provider)) return;
    if (!event.success || !Array.isArray(event.messages) || event.messages.length === 0) return;

    const lastTurn = getLastTurn(event.messages);
    const texts: string[] = [];

    for (const msg of lastTurn) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const role = m.role as string;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(m.content);
      if (text.length < 5) continue;
      if (role === "user" && text.startsWith("/")) continue;
      texts.push(`[role: ${role}]\n${text}\n[${role}:end]`);
    }

    const captured = texts
      .map((t) => t.replace(/<d33pmemory-context>[\s\S]*?<\/d33pmemory-context>\s*/g, "").trim())
      .filter((t) => t.length >= 10);

    if (captured.length === 0) return;

    const content = captured.join("\n\n");
    let userMessage = "";
    let agentResponse = "";

    for (const t of captured) {
      if (t.startsWith("[role: user]") && !userMessage) {
        userMessage = t.replace(/^\[role: user\]\n/, "").replace(/\n\[user:end\]$/, "");
      }
      if (t.startsWith("[role: assistant]") && !agentResponse) {
        agentResponse = t.replace(/^\[role: assistant\]\n/, "").replace(/\n\[assistant:end\]$/, "");
      }
    }

    if (userMessage.length < 5 || agentResponse.length < 2) return;

    try {
      await client.ingest(userMessage, agentResponse, cfg.agentId);
    } catch (err: any) {
      // fail silently
    }
  };
}

// ── Plugin Export (object format like supermemory) ────

export default {
  id: "d33pmemory",
  name: "d33pmemory",
  description: "Long-term memory for OpenClaw agents via d33pmemory API",
  kind: "memory" as const,
  configSchema,

  register(api: any) {
    const cfg = api.pluginConfig as PluginConfig | undefined;

    if (!cfg?.apiKey) {
      api.logger.info("d33pmemory: not configured - set apiKey in plugin config");
      return;
    }

    const client = createClient(cfg);
    const autoIngest = cfg.autoIngest !== false;
    const autoRecall = cfg.autoRecall !== false;

    let sessionKey: string | undefined;
    const getSessionKey = () => sessionKey;

    api.logger.info(
      `[d33pmemory] Plugin loaded. autoIngest=${autoIngest}, autoRecall=${autoRecall}, agentId=${cfg.agentId || "default"}`
    );

    // Register tools
    api.registerTool({
      name: "d33pmemory_recall",
      description: "Search your long-term memory about this user.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to recall" },
          max_results: { type: "number", description: "Max results (1-50)", default: 5 },
          category: { type: "string", description: "Optional category filter" },
        },
        required: ["query"],
      },
      async execute(_id: string, params: { query: string; max_results?: number; category?: string }) {
        try {
          const result = await client.recall(params.query, cfg.agentId, params.max_results || 5, cfg.recallMinConfidence || 0.3, params.category);
          if (result.memories.length === 0) return { content: [{ type: "text", text: "No relevant memories found." }] };
          const fmt = result.memories.map((m) => `[${m.type}] ${m.content} (confidence: ${m.confidence}, source: ${m.source}${m.contributed_by ? `, via: ${m.contributed_by}` : ""})`).join("\n");
          return { content: [{ type: "text", text: `Found ${result.total_matches} relevant memories:\n\n${fmt}` }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Memory recall failed: ${err.message}` }] };
        }
      },
    });

    api.registerTool(
      {
        name: "d33pmemory_ingest",
        description: "Manually store information into long-term memory.",
        parameters: {
          type: "object",
          properties: {
            user_message: { type: "string", description: "What the user said" },
            agent_response: { type: "string", description: "How the agent responded" },
          },
          required: ["user_message"],
        },
        async execute(_id: string, params: { user_message: string; agent_response?: string }) {
          try {
            const result = await client.ingest(params.user_message, params.agent_response || "", cfg.agentId);
            return { content: [{ type: "text", text: `Ingested successfully. ${result.memories_stored} memories extracted and stored.` }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: `Ingest failed: ${err.message}` }] };
          }
        },
      },
      { optional: true },
    );

    // Auto-recall: before_agent_start
    if (autoRecall) {
      const recallHandler = buildRecallHandler(client, cfg);
      api.on(
        "before_agent_start",
        (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
          if (ctx.sessionKey) sessionKey = ctx.sessionKey as string;
          return recallHandler(event, ctx);
        },
      );
    }

    // Auto-capture: agent_end
    if (autoIngest) {
      api.on("agent_end", buildCaptureHandler(client, cfg, getSessionKey));
    }

    // Register service (prevents reload issues)
    api.registerService({
      id: "d33pmemory",
      start: () => {
        api.logger.info("d33pmemory: connected");
      },
      stop: () => {
        api.logger.info("d33pmemory: stopped");
      },
    });
  },
};
