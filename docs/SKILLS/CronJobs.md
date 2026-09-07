---
name: cron
description: "Schedule one-shot and recurring reminders via openclaw cron CLI. Use exec, NOT the cron tool (restricted to cron job context)."
metadata:
  openclaw:
    emoji: "⏰"
    requires:
      bins: ["openclaw"]
---

# Cron / Reminders

Use `exec` with the `openclaw cron` CLI. Do NOT use the built-in `cron` tool — it only works inside cron job executions, not from chat. (The `cron` tool is denied for this agent; only the CLI is available.)

## MANDATORY — you MUST actually run the command

You have `exec` access (`tools.profile: full`, `exec.mode: full`). You are NOT allowed to only describe what you would do.

1. **Execute** the `openclaw cron add ...` command via `exec`. Do not skip this step.
2. **NEVER fabricate output.** Do not invent a job id (e.g. `fast-nexus`), a schedule (e.g. `Every 120,000ms`), or a "next run" time. Only report values that appear in the real command output.
3. **VERIFY** by running `openclaw cron list --json` immediately after. Confirm the new job is present. If it is NOT in the list, the creation failed — report the actual error from the `add` command instead of claiming success.
4. Report back the **real** job id, schedule, and next-run time from the `list`/`add --json` output — nothing else.

If the `add` command errors, paste the real error and stop. Do not paper over failures with a fake success message.

## FORBIDDEN — common failures

- NEVER call the `cron.add` tool. Only `openclaw cron add` (CLI) is allowed.
- NEVER set `trigger.script` (or `payload.kind: "systemEvent"`). `trigger.script` is executed as **JavaScript (code-mode)**, so a shell command like `echo '...'` throws `SyntaxError: expecting ';'`. Put the reminder text in `--message "..."` instead — that is the agent payload and is delivered correctly.
- NEVER use `--session main` for non-default agents; use `--session isolated`.
- NEVER let the reminder payload trigger an action. A reminder is a NOTE to the user, not a task. Use `--command 'echo "<reminder text>"'` so the text is relayed verbatim via `--announce`. Do NOT use `--message` with an instruction the agent will try to execute (e.g. `--message "check your email"` made the agent actually try to fetch email and fail). For a plain "remind me to X" reminder, always use the `--command echo` form below.
- NEVER use a `sleep`/background-process workaround (`sleep 120 && echo ...`, `nohup ... &`, `at`, shell loops, etc.). A background `sleep` does NOT deliver to chat — it only echoes into a detached shell and is NOT a reminder. Always create the reminder with `openclaw cron add`.
- NEVER claim "cron is disabled" / "cron is globally disabled" / "cron triggers are disabled". Cron is ENABLED. Only the agent's built-in `cron` *tool* is denied (that is exactly why you must use the `openclaw cron add` CLI). If `openclaw cron add` errors, report the REAL error — do not invent a workaround or a disabled-system excuse.

## How to handle ANY reminder request (free-form)

Users will phrase requests unpredictably ("remind me to X in 2 minutes", "ping me tomorrow 3pm to Y", "every weekday at 9 standup"). There is no fixed template — **parse the request and build the command from it**:

1. **Extract the reminder text** — what the user wants to be reminded of (strip "remind me to/that", "ping me to", etc.). This becomes the echoed string in `--command 'echo "<text>"'`. Derive a short `--name` from it.
2. **Classify the schedule** and pick flags:
   - **Relative** ("in/after N minutes/hours/seconds/days", "N minutes from now") → `--at "+Nm"` where N is the number and the unit is `s`/`m`/`h`/`d`. One-shot → add `--delete-after-run`.
   - **Absolute** ("tomorrow at 3pm", "2026-08-25 15:00", "at 09:00") → `--at "<ISO or parseable time>"` plus `--tz "<user's timezone, e.g. Asia/Kolkata>"`. One-shot → add `--delete-after-run`.
   - **Recurring** ("every day at 9", "every weekday 8am", "every Monday 10:00") → `--cron "<5-field expression>"` plus `--tz`. Do NOT add `--delete-after-run` (it repeats forever).
