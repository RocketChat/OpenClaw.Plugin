# OpenClaw Rocket.Chat Plugin

A fully unified plugin for integrating Rocket.Chat with OpenClaw. This plugin eliminates the need for an external bridging server, providing a direct, single-place architecture for inbounds, outbounds, session management, and CLI configuration.

## Architecture

1. **Inbound**: Rocket.Chat sends a message to a custom webhook endpoint registered inside the plugin via `registerHttpRoute`.
2. **Gateway Dispatch**: The handler parses the payload and calls `api.gateway.dispatchInbound` to push the message into OpenClaw. The gateway handles deduplication, session resolution, and routes it to the agent.
3. **Outbound**: The agent processes the message, and the reply comes back out through the plugin's `sendText` (via `registerChannel` outbound).

## Core Features

- **Inbound and Outbounds**: Full bi-directional messaging support.
- **Secure Authentication**: Ensuring robust security for the webhook integration.
- **Session & Context Aware**: Maintains conversation context and seamlessly handles session resolution.
- **Good UX and Reactions**: Rich chat interactions including native message reactions.
- **Bot-to-Bot Delegation**: Support for delegating and automating tasks between different bots.
- **Native Access Control**: Role enforcement and `allowFrom` policies are handled natively through OpenClaw.
