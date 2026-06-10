# OpenClaw Rocket.Chat Plugin

Polling-based Rocket.Chat channel plugin for the [OpenClaw](https://opencode.ai) agent gateway.

## How It Works

```
Rocket.Chat ──poll──► plugin.ts:startGateway()
                           │
                    ┌──────┴──────┐
                    │  Every 3s   │
                    └──────┬──────┘
                           │
              client.listSubscriptions(updatedSince)
              client.syncMessages(roomId, updatedSince)
                           │
                    shouldSkipMessage() → dedup via checkpoint-store.ts
                    shouldHandleInboundEvent() → DM? @mention?
                           │
                    ┌──────┴──────┐
                    │ channel.ts  │ → posts "Thinking..." via client.postMessage()
                    │             │ → runs dispatchInboundEventWithChannelRuntime()
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │    inbound-dispatch.ts   │
              │                          │
              │ 1. resolveAgentRoute()   │→ finds which agent handles this room
              │ 2. finalizeInboundContext│→ builds Body/From/To/SessionKey...
              │ 3. recordInboundSession()│
              │ 4. dispatchReply...()    │→ sends to agent engine
              └────────────┬────────────┘
                           │
              Agent replies flow back via deliver callback
                           │
                    session.update({kind, payload})
                           │
              client.updateMessage() → progressively replaces "Thinking..."
```

## File Responsibilities

| File | Job |
|---|---|
| `client.ts` | Talks to Rocket.Chat REST API (get messages, post, update) |
| `plugin.ts` |  Runs the polling loop, decides what to process |
| `channel.ts` | Manages the reply lifecycle (Thinking... → progress → final) |
| `inbound-dispatch.ts` | Translates RC messages into OpenClaw's format and sends to agent |
| `checkpoint-store.ts` | Saves timestamps + message IDs to disk so nothing is processed twice |
| `format.ts` | Renders tool progress, block updates, failure messages |
| `config.ts` | Validates `openclaw.json` config with Zod |
| `types/types.ts` | All TypeScript types in one place |
| `index.ts` | Entry point registers plugin with OpenClaw |

## Data Flow

Plugin polls Rocket.Chat every 3s for new messages. Each valid message goes through `channel.ts` (which posts a "Thinking..." placeholder) → `inbound-dispatch.ts` (which formats it for the agent and dispatches) → agent replies come back through the `deliver` callback → `client.updateMessage()` updates the placeholder with the actual response.

## Config

Add to `~/.openclaw/openclaw.json`:

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
            "userId": "...",
            "accessToken": "..."
          },
          "transport": {
            "mode": "polling",
            "pollIntervalMs": 3000
          },
          "mentionNames": ["mybot"],
          "forceThread": true
        }
      }
    }
  }
}
```

## Demo

<img width="1927" alt="Screenshot" src="https://github.com/user-attachments/assets/68f01242-aa4b-4593-80d8-2f56c881725d" />

<br />
<br />

https://github.com/user-attachments/assets/8f98a0be-4d0e-4d6c-9b5a-a2ed6dad2ae0

## Testing

1. Configure a Rocket.Chat account in `openclaw.json` under `channels.rocketchat.accounts.<name>`
2. Run `openclaw gateway start`
3. Send a DM to the bot user from Rocket.Chat
4. Verify the bot replies with the agent's response
5. Test @mention behavior in channels (bot should respond only when mentioned)
6. Test threading (bot replies should appear in the same thread as the trigger message)
