<h1 align="center">Rocket.Chat Plugin for OpenClaw</h1>
<div align="center">

![Rocket.Chat Plugin for OpenClaw](https://img.shields.io/badge/Rocket.Chat-OpenClaw%20Plugin-blue?style=for-the-badge&logo=rocket.chat)

Connect your Rocket.Chat server directly to OpenClaw agents—no bridge server needed.

[View on ClawHub](https://clawhub.ai/plugins/@dodaa08/openclaw-plugin-test)
</div>

## Prerequisites

- A Rocket.Chat server (with admin access)
- OpenClaw installed and configured with an AI provider
- A default agent already set up

> **Having issues?** Check [`openclaw.examples.json`](./openclaw.examples.json) in the repo root for a complete annotated configuration reference. You can also manually edit `~/.openclaw/openclaw.json` if needed.

## Quick Start

Checkout : [SETUP.md](https://github.com/RocketChat/OpenClaw.Plugin/blob/main/docs/SETUP.md) Full installation, credentials & email setup

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

> Credentials are stored securely in `~/.openclaw/credentials/` (owner-only permissions).

## Common Commands

| Command                        | Description                                            |
| ------------------------------ | ------------------------------------------------------ |
| `!help`                        | Show all commands                                      |
| `!status`                      | Gateway + connection status                            |
| `!bots`                        | List bots and agents                                   |
| `!add-bot <user>`              | Create a new bot (owner)                               |
| `!remove-bot <user...>`        | Delete bot(s) (owner)                                  |
| `!lend <group> <user>`         | Grant access                                           |
| `!revoke <group> <user>`       | Revoke access                                          |
| `!model` / `!model set <name>` | Show or switch model                                   |
| `!compact`                     | Compress conversation history                          |
| `!reset`                       | Wipe context                                           |
| `!new [model]`                 | Start fresh conversation                               |
| `!think <level>`               | Set thinking depth (`off` / `low` / `medium` / `high`) |
| `!abort`                       | Stop current reply                                     |

## Notes

- All data stays on your machine — no cloud uploads
- Each bot is isolated (own connection, own agent, own access grants)
- Admin token is only used during setup and can be deleted afterward

## Documentation

| Doc                                                                                             | Description                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [SETUP.md](https://github.com/RocketChat/OpenClaw.Plugin/blob/main/docs/SETUP.md)               | Full installation, credentials & email setup           |
| [ARCHITECTURE.md](https://github.com/RocketChat/OpenClaw.Plugin/blob/main/docs/ARCHITECTURE.md) | How the plugin works (DDP + REST, multi-bot, security) |
| [COMMANDS.md](https://github.com/RocketChat/OpenClaw.Plugin/blob/main/docs/COMMANDS.md)         | Complete command reference                             |
| [CONTRIBUTING.md](https://github.com/RocketChat/OpenClaw.Plugin/blob/main/CONTRIBUTING.md)      | Contributors guide                                     |
