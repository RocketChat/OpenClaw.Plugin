import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandContext } from "./channel.js";

const execFileAsync = promisify(execFile);

export const CRON_HEADING = "**Cron jobs**";
export const CRON_USAGE = [
  "• `!cron <interval> <task>` one-shot reminder (30s | 5m | 2h | 1d)",
  "• `!cron --every <interval> <task>` repeat every interval until stopped",
  "• `!cron list` list running jobs",
  "• `!cron stop <name>` stop a repeating job",
  "• Examples: `!cron 30m stretch` · `!cron --every 1h check disk space`",
].join("\n");
const INTERVAL_RE =
  /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

const UNIT_MAP: Record<string, string> = {
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  m: "m",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  d: "d",
  day: "d",
  days: "d",
};

export function parseInterval(
  input: string,
): { ok: true; seconds: number; at: string } | { ok: false; error: string } {
  const match = input.trim().match(INTERVAL_RE);
  if (!match) {
    return {
      ok: false,
      error: `Invalid interval \`${input}\`. Expected e.g. \`30s\`, \`5m\`, \`2h\`, \`1d\` (number + s/m/h/d).`,
    };
  }
  const value = Number(match[1]);
  const unit = UNIT_MAP[match[2]!.toLowerCase()]!;
  const secondsMap: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = value * secondsMap[unit]!;
  return { ok: true, seconds, at: `+${match[1]}${unit}` };
}

export function deriveName(task: string): string {
  const slug = task
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  return (slug || "reminder").slice(0, 60);
}

function resolveOpenClawBin(): string {
  return process.env.OPENCLAW_BIN ?? "openclaw";
}

function formatEveryMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function runOpenClaw(
  args: string[],
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolveOpenClawBin(), args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

type CronSubcommand =
  | { type: "list" }
  | { type: "stop"; name: string }
  | {
      type: "schedule";
      every: boolean;
      intervalInput: string;
      interval: { ok: true; seconds: number; at: string };
      task: string;
    };

function parseCronArgs(trimmed: string): CronSubcommand | { ok: false; error: string } {
  const lower = trimmed.toLowerCase();
  if (lower === "list") return { type: "list" };
  if (lower.startsWith("stop")) {
    const name = trimmed
      .slice(4)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!name) {
      return { ok: false, error: "Usage: `!cron stop <name>` stop a repeating job." };
    }
    return { type: "stop", name };
  }

  const everyMatch = trimmed.match(/^--every\s+(\S+)\s+([\s\S]+)$/i);
  if (everyMatch) {
    const intervalInput = everyMatch[1]!;
    const task = everyMatch[2]!.trim();
    if (!task) {
      return {
        ok: false,
        error: "Usage: `!cron --every <interval> <task>` (e.g. `!cron --every 1h check disk`).",
      };
    }
    const interval = parseInterval(intervalInput);
    if (!interval.ok) return interval;
    return { type: "schedule", every: true, intervalInput, interval, task };
  }

  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { ok: false, error: "Missing task. Usage:\n" + CRON_USAGE };
  }
  const intervalInput = trimmed.slice(0, firstSpace).trim();
  const task = trimmed.slice(firstSpace).trim();
  if (!task) {
    return { ok: false, error: "Missing task. Usage:\n" + CRON_USAGE };
  }
  const interval = parseInterval(intervalInput);
  if (!interval.ok) return interval;
  return { type: "schedule", every: false, intervalInput, interval, task };
}

async function cronList(ctx: CommandContext): Promise<string> {
  try {
    const res = await runOpenClaw(["cron", "list", "--agent", `rc-${ctx.accountId}`, "--json"]);
    const parsed = JSON.parse(res.stdout || "{}") as { jobs?: Array<Record<string, unknown>> };
    const jobs = parsed.jobs ?? [];
    if (jobs.length === 0) {
      return "No cron jobs for this bot.";
    }
    const lines: string[] = [];
    for (const job of jobs) {
      const name = String(job.name ?? job.id ?? "unknown");
      const schedule = job.schedule as
        { kind?: string; everyMs?: number; at?: string; cron?: string } | undefined;
      const everyMs = schedule?.everyMs;
      const scheduleDesc =
        schedule?.kind === "every"
          ? `every ${everyMs ? formatEveryMs(everyMs) : "?"}`
          : schedule?.kind === "cron"
            ? `cron ${schedule.cron ?? "?"}`
            : schedule?.kind === "at"
              ? `at ${schedule.at ?? "?"}`
              : (schedule?.kind ?? "?");
      lines.push(`- ${name} (${scheduleDesc})`);
    }
    return ["**Cron jobs**", ...lines].join("\n");
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return [
      "Failed to list cron jobs.",
      "```",
      String(error?.stderr ?? error?.stdout ?? error?.message ?? "unknown error").trim(),
      "```",
    ].join("\n");
  }
}

