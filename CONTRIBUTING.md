# Contributing

Thanks for helping! Here's how to get started.

## Setup

```bash
git clone https://github.com/RocketChat/OpenClaw.Plugin.git
cd OpenClaw.Plugin
corepack enable
pnpm install
```

## Development

```bash
pnpm run build      # Compile TypeScript + bundle
pnpm run format     # Auto-format code
pnpm run setup      # Test with your own Rocket.Chat server (optional)
```

Before submitting a PR:

```bash
pnpm run build           # No errors?
pnpm run format:check    # Code styled?
```

## Project Structure

- `src/cli/` — Setup wizard and commands
- `src/client/` — Rocket.Chat connection (DDP + REST)
- `src/service/` — Message handling and routing
- `src/plugin.ts` — Plugin definition
- `docs/` — Architecture and guides

## Submitting a PR

- [ ] Code builds and formats cleanly
- [ ] Changes tested manually (if adding features)
- [ ] README updated (if user-facing change)

Questions? See [ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how it all connects.