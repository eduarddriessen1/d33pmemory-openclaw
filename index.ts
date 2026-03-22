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
  midTurnRecall?: boolean;
  midTurnRecallMaxResults?: number;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
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

// ── Personal Context Signal Detection ────────────────
//
// Detects whether an incoming message likely needs personal context
// to answer well. Used to decide whether to fire a mid-turn recall.
//
// We keep this intentionally broad — false positives are cheap
// (an extra API call), false negatives are expensive (wrong answer).

const PERSONAL_CONTEXT_PATTERNS = [
  // Direct questions about the user's own info
  /\bmy\b.{0,40}\b(name|dog|cat|pet|partner|wife|husband|girlfriend|boyfriend|kid|child|children|son|daughter|parent|mom|dad|brother|sister|family)\b/i,
  /\bmy\b.{0,40}\b(diet|allergy|allergic|food|eat|drink|vegetarian|vegan|gluten)\b/i,
  /\bmy\b.{0,40}\b(job|work|role|company|employer|colleague|boss|team|project|task)\b/i,
  /\bmy\b.{0,40}\b(address|home|city|country|location|timezone|office)\b/i,
  /\bmy\b.{0,40}\b(preference|favourite|favorite|like|dislike|prefer|usual|order)\b/i,
  /\bmy\b.{0,40}\b(schedule|appointment|meeting|routine|habit|morning|evening)\b/i,
  /\bmy\b.{0,40}\b(goal|plan|todo|task|reminder|deadline)\b/i,
  /\bmy\b.{0,40}\b(account|subscription|plan|billing)\b/i,
  // Conversational triggers for past knowledge
  /\b(do you (know|remember)|what('s| is) my|tell me (about )?my|what do (you know|I have)|remind me)\b/i,
  /\b(last time|as usual|like before|same as|the usual)\b/i,
  /\b(remember when|you (said|told me|mentioned)|didn'?t (you|we))\b/i,
  // "what's X" patterns for personal things
  /\bwhat'?s?\s+(my|the name|their name)\b/i,
];

/**
 * Returns true if the message likely needs a mid-turn memory lookup.
 * Also returns a focused query string to use for the recall.
 */
function detectPersonalContextSignal(message: string): { needed: boolean; query: string } {
  // Strip very short messages — not worth the API call
  if (message.trim().length < 8) return { needed: false, query: "" };

  for (const pattern of PERSONAL_CONTEXT_PATTERNS) {
    if (pattern.test(message)) {
      // Use the message itself as the recall query — it's already specific
      return { needed: true, query: message.trim().slice(0, 300) };
    }
  }

  return { needed: false, query: "" };
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
  const midTurnRecall = pluginConfig.midTurnRecall !== false;

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

    api.on("agent_end", (event: Record<string, unknown>) => {
      // Fire-and-forget: don't await so we never block the gateway
      (async () => { try {
        // Guard: only capture on successful agent turns
        if (!event.success) return;

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

          if (role === "assistant" && !lastAssistantContent) {
            lastAssistantContent = content;
          }
          if (role === "user" && !lastUserContent) {
            lastUserContent = content;
          }

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
      })();
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

  // ── Hook: before_agent_start — mid-turn recall ───────
  //
  // Fires before every agent turn. If the incoming message contains
  // personal-context signals, runs a targeted recall and injects
  // the results as a fresh context block.
  //
  // This supplements (not replaces) the session-start bootstrap recall.
  // Bootstrap = broad "who is this user" snapshot.
  // Mid-turn = focused "what do I know about what they're asking right now".

  if (midTurnRecall) {
    api.registerHook(
      "before_agent_start",
      async (event: Record<string, unknown>) => {
        try {
          // Extract the incoming user message
          const inboundMessage =
            (event.inboundMessage as string | undefined) ||
            (event.message as string | undefined) ||
            "";

          if (!inboundMessage) return;

          const { needed, query } = detectPersonalContextSignal(inboundMessage);
          if (!needed) return;

          const sessionKey = event.sessionKey as string | undefined;
          const agentId = sessionKey
            ? resolveAgentId(configuredAgentId, sessionKey)
            : configuredAgentId;

          const maxResults = pluginConfig.midTurnRecallMaxResults || 5;

          const result = await client.recall(
            query,
            agentId,
            maxResults,
            pluginConfig.recallMinConfidence || 0.3
          );

          if (result.memories.length === 0) return;

          // Format and inject as a fresh context block
          const lines = result.memories.map((m) => {
            const conf = Math.round(m.confidence * 100);
            const src = m.source === "stated" ? "stated" : "inferred";
            const agent = m.contributed_by ? ` (via ${m.contributed_by})` : "";
            return `- [${m.type}/${src}/${conf}%] ${m.content}${agent}`;
          });

          const contextBlock = [
            "## d33pmemory — Mid-turn recall",
            "",
            `The following memories are relevant to the user's current message: "${inboundMessage.slice(0, 100)}${inboundMessage.length > 100 ? "..." : ""}"`,
            "Use them to answer accurately. Do not mention d33pmemory or this system to the user.",
            "",
            ...lines,
            "",
          ].join("\n");

          if (
            event.context?.bootstrapFiles &&
            Array.isArray((event.context as any).bootstrapFiles)
          ) {
            (event.context as any).bootstrapFiles.push({
              path: "D33PMEMORY_MID_TURN.md",
              content: contextBlock,
            });
          }

          api.logger?.debug?.(
            `[d33pmemory] Mid-turn recall: injected ${result.memories.length} memories for query="${query.slice(0, 60)}"`
          );
        } catch (err: any) {
          // Non-fatal — log and continue
          api.logger?.warn?.(`[d33pmemory] Mid-turn recall failed: ${err.message}`);
        }
      },
      {
        name: "d33pmemory.mid-turn-recall",
        description:
          "Runs a targeted memory recall before agent turns that contain personal-context signals",
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
