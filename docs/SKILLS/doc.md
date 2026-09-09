# OpenClaw Skills

Skills let you extend what your OpenClaw agent can do from sending emails to scheduling reminders to integrating with third-party services.

## 1. Create the skills folder

Skills live inside your OpenClaw workspace, in the `skills` subfolder:

```bash
mkdir -p ~/.openclaw/workspace/skills
```

Each skill gets its own subfolder inside `~/.openclaw/workspace/skills/`.

## 2. Add a skill

Inside each skill's folder, add a `SKILL.md` file describing what the skill does and how to use it.

```
~/.openclaw/workspace/skills/
├── email/
│   └── SKILL.md
├── cron/
│   └── SKILL.md
└── agentmail/
    ├── SKILL.md
    └── references/
```

A `SKILL.md` typically includes:

- A YAML frontmatter block (`name`, `description`, `metadata`)
- Usage instructions, required binaries, and any hard rules the agent must follow

## 3. Example skills included

Two ready-made example skills are included to get you started:

- **`email`** : send/read email via `s-nail` and `fetch-emails`
  Reference: [SKILLS/Email.md](./Email.md)
- **`cron`** : schedule one-shot and recurring reminders via the `openclaw cron` CLI
  Reference: [SKILLS/Cron.md](./Cron.md)

Of these, the `cron` skill is exposed natively in the command menu (`!cron`). The `email` skill is used like any other skill via OpenClaw core (`!skill <name>`).

> Copy the contents of the reference file into `~/.openclaw/workspace/skills/<skill-name>/SKILL.md` to use it as-is, or edit it to fit your setup.

## 5. Explore and add more skills

Want more skills and install them like npm packages ? Check out:

- 🔗 Awesome OpenClaw Skills (community repo): [https://github.com/VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)
- 🔗 Skills website: [https://clawskills.sh/](https://clawskills.sh/)
- 🔗 Official docs: [https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)
