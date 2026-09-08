# OpenClaw Skills

Skills let you extend what your OpenClaw agent can do from sending emails to scheduling reminders to integrating with third-party services.

## 1. Create the skills folder

Skills live **outside** your workspace, in your home directory root:

```bash
mkdir -p ~/.openclaw/skills
```

Each skill gets its own subfolder inside `~/.openclaw/skills/`.

## 2. Add a skill

Inside each skill's folder, add a `SKILL.md` file describing what the skill does and how to use it.

```
~/.openclaw/skills/
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
  Reference: [SKILLS/CronJobs.md](./CronJobs.md)

These two are directly accessible from the **command menu**.

> Copy the contents of the reference file into `~/.openclaw/skills/<skill-name>/SKILL.md` to use it as-is, or edit it to fit your setup.

## 4. Skills beyond the command menu

Not every skill needs to live in the command menu. right now other skills aren't directly triggered from the command menu instead, they're picked up and used automatically through OpenClaw's **inbound message handling**, exactly as OpenClaw is designed to work.

## 5. Explore and add more skills

Want more skills? Check out:

- 🔗 Awesome OpenClaw Skills (community repo): [https://github.com/VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)
- 🔗 Skills website: [https://clawskills.sh/](https://clawskills.sh/)
- 🔗 Official docs: [https://docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)
