# Rocket.Chat Plugin Setup

How to install, configure, and manage credentials for the Rocket.Chat plugin.

## Prerequisites

- Rocket.Chat server with admin access (needed once, during setup)
- OpenClaw installed with AI provider configured
- A default agent already set up

## Quick Start

```bash
openclaw plugins install clawhub:@dodaa08/openclaw-plugin-test
openclaw rocketchat setup
```

This runs an interactive wizard that handles everything automatically.

If you already have the plugin installed, make sure you're using the latest version:

```bash
openclaw plugins update --all
```

## Setup Wizard

The wizard prompts you through these steps:

1. **Server URL**  
   └─ Validates connection + checks server health

2. **Admin Login**  
   ├─ Tries saved credentials first (if exists)  
   ├─ Prompts username + password if needed  
   ├─ Handles 2FA (TOTP or email challenge)  
   └─ Saves admin token (used only during setup)

3. **Bot Username**  
   └─ Creates bot user on server

4. **Bot Password**  
   ├─ Auto-generated (shown once, save it if needed) if created using command menu  
   └─ Saved securely locally

5. **Agent Selection**  
   ├─ `"main"` (shared agent)  
   └─ `"rc-<username>"` (dedicated agent, auto-created)

6. **Config Saved**  
   └─ `~/.openclaw/openclaw.json` updated

7. **Bot Setup Complete**  
   └─ Welcome DM sent to bot owner (optional)

8. **(Optional)** Invite bot to a group

After this, run `!status` in Rocket.Chat to verify (should show online + ready).

## What Gets Stored

Everything lives in `~/.openclaw/` (override with `OPENCLAW_STATE_DIR` env var):

### Credentials

```
credentials/rocketchat/
├── admin.json          # Admin token (setup only; safe to delete after)
└── bot-<username>.json # Bot credentials (kept for reconnections)
```

Permissions: Files created as `0600` (read/write owner only).

### Data (SQLite)

```
rocketchat/
├── access.db           # Access grants (who can use which bot/room)
├── <botId>.db          # Seen messages + failures (per bot)
├── rate-limit.json     # Bot creation cooldown state
└── skills-status.json  # Email skill setup status
```

### Credentials: What's Safe to Delete

| File                | Safe to Delete? | What Happens                                 |
|---------------------|-----------------|----------------------------------------------|
| `admin.json`        | ✅ Yes          | Next setup will re-prompt for admin login    |
| `admin.json.bak`    | ✅ Yes          | Just a backup; doesn't affect anything       |
| `bot-<username>.json` | ❌ No         | Bot can't reconnect; use `!remove-bot` instead |

## Remove a Bot

Use the command (owner-only):

```
!remove-bot <username...>
```

This deletes:

- Bot user from Rocket.Chat server
- Bot config + credentials
- Agent workspace
- All associated data

## Clean Everything Up

To completely remove the plugin from your machine:

```bash
# Delete all Rocket.Chat plugin data
rm -rf ~/.openclaw/credentials/rocketchat/
rm -rf ~/.openclaw/rocketchat/
rm -rf ~/.openclaw/agents/rc-*/
rm -rf ~/.openclaw/media/inbound/
```

**Important:** This does **not** delete bot users from your Rocket.Chat server. Use `!remove-bot` first, or manually delete them via Rocket.Chat admin panel.

## Agent Workspaces

```
agents/rc-<username>/   # Dedicated agent config + sessions
```

## Media (Temporary)

```
media/inbound/          # Downloaded attachments (NOT auto-cleaned)
```

**Note:** All stored locally on your machine — no cloud uploads.

---

## Environment Variables

Optional overrides for paths and email skills. Set these in your shell before starting the gateway.

### Path Configuration

| Variable           | Purpose                                              | Default     |
|--------------------|------------------------------------------------------|-------------|
| `OPENCLAW_STATE_DIR` | Custom directory for all config/credentials        | `~/.openclaw` |
| `OPENCLAW_HOME`      | Custom home; config becomes `$OPENCLAW_HOME/.openclaw` | `~`       |

---

## Email Setup (Simplified)

Email skills enable the `!email send` and `!email fetch` commands in Rocket.Chat.  
Without the correct credentials, these commands will not work.

### Recommended Simple Setup

| Purpose   | Recommended Method                          | Notes                                      |
|-----------|---------------------------------------------|--------------------------------------------|
| **Send**  | `~/.netrc` file (Linux / macOS)             | Cleanest, no env vars needed               |
| **Send**  | Environment variables (Windows)             | Easiest on Windows                         |
| **Fetch** | Gmail App Password                          | Required for `!email fetch`                |

### 1. Sending Emails

#### Linux & macOS (recommended)

Create or edit `~/.netrc`:

```bash
nano ~/.netrc
```

Add this line (replace with your real Gmail + app password):

```
machine smtp.gmail.com login you@gmail.com password "xxxx xxxx xxxx xxxx"
```

