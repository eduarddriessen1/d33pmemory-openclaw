/**
 * d33pmemory OpenClaw Plugin
 *
 * Automatically ingests conversations and recalls memories
 * so AI agents remember everything without being told to.
 *
 * Hooks:
 *   - agent_end       → auto-ingest conversation into d33pmemory
 *   - before_agent_start → track sessionKey for the turn
 *   - agent:bootstrap → auto-recall relevant memories into context
 *
 * Tools:
 *   - d33pmemory_recall  → manual semantic memory search
 *   - d33pmemory_ingest  → manual memory ingestion
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
      source?: string,
      customId?: string,
      metadata?: Record<string, string | number | boolean>
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
        ...(customId ? { custom_id: customId } : {}),
        ...(metadata ? { metadata } : {}),
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

// ── Session Key Derivation ─────────────────────────────

/**
 * Session key format: agent:<workspace-name>:<channel>:<account>:<conversation>
 * Example: agent:dm-agent:telegram:dm-agent-bot:direct:176654117
 * Example: agent:alice:telegram:alice-bot:direct:123456
 *
 * The workspace name (parts[1]) is the unique identifier for each agent/workspace.
 * This is the key isolation mechanism for multi-agent setups.
 */
function deriveWorkspaceName(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts[1] || "unknown";
}

/**
 * Resolves the agent_id for API calls.
 *
 * Logic:
 *   - If config.agentId is explicitly set → use it (user wants shared namespace)
 *   - If config.agentId is empty/undefined → derive from session key workspace name
 *     (each workspace/agent gets its own memory namespace)
 *
 * This means:
 *   - dm-agent workspace → memories stored under agent_id="dm-agent"
 *   - alice workspace    → memories stored under agent_id="alice"
 *
 * Even with the same API key, memories stay isolated per workspace.
 */
function resolveAgentId(configuredAgentId: string | undefined, sessionKey: string): string {
  if (configuredAgentId && configuredAgentId.trim() !== "") {
    return configuredAgentId.trim();
  }
  return deriveWorkspaceName(sessionKey);
}

function buildMemoryCustomId(sessionKey: string): string {
  // Sanitize for use as a d33pmemory custom_id
  return sessionKey
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 200); // stay within reasonable length
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

// Store the last user message and session key per session for pairing
// with the agent's response on agent_end.

interface PendingTurn {
  content: string;
  timestamp: number;
}

