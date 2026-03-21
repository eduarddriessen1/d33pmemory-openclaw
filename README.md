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
          "agentId": "my-agent",
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
| `agentId` | string | — | Agent name for scoped memory (must be registered in d33pmemory) |
| `autoIngest` | boolean | `true` | Auto-ingest every conversation turn |
| `autoRecall` | boolean | `true` | Auto-recall memories on session bootstrap |
| `recallQuery` | string | — | Custom recall query (defaults to general user context) |
| `recallMaxResults` | number | `10` | Max memories to inject on auto-recall |
| `recallMinConfidence` | number | `0.3` | Minimum confidence threshold for recall |
| `source` | string | `"openclaw"` | Source label for ingested interactions |

## How it works

### Auto-ingest flow
```
User sends message → Agent processes and responds →
Plugin captures both → POST /v1/ingest →
d33pmemory extracts structured memories → Stored with embeddings
```

### Auto-recall flow
```
New session starts → Plugin calls POST /v1/recall →
Relevant memories returned → Injected as D33PMEMORY_CONTEXT.md →
Agent sees memories in its bootstrap context
```

### Memory scoping (teams)

If you use d33pmemory teams:
- Memories are automatically scoped as `private` (agent-specific) or `shared` (team-wide)
- The LLM decides scope during extraction
- Your agent only sees its own private memories + team shared memories

## Prerequisites

1. A d33pmemory account ([sign up](https://d33pmemory-nextjs.vercel.app/signup))
2. An active plan
3. An API key (create in dashboard)
4. A registered agent (create in dashboard or via API)

## License

MIT