3. **Delivery target** — deliver to the conversation where the request originated (the user's direct message). Use `--channel rocketchat --to "<room name or id of the chat you received this in>"`. If you cannot determine the room, ASK the user which room to deliver to. **Never default to `general`** — a personal reminder goes to the user, not a public room.
4. **Acting agent** — ALWAYS pass `--agent <your own agent id>` (e.g. `rc-ocrcbot` for this agent). Without it the job runs as the `main` agent, which is NOT permitted to deliver to the user's chat and fails with `error-not-allowed`. Combined with `--session isolated`, this is mandatory.
5. **Always** include `--agent <your id> --session isolated --announce --json`.
6. **Execute** the command (see MANDATORY above), then **verify** with `openclaw cron list --json`.

### Examples (patterns — adapt to the actual words)

Relative one-shot ("remind me to check email after 2 minutes"):

```bash
openclaw cron add \
  --name "Check email" \
  --at "+2m" \
  --agent rc-ocrcbot \
  --session isolated \
  --command 'echo "Time to check your email!"' \
  --announce --channel rocketchat --to "<current room>" \
  --delete-after-run --json
```

Absolute one-shot ("remind me tomorrow 3pm"):

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "2026-08-24T15:00:00" --tz "Asia/Kolkata" \
  --agent rc-ocrcbot \
  --session isolated \
  --command 'echo "Meeting starting now"' \
  --announce --channel rocketchat --to "<current room>" \
  --delete-after-run --json
```

Recurring ("every weekday at 9am standup"):

```bash
openclaw cron add \
  --name "Daily standup" \
  --cron "0 9 * * 1-5" --tz "Asia/Kolkata" \
  --agent rc-ocrcbot \
  --session isolated \
  --command 'echo "Time for daily standup!"' \
  --announce --channel rocketchat --to "<current room>" \
  --json
```

## List jobs

```bash
openclaw cron list --json
```

> **VERIFY after every create:** always run `openclaw cron list --json` after `add` and confirm the job id from the output exists. If it is missing, the create failed — report the real error, never a fake success.

## Remove a job

```bash
openclaw cron rm <job-id> --json
```

## Important flags

- `--agent <id>` — the agent that runs/delivers the job. ALWAYS set this to your own agent id (e.g. `rc-ocrcbot`). Omitting it makes the job run as `main`, which is NOT allowed to deliver to the user's chat and fails with `error-not-allowed`.
- `--session isolated` — ALWAYS use `isolated`, NEVER use `main`. Using `--session main` causes delivery failures.
- `--command 'echo "<text>"'` — the reminder payload. Runs on the Gateway and its output is delivered via `--announce`. Use this for plain reminders so the text is relayed verbatim and the agent does NOT perform the task described.
- `--announce` — delivers the command output (the reminder text) to the channel
- `--channel rocketchat` — the channel plugin name
- `--to <room>` — the room name (e.g. `general`) or room ID where the reminder is delivered. Use the room you received the request in (the user's DM), NOT `general`, unless the user asks for a public room.
- `--account <accountId>` — the bot account ID (e.g. `rocketbot123`), required for multi-account setups
- `--delete-after-run` — auto-remove ONE-SHOT jobs after they fire. Omit for recurring jobs.
- `--json` — get machine-readable output
- `--tz "<IANA>"` — set timezone for absolute times and cron expressions (e.g. `Asia/Kolkata`)

> **Delivery is mandatory with `--session isolated`.** An isolated job runs in a fresh session with no inherited recipient, so omitting `--channel`/`--to` (or having the channel plugin fail to resolve them) causes the runner to abort with "Refusing implicit isolated cron delivery" and the job is disabled. Always pass `--agent <your id> --announce --channel <plugin> --to <target>` together.

> **NEVER use `--session main`.** Always use `--session isolated` + `--agent <your id>`. The `main` session target is not permitted to deliver to the user's chat and fails with `error-not-allowed`.