# d33pmemory — Agent Memory Skill

You have access to **d33pmemory**, a long-term memory service for AI agents. Use it to remember facts, preferences, relationships, events, and patterns about the user across all conversations.

---

## Two ways to integrate

| Integration | How it works | Best for |
|---|---|---|
| **OpenClaw Plugin** | Fully automatic — hooks handle ingest and recall | OpenClaw agents |
| **This skill** | Agentic heartbeat + on-demand recall | All other agent frameworks |

> **OpenClaw users**: Install the plugin instead. It handles everything automatically.  
> See: [github.com/eduarddriessen1/d33pmemory-openclaw](https://github.com/eduarddriessen1/d33pmemory-openclaw)

---

## Architecture

```
Heartbeat timer (e.g. every 30s)
    → Agent batches recent conversation turns
    → Calls POST /v1/ingest (one call, multiple turns)

On-demand
    → When uncertain, call POST /v1/recall
    → Use returned memories to answer accurately
```

The heartbeat batches ingests so you're not calling the API after every single message. Recall is triggered by the agent's actual uncertainty — not a fixed schedule.

---

## Setup

### 1. Authenticate

Store your API key as an environment variable or in your agent's secret store:

```bash
DM_API_KEY=dm_your_api_key_here
```

Base URL: `https://api.d33pmemory.com`

---

## Heartbeat — Periodic Ingest

Set a timer (e.g. every 30–60 seconds, or after every N messages). When it fires:

### Step 1: Collect recent turns

Buffer the last few user/assistant message pairs since the last heartbeat. Include both sides — the agent's response often contains facts the user didn't say directly (restaurant names, times, action outcomes).

### Step 2: Batch ingest

```http
POST https://api.d33pmemory.com/v1/ingest
Authorization: Bearer {DM_API_KEY}
Content-Type: application/json

{
  "user_message": "User said X...\n\nUser said Y...",
  "agent_response": "You responded with A...\n\nYou responded with B...",
  "source": "your-agent-name",
  "metadata": {
    "agent": "your-agent-name",
    "ingested_via": "heartbeat"
  }
}
```

- **One ingest call per heartbeat**, not per message
- The extraction engine handles what to remember — ingest everything, let it filter
- `source` identifies your agent (each agent = one identity)

### Step 3: No need to await

Ingest is fire-and-forget for the heartbeat. The extraction happens server-side. Don't wait for the result to continue — move on to the next agent turn.

---

## On-Demand Recall

Recall is **not** on a schedule. The agent calls recall when:

- User asks something personal: "what's my usual order?", "do I have any allergies?"
- User references the past: "like last time", "remember when...", "the usual"
- User corrects you: incorporate the correction immediately
- You're about to assume something about the user that you don't recall confirming

### Session start

On the first interaction of a new session, do one broad recall:

```http
POST https://api.d33pmemory.com/v1/recall
Authorization: Bearer {DM_API_KEY}
Content-Type: application/json

{
  "query": "Important facts, preferences, habits, and recent context about this user",
  "max_results": 15,
  "min_confidence": 0.3
}
```

Store the result in working memory. This is your user profile for the session.

### During conversation

```http
POST https://api.d33pmemory.com/v1/recall
Authorization: Bearer {DM_API_KEY}
Content-Type: application/json

{
  "query": "what the user is asking about or any relevant prior context",
  "max_results": 5,
  "min_confidence": 0.3
}
```

Use targeted queries. "Coffee orders and preferences", "weekend plans they've mentioned", "dietary restrictions".

---

## Correction — When the user corrects you

If the user denies or updates a memory, tell d33pmemory immediately:

```http
POST https://api.d33pmemory.com/v1/correct
Authorization: Bearer {DM_API_KEY}
Content-Type: application/json

{
  "memory_id": "<id from recall result>",
  "action": "deny"
}
```

- `"confirm"` — boost confidence (fact corroborated again)
- `"deny"` — archive/retract the memory
- `"update"` — replace with the corrected fact (include `new_content`)

Corrections fire immediately, not on heartbeat.

---

## Memory confidence — how to use it

| Confidence | What it means | How to use it |
|---|---|---|
| 0.8 – 1.0 | Strong — stated repeatedly or confirmed | Assert confidently |
| 0.5 – 0.8 | Probable — stated once or strong inference | Use as working assumption |
| 0.3 – 0.5 | Weak — inferred, single source | Mention tentatively, verify if important |
| Below 0.3 | Uncertain | Don't rely on it; ask the user |

**Stated vs Inferred** (`source` field):
- `"stated"` — user explicitly said it
- `"inferred"` — deduced from behavior or context

Always note which it is when responding. "I recall you mentioned you're gluten-free" vs "I think you might prefer Italian food based on our past conversations."

---

## Fleet mode (multiple agents)

If your organization has multiple agents sharing memory:

- `private` memories — only your agent sees them
- `shared` memories — all agents in the organization can see them

The extraction engine classifies new memories automatically. Use `scope: "auto"` to search both.

---

## Memory categories

Optional filters for targeted recall:

- `fact/stated`, `fact/inferred` — factual knowledge
- `preference` — likes, dislikes, communication style
- `relationship` — people and their connections to the user
- `event` — things that happened or will happen
- `pattern` — behavioral habits
- `health/dietary`, `health/medical`, `health/fitness` — health-related

---

## Token budget

Context compilation is automatic. d33pmemory returns memories ranked by relevance and compiles them into a compact payload (typically under 200 tokens). You get the intelligence, not the raw conversation history.

---

## Error handling

- **429 rate limit**: Back off and retry after the indicated delay. Don't drop memories — queue for next heartbeat.
- **Network failure**: Retry the ingest on the next heartbeat cycle. Memories are not lost if the agent restarts — they're buffered.
- **Unknown user**: If recall returns nothing, the user is new or the agent identity is wrong. Start fresh.

---

## Example heartbeat implementation (pseudocode)

```
every 30 seconds:
    if message_buffer not empty:
        turns = message_buffer.drain_all()
        user_text = turns.map(u.message).join("\n\n")
        agent_text = turns.map(a.response).join("\n\n")
        
        POST /v1/ingest {
            user_message: user_text,
            agent_response: agent_text
        }
```

## Example on-demand recall

```
on user message:
    if user asks about past context:
        result = POST /v1/recall { query: what they're asking about }
        memories = result.memories
        incorporate memories into context
        
    if user corrects us:
        POST /v1/correct { memory_id, action: "deny" or "update" }
        
    if this is first message of session:
        profile = POST /v1/recall { query: "user profile", max_results: 15 }
        session_context = profile.memories
```
