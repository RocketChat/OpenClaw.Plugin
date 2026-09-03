import { execFile, spawn } from "node:child_process";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { resolveOpenClawDir } from "../utils.js";
import type { CommandContext } from "./channel.js";

const execFileAsync = promisify(execFile);

const EMAIL_DOCS =
  "https://github.com/dodaa08/GSOC_project/Openclaw/blob/main/README.md#skills-setup";

export const CRON_HEADING = "**Cron jobs**";
export const CRON_USAGE = [
  "• `!cron <interval> <task>` one-shot reminder (30s | 5m | 2h | 1d)",
  "• `!cron --every <interval> <task>` repeat every interval until stopped",
  "• `!cron list` list running jobs",
  "• `!cron stop <name>` stop a repeating job",
  "• Examples: `!cron 30m stretch` · `!cron --every 1h check disk space`",
].join("\n");

export const EMAIL_HEADING = "**Email**";
export const EMAIL_USAGE = [
  "• Send via Agentmail: `!email send <to> : <subject> : <body>`",
  "• Fetch via email skill: `!email fetch <count> [account]` (max 100)",
  "• Summarize via email skill + agent: `!email summarize <count> [account]` (max 10)",
].join("\n");

export const CONFIGURE_HEADING = "**Configure**";
export const CONFIGURE_USAGE = ["• `!configure` check skill setup and get setup steps"].join(
  "\n",
);

type AuthStatus = { ok: boolean; hint: string };

function skillStatusFile(): string {
  return resolve(resolveOpenClawDir(), "rocketchat", "skills-status.json");
}

function persistStatus(send: boolean, fetch: boolean): void {
  const data = {
    sendConfigured: send,
    fetchConfigured: fetch,
    checkedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(skillStatusFile(), JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* best-effort; non-fatal */
  }
}

function readStatus(): { send: boolean; fetch: boolean } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(skillStatusFile(), "utf8")) as Partial<{
      sendConfigured?: boolean;
      fetchConfigured?: boolean;
    }>;
    return { send: parsed.sendConfigured === true, fetch: parsed.fetchConfigured === true };
  } catch {
    return undefined;
  }
}

export function fetchAuthStatus(): AuthStatus {
  const password = process.env.GMAIL_APP_PASSWORD?.trim();
  if (password) return { ok: true, hint: "Gmail app password (env `GMAIL_APP_PASSWORD`)" };
  const gmailDir = resolve(homedir(), ".config", "gmail");
  const files = existsSync(gmailDir)
    ? readdirSync(gmailDir).filter((f) => f.startsWith("app_password"))
    : [];
  if (files.length > 0) return { ok: true, hint: "Gmail app password file(s)" };
  return {
    ok: false,
    hint: "fetch needs a Gmail app password. Set `GMAIL_APP_PASSWORD` env, or add one under `~/.config/gmail/`.",
  };
}

export function sendAuthStatus(): AuthStatus {
  if (process.env.AGENTMAIL_API_KEY?.trim()) {
    return { ok: true, hint: "Agentmail API key (env `AGENTMAIL_API_KEY`)" };
  }
  if (process.env.EMAIL_SMTP_USER?.trim() && process.env.EMAIL_SMTP_PASS?.trim()) {
    return { ok: true, hint: "SMTP credentials (`EMAIL_SMTP_USER` + `EMAIL_SMTP_PASS`)" };
  }
  const mailrcPath = resolve(homedir(), ".mailrc");
  if (existsSync(mailrcPath)) {
    try {
      const content = readFileSync(mailrcPath, "utf8");
      const hasMta = /mta\s*=\s*smtps?:\/\/[^\s]*@[^\s]+/.test(content);
      const usesNetrc = /netrc-lookup/.test(content);
      const credsReady = usesNetrc
        ? existsSync(resolve(homedir(), ".netrc"))
        : /mta\s*=\s*smtps?:\/\/[^\s]*:[^\s]*@[^\s]+/.test(content);
      if (hasMta && credsReady) {
        return { ok: true, hint: "s-nail config (`~/.mailrc` SMTP `mta`)" };
      }
    } catch {
      /* fall through to "not configured" */
    }
  }
  return {
    ok: false,
    hint: "send needs Agentmail or SMTP creds. Set `AGENTMAIL_API_KEY`, or `EMAIL_SMTP_USER` + `EMAIL_SMTP_PASS`, or configure s-nail in `~/.mailrc`.",
  };
}