async function cronStop(ctx: CommandContext, name: string): Promise<string> {
  try {
    const listRes = await runOpenClaw(["cron", "list", "--agent", `rc-${ctx.accountId}`, "--json"]);
    const parsed = JSON.parse(listRes.stdout || "{}") as {
      jobs?: Array<Record<string, unknown>>;
    };
    const jobs = parsed.jobs ?? [];
    const target = jobs.find((j) => {
      const jobName = String(j.name ?? "");
      return jobName.toLowerCase() === name.trim().toLowerCase();
    });
    if (!target) {
      return `No repeating job named \`${name}\` found for this bot. Use \`!cron list\` to see jobs.`;
    }
    const id = String(target.id ?? "");
    await runOpenClaw(["cron", "rm", id, "--json"]);
    return `Stopped cron job \`${id}\` (\`${String(target.name ?? "")}\`).`;
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return [
      "Failed to stop cron job.",
      "```",
      String(error?.stderr ?? error?.stdout ?? error?.message ?? "unknown error").trim(),
      "```",
    ].join("\n");
  }
}

export async function runCronCommand(ctx: CommandContext, argStr: string): Promise<string> {
  const trimmed = argStr.trim();
  if (!trimmed || trimmed === "help") {
    return [CRON_HEADING, CRON_USAGE].join("\n");
  }

  const parsed = parseCronArgs(trimmed);
  if ("error" in parsed) {
    return ["Cron error.", parsed.error].join("\n");
  }

  if (parsed.type === "list") return cronList(ctx);
  if (parsed.type === "stop") return cronStop(ctx, parsed.name);

  const { every, intervalInput, interval, task } = parsed;

  const accountId = ctx.accountId;
  const agentId = `rc-${accountId}`;
  const roomId = ctx.roomId;
  const name = deriveName(task);

  if (!roomId) {
    return "Could not determine the destination chat for this reminder. Try again from a direct conversation.";
  }

  const value = every ? interval.at.replace(/^\+/, "") : interval.at;
  const argv = [
    "cron",
    "add",
    every ? "--every" : "--at",
    value,
    "--name",
    name,
    "--agent",
    agentId,
    "--account",
    accountId,
    "--session",
    "isolated",
    "--announce",
    "--channel",
    "rocketchat",
    "--to",
    roomId,
    "--command-argv",
    JSON.stringify(["echo", task]),
  ];
  if (!every) argv.push("--delete-after-run");
  argv.push("--json");

  let out: string;
  try {
    const res = await runOpenClaw(argv, 30000);
    out = res.stdout;
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return [
      "Failed to schedule the cron job. Details:",
      "```",
      String(error?.stderr ?? error?.stdout ?? error?.message ?? "unknown error").trim(),
      "```",
    ].join("\n");
  }

  const scheduled: unknown = (() => {
    try {
      if (!out) return undefined;
      const j = JSON.parse(out);
      return Array.isArray(j) ? j[0] : j;
    } catch {
      return undefined;
    }
  })();

  const nextRun =
    (scheduled as { nextRunAt?: string } | undefined)?.nextRunAt ??
    (scheduled as { next_run_at?: string } | undefined)?.next_run_at;

  if (every) {
    return [
      `Scheduled repeating job: \`${name}\` every ${intervalInput}.`,
      "It will run until you stop it with `!cron stop <name>`.",
      "It will appear in this chat.",
    ].join("\n");
  }

  return [
    `Scheduled: \`${name}\` in ${intervalInput}.`,
    nextRun ? `Next run: ${nextRun}` : "Next run: scheduled.",
    "Reminder set. It will appear in this chat.",
  ].join("\n");
}
