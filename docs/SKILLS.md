# Skill Installation & Management Guide

OpenClaw supports installing skills both **globally** for all bots and **per-agent** for isolated bots.

---

## 1. Global Skill Installation (For ALL Bots)

To install a skill **globally** so that every bot on your server (`main`, `rc-newb2`, etc.) can access it:

```bash
openclaw skills install <skill-name> --global
```

- **Target Directory**: `~/.openclaw/skills/`
- **Scope**: All present and future agents automatically gain access.
- **Flag Required**: `--global` (or `-g`). Does **not** require `--agent`.

---

## 2. Per-Agent Skill Installation (Isolated Bot Workspace)

To install a skill **specifically for one agent** (so other bots cannot access it):

```bash
openclaw skills install <skill-name> --agent <agent-id>
```

> ⚠️ **Note on Syntax**: Always use `--agent <agent-id>` (e.g. `--agent main` or `--agent rc-newb2`). Do not pass `--main` as a boolean flag.

**Examples:**

```bash
# Install for the main agent
openclaw skills install @otman-ai/google-calender-maton --agent main

# Install for a dedicated Rocket.Chat bot agent
openclaw skills install @porteden/email-gmail-outlook --agent rc-newb2
```

- **Target Directory**: `~/.openclaw/workspace/<agent-id>/skills/`
- **Scope**: Isolated to that specific agent only.

---

## 3. Active Skill Directory Structure

| Type                      | On-Disk Path                                      | Command                                              | Access Scope                            |
| :------------------------ | :------------------------------------------------ | :--------------------------------------------------- | :-------------------------------------- |
| **Global**                | `~/.openclaw/skills/<skill>`                      | `openclaw skills install <skill> --global`           | **All bots** (`main`, `rc-newb2`, etc.) |
| **Agent Workspace**       | `~/.openclaw/workspace/<agent-id>/skills/<skill>` | `openclaw skills install <skill> --agent <agent-id>` | That specific agent only                |
| **Legacy Seed Directory** | `~/.openclaw/workspace/skills/`                   | _(Legacy system seed directory)_                     | Read-only legacy fallback               |

---

## 4. Why `--agent <id>` is Required in Multi-Agent Setup

When multiple agents exist (e.g., `main` and `rc-newb2`), OpenClaw operates in **Strict Ownership Mode**:

- Omitting both `--global` and `--agent` will trigger the error:
  `Multiple agents are configured, but the skills command has no explicit owner. Pass --agent <id>.`
- This prevents accidental installation of sensitive or admin skills into the wrong bot workspace.

---

## 5. Managing Installed Skills

| Action              | Global (All Bots)                            | Specific Agent                                         |
| :------------------ | :------------------------------------------- | :----------------------------------------------------- |
| **List Skills**     | `openclaw skills list`                       | `openclaw skills list --agent <agent-id>`              |
| **Check Skills**    | `openclaw skills check`                      | `openclaw skills check --agent <agent-id>`             |
| **Uninstall Skill** | `openclaw skills uninstall <skill> --global` | `openclaw skills uninstall <skill> --agent <agent-id>` |