export function runConfigureCommand(): string {
  const send = sendAuthStatus();
  const fetch = fetchAuthStatus();
  persistStatus(send.ok, fetch.ok);
  const emailOk = send.ok || fetch.ok;

  const lines = ["**Setup status**"];
  lines.push(`- Email: ${emailOk ? "**configured**" : "**not configured**"}`);
  lines.push(`- Send: ${send.ok ? "**configured**" : "**not configured**"} ${send.hint}`);
  lines.push(`- Fetch: ${fetch.ok ? "**configured**" : "**not configured**"} ${fetch.hint}`);
  lines.push("- Cron: **always available** (uses OpenClaw account config)");

  if (!emailOk) {
    lines.push("", "### To set up email");
    lines.push(
      "• Send: set the `AGENTMAIL_API_KEY` env var, or `EMAIL_SMTP_USER` + `EMAIL_SMTP_PASS`, on the gateway or configure s-nail in `~/.mailrc`.",
    );
    lines.push(
      "• Fetch: set the `GMAIL_APP_PASSWORD` env var (a Gmail app password), or add a file under `~/.config/gmail/`.",
    );
    lines.push("• After adding creds, run `!configure` again to re-check.");
  }

  lines.push("", `Docs: ${EMAIL_DOCS}`);
  return lines.join("\n");
}

function resolveFetchAccount(): string {
  return process.env.GMAIL_ACCOUNT?.trim() ?? "";
}

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

function resolveFetchEmailsBin(): string {
  return process.env.FETCH_EMAILS_BIN ?? "fetch-emails";
}

function resolveSNailBin(): string {
  return process.env.SNAIL_BIN ?? "s-nail";
}

function formatEmailHelp(): string {
  return [EMAIL_HEADING, EMAIL_USAGE].join("\n");
}

