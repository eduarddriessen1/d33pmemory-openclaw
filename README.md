# d33pmemory OpenClaw Plugin

Automatic memory for AI agents. No prompt engineering needed.

This plugin connects your OpenClaw agent to [d33pmemory](https://d33pmemory.com) — a hosted memory service that extracts structured knowledge from conversations and recalls it when relevant.

## What it does

| Feature | How it works |
|---------|-------------|
| **Auto-ingest** | Every conversation is automatically sent to d33pmemory after the agent responds. Memories are extracted and stored — facts, preferences, relationships, events, patterns. |
| **Auto-recall** | When a session starts, relevant memories are automatically injected into the agent's context. The agent knows the user from the first message. |
| **Manual tools** | `d33pmemory_recall` and `d33pmemory_ingest` tools are available for explicit memory operations. |

**The agent never needs to "remember" to use memory. It just happens.**

## Install

```bash
openclaw plugins install @d33pmemory/openclaw-plugin
```

Or clone and link for development:

```bash
git clone https://github.com/eduarddriessen1/d33pmemory-openclaw
openclaw plugins install -l ./d33pmemory-openclaw
```

## Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "d33pmemory": {
        "enabled": true,
        "config": {
          "apiKey": "dm_your_api_key_here",
          "autoIngest": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

Then restart: `openclaw gateway restart`

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | *required* | Your d33pmemory API key (`dm_xxx`) |
| `apiUrl` | string | `https://api.d33pmemory.com` | API base URL |
| `agentId` | string | derived from session | Agent name for scoped memory. **Leave empty** to auto-derive from workspace name (each OpenClaw workspace gets its own isolated memory namespace). **Set a value** to share one namespace across all workspaces. |
| `autoIngest` | boolean | `true` | Auto-ingest every conversation turn |
| `autoRecall` | boolean | `true` | Auto-recall memories on session bootstrap |
| `recallQuery` | string | — | Custom recall query (defaults to general user context) |
| `recallMaxResults` | number | `10` | Max memories to inject on auto-recall |
| `recallMinConfidence` | number | `0.3` | Minimum confidence threshold for recall |
| `source` | string | `"openclaw"` | Source label for ingested interactions |

## Multi-agent & multi-workspace safety

**Session-level isolation**: Each OpenClaw session has a unique `sessionKey` (e.g. `agent:dm-agent:telegram:dm-agent-bot:direct:123456`). Memories from each session are stored with that session as a `custom_id`, so sessions never overwrite each other's memories.

**Workspace-level isolation**: OpenClaw workspaces have unique names (the part after `agent:` in the session key, e.g. `dm-agent`, `alice`, `dev-bot`). When `agentId` is **not set** in config:

- `dm-agent` workspace → memories stored under `agent_id = "dm-agent"`
- `alice` workspace → memories stored under `agent_id = "alice"`
- Each workspace retrieves only its own memories on recall

**Shared namespace**: If you set `agentId` in config (e.g. `"my-team"`), all workspaces using that API key share the same `agent_id` namespace. Memories from all workspaces mix — useful if you explicitly want shared memory across agents.

## How it works

### Auto-ingest flow
```
User message → Agent responds → api.on("agent_end") fires →
Plugin extracts user+assistant turns →
POST /v1/ingest (with session custom_id + workspace agent_id) →
d33pmemory extracts structured memories → Stored
```

### Auto-recall flow
```
New session starts → api.registerHook("agent:bootstrap") fires →
Plugin calls POST /v1/recall (scoped to workspace agent_id) →
Relevant memories returned → Injected as D33PMEMORY_CONTEXT.md →
Agent sees memories in its bootstrap context
```

## Prerequisites

1. A d33pmemory account ([sign up](https://d33pmemory-nextjs.vercel.app/signup))
2. An active plan
3. An API key (create in dashboard)

## License

MIT
