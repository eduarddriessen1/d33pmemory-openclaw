# Architecture

## Overview

The d33pmemory plugin integrates with OpenClaw's plugin system to provide automatic memory ingest and recall for AI agents. It is implemented as a single-file TypeScript plugin that registers hooks, tools, and services with the OpenClaw runtime.

```
OpenClaw Gateway
├── d33pmemory plugin (index.ts)
│   ├── Hooks
│   │   ├── before_agent_start  — capture sessionKey per turn
│   │   ├── agent_end            — auto-ingest conversation turns
│   │   └── agent:bootstrap      — auto-recall memories on session start
│   └── Tools
│       ├── d33pmemory_recall   — manual semantic search
│       └── d33pmemory_ingest   — manual memory storage
└── d33pmemory API (https://api.d33pmemory.com)
    ├── POST /v1/ingest  — store memories
    └── POST /v1/recall  — retrieve memories
```

## Session Key Model

OpenClaw session keys follow the format:

```
agent:<workspace-name>:<channel>:<account>:<conversation>
```

Examples:
- `agent:dm-agent:telegram:dm-agent-bot:direct:176654117`
- `agent:alice:telegram:alice-bot:direct:123456`

The **workspace name** (second segment) is the fundamental unit of memory isolation.

## Hook Flow

### Auto-Ingest (`agent_end`)

```
User sends message
    → OpenClaw routes to agent
        → before_agent_start fires
            → Plugin stores ctx.sessionKey on api.__d33pmemory_sessionKey
        → Agent processes (model call)
        → agent_end fires
            → Plugin extracts last user turn + last assistant turn
            → resolveAgentId(configuredAgentId, sessionKey) → agent_id
            → buildMemoryCustomId(sessionKey) → custom_id
            → POST /v1/ingest { user_message, agent_response, agent_id, custom_id, metadata }
                → d33pmemory extracts facts/preferences/patterns
                → Stores with session-scoped custom_id
```

**Why `agent_end` instead of `message:sent`?**

`api.registerHook("message:sent")` is a file-based hook that runs in the gateway's hook runner. Plugin-registered hooks (`api.registerHook(...)`) for message events (`message:received`, `message:sent`) are dispatched through a different code path that does not reliably fire for all message scenarios. The `api.on("agent_end")` typed lifecycle hook fires consistently after every agent turn regardless of channel or message type.

**Why `before_agent_start` for sessionKey?**

`agent_end` events do not reliably carry `sessionKey` in `event.context`. The plugin captures `sessionKey` during `before_agent_start` (where `ctx.sessionKey` is always populated) and stores it on the api object for use in `agent_end`.

### Auto-Recall (`agent:bootstrap`)

```
New session /new
    → agent:bootstrap fires (before workspace bootstrap files are injected)
        → Plugin calls POST /v1/recall { query, agent_id, max_results, min_confidence }
            → d33pmemory returns ranked memories
            → formatMemoriesForContext() builds markdown block
            → Injected into event.context.bootstrapFiles as D33PMEMORY_CONTEXT.md
    → OpenClaw injects bootstrap files into system prompt
        → Agent sees memories before first response
```

## Memory Isolation

### Agent Namespace (`agent_id`)

The `agent_id` passed to the d33pmemory API controls high-level memory namespace isolation:

```
resolveAgentId(configuredAgentId, sessionKey):
    if configuredAgentId is set:
        return configuredAgentId  → all workspaces share one namespace
    else:
        return deriveWorkspaceName(sessionKey)  → each workspace gets its own
```

| Config | agent_id used | Effect |
|--------|--------------|--------|
| `agentId: "dm-agent"` | `"dm-agent"` | All workspaces share memories |
| `agentId: ""` (empty) | `"dm-agent"` from session key | Each workspace isolated |

### Session Scoping (`custom_id`)

Each ingest also sends a `custom_id` derived from the full session key:

```typescript
buildMemoryCustomId("agent:dm-agent:telegram:dm-agent-bot:direct:176654117")
// → "agent_dm_agent_telegram_dm_agent_bot_direct_176654117"
```

This means:
- Within the same `agent_id` namespace, each session has its own memory slot
- A session's memories are never overwritten by another session
- Memories can be queried by session if needed

### Ingest Metadata

Every ingest call includes structured metadata:

```json
{
  "session_key": "agent:dm-agent:telegram:dm-agent-bot:direct:176654117",
  "agent_id": "dm-agent",
  "workspace": "dm-agent",
  "ingested_via": "agent_end_hook"
}
```

This gives full traceability at the d33pmemory side for debugging and analytics.

## API Contract

### POST /v1/ingest

```typescript
{
  user_message: string,      // What the user said
  agent_response: string,    // How the agent responded
  agent_id: string,          // Workspace agent identifier
  source?: string,           // Channel label (default: "openclaw")
  custom_id?: string,       // Session-scoped ID for isolation
  metadata?: object          // Extra structured data
}
```

**Response:**
```typescript
{
  interaction_id: string,
  memories_stored: number,
  extracted_memories: Array<{
    id: string,
    type: string,        // "fact" | "preference" | "pattern" | etc.
    content: string,
    confidence: number
  }>
}
```

### POST /v1/recall

```typescript
{
  query: string,             // Semantic search query
  agent_id?: string,         // Scope recall to specific agent
  max_results?: number,      // Default 10, max 50
  min_confidence?: number,   // Default 0.3
  category?: string          // Optional category filter
}
```

**Response:**
```typescript
{
  memories: Array<{
    id: string,
    type: string,
    layer: string,
    content: string,
    source: string,         // "stated" | "inferred"
    confidence: number,
    category: string | null,
    tags: string[],
    similarity: number,
    scope: string,
    contributed_by: string | null,
    created_at: string
  }>,
  total_matches: number
}
```

## Tools

### d33pmemory_recall

```typescript
{
  query: string,          // What to search for (required)
  max_results?: number,   // 1-50, default 5
  category?: string        // Optional filter
}
```

Uses the current session's `agent_id` (resolved the same way as auto-recall).

### d33pmemory_ingest

```typescript
{
  user_message: string,     // Required
  agent_response?: string   // Optional
}
```

Stores a manual memory under the current session's `agent_id` with `custom_id`.

## Configuration Schema

```typescript
interface PluginConfig {
  apiKey: string;           // required — d33pmemory API key (dm_xxx)
  apiUrl?: string;         // default: https://api.d33pmemory.com
  agentId?: string;        // default: derived from session key
  autoIngest?: boolean;     // default: true
  autoRecall?: boolean;    // default: true
  recallQuery?: string;    // custom recall query for bootstrap
  recallMaxResults?: number;// default: 10
  recallMinConfidence?: number; // default: 0.3
  source?: string;         // default: "openclaw"
}
```

## Error Handling

- **API errors**: Logged via `api.logger.warn`, never crash the gateway
- **Missing sessionKey**: Falls back gracefully (uses "unknown" / "manual")
- **Empty messages**: Skipped silently (short messages, system commands)
- **Network failures**: Caught and logged, agent continues uninterrupted

## Security Notes

- API key is stored in `openclaw.json` config — treat it as a secret
- Memories are stored server-side in d33pmemory's managed database
- The plugin only stores structured extractions, not raw conversation logs
- Session keys are hashed/sanitized before being used as `custom_id`s