async function fetchEmailRaw(count: number, account: string): Promise<string> {
  try {
    const res = await execFileAsync(resolveFetchEmailsBin(), [`${count}`, account], {
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return (res.stdout || "").trim();
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      String(error?.stderr ?? error?.stdout ?? error?.message ?? "unknown error").trim(),
    );
  }
}

async function fetchEmail(countInput: string, accountInput: string | undefined): Promise<string> {
  const count = parseInt(countInput, 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return [
      "Invalid count for fetching emails.",
      "Correct format:",
      "• `!email fetch <count> [account]`",
      "• Example: `!email fetch 5`",
    ].join("\n");
  }
  const status = readStatus();
  if (!status?.fetch) {
    return [
      "Email isn't set up yet.",
      "Run `!configure` to check and set up email creds, then try again.",
      `Docs: ${EMAIL_DOCS}`,
    ].join("\n");
  }
  const account = accountInput?.trim() || resolveFetchAccount();
  if (!account) {
    return [
      "No Gmail account specified.",
      "Pass one: `!email fetch <count> <account>`, or set the `GMAIL_ACCOUNT` env var on the gateway.",
      `Docs: ${EMAIL_DOCS}`,
    ].join("\n");
  }
  try {
    const out = await fetchEmailRaw(count, account);
    if (!out) return "Fetched, but the inbox returned no content.";
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return ["Failed to fetch email. Details:", "```", error, "```"].join("\n");
  }
}

const EMAIL_SUMMARY_MAX = 10;

async function summarizeEmail(
  ctx: CommandContext,
  countInput: string,
  accountInput: string | undefined,
): Promise<string> {
  const count = parseInt(countInput, 10);
  if (!Number.isInteger(count) || count < 1 || count > EMAIL_SUMMARY_MAX) {
    return [
      `Invalid count for summarizing emails (max ${EMAIL_SUMMARY_MAX}).`,
      "Correct format:",
      `• \`!email summarize <count> [account]\` (max ${EMAIL_SUMMARY_MAX})`,
      "• Example: `!email summarize 5`",
    ].join("\n");
  }
  const status = readStatus();
  if (!status?.fetch) {
    return [
      "Email isn't set up yet.",
      "Run `!configure` to check and set up email creds, then try again.",
      `Docs: ${EMAIL_DOCS}`,
    ].join("\n");
  }
  const account = accountInput?.trim() || resolveFetchAccount();
  if (!account) {
    return [
      "No Gmail account specified.",
      "Pass one: `!email summarize <count> <account>`, or set the `GMAIL_ACCOUNT` env var on the gateway.",
      `Docs: ${EMAIL_DOCS}`,
    ].join("\n");
  }

  let emails: string;
  try {
    emails = await fetchEmailRaw(count, account);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return ["Failed to fetch email. Details:", "```", error, "```"].join("\n");
  }
  if (!emails) {
    return "Fetched, but the inbox returned no content to summarize.";
  }

  const agentId = `rc-${ctx.accountId}`;
  const prompt = [
    "Summarize the following email inbox in a concise, natural way.",
    "Group similar items (newsletters, alerts, personal), note senders and subjects,",
    "and flag anything that needs attention. Keep it short and skimmable.",
    "",
    "--- INBOX START ---",
    emails,
    "--- INBOX END ---",
  ].join("\n");

  const argv = ["agent", "--agent", agentId, "--message", prompt, "--json", "--timeout", "120"];

  const extractSummary = (raw: string): string | undefined => {
    try {
      const parsed = JSON.parse(raw) as {
        text?: unknown;
        result?: unknown;
        response?: unknown;
        error?: unknown;
      };
      for (const v of [parsed.text, parsed.response]) {
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      const result = parsed.result;
      if (result && typeof result === "object") {
        const payloads = (result as { payloads?: Array<{ text?: unknown }> }).payloads;
        for (const p of payloads ?? []) {
          if (typeof p.text === "string" && p.text.trim()) return p.text.trim();
        }
      }
      if (typeof parsed.error === "string") return undefined;
      return undefined;
    } catch {
      return undefined;
    }
  };

  const summarizeErr = (raw: string): string =>
    ["Failed to summarize email. Details:", "```", raw || "unknown error", "```"].join("\n");

  try {
    const res = await execFileAsync(resolveOpenClawBin(), argv, {
      timeout: 125000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const summary = extractSummary(res.stdout ?? "");
    if (summary !== undefined) return summary;
    return "The agent produced no summary.";
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    const raw = String(error?.stderr ?? error?.stdout ?? error?.message ?? "").trim();
    const summary = extractSummary(raw);
    if (summary !== undefined) return summary;
    const msg = ((err: unknown) => {
      try {
        const parsed = JSON.parse(String(err)) as { error?: string };
        return typeof parsed.error === "string" ? parsed.error : undefined;
      } catch {
        return undefined;
      }
    })(raw);
    if (msg) return `Summarization failed: ${msg}`;
    return summarizeErr(raw);
  }
}

function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const from = process.env.EMAIL_FROM?.trim();
  const argv = from ? ["-s", subject, "-S", `from=${from}`, to] : ["-s", subject, to];
  return new Promise((resolvePromise) => {
    const child = spawn(resolveSNailBin(), argv, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => err.push(String(d)));
    child.on("error", (e) =>
      resolvePromise(["Failed to send email.", "```", String(e.message || e), "```"].join("\n")),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(`Email sent to ${to}.`);
      } else {
        resolvePromise(
          [
            `s-nail exited with code ${code}.`,
            "```",
            (err.join("") || out.join("") || "no output").trim(),
            "```",
          ].join("\n"),
        );
      }
    });
    child.stdin?.write(body);
    child.stdin?.end();
  });
}

export async function runEmailCommand(ctx: CommandContext, argStr: string): Promise<string> {
  const trimmed = argStr.trim();
  if (!trimmed || trimmed === "help") {
    return formatEmailHelp();
  }

  const firstSpace = trimmed.search(/\s/);
  const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();

  if (sub === "fetch") {
    return fetchEmail(
      rest.split(/\s+/)[0] ?? "",
      rest.split(/\s+/).slice(1).join(" ") || undefined,
    );
  }

  if (sub === "summarize") {
    return summarizeEmail(
      ctx,
      rest.split(/\s+/)[0] ?? "",
      rest.split(/\s+/).slice(1).join(" ") || undefined,
    );
  }

  if (sub === "send") {
    const parts = rest.split(":").map((s) => s.trim());
    const to = parts[0] ?? "";
    const subject = parts[1] ?? "";
    const body = parts[2] ?? "";
    if (!to || !subject || !body) {
      return [
        "Invalid send format.",
        "Correct format:",
        "• `!email send <to> : <subject> : <body>`",
        "• Example: `!email send friend@example.com : Hello : Check this out`",
      ].join("\n");
    }
    const status = readStatus();
    if (!status?.send) {
      return [
        "Email isn't set up yet (send).",
        "Run `!configure` to check and set up email creds, then try again.",
        `Docs: ${EMAIL_DOCS}`,
      ].join("\n");
    }
    return sendEmail(to, subject, body);
  }

  return ["Unknown email action. Usage:", formatEmailHelp()].join("\n");
}
