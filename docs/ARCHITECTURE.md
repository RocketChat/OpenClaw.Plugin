# Architecture

How the Rocket.Chat plugin connects Rocket.Chat to OpenClaw agents—no external bridge server required.

## System Overview

The plugin acts as a **real-time bridge** between Rocket.Chat (your messaging platform) and OpenClaw (your agent runtime). It uses two connection types:

1. **DDP WebSocket** — for live message streaming (real-time)
2. **REST API** — for bot management, authentication, and administrative tasks and outbounds

```
┌──────────────────────────────────────────────────────────────────┐
│                     Rocket.Chat Server                            │
│                                                                   │
│  ┌────────────────────┐         ┌──────────────────────────┐    │
│  │  DDP WebSocket     │         │      REST API            │    │
│  │  (Real-time)       │         │  (Admin + Outbound)      │    │
│  │                    │         │                          │    │
│  │  ◄ Message events  │         │  ► Create/manage bots    │    │
│  │  ◄ Subscriptions   │         │  ► Manage groups         │    │
│  │  ◄ Typing/reactions│         │  ► Authenticate          │    │
│  │                    │         │  ► Post agent replies    │    │
│  └────────┬───────────┘         └──────────┬───────────────┘    │
│           │                                │                    │
│        (inbound)                        (outbound +             │
│                                         admin)                  │
└───────────┼────────────────────────────────┼────────────────────┘
            │                                │
            │ (user message)                 │ (bot reply)
            ▼                                │
┌────────────────────────────────────────────┴──────────────────────┐
│        OpenClaw Gateway Plugin                                    │
│     (@openclaw/rocketchat)                                       │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  • DDP Client (inbound: message receiver)                   │ │
│  │  • REST Client (outbound: message poster + attachments)     │ │
│  │  • Command Router (!help, !status, etc.)                    │ │
│  │  • Access Control (permissions)                             │ │
│  │  • Deduplication (prevent replays)                          │ │
│  │  • Message Chunking (4000 char limit)                       │ │
│  │  • Thread tracking (message ID → thread ID)                 │ │
│  └────────────────────────┬─────────────────────────────────────┘ │
└───────────────────────────┼────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│        OpenClaw Agent Runtime                                      │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │   Agent 1    │  │   Agent 2    │  │  Agent N     │             │
│  │   (main)     │  │   (work)     │  │  (custom)    │             │
│  │              │  │              │  │              │             │
│  │ • LLM Model  │  │ • LLM Model  │  │ • LLM Model  │             │
│  │ • Tools      │  │ • Tools      │  │ • Tools      │             │
│  │ • Skills     │  │ • Skills     │  │ • Skills     │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
└────────────────────────────────────────────────────────────────────┘
```

## Message Flow

### User sends message → Plugin receives → Agent processes → Bot replies

```
Rocket.Chat
     │
     │ DDP: room-messages stream
     ▼
Plugin DDP Client
     │
     ├─ Dedup check (SQLite checkpoint)
     ├─ Permission check (!lend grants)
     ├─ Command routing (!status, !help, etc.)
     │
     ├─ [if command] → reply directly
     │
     └─ [if passthrough] → dispatch to agent
               │
               ▼
         OpenClaw Agent
               │
               ├─ Process with tools & reasoning
               ├─ Generate response
               │
               ▼
         Send back to plugin
               │
               ├─ Split message (4000 char chunks)
               ├─ Prepare attachments (if any)
               │
               ▼
         REST API: chat.postMessage
               │
               ▼
         Rocket.Chat room (reply posted)
```

## Data Flow Pipelines

### Inbound (Rocket.Chat → Agent)

| Step            | What Happens                                                              |
| --------------- | ------------------------------------------------------------------------- |
| **Stream**      | DDP WebSocket receives `room-messages` events                             |
| **Dedup**       | Check SQLite checkpoint (`~/.openclaw/rocketchat/<id>.db`) — skip if seen |
| **Filter**      | Ignore own messages, system events, empty messages                        |
| **Parse**       | Extract roomId, userId, text, attachments, quote chains (4 levels)        |
| **Mention**     | DMs: always process. Groups: only on `@mention` or `!command`             |
| **Permissions** | Owner always allowed; others checked against access grants                |
| **Route**       | `!help` / `!status` handled locally; others → agent                       |

### Outbound (Agent → Rocket.Chat)

| Step              | What Happens                                              |
| ----------------- | --------------------------------------------------------- |
| **Receive**       | Agent sends final reply payload                           |
| **Reformat**      | Strip OpenClaw `/` commands, replace with `!` equivalents |
| **Strip emoji**   | Remove rendering emoji from output                        |
| **Chunk**         | Split at 4000 chars on newline/space boundaries           |
| **Track threads** | LRU map stores `messageId → threadId` for reply threading |
| **Post**          | DDP: send typing stop signal; REST: post message          |
| **Attachments**   | Download → upload via REST → attach reference             |

## Commands

Commands are parsed by `CommandParser.parse()` and route three ways:

| Type                 | Behavior                                 |
| -------------------- | ---------------------------------------- |
| **Reply**            | Bot responds directly (no agent)         |
| **Passthrough**      | Forwarded to agent as normal message     |
| **OpenClaw Command** | Translated to `/compact`, `/reset`, etc. |

### Quick Reference

**Bot Management** (owner-only)

- `!add-bot <user>` — Create bot, agent, config
- `!remove-bot <users...>` — Delete bots
- `!add-group <group> [bot]` — Invite bot to group
- `!lend <group> <user>` — Grant access
- `!revoke <group> <user>` — Revoke access

**Status & Info**

- `!help` — Command menu
- `!status` — Gateway + connection status
- `!bots` — List all bots
- `!access` — Show owner + grants
- `!model` / `!model set <name>` — Show/switch model

**Context Control**

- `!compact` — Compress history
- `!reset` — Wipe all context
- `!new [model]` — Fresh start
- `!think <level>` — Reasoning depth
- `!abort` — Stop reply

See [COMMANDS.md](./COMMANDS.md) for full reference.

## Authentication Flow

```
1. User runs: openclaw rocketchat setup
                    ↓
2. Provide Rocket.Chat server URL + admin login with password
                    ↓
3. Plugin authenticates via REST API (admin token)
                    ↓
4. Creates bot user on server
                    ↓
5. Bot receives personal access token
                    ↓
6. DDP client connects using bot token
                    ↓
7. Subscribe to message streams
                    ↓
8. Bot Config saved to ~/.openclaw/openclaw.json
                    ↓
9. Ready: !status shows online + ready
```

## Connection Types

### DDP (Distributed Data Protocol) WebSocket

- **What:** Native Rocket.Chat real-time protocol
- **Why:** Bidirectional, efficient, native support for subscriptions
- **Auth:** Bot's personal access token
- **Data:** Message events, room subscriptions, typing, reactions
- **Reliability:** Built-in retry logic; reconnects on network failure

### REST API

- **What:** HTTP request/response
- **Why:** Admin operations, bot management
- **Auth:** Admin token (setup only) or bot token
- **Operations:**
  - Create/delete bots
  - Invite to groups
  - Post messages (fallback to DDP)
  - Fetch user/group info
  - Upload/download files

## Multi-Bot Architecture

Each bot is **independent and isolated**:

```
Rocket.Chat Server
│
├─ Bot 1 (token: xyz) → Agent: main
│  ├─ Own DDP connection
│  ├─ Own SQLite checkpoint
│  └─ Own access grants
│
├─ Bot 2 (token: abc) → Agent: work
│  ├─ Own DDP connection
│  ├─ Own SQLite checkpoint
│  └─ Own access grants
│
└─ Bot 3 (token: def) → Agent: shared-agent
   ├─ Own DDP connection
   ├─ Own SQLite checkpoint
   └─ Own access grants
```

**Benefits:**

- One bot's crash doesn't affect others
- Different agents can handle different tasks
- Access control per-bot
- Scale horizontally (add more bots as needed)

## Data Deduplication

Prevents message replay after restart or duplicate receipt:

```
Message arrives via DDP
     ↓
Check: seen before?
     │
     ├─ YES: skip (already processed)
     │
     └─ NO: process + record in checkpoint
            (SQLite: ~/.openclaw/rocketchat/<id>.db)

Checkpoint persists across restarts
```

Message ID + room ID combination is unique marker.

## Data Storage

```
~/.openclaw/
│
├─ openclaw.json                     # All config (read by OpenClaw core)
│
├─ credentials/rocketchat/
│  ├─ admin.json                     # Admin auth (setup only, not stored)
│  └─ bot-<username>.json            # Bot tokens (kept for reconnection)
│
├─ rocketchat/
│  ├─ <accountId>.db                 # SQLite: seen messages (per bot)
│  ├─ access.db                      # SQLite: access grants (shared)
│  └─ rate-limit.json                # Bot creation cooldown state
│
└─ agents/rc-<username>/             # Dedicated agent workspaces
   ├─ agent/
   └─ sessions/
```

All data stored **locally** — no cloud, no external services.

## Reconnection Logic

```
connecting ──► connected ──► ready (streams subscribed)
   │              │
   │              └─ [close event] ──► reconnecting (repeat)
   │
   └─ [after 20 failed attempts] ──► failed (bot marked dead)
```

- Reconnect delay: 2000ms (configurable)
- DDP SDK has built-in retry with exponential backoff
- Status: tracked in memory, used by `!status` / `!bots`

## Security

| Aspect                   | Implementation                                                  |
| ------------------------ | --------------------------------------------------------------- |
| **Credentials**          | Stored in `~/.openclaw/credentials/`, never in config files     |
| **Tokens**               | One personal access token per bot; rotatable via Rocket.Chat UI |
| **Access Control**       | Explicit grants via `!lend`; stored in SQLite (`access.db`)     |
| **Admin Access**         | Only used during setup; immediately discarded after             |
| **Transport**            | HTTPS/WebSocket (encrypted in transit)                          |
| **SSRF Protection**      | `isSafeExternalUrl()` blocks private/loopback on downloads      |
| **Rate Limiting**        | Max 10 bots total, 5 per server, 1 min cooldown                 |
| **Self-Loop Prevention** | Strips bot mention from outbound messages                       |

## Deployment Models

### Mode A: Co-located (All-in-One)

Everything on single machine (simplest):

```
Your Server
├─ Rocket.Chat + MongoDB (Docker)
└─ OpenClaw Gateway (Node.js)
```

**Best for:** Testing, small teams, single server.

### Mode B: Split Deployment

Rocket.Chat on cloud VPS, OpenClaw on local machine/low-spec hardware:

```
Cloud VPS (cheap 1C1G)
├─ Rocket.Chat + MongoDB (Docker)
└─ Nginx (reverse proxy)

Your Local Machine / Network
└─ OpenClaw Gateway (connects to remote RC via internet)
```

**Best for:** No public IP, limited resources, privacy, testing.

Both use same plugin code; only network addresses differ.

## Performance

- **Message latency:** Sub-second (DDP real-time)
- **Agent dispatch:** Depends on model (typically 5-30s)
- **Thread memory:** LRU map (2000 entries) for message threading
- **Concurrent rooms:** Configurable (`transport.maxConcurrent`, default 50)
- **Message chunking:** Splits large replies at 4000 chars to respect Rocket.Chat limits
