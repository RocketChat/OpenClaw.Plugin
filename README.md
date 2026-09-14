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

## Media Storage & Handling

When users send media (images, audio, etc.) in Rocket.Chat, the plugin downloads the files locally to `~/.openclaw/media/inbound/`.

- **Why locally?** This allows the OpenClaw agent to reliably process the actual file bytes from the filesystem rather than struggling with URL authentication or timeouts.
- **Limits**: The plugin currently caps downloads at **20MB** per file and supports `image/`, `audio/`, `video/`, and `application/` MIME types.
- **Cleanup**: Currently, there is no automatic auto-prune for these files. We recommend users set up a cron job to clean up the folder periodically, e.g.: `find ~/.openclaw/media/inbound -type f -mtime +7 -delete`.

## Roadmap / Leftovers

_Future enhancements currently being tracked:_

- [ ] Expanding End-to-End (E2E) and integration test coverage across the repository.
- [ ] Preparing project for official v1 release.
- [ ] Addressing remaining bugs and structural updates from our internal trackers:
  - [Notion Bug Tracker](https://deserted-education-78a.notion.site/Bugs-to-solve-3cf53cee1e07801b8a25d518f956af23)
  - [GSOC Submission Gist](https://gist.github.com/dodaa08/883e8d7d5e2e2d17dd345dfafe918eb6)
