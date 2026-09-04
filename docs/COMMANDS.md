# Commands

Rocket.Chat bot command reference. Send these messages in any room where the bot is present.

Prefix: `!` (exclamation mark)


## Bot Management

| Command | Description | Who |
|---------|-------------|-----|
| `!help` | Show available commands | Anyone |
| `!status` | Gateway status (online/offline, agent, runtime) | Anyone |
| `!bots` | List all bot accounts and their agents | Anyone |
| `!groups` | List groups/channels this bot has joined | Anyone |
| `!access` | Show owner + granted users and their scopes | Anyone |
| `!add-bot <user> [--name "..."] [--email ...] [--agent <id>]` | Create a new bot account on the server | Owner |
| `!remove-bot <user...>` | Delete one or more bots (server user + config + agent) | Owner |
| `!add-group <group> [<bot>]` | Invite a bot to a group/channel (defaults to this bot) | Owner |


## Access Control

Control who can use the bot and where.

| Command | Description |
|---------|-------------|
| `!lend <group> <user>` | Grant a user access to the bot in a specific group |
| `!lend dm <user>` | Grant a user DM access to the bot |
| `!lend <user> --dm` | Same as above (flag form) |
| `!revoke <group> <user>` | Revoke a user's group access |
| `!revoke dm <user>` | Revoke a user's DM access |

**Examples:**

```
!lend #general @alice
!lend dm @bob
!revoke #general @alice
```


## Context

Manage conversation context with the agent.

| Command | Description |
|---------|-------------|
| `!compact` | Compress conversation history (reduces token usage) |
| `!reset` | Wipe all context and start fresh |
| `!new [model]` | Start a fresh conversation, optionally switch model |

**Examples:**

```
!compact
!new
!new gpt-4o
```


## Model

Switch between available AI models.

| Command | Description |
|---------|-------------|
| `!model` | Show current model + list available models |
| `!model set <name>` | Switch to a different model |

**Examples:**

```
!model
!model set gpt-4o
!model set claude-3-opus
```

Run `!model` with no arguments to see all usable models. The new default is saved and applies to the next `!new` turn.


## Behavior

Control how the agent responds.

| Command | Description |
|---------|-------------|
| `!think off` | Disable extended thinking |
| `!think low` | Minimal thinking |
| `!think medium` | Moderate thinking |
| `!think high` | Deep thinking (slower, more thorough) |
| `!abort` | Stop the current reply in progress |
| `!reasoning on` | Show agent reasoning in replies |
| `!reasoning off` | Hide reasoning |
| `!verbose on` | Show debug details |
| `!verbose off` | Hide debug details |


## Tools & Skills

| Command | Description |
|---------|-------------|
| `!tools` | List tools available to the agent |
| `!skills` | List installed skills with usage info |
| `!skill <name>` | Run a specific skill |
| `!skill cron` | Show cron skill help |
| `!skill email` | Show email skill help |
| `!skill configure` | Show setup status for skills |


## Cron Jobs

Schedule one-shot reminders or repeating tasks.

| Command | Description |
|---------|-------------|
| `!cron <interval> <task>` | One-shot reminder after interval |
| `!cron --every <interval> <task>` | Repeat task every interval (until stopped) |
| `!cron list` | List all cron jobs for this bot |
| `!cron stop <name>` | Stop a repeating job |

**Interval formats:** `30s`, `5m`, `2h`, `1d` (seconds, minutes, hours, days)

**Examples:**

```
!cron 30m stretch
!cron 2h check deployments
!cron --every 1h check disk space
!cron list
!cron stop check disk space
```


## Email

Send, fetch, and summarize emails. Requires env vars — see [SETUP.md](SETUP.md#email-skills).

| Command | Description |
|---------|-------------|
| `!email send <to> : <subject> : <body>` | Send an email |
| `!email fetch <count> [account]` | Fetch recent emails (max 100) |
| `!email summarize <count> [account]` | Fetch + AI-summarize emails (max 10) |
| `!email` or `!email help` | Show email usage |

**Examples:**

```
!email send alice@example.com : Meeting : Let's meet at 3pm
!email fetch 5
!email fetch 10 user@gmail.com
!email summarize 5
```

**Requirements:**
- **Send:** `AGENTMAIL_API_KEY` or `EMAIL_SMTP_USER` + `EMAIL_SMTP_PASS` env var
- **Fetch:** `GMAIL_APP_PASSWORD` env var + `GMAIL_ACCOUNT` (or pass account as arg)

See [SETUP.md](./SETUP.md) for full reference.

## Configure

Check skill setup status and get configuration steps.

| Command | Description |
|---------|-------------|
| `!configure` | Show which skills are configured and how to set them up |

Returns the status of email send/fetch and shows the env vars needed for each.


## Permission Model

Commands are split into two tiers:

| Tier | Who can run |
|------|-------------|
| **Public** | Anyone in a room where the bot is present |
| **Owner** | Only the bot owner (set in `openclaw.json` under `accounts.<id>.owner`) |

Owner-only commands: `add-bot`, `remove-bot`, `add-group`, `revoke`, `access`, `bots`, `email`, `configure`

Non-owners see a permission error when trying owner-only commands.


## Unknown Command

If you type a command that doesn't exist, the bot replies:

```
Unknown command `!foo`. Type `!help` to see available commands.
```
