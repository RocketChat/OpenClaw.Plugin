# Rocket.Chat Plugin for OpenClaw

Connect your Rocket.Chat server directly to OpenClaw agents—no bridge server needed.

[View on ClawHub](https://clawhub.ai/plugins/@dodaa08/openclaw-plugin-test)

## Prerequisetis

- A Rocket.Chat server (with admin access)
- OpenClaw installed and configured with an AI provider
- A default agent already set up

> **Having issues?** Check [`openclaw.example.json`](./openclaw.example.json) in the repo root for a complete annotated configuration reference. You can also manually edit `~/.openclaw/openclaw.json` if needed.

## Quick Start

```bash
openclaw plugins install clawhub:@dodaa08/openclaw-plugin-test
openclaw rocketchat setup
```

The wizard will:
1. Ask for your Rocket.Chat server URL and admin login
2. Create a bot user on your server
3. Create or bind an OpenClaw agent
4. Write bot config to `~/.openclaw/openclaw.json`

Then verify in Rocket.Chat by DMing the bot:

You should see `gateway - online` and `runtime - ready`.

**Credentials are stored securely** in `~/.openclaw/credentials/` — On your machine, the plugin never stores or displays tokens directly.

## Commands

In a DM to the bot or @-mention it with the command in a group.

### Bot

| Command | Description |
|---------|-------------|
| `!help` | Show the command menu |
| `!status` | Gateway status |
| `!bots` | List bots and agents |
| `!groups` | Groups joined by bots |
| `!access` | Who can use this bot |
| `!add-bot <user>` | Create a new bot |
| `!remove-bot <user...>` | Delete bot(s); clears config, creds, agent |
| `!add-group <group> [bot]` | Invite bot to group |
| `!lend <group> <user>` | Grant group access |
| `!lend dm <user>` | Grant DM access |
| `!revoke <group> <user>` | Revoke group access |
| `!revoke dm <user>` | Revoke DM access |

### Context

| Command | Description |
|---------|-------------|
| `!compact` | Compress conversation history |
| `!reset` | Wipe all context |
| `!new [model]` | Fresh start (optionally switch model) |

### Model

| Command | Description |
|---------|-------------|
| `!model` | Show current + list available models |
| `!model set <name>` | Switch to a different model |

### Behavior

| Command | Description |
|---------|-------------|
| `!think <level>` | Set reasoning depth: `off`, `low`, `medium`, `high` |
| `!abort` | Stop the in-flight reply |
| `!reasoning on/off` | Show or hide reasoning text |
| `!verbose on/off` | Show or hide debug details |

### Tools & Skills

| Command | Description |
|---------|-------------|
| `!tools` | List agent tools |
| `!skills` | List installed skills |
| `!skill <name>` | Run a skill |