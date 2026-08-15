# Rocket.Chat Plugin for OpenClaw
A channel plugin for [OpenClaw](https://opencode.ai) that enables direct integration with [Rocket.Chat](https://rocket.chat), no external bridge server needed. It handles inbound message polling, outbound delivery, session management, and agent orchestration through a single plugin.

## Architecture
The plugin uses REST polling on a configurable interval to fetch new messages from Rocket.Chat subscriptions. On each poll cycle, it checks for updated subscriptions via `subscriptions.get`, syncs new messages per room via `chat.syncMessages`, deduplicates using an in-memory Set combined with an on-disk checkpoint file, filters out system events and the bot's own messages, and dispatches user messages to OpenClaw's agent runtime. The outbound path delivers agent replies directly to Rocket.Chat rooms via `chat.postMessage`. A checkpoint file at `~/.openclaw/rocketchat/<accountId>.json` persists the last 250 message IDs and timestamp across restarts.

## Features
- **Polling-based inbound**: REST polling on configurable interval (default 3s)
- **Deduplication**: on-disk checkpoint + in-memory Set prevents re-processing
- **Message filtering**: skips bot's own messages, system events, empty messages, duplicates
- **Emoji reactions**: random processing emoji on receive, checkmark on delivery
- **Direct outbound delivery**: replies posted to Rocket.Chat rooms via REST
- **Token-based auth**: configured via standard OpenClaw channel config

## Bot Access Control
Each bot account is **private by default** — only its **owner/creator** can use it, in both direct messages and group chats. The owner can lend access to specific users and revoke it anytime via the CLI:

| Command | What it does |
| --- | --- |
| `npm run allow-user [bot]` | Grant a user access to a bot |
| `npm run remove-user [bot]` | Revoke a user's access to a bot |
| `npm run users [bot]` | List who has access to a bot |
| `npm run set-owner [bot]` | Claim or transfer bot ownership (admin) |

Rules:
- The bot's `owner` is recorded automatically when the bot is created (`add-bot` / `setup`).
- `allow-user`, `remove-user`, `add-group` and `remove-group` require the operator to prove they are the bot's owner (Rocket.Chat owner login, cached per-bot).
- `allowedUsers` (and `owner`) are stored per account in `~/.openclaw/openclaw.json`:
```json
{
  "channels": {
    "rocketchat": {
      "accounts": {
        "reminder-bot": {
          "enabled": true,
          "serverUrl": "http://localhost:3000",
          "owner": "your-username",
          "allowedUsers": ["alice", "bob"],
          "mentionNames": ["reminder-bot"]
        }
      }
    }
  }
}
```
- An empty `allowedUsers` list means **only the owner** can use the bot. Unauthorized senders are ignored.


## What's Being Worked On
- [x] Auth configuration window / setup wizard
- [x] Updated polling to reduce no of requests
- [ ] Concurrency control / per-room message queue
- [ ] Rate limiting and security hardening
- [ ] Media handling (files and audio)
- [x] Group chat @mention support, routing and thread replies
- [ ] Bot delegation / multi-bot task routing
- [ ] Shortcuts and slash commands
- [ ] WebSocket real-time transport (optional upgrade from polling)

## Configuration
Added as `Example openclaw.example.json` in codebase
```json
{
  "channels": {
    "rocketchat": {
      "accounts": {
        "main": {
          "enabled": true,
          "serverUrl": "http://localhost:3000",
          "auth": {
            "mode": "token",
            "userId": "<your-user-id>",
            "accessToken": "<your-personal-access-token>"
          },
          "transport": { "mode": "polling" },
          "mentionNames": ["rocketbot"]
        }
      }
    }
  }
}
```
You also need at least one AI provider and a default agent model configured:
```json
{
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434",
        "apiKey": "ollama",
        "api": "ollama",
        "models": [
          {
            "id": "llama3.2:3b",
            "name": "Llama 3.2 3B",
            "contextWindow": 16000,
            "maxTokens": 4096
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "ollama/llama3.2:3b"
    }
  }
}
```

## Plugin Installation
Add the plugin path to your `openclaw.json`:
```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/your/plugin"]
    }
  }
}
```

## Learn more
Added a detailed blog :  https://readyy.hashnode.dev/building-rocket-chat-channel-plugin-for-openclaw
