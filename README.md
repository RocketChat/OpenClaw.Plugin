# OpenClaw Rocket.Chat Plugin

A fully unified plugin for integrating Rocket.Chat with OpenClaw. This plugin eliminates the need for an external bridging server, providing a direct, single-place architecture for inbounds, outbounds, session management, and CLI configuration using polling-based inbound and REST outbound.

## In Progress

- [ ] Rate limiting — backoff and retry logic for 429 responses
- [ ] Thread handling — verify forceThread behavior in group chats
- [ ] First-run checkpoint — handle ENOENT on cold start gracefully
- [ ] Latency — reduce polling interval overhead and message sync churn
- [ ] Tests — unit tests for client, checkpoint store, and dispatch logic

## Architecture

- **Inbound**: Polls `subscriptions.get` and `chat.syncMessages` at configurable intervals. Checkpoint store tracks `updatedSince` timestamps and deduplicates via message IDs.
- **Dispatch**: Filters messages (skip self, system events, duplicates). Routes to OpenClaw via `channelRuntime` for agent processing.
- **Outbound**: Direct REST delivery via `chat.postMessage` with thread support.
