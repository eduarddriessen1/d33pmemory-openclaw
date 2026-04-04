/**
 * d33pmemory OpenClaw Plugin
 *
 * Automatically ingests conversations and recalls memories
 * so AI agents remember everything without being told to.
 *
 * Hooks:
 *   - agent_end          → auto-ingest conversation into d33pmemory
 *   - before_agent_start → bootstrap recall (first turn) + mid-turn recall (signal detected)
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
      // API returns 202 + { job_id, status: "queued" } (async)
      // Fire-and-forget — we don't poll for results
      const result = await request<{
        // New async response shape
        job_id?: string;
        status?: string;
        // Legacy sync shape (old API versions) — kept for compatibility
        interaction_id?: string;
        memories_stored?: number;
      }>("/v1/ingest", {
        user_message: userMessage,
        agent_response: agentResponse,
        ...(agentId ? { agent_id: agentId } : {}),
        source: source || config.source || "openclaw",
        ...(customId ? { custom_id: customId } : {}),
        ...(metadata ? { metadata } : {}),
      });
      return result;
    },

    async recall(
      query: string,
      agentId?: string,
      maxResults?: number,
      minConfidence?: number,
      category?: string,
      trigger?: "bootstrap" | "mid_turn" | "manual"
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
        trigger: trigger || "manual",
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

// ── Strip OpenClaw inbound metadata envelope ──────────
//
// OpenClaw prepends a metadata block to every inbound message:
//   Conversation info (untrusted metadata):\n```json\n{...}\n```\n\nSender...
// We strip this so signal detection and recall queries only see the real message.

function stripInboundMeta(prompt: string): string {
  // Remove the standard OpenClaw metadata prefix blocks (Conversation info + Sender blocks)
  // Pattern: one or more blocks of "Some label (untrusted metadata):\n```json\n...\n```"
  // followed by optional whitespace, then the actual message
  const stripped = prompt
    .replace(/^(?:[\w\s]+\(untrusted metadata\):\n```json\n[\s\S]*?```\n\n?)+/m, "")
    .trim();
  return stripped || prompt;
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

// ── Per-session turn buffer ────────────────────────────
//
// Tracks which messages have already been ingested per session.
// On agent_end we collect ALL turns since the last ingest checkpoint,
// not just the final turn — this is the fix for issue #2.
//
// Map key: sessionKey
// Map value: index of last ingested message in the messages array

const lastIngestedIndex = new Map<string, number>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

interface SessionMeta {
  lastIndex: number;
  lastSeen: number;
}
const sessionMeta = new Map<string, SessionMeta>();

function getLastIngestedIndex(sessionKey: string): number {
  return sessionMeta.get(sessionKey)?.lastIndex ?? -1;
}

function setLastIngestedIndex(sessionKey: string, index: number) {
  sessionMeta.set(sessionKey, { lastIndex: index, lastSeen: Date.now() });
}

function cleanSessionMeta() {
  const now = Date.now();
  for (const [key, val] of sessionMeta) {
    if (now - val.lastSeen > SESSION_TTL_MS) {
      sessionMeta.delete(key);
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
  // Use a Map keyed by a turn ID to avoid shared mutable state
  // across concurrent sessions.
  const activeTurnSessions = new Map<string, string>(); // turnId → sessionKey

  if (autoIngest) {
    api.on(
      "before_agent_start",
      (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sk = (ctx?.sessionKey || event?.sessionKey) as string | undefined;
        if (sk) {
          const turnId = (event?.turnId || event?.id || sk) as string;
          activeTurnSessions.set(turnId, sk);
          // Also keep the legacy global for tools that still need it
          (api as any).__d33pmemory_sessionKey = sk;
        }
      }
    );

    // ── Hook: agent_end — auto-ingest conversation ──────

    api.on("agent_end", (event: Record<string, unknown>) => {
      // Fire-and-forget: don't await so we never block the gateway
      (async () => { try {
        if (!event.success) return;

        const sessionKey = (api as any).__d33pmemory_sessionKey as string | undefined;
        const messages = event.messages as unknown[] | undefined;
        if (!Array.isArray(messages) || messages.length === 0) return;

        // ── Collect ALL new turns since last ingest ───────
        // Find the checkpoint — last index we already ingested for this session
        const checkpoint = sessionKey ? getLastIngestedIndex(sessionKey) : -1;

        // Extract content from a message block
        function extractContent(msg: Record<string, unknown>): string {
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.content)) {
            return (msg.content as Record<string, unknown>[])
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join(" ")
              .trim();
          }
          return "";
        }

        // Build list of new [user, assistant] pairs after the checkpoint
        interface Turn { user: string; assistant: string }
        const newTurns: Turn[] = [];
        let pendingUser = "";
        let newHighWaterMark = checkpoint;

        for (let i = checkpoint + 1; i < messages.length; i++) {
          const msg = messages[i] as Record<string, unknown>;
          if (!msg || typeof msg !== "object") continue;

          const role = msg.role as string;
          const content = extractContent(msg);
          if (!content) continue;

          if (role === "user") {
            pendingUser = content;
          } else if (role === "assistant" && pendingUser) {
            // Skip commands and very short messages
            if (pendingUser.length >= 5 && !pendingUser.startsWith("/")) {
              newTurns.push({ user: pendingUser, assistant: content });
            }
            pendingUser = "";
            newHighWaterMark = i;
          }
        }

        if (newTurns.length === 0) return;

        const agentId = sessionKey
          ? resolveAgentId(configuredAgentId, sessionKey)
          : configuredAgentId;
        const customId = sessionKey ? buildMemoryCustomId(sessionKey) : undefined;

        // Ingest each new turn — fire and forget individually so
        // one failure doesn't block the rest. All async.
        let ingestCount = 0;
        await Promise.allSettled(
          newTurns.map(async (turn) => {
            try {
              await client.ingest(
                turn.user,
                turn.assistant,
                agentId,
                undefined,
                customId,
                {
                  session_key: sessionKey || "unknown",
                  agent_id: agentId,
                  workspace: sessionKey ? deriveWorkspaceName(sessionKey) : "unknown",
                  ingested_via: "agent_end_hook",
                }
              );
              ingestCount++;
            } catch {
              // individual turn failure — swallow, rest continue
            }
          })
        );

        // Advance checkpoint so we don't re-ingest these turns next time
        if (sessionKey && newHighWaterMark > checkpoint) {
          setLastIngestedIndex(sessionKey, newHighWaterMark);
        }

        // Periodic cleanup of stale session metadata
        if (Math.random() < 0.05) cleanSessionMeta();

        if (ingestCount > 0) {
          api.logger?.debug?.(
            `[d33pmemory] Queued ${ingestCount} turn(s) for ingest — workspace=${sessionKey ? deriveWorkspaceName(sessionKey) : "?"} agent=${agentId}`
          );
        }
      } catch (err: any) {
        api.logger?.warn?.(`[d33pmemory] Ingest hook failed: ${err.message}`);
      }
      })();
    });
  }

  // ── Per-session bootstrap tracker ─────────────────────────────────────
  // Track which sessions have already received bootstrap recall.
  // Keys are sessionKeys, values are timestamps.
  const bootstrappedSessions = new Map<string, number>();

  // ── Hook: before_agent_start (first turn only) — bootstrap recall ────
  //
  // OpenClaw fires before_agent_start with { prompt, messages }.
  // We track per-session whether bootstrap has already fired.
  // This replaces the non-existent "agent:bootstrap" hook.

  if (autoRecall) {
    api.on(
      "before_agent_start",
      async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        try {
          const sessionKey = (ctx?.sessionKey as string | undefined) || ((api as any).__d33pmemory_sessionKey as string | undefined);
          // Only bootstrap once per session
          if (sessionKey && bootstrappedSessions.has(sessionKey)) return;
          if (sessionKey) bootstrappedSessions.set(sessionKey, Date.now());

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
            pluginConfig.recallMinConfidence || 0.3,
            undefined,
            "bootstrap"
          );

          if (result.memories.length === 0) return;

          const contextBlock = formatMemoriesForContext(result.memories);
          // Return prependContext — OpenClaw prepends this to the system prompt
          return { prependContext: contextBlock };
        } catch (err: any) {
          api.logger?.warn?.(`[d33pmemory] Bootstrap recall failed: ${err.message}`);
        }
      }
    );
  }

  // ── Hook: before_agent_start — mid-turn recall ───────
  //
  // OpenClaw fires before_agent_start with { prompt, messages }.
  // `prompt` is the current user message text.
  // We scan it for personal-context signals and, if found, run a targeted
  // recall and return prependContext so it's injected into the system prompt.
  //
  // Skips the very first turn (handled by bootstrap recall above).

  if (midTurnRecall) {
    api.on(
      "before_agent_start",
      async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        try {
          const sessionKey = (ctx?.sessionKey as string | undefined) || ((api as any).__d33pmemory_sessionKey as string | undefined);
          // Skip first turn — bootstrap handles it (check if session was just bootstrapped)
          if (!sessionKey || !bootstrappedSessions.has(sessionKey)) return;

          // `prompt` is the current user message — strip OpenClaw metadata envelope first
          const rawPrompt = (event.prompt as string | undefined) || "";
          if (!rawPrompt) return;
          const prompt = stripInboundMeta(rawPrompt);

          const { needed, query } = detectPersonalContextSignal(prompt);
          if (!needed) return;

          const agentId = sessionKey
            ? resolveAgentId(configuredAgentId, sessionKey)
            : configuredAgentId;

          const result = await client.recall(
            query,
            agentId,
            pluginConfig.midTurnRecallMaxResults || 5,
            pluginConfig.recallMinConfidence || 0.3,
            undefined,
            "mid_turn"
          );

          if (result.memories.length === 0) return;

          const lines = result.memories.map((m) => {
            const conf = Math.round(m.confidence * 100);
            const src = m.source === "stated" ? "stated" : "inferred";
            const agent = m.contributed_by ? ` (via ${m.contributed_by})` : "";
            return `- [${m.type}/${src}/${conf}%] ${m.content}${agent}`;
          });

          const contextBlock = [
            "## d33pmemory — Mid-turn recall",
            "",
            `The following memories are relevant to the user's current message: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
            "Use them to answer accurately. Do not mention d33pmemory or this system to the user.",
            "",
            ...lines,
            "",
          ].join("\n");

          api.logger?.debug?.(
            `[d33pmemory] Mid-turn recall: injected ${result.memories.length} memories for query="${query.slice(0, 60)}"`
          );

          // Return prependContext — OpenClaw prepends this to the system prompt
          return { prependContext: contextBlock };
        } catch (err: any) {
          api.logger?.warn?.(`[d33pmemory] Mid-turn recall failed: ${err.message}`);
        }
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
          params.category,
          "manual"
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