const pendingTurns = new Map<string, PendingTurn>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanPending() {
  const now = Date.now();
  for (const [key, val] of pendingTurns) {
    if (now - val.timestamp > PENDING_TTL_MS) {
      pendingTurns.delete(key);
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
  const configuredAgentId = pluginConfig.agentId; // fallback agent id from config
  const autoIngest = pluginConfig.autoIngest !== false;
  const autoRecall = pluginConfig.autoRecall !== false;

  api.logger?.info?.(
    `[d33pmemory] Plugin loaded. autoIngest=${autoIngest}, autoRecall=${autoRecall}, agentId=${configuredAgentId || "derived from session"}`
  );

  // ── Track sessionKey per turn ─────────────────────────

  if (autoIngest) {
    // Use before_agent_start to capture the sessionKey before the agent runs.
    // This is more reliable than trying to extract it from event.context
    // in agent_end (which may not always be populated).
    api.on(
      "before_agent_start",
      (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        if (ctx.sessionKey) {
          // Store sessionKey at the turn level; agent_end will use it
          (api as any).__d33pmemory_sessionKey = ctx.sessionKey as string;
        }
      }
    );

    // ── Hook: agent_end — auto-ingest conversation ──────

    api.on("agent_end", async (event: Record<string, unknown>) => {
      try {
        // Grab the sessionKey we captured on before_agent_start
        const sessionKey = (api as any).__d33pmemory_sessionKey as string | undefined;

        // Extract messages — look for the standard message array
        const messages = event.messages as unknown[] | undefined;
        if (!Array.isArray(messages) || messages.length === 0) return;

        // Get the last user turn and the last assistant turn
        let lastUserContent = "";
        let lastAssistantContent = "";

        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as Record<string, unknown>;
          if (!msg || typeof msg !== "object") continue;

          const role = msg.role as string;
          let content = "";

          if (typeof msg.content === "string") {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            // Handle multimodal content blocks
            for (const block of msg.content as Record<string, unknown>[]) {
              if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
                content += block.text + " ";
              }
            }
            content = content.trim();
          }

          if (!content) continue;

          if (role === "user" && !lastUserContent) {
            lastUserContent = content;
          }
          if (role === "assistant" && !lastAssistantContent) {
            lastAssistantContent = content;
            break; // found the paired assistant response
          }

          // If we've found both, stop
          if (lastUserContent && lastAssistantContent) break;
        }

        // Skip system messages and very short messages
        if (lastUserContent.length < 5) return;
        if (lastUserContent.startsWith("/")) return;
        if (lastAssistantContent.length < 2) return;

        // Resolve agent_id:
        // - If config.agentId is set → use it (shared namespace across workspaces)
        // - Otherwise → derive from session key workspace name (each workspace isolated)
        const agentId = sessionKey
          ? resolveAgentId(configuredAgentId, sessionKey)
          : configuredAgentId;
        const customId = sessionKey ? buildMemoryCustomId(sessionKey) : undefined;

        const result = await client.ingest(
          lastUserContent,
          lastAssistantContent,
          agentId,
          undefined, // source — use config default
          customId,
          {
            session_key: sessionKey || "unknown",
            agent_id: agentId,
            workspace: sessionKey ? deriveWorkspaceName(sessionKey) : "unknown",
            ingested_via: "agent_end_hook",
          }
        );

        if (result.memories_stored > 0) {
          api.logger?.debug?.(
            `[d33pmemory] Ingested ${result.memories_stored} memories workspace=${sessionKey ? deriveWorkspaceName(sessionKey) : "?"} agent=${agentId}`
          );
        }
      } catch (err: any) {
        api.logger?.warn?.(`[d33pmemory] Ingest failed: ${err.message}`);
      }
    });
  }

  // ── Hook: agent:bootstrap — auto-recall memories ────

  if (autoRecall) {
    api.registerHook(
      "agent:bootstrap",
      async (event: Record<string, unknown>) => {
        try {
          const sessionKey = event.sessionKey as string | undefined;
          const agentId = sessionKey
            ? resolveAgentId(configuredAgentId, sessionKey)
            : configuredAgentId;

          const query =
            pluginConfig.recallQuery ||
            "Important facts, preferences, and recent context about this user";

          const result = await client.recall(
            query,
            agentId,
            pluginConfig.recallMaxResults || 10,
            pluginConfig.recallMinConfidence || 0.3
          );

          if (result.memories.length === 0) return;

          const contextBlock = formatMemoriesForContext(result.memories);

          if (
            event.context?.bootstrapFiles &&
            Array.isArray((event.context as any).bootstrapFiles)
          ) {
            (event.context as any).bootstrapFiles.push({
              path: "D33PMEMORY_CONTEXT.md",
              content: contextBlock,
            });
          }

          api.logger?.debug?.(
            `[d33pmemory] Injected ${result.memories.length} memories into bootstrap context (workspace=${sessionKey ? deriveWorkspaceName(sessionKey) : "?"})`
          );
        } catch (err: any) {
          api.logger?.warn?.(`[d33pmemory] Auto-recall failed: ${err.message}`);
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
        const sessionKey = (api as any).__d33pmemory_sessionKey as string | undefined;
        const agentId = sessionKey
          ? resolveAgentId(configuredAgentId, sessionKey)
          : configuredAgentId;

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
          const sessionKey = (api as any).__d33pmemory_sessionKey as string | undefined;
          const agentId = sessionKey
            ? resolveAgentId(configuredAgentId, sessionKey)
            : configuredAgentId;
          const customId = sessionKey ? buildMemoryCustomId(sessionKey) : undefined;

          const result = await client.ingest(
            params.user_message,
            params.agent_response || "",
            agentId,
            undefined,
            customId,
            {
              session_key: sessionKey || "manual",
              agent_id: agentId,
              workspace: sessionKey ? deriveWorkspaceName(sessionKey) : "manual",
              ingested_via: "d33pmemory_ingest_tool",
            }
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
