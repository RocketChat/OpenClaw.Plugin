# Rocket.Chat Plugin for OpenClaw

A channel plugin for [OpenClaw](https://opencode.ai) that enables direct integration with [Rocket.Chat](https://rocket.chat) — no external bridge server needed. It handles inbound message polling, outbound delivery, session management, and agent orchestration through a single plugin.

## Architecture

The plugin uses REST polling on a configurable interval to fetch new messages from Rocket.Chat subscriptions. On each poll cycle, it checks for updated subscriptions via `subscriptions.get`, syncs new messages per room via `chat.syncMessages`, deduplicates using an in-memory Set combined with an on-disk checkpoint file, filters out system events and the bot's own messages, and dispatches user messages to OpenClaw's agent runtime. The outbound path delivers agent replies directly to Rocket.Chat rooms via `chat.postMessage`. A checkpoint file at `~/.openclaw/rocketchat/<accountId>.json` persists the last 250 message IDs and timestamp across restarts.

## Features

- **Polling-based inbound** — REST polling on configurable interval (default 3s)
- **Deduplication** — on-disk checkpoint + in-memory Set prevents re-processing
- **Message filtering** — skips bot's own messages, system events, empty messages, duplicates
- **Emoji reactions** — random processing emoji on receive, checkmark on delivery
- **Direct outbound delivery** — replies posted to Rocket.Chat rooms via REST
- **Token-based auth** — configured via standard OpenClaw channel config

## What's Being Worked On

- [ ] Auth configuration window / setup wizard
- [ ] Concurrency control / per-room message queue
- [ ] Rate limiting and security hardening
- [ ] Media and attachment handling (images, files, audio)
- [ ] Group chat @mention support and routing
- [ ] Bot delegation / multi-bot task routing
- [ ] Shortcuts and slash commands
- [ ] WebSocket real-time transport (optional upgrade from polling)

## Configuration

The plugin requires an account entry under `channels.rocketchat` in your `openclaw.json`:

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
          "transport": {
            "mode": "polling",
            "pollIntervalMs": 3000
          },
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

## Conclusion

This plugin simplifies the Rocket.Chat + OpenClaw integration into a single deployment. No more managing separate bridge services — just configure, install, and your Rocket.Chat users can talk to OpenClaw agents directly.
