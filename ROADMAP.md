# OpenClaw Rocket.Chat Plugin — Roadmap

Active work only. Detailed plans live in PRs / design docs, not here.

# Cleanups
- [ ] Logs and comments

## Commands shortcut


## In progress (this branch)
- [ ] **Per-room concurrency cap** — N bots in one room on `@all` shouldn't blast the LLM
- [ ] **User-facing error messages** — surface dispatch/upload failures to the user, not just logs
- [ ] **Group members registry** — fetch + cache who's in each room, let the bot answer "is @bob here?"

## Multi-bot (next up, fresh branch off main)
- [ ] Multi-account setup (2+ bots in same room, verify both come up)
- [ ] `displayName` + `agent` per account in config
- [ ] Per-room bot registry (which bots are in which rooms)
- [ ] Per-room `requireMention` config (strict vs casual rooms)

## CLI (port from `openclaw-rocketchat-master/src/cli/`)
- [ ] `add-bot` — create RC user, save creds, auto-create DMs
- [ ] `add-group` / `invite` — group + member management
- [ ] `add-user` / `remove-user` — phone user CRUD
- [ ] `status` / `upgrade` / `uninstall` / `setup` hardening
- [ ] Credential system under `~/.openclaw/credentials/rocketchat/`

## Quality (post-merge)
- [ ] Test coverage (port 3 vitest files from master, add SSRF + mention + quoted-chain tests)
- [ ] Schema codegen so `openclaw.plugin.json` blocks can't drift again
- [ ] README update if it describes the old polling approach
- [ ] Trim `AGENTS.md` (currently 21 lines, fine for now)

## Defer (no RC public API)
- ❌ Ephemeral / private messages visible to only one user in a group — RC schema rejects `private: true` on `sendMessage`
- ❌ Hiding the user's own @mention message

## Done in `feat-DDP_Migration24thJuly` (this branch)
- [x] DDP-based real-time inbound (replaced polling)
- [x] Multi-model support
- [x] File restructure (`src/service/`, `src/client/`, `src/config/`)
- [x] Quoted messages in groups
- [x] Typing indicator
- [x] Strict mention filtering
- [x] Sender-label prefix in group `Body` (`alice (@alice): @bot hi`)
- [x] Group history tracking (last 10 skipped messages, embedded in body)
- [x] `WasMentioned` flag in ctxPayload
- [x] Processing-lock (prevents double-dispatch on duplicate `msg._id`)
- [x] `!help` command
- [x] `openclaw.plugin.json` schemas re-synced
