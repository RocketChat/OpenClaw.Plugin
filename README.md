# Rocket.Chat Plugin for OpenClaw

A [OpenClaw](https://opencode.ai) channel plugin that connects [Rocket.Chat](https://rocket.chat) directly — **no external bridge server**. The plugin speaks to Rocket.Chat over a real-time **WebSocket/DDP** connection for both inbound and outbound traffic, and routes messages into OpenClaw's agent runtime.

- Inbound: real-time DDP stream, deduplicated via an on-disk checkpoint, filtered (bot's own messages, system events, empty/duplicate messages), and dispatched to the agent.
- Outbound: agent replies posted back into the same Rocket.Chat room/thread.
- Control: a built-in `!`-command interface for bot management (no native slash commands).

## Installation

Install the plugin:

```bash
openclaw plugins install @rocketchat/openclaw-plugin
```

## Setup

The plugin ships an interactive wizard that provisions everything for you — no manual editing of `openclaw.json` required.

### Prerequisites
- A Rocket.Chat server you have **admin** access to. The wizard uses admin rights **once**, only to create the bot account.
- An AI provider and a default agent already configured in OpenClaw. (The wizard can create a dedicated agent for the bot, or bind it to one you pick.)

### Run the wizard

```bash
openclaw rocketchat setup
```

The wizard will:
1. Ask for your Rocket.Chat **server URL** and an **admin** login.
2. Create a dedicated **bot user** on your server and issue a personal access token for it.
3. Create a dedicated OpenClaw **agent** for the bot (e.g. `rc-<bot>`) — or bind it to an existing agent.
4. Write the channel account and `bindings` into `~/.openclaw/openclaw.json`.
5. Optionally invite the bot into a group or channel.

> The bot is just a normal Rocket.Chat user — invite or @-mention it like anyone else. Its access token is stored by the plugin under the OpenClaw config dir, so you never handle it by hand.

### Verify

In Rocket.Chat, DM the bot (or @-mention it in a group it's been invited to) and send:

```
!status
```

You should see `gateway - online` and `runtime - ready`. If you don't, see Troubleshooting below.

## Configuration (manual)

Prefer the wizard above — but if you want to edit config by hand, a complete, annotated reference of the plugin's settings is shipped in **[`openclaw.example.json`](./openclaw.example.json)**. Merge its `channels.rocketchat` and `bindings` blocks into your `~/.openclaw/openclaw.json` and set:

- `channels.rocketchat.accounts.main.serverUrl` → your Rocket.Chat URL.
- `auth.userId` / `auth.accessToken` → the bot user's ID and personal access token (created via `openclaw rocketchat setup`, or in Rocket.Chat → My Account → Personal Access Tokens).
- `bindings[0].agentId` → the agent the bot should use.

The `bindings` entry is what connects the bot account to an agent — **without it the bot will not respond.** Plugin registration is handled by `openclaw plugins install`, so you don't need to touch `plugins.load`.

### Account field reference

Each entry under `channels.rocketchat.accounts.<id>`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | — | Must be `true` to start the gateway. |
| `serverUrl` | string | — | Rocket.Chat base URL (https recommended). |
| `auth` | object | — | `mode: "token"` (`userId` + `accessToken`) **or** `mode: "password"` (`username` + `password`). |
| `transport.mode` | `"websocket"` | — | Only WebSocket/DDP is supported. |
| `transport.reconnectDelayMs` | number | `2000` | Delay before reconnecting the DDP socket. |
| `transport.maxConcurrent` | number | `50` | Max rooms processed in parallel per bot account. |
| `mentionNames` | string[] | `[]` | Names that trigger the bot in group chats (e.g. `["rocketbot"]`). In DMs the bot always responds. |
| `agent` | string | — | Optional agent override; otherwise the `bindings` entry decides. |
| `owner` | string | — | Rocket.Chat username that always has access (and is exempt from denials). |


## `!` commands

Send these in a DM to the bot, or @-mention the bot with the command in a group.

**Bot management**
| Command | Description |
|---|---|
| `!help` | Show the command menu. |
| `!status` | OpenClaw-side status: gateway, bot, agent, runtime. |
| `!bots` | List all configured bot accounts and their agent bindings. |
| `!groups` | List groups/channels the bot has joined. |
| `!access` | Who is allowed to use the bot. |
| `!add-bot <user>` | Create a new bot account + dedicated agent. |
| `!remove-bot <user...>` | Delete bot account(s). |
| `!add-group <group> [bot]` | Invite a bot into a group. |
| `!lend <group\|dm> <user>` | Grant access to a group or DM. |
| `!revoke <group\|dm> <user>` | Revoke access. |

**Context & model**
| Command | Description |
|---|---|
| `!compact` | Compress conversation history. |
| `!reset` | Wipe all context. |
| `!new [model]` | Fresh session (optionally switch model). |
| `!model [name\|#]` | List or switch the model. |

**Behavior**
| Command | Description |
|---|---|
| `!think <level>` | Set reasoning depth (`off`..`high`). |
| `!abort` | Stop the in-flight reply. |
| `!reasoning on/off` | Show/hide reasoning text. |
| `!verbose on/off` | Show/hide debug detail. |

**Tools & skills**
| Command | Description |
|---|---|
| `!tools` | List the agent's tools. |
| `!skills` | List installed skills. |
| `!skill <name>` | Run a skill. |

## Troubleshooting

- **`!status` shows `gateway - offline`/`stopped`** — the DDP socket isn't connected. Check `serverUrl`, that the bot user exists, and that OpenClaw was restarted after config changes (`openclaw restart`). Look at OpenClaw logs for `[rocketchat:<id>] ddp status: …`.
- **Bot doesn't reply in a group** — make sure you @-mention it using one of its `mentionNames`, and that `bindings` points the account at a valid agent.
- **`runtime - unavailable`** — the agent runtime wasn't ready when the message arrived; restart OpenClaw and retry.
- **Duplicate/replayed messages** — the plugin deduplicates via `~/.openclaw/rocketchat/<id>.db`; if you suspect staleness, that file is the checkpoint.

## Learn more

- Blog: https://readyy.hashnode.dev/building-rocket-chat-channel-plugin-for-openclaw
