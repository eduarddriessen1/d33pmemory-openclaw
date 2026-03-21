# d33pmemory OpenClaw Plugin

> Automatic long-term memory for AI agents. No prompt engineering. No manual memory management.

This plugin connects [OpenClaw](https://openclaw.ai) agents to [d33pmemory](https://d33pmemory.com) — a hosted memory-as-a-service platform. Every conversation is automatically analyzed, facts are extracted, and relevant memories are injected into the agent's context before every response.

## Quick Start

### 1. Install

```bash
openclaw plugins install @d33pmemory/openclaw-plugin
```

Or for development:

```bash
git clone https://github.com/eduarddriessen1/d33pmemory-openclaw
openclaw plugins install -l ./d33pmemory-openclaw
```

### 2. Configure

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

Restart the gateway:

```bash
openclaw gateway restart
```

That's it. The agent will now automatically remember everything about the user.

## What Gets Remembered

d33pmemory extracts structured memories from conversations:

| Type | Examples |
|------|----------|
| **Facts** | Name, age, occupation, location |
| **Preferences** | Likes, dislikes, communication style |
| **Relationships** | Family, friends, colleagues |
| **Events** | Things the user has done or plans to do |
| **Patterns** | Behavioral habits, recurring themes |

Memories are stored with confidence scores and source attribution (`stated` vs `inferred`).

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | Your d33pmemory API key (`dm_xxx`) |
| `apiUrl` | `string` | `https://api.d33pmemory.com` | API base URL |
| `agentId` | `string` | derived from session | See [Multi-Agent Safety](#multi-agent-safety) |
| `autoIngest` | `boolean` | `true` | Auto-ingest every conversation turn |
| `autoRecall` | `boolean` | `true` | Auto-recall memories on session bootstrap |
| `recallQuery` | `string` | general context query | Custom recall query for bootstrap |
| `recallMaxResults` | `number` | `10` | Max memories injected on auto-recall |
| `recallMinConfidence` | `number` | `0.3` | Minimum confidence threshold |
| `source` | `string` | `"openclaw"` | Source label for ingested interactions |

## Manual Tools

When the plugin is loaded, these tools are available to the agent automatically:

### `d33pmemory_recall`

Search long-term memory for facts about the user.

```
Search: "what are this user's dietary restrictions"
Search: "what did the user mention about their weekend plans"
Search: "user's work projects and tech stack"
```

### `d33pmemory_ingest`

Manually store something important (beyond auto-ingest).

```
Store: "User prefers to be called Eduard, not Ed"
Store: "User is building a SaaS called d33pmemory"
```

These tools are called automatically by the agent when it needs to recall or store something — no human trigger needed.

## Multi-Agent Safety

OpenClaw supports multiple agents and workspaces. The plugin isolates each agent's memories correctly.

### How isolation works

Every OpenClaw session has a **session key**:

```
agent:<workspace-name>:<channel>:<account>:<conversation>
```

Examples:
- `agent:dm-agent:telegram:dm-agent-bot:direct:176654117`
- `agent:alice:telegram:alice-bot:direct:123456`
- `agent:dev-bot:slack:dev-bot:channel:C05ABC123`

The plugin uses this to scope memory:

| Config `agentId` | `agent_id` in API | Effect |
|---|---|---|
| `"my-team"` (set) | `"my-team"` | All workspaces share memories |
| `""` or absent | Derived from session key | Each workspace is isolated |

**Default behavior (no `agentId` set):**
- `dm-agent` workspace → `agent_id = "dm-agent"`
- `alice` workspace → `agent_id = "alice"`
- Each workspace retrieves only its own memories

**With shared `agentId`:**
- Set `"agentId": "team-shared"` in config
- All workspaces share the same memory namespace
- Useful for team agents that should share context

### Session-level deduplication

Each ingest also sends a `custom_id` derived from the full session key. This prevents one session's memories from overwriting another's, even within the same `agent_id` namespace.

## How It Works

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical explanation.

### Auto-ingest flow

```
User message
    → Agent responds
        → "agent_end" lifecycle hook fires
            → Plugin extracts user turn + agent turn
            → resolveAgentId() → agent_id
            → POST /v1/ingest
                → d33pmemory extracts structured memories
                → Stored with session-scoped custom_id
```

### Auto-recall flow

```
Session starts (/new)
    → "agent:bootstrap" hook fires
        → POST /v1/recall (scoped to workspace agent_id)
            → Relevant memories returned
            → Injected as D33PMEMORY_CONTEXT.md
    → Agent bootstrap context includes memories
        → Agent sees user context before first response
```

## Repository Structure

```
d33pmemory-openclaw/
├── index.ts              # Plugin entry — hooks, tools, client
├── openclaw.plugin.json  # Plugin manifest + config schema
├── package.json
├── README.md             # This file
└── docs/
    └── ARCHITECTURE.md   # Technical deep-dive
```

## Prerequisites

1. **OpenClaw** — [Install guide](https://docs.openclaw.ai)
2. **d33pmemory account** — [Sign up](https://d33pmemory-nextjs.vercel.app/signup)
3. **d33pmemory API key** — Create in your dashboard

## Troubleshooting

### Plugin not loading

```bash
openclaw plugins list
# Should show: d33pmemory ✓
```

Check the gateway log:

```bash
tail -f ~/.openclaw/gateway.log | grep d33pmemory
```

### Hooks not firing

1. Make sure `autoIngest` / `autoRecall` are not explicitly set to `false` in config
2. Restart the gateway after config changes: `openclaw gateway restart`
3. Check `openclaw status` for plugin load confirmation

### Memories not being recalled

1. Verify the `apiKey` is correct
2. Check that the agent has an entry in your d33pmemory dashboard
3. Try the `d33pmemory_recall` tool manually with a query like `"user preferences and facts"`

### Wrong agent namespace

If memories are mixing between workspaces, check that `agentId` is **not** set in config if you want per-workspace isolation.

## License

MIT
