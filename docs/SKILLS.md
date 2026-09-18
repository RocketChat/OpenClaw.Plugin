# OpenClaw Skills & Management Guide

Skills let you extend what your OpenClaw agent can do—from scheduling reminders and automation to integrating with third-party services like email, calendars, and external APIs.

OpenClaw supports creating custom skills manually in your workspace as well as installing package-managed skills from ClawHub.

---

## 1. Creating a Custom Skill Manually

To create your own custom skill:

### Step 1: Create the Skill Folder

Skills live inside an agent's workspace folder under `skills`:

```bash
# For a specific agent (e.g., main or rc-newb2)
mkdir -p ~/.openclaw/workspace/main/skills/my-custom-skill
```

### Step 2: Add `SKILL.md`

Inside the skill folder, create a `SKILL.md` file detailing what the skill does and its rules:

```markdown
---
name: my-custom-skill
description: A brief summary of what this custom skill does
---

# My Custom Skill

Write instructions, required parameters, environment variables, or CLI usage rules here for the agent.
```

A `SKILL.md` must include:

- A YAML frontmatter block (`---` containing `name` and `description`).
- Usage instructions and rules that the AI model follows when executing the skill.

---

## 2. Installing Skills via ClawHub CLI

OpenClaw supports installing pre-built community skills directly from ClawHub.

### Global Installation (Available to ALL Bots)

To install a skill **globally** so that every bot on your server (`main`, `rc-newb2`, etc.) can access it:

```bash
openclaw skills install <skill-name> --global
```

- **Target Directory**: `~/.openclaw/skills/`
- **Access**: Available to all present and future bots.

---

### Per-Agent Installation (Isolated Bot Workspace)

To install a skill **specifically for one agent** (so other bots cannot access it):

```bash
openclaw skills install <skill-name> --agent <agent-id>
```

> ⚠️ **Note**: Always use `--agent <agent-id>` (e.g., `--agent main` or `--agent rc-newb2`).

**Examples:**

```bash
# Install for default main agent
openclaw skills install @otman-ai/google-calender-maton --agent main

# Install for a dedicated Rocket.Chat bot agent
openclaw skills install @porteden/email-gmail-outlook --agent rc-newb2
```

- **Target Directory**: `~/.openclaw/workspace/<agent-id>/skills/`
- **Access**: Isolated to that specific agent only.

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

---

## 6. Resources & Community Skills

- 🔗 **Official Documentation**: [https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)
- 🔗 **ClawHub Registry**: Search skills using `openclaw skills search <query>`