Lock the file:

```bash
chmod 0600 ~/.netrc
```

`s-nail` reads this automatically — no extra environment variables needed.

#### Windows

Use environment variables instead:

```powershell
$env:EMAIL_SMTP_USER = "you@gmail.com"
$env:EMAIL_SMTP_PASS = "xxxx xxxx xxxx xxxx"
```

### 2. Fetching Emails (Gmail App Password)

You need a Gmail **App Password** (not your regular password).

Generate one at:  
Google Account → Security → 2-Step Verification → App passwords → select "Mail".

#### Linux (systemd – recommended for production)

```bash
systemctl --user edit --full openclaw-gateway.service
```

Add under the `[Service]` section:

```
Environment="GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx"
Environment=GMAIL_ACCOUNT=you@gmail.com
Environment=EMAIL_FROM=you@gmail.com
```

**Important:** Quote the entire `KEY=value` pair because Gmail app passwords contain spaces.

Reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

Verify the password loaded:

```bash
systemctl --user show openclaw-gateway.service -p Environment | grep GMAIL
```

> Note: OpenClaw may regenerate the service file on updates. Re-check and re-add these lines after each upgrade.

#### macOS / Linux (shell profile)

Add to `~/.zshrc`, `~/.bashrc`, or `~/.profile`:

```bash
export GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"
export GMAIL_ACCOUNT="you@gmail.com"
export EMAIL_FROM="you@gmail.com"
```

Then:

```bash
source ~/.zshrc   # or the file you edited
openclaw gateway restart
```

#### Windows (PowerShell)

```powershell
$env:GMAIL_APP_PASSWORD = "xxxx xxxx xxxx xxxx"
$env:GMAIL_ACCOUNT = "you@gmail.com"
$env:EMAIL_FROM = "you@gmail.com"
openclaw gateway restart
```

To make them permanent, add the variables in **System Properties → Environment Variables**, or put the lines in your PowerShell profile (`$PROFILE`).

### Getting the Keys

- **Gmail App Password** (for fetch):  
  Google Account → Security → 2-Step Verification → App passwords → generate one for "Mail".

- **SMTP credentials** (for send):  
  Use `smtp.gmail.com` with the same App Password. Prefer `~/.netrc` on Linux/macOS.

### Verifying Setup

In Rocket.Chat run:

```
!configure
```

You should see something like:

```
Email Configuration:
Send:  ✅ netrc / SMTP configured
Fetch: ✅ Gmail app password configured
```

If a skill shows ❌, set the corresponding credentials and restart the gateway.

---

## Troubleshooting Setup

| Issue                     | Fix                                                                          |
|---------------------------|------------------------------------------------------------------------------|
| "Can't connect to server" | Check server URL is correct + reachable                                      |
| "Admin login failed"      | Verify admin username/password; try deleting `admin.json` and re-running setup |
| "Bot creation failed"     | Check you have admin rights; try manual `!add-bot` after setup               |
| "2FA keeps failing"       | Check TOTP app time is synced; email OTP expires after ~5 min                |
| Email send/fetch fails    | Run `!configure` and confirm both Show ✅. Restart gateway after changing credentials |

---

## Technical Details (For Debugging)

### Admin Authentication Flow

1. Prompt server URL → validate with `GET /api/v1/info`
2. Prompt admin username + password
3. Call `POST /api/v1/login` → get auth token
4. Verify token with `GET /api/v1/users.info` → check for admin role
5. Save to `credentials/rocketchat/admin.json`

### Bot Creation Flow

1. Check if bot exists via `GET /api/v1/users.list?query={"username": "bot-name"}`
2. If not: create via `POST /api/v1/users.create` with `bot=true` role
3. Generate random password
4. Call `POST /api/v1/login` with bot credentials
5. Save to `credentials/rocketchat/bot-<username>.json`
6. DDP client connects using bot token

### Rate Limiting

- Max bot accounts: 10 (configurable via `limits.maxAccounts` in `openclaw.json`)
- Max bots per server: 5 (configurable via `limits.maxBotsPerServer`)
- Cooldown between creations: 60s (configurable via `limits.botCreationCooldownMs`)
- State stored: `rocketchat/rate-limit.json`

### SQLite Schemas

**access.db** — stores access grants:

```sql
meta (key TEXT PRIMARY KEY, value TEXT)          -- schema version
grants (
  account_id TEXT NOT NULL,
  room_id    TEXT NOT NULL,
  room_name  TEXT,
  username   TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, room_id, username)
)
```

**<botId>.db** — stores message dedup + errors:

```sql
meta            (key, value)                      -- schema version
seen_messages   (id TEXT PRIMARY KEY)             -- dedup: message ID → processed
failed_messages (message_id, room_id, reason)     -- debugging: what went wrong
```

Limits: 250 seen messages, 100 failed records per bot (auto-pruned).