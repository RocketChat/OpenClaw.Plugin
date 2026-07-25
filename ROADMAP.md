# Openclaw Rocket.Chat Plugin — Roadmap

## Done
- [x] DDP-only gateway (polling removed)
- [x] SSRF protection with `ipaddr.js`
- [x] SQLite checkpoint store
- [x] Session memory fix (hardcoded `t: "d"`, removed roomTypeMap race)
- [x] Default model switched to local NIM
- [x] Himalayan Gmail auth fix (app password + PATH + save-copy=false)

## Phase 1 — Reference Architecture Ports
- [ ] **REST Client rewrite** — port `rc-api/rest-client.ts`: retry/backoff, user/room management, file upload, server info
- [ ] **MessageHandler** — `!commands` (`!help`, `!reset`, `!new`, `!clear`, `!model`, `!status`), clean formatting, long message splitting
- [ ] **BotManager** — unified multi-bot connection manager (all 7 accounts)
- [ ] **CLI commands** — add-bot, add-user, add-group, invite, remove-user, setup, status, uninstall, upgrade
- [ ] **CLI prompts** — ask, askPassword, confirm, select, multiSelect
- [ ] **Credential system** — move auth to `~/.openclaw/credentials/rocketchat/` with 0o600, backups, optional AES encryption

## Phase 2 — Features
- [ ] **Message reactions** — ⏳→🧠→✅ progress on bot messages
- [ ] **Reply watchdog** — thinking placeholder that updates at 60s/5m/15m to show liveness
- [ ] **Thread context injection** — fetch parent + prior replies when mentioned in a thread
- [ ] **Inbound anchor cache** — keep tool-based sends threaded
- [ ] **Quotes Understanding** -- bot should understand quoted messages
- [ ] **DDP watchdog** — 120s silence detection + client pings
- [ ] **Typing indicator** — via DDP `stream-notify-room`/`user-activity`
- [ ] **Room history injection** — fetch last N via REST on dispatch
- [ ] **Config env-var substitution** — `${ENV_VAR}` in config strings

## Phase 3 — GitHub Integration (Demo-ready)
- [ ] **RC webhook receiver** — post GitHub events (PRs, issues, CI) to RC channels via webhook
- [ ] **Bot reacts to events** — "review this PR", "merge when CI passes", "assign to @user"
- [ ] **Proactive GitHub queries** — "what PRs need review?", "status of PR #42?"
- [ ] **Demo flow**: webhook posts PR → user asks bot to review → bot reads diff + summarizes

## Phase 4 — Mobile Testing
- [ ] Test bot via mobile app (same WiFi or ngrok tunnel)
- [ ] Verify session memory, typing indicator, reactions on mobile
- [ ] Handle mobile-specific message formats (if any)

## Phase 5 - Code review
- [ ] Code review
- [ ] SDK migration and lib migration to places which have manual code written
- [ ] Cleanups dead code and files

## Group Channels

- [ ] Sync with all group channels with bot
- [ ] All can access the bot
- [ ] Do proper code management with openclaw and github
- [ ]

## Leftovers
- [ ] User manual collect
- [ ] Npm package ready
- [ ] E2E testing 



## Failure and erros handling


## Bot exec theek so it doesn't fail with basic shell commands running


## Double messages firing shouldn't happen