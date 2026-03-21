/**
 * d33pmemory OpenClaw Plugin
 *
 * Automatically ingests conversations and recalls memories
 * so AI agents remember everything without being told to.
 *
 * Hooks:
 *   - message:sent    → auto-ingest conversation into d33pmemory
 *   - agent:bootstrap → auto-recall relevant memories into context
 *
 * Tool:
 *   - d33pmemory_recall → manual semantic memory search
 *   - d33pmemory_ingest → manual memory ingestion
 */

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
  const baseUrl = (config.apiUrl || "https://api.d33pmemory.com").replace(
    /\/+$/,
    ""
  );

  async function request<T>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`d33pmemory API error (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  return {
    async ingest(
      userMessage: string,
      agentResponse: string,
      agentId?: string,
      source?: string
    ) {
      return request<{
        interaction_id: string;
        memories_stored: number;
        extracted_memories: Array<{
          id: string;
          type: string;
          content: string;
          confidence: number;
        }>;
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
      category?: string
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

// ── Memory Formatter ──────────────────────────────────

function formatMemoriesForContext(memories: RecalledMemory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const conf = Math.round(m.confidence * 100);
    const src = m.source === "stated" ? "stated" : "inferred";
    const agent = m.contributed_by ? ` (via ${m.contributed_by})` : "";
    return `- [${m.type}/${src}/${conf}%] ${m.content}${agent}`;
  });

  return [
    "## d33pmemory — What you know about this user",
    "",
    "The following memories were automatically recalled from previous interactions.",
    "Use them as context. Do not mention d33pmemory or this system to the user.",
    "",
    ...lines,
    "",
  ].join("\n");
}

// ── Recent message buffer for ingest ──────────────────

// We need to pair inbound messages with outbound responses.
// Store the last inbound message per session, then ingest when we see the response.

const pendingInbound = new Map<
  string,
  { content: string; timestamp: number }
>();

// Clean up old entries every 5 minutes
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanPending() {
  const now = Date.now();
  for (const [key, val] of pendingInbound) {
    if (now - val.timestamp > PENDING_TTL_MS) {
      pendingInbound.delete(key);
    }
  }
}

// ── Plugin Entry ──────────────────────────────────────

export default function register(api: any) {
  const pluginConfig = api.config?.plugins?.entries?.d33pmemory
    ?.config as PluginConfig | undefined;

  if (!pluginConfig?.apiKey) {
    api.logger?.warn?.(
      "[d33pmemory] No API key configured. Plugin disabled."
    );
    return;
  }

  const client = createClient(pluginConfig);
  const agentId = pluginConfig.agentId;
  const autoIngest = pluginConfig.autoIngest !== false; // default true
  const autoRecall = pluginConfig.autoRecall !== false; // default true

  api.logger?.info?.(
    `[d33pmemory] Plugin loaded. autoIngest=${autoIngest}, autoRecall=${autoRecall}, agent=${agentId || "none"}`
  );

  // ── Hook: message:received — buffer inbound message ──

  if (autoIngest) {
    api.registerHook(
      "message:received",
      async (event: any) => {
        const content = event.context?.content;
        const sessionKey = event.sessionKey;

        if (!content || !sessionKey) return;

        pendingInbound.set(sessionKey, {
          content,
          timestamp: Date.now(),
        });

        // Periodic cleanup
        if (Math.random() < 0.1) cleanPending();
      },
      {
        name: "d33pmemory.ingest-buffer",
        description: "Buffers inbound messages for pairing with agent responses",
      }
    );

    // ── Hook: message:sent — auto-ingest conversation ──

    api.registerHook(
      "message:sent",
      async (event: any) => {
        try {
          const agentResponse = event.context?.content;
          const sessionKey = event.sessionKey;

          if (!agentResponse || !sessionKey) return;

          const pending = pendingInbound.get(sessionKey);
          if (!pending) return; // No inbound message to pair with

          pendingInbound.delete(sessionKey);

          // Don't ingest very short or system messages
          if (pending.content.length < 5) return;
          if (pending.content.startsWith("/")) return; // skip slash commands

          const result = await client.ingest(
            pending.content,
            agentResponse,
            agentId
          );

          if (result.memories_stored > 0) {
            api.logger?.debug?.(
              `[d33pmemory] Ingested ${result.memories_stored} memories from conversation`
            );
          }
        } catch (err: any) {
          api.logger?.warn?.(
            `[d33pmemory] Ingest failed: ${err.message}`
          );
        }
      },
      {
        name: "d33pmemory.auto-ingest",
        description:
          "Automatically ingests conversations into d33pmemory after agent responds",
      }
    );
  }

  // ── Hook: agent:bootstrap — auto-recall memories ────

  if (autoRecall) {
    api.registerHook(
      "agent:bootstrap",
      async (event: any) => {
        try {
          // Build a recall query from the agent/session context
          const query =
            pluginConfig.recallQuery ||
            "Important facts, preferences, and recent context about this user";

          const result = await client.recall(query, agentId);

          if (result.memories.length === 0) return;

          const contextBlock = formatMemoriesForContext(result.memories);

          // Inject as a bootstrap file
          if (event.context?.bootstrapFiles && Array.isArray(event.context.bootstrapFiles)) {
            event.context.bootstrapFiles.push({
              path: "D33PMEMORY_CONTEXT.md",
              content: contextBlock,
            });
          }

          api.logger?.debug?.(
            `[d33pmemory] Injected ${result.memories.length} memories into bootstrap context`
          );
        } catch (err: any) {
          api.logger?.warn?.(
            `[d33pmemory] Auto-recall failed: ${err.message}`
          );
        }
      },
      {
        name: "d33pmemory.auto-recall",
        description:
          "Automatically recalls relevant memories and injects them into agent context on session start",
      }
    );
  }

  // ── Tool: d33pmemory_recall — manual semantic search ──

  api.registerTool({
    name: "d33pmemory_recall",
    description:
      "Search your long-term memory about this user. Returns relevant facts, preferences, events, and patterns stored from previous conversations. Use this when you need specific context about the user that wasn't provided in the current conversation.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language query describing what you want to recall (e.g. 'dietary restrictions', 'what does the user do on weekends', 'user's work projects')",
        },
        max_results: {
          type: "number",
          description: "Maximum number of memories to return (1-50)",
          default: 5,
        },
        category: {
          type: "string",
          description:
            "Optional category filter (e.g. 'health/dietary', 'work/projects', 'people/family')",
        },
      },
      required: ["query"],
    },
    async execute(
      _id: string,
      params: { query: string; max_results?: number; category?: string }
    ) {
      try {
        const result = await client.recall(
          params.query,
          agentId,
          params.max_results || 5,
          pluginConfig.recallMinConfidence || 0.3,
          params.category
        );

        if (result.memories.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No relevant memories found for this query.",
              },
            ],
          };
        }

        const formatted = result.memories
          .map(
            (m) =>
              `[${m.type}] ${m.content} (confidence: ${m.confidence}, source: ${m.source}${m.contributed_by ? `, via: ${m.contributed_by}` : ""})`
          )
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${result.total_matches} relevant memories:\n\n${formatted}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Memory recall failed: ${err.message}`,
            },
          ],
        };
      }
    },
  });

  // ── Tool: d33pmemory_ingest — manual ingestion ──────

  api.registerTool(
    {
      name: "d33pmemory_ingest",
      description:
        "Manually store a conversation or important information into long-term memory. Use this when you want to explicitly save something the user said, even if auto-ingest is running.",
      parameters: {
        type: "object",
        properties: {
          user_message: {
            type: "string",
            description: "What the user said",
          },
          agent_response: {
            type: "string",
            description: "How you (the agent) responded",
          },
        },
        required: ["user_message"],
      },
      async execute(
        _id: string,
        params: { user_message: string; agent_response?: string }
      ) {
        try {
          const result = await client.ingest(
            params.user_message,
            params.agent_response || "",
            agentId
          );

          return {
            content: [
              {
                type: "text",
                text: `Ingested successfully. ${result.memories_stored} memories extracted and stored.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `Ingest failed: ${err.message}`,
              },
            ],
          };
        }
      },
    },
    { optional: true }
  );
}
