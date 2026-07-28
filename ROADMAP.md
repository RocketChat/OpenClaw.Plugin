# Openclaw Rocket.Chat Plugin — Roadmap

## Phase 1 — Reference Architecture Ports
- [ ] **REST Client rewrite** — port `rc-api/rest-client.ts`: retry/backoff, user/room management, file upload, server info
- [ ] **MessageHandler** — `!commands` (`!help`, `!reset`, `!new`, `!clear`, `!model`, `!status`), clean formatting, long message splitting
- [ ] **BotManager** — unified multi-bot connection manager (all 7 accounts)
- [ ] **CLI commands** — add-bot, add-user, add-group, invite, remove-user, setup, status, uninstall, upgrade
- [ ] **CLI prompts** — ask, askPassword, confirm, select, multiSelect
- [ ] **Credential system** — move auth to `~/.openclaw/credentials/rocketchat/` with 0o600, backups, optional AES encryption

## Phase 2 — Features
- [ ] **Thread context injection** — fetch parent + prior replies when mentioned in a thread
- [ ] **Quotes Understanding** -- bot should understand quoted messages
- [ ] **Room history injection** — fetch last N via REST on dispatch
- [ ] **Config env-var substitution** — `${ENV_VAR}` in config strings

## Phase 4 — Mobile Testing
- [ ] Test bot via mobile app (same WiFi or ngrok tunnel)
- [ ] Verify session memory, typing indicator, reactions on mobile
- [ ] Handle mobile-specific message formats (if any)


## Phase 5 - Group Channels

- [ ] Ephemeral bot messages for groups
- [ ] Allow user to share messages of bot in the group and not if they don't want to
- [ ] Allow everyone have access to the bot for specific skills
- [ ] Bot shuld suggest members and user about what needs to be configured before they can start using it
- [ ] Borrow and lend the openclaw bot
 


## Phase 6 - Error handling and cleaning up the dead code and merging to main
- [ ] Keep the main code up to date merged to avoid conflicts later
- [ ] Media handling tightining up including voice instructions
- [ ] Bot intellegent so it asks user to tell if something is missing or good to have to start doing something
- [ ] Code review, SDK, Migration, Cleanups and good code approaches
- [ ] Bot exec theek so it doesn't fail with basic shell commands running so have strict error handling logic and  bot should show whats wrong to user
- [ ] Double messages firing shouldn't happen and bot shouldn't go crazy
- [ ] Test with better models and config


##  Final Phase - Leftovers
- [ ] User manual collect in github readme
- [ ] Npm package ready
- [ ] E2E testing 