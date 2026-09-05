import type { InboundEvent } from "../types.js";
import type { ChannelRuleOptions } from "../types.js";
import { DM_SCOPE, CommandParser } from "../utils.js";
import { RocketChatClient } from "../client/rest.js";
import type { RCLoginResult } from "../types.js";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  readConfig,
  readDefaultModel,
  setDefaultModel,
  readAllAccounts,
  readBindingsForAccount,
  readOwner,
  readAccount,
  addAccount,
  addBinding,
  ensureAgentForBot,
  removeBindingsForAccount,
  removeAccount,
  removeAgentDir,
  type ExistingAccount,
  type TokenAuth,
} from "../cli/config-updater.js";
import {
  createBotUser,
  loginAs,
  getGroupByName,
  createDirectMessage,
  sendMessage,
  deleteUser,
  getUserInfo,
  inviteToGroup,
  listGroupMembers,
  type RocketChatGroup,
} from "../cli/admin-api.js";
import { checkBotCreationLimit, recordBotCreation } from "../cli/rate-limiter.js";
import { loadAdmin, removeBotCredentials } from "../cli/credentials.js";
import { startGateway } from "./gateway.js";
import { activeClients, connectionStatus } from "./runtime-state.js";
import { AccessStore } from "../config/access-store.js";
import {
  runCronCommand,
  runEmailCommand,
  runConfigureCommand,
  CRON_USAGE,
  CRON_HEADING,
  EMAIL_USAGE,
  EMAIL_HEADING,
  CONFIGURE_USAGE,
  CONFIGURE_HEADING,
} from "./skill-commands.js";

const BROADCAST_MENTIONS = new Set(["here", "all", "everyone"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize a room name for comparison: optional leading #, trimmed, lowercased. */
function normalizeRoomName(name: string): string {
  return name.replace(/^#+/, "").trim().toLowerCase();
}

function groupNotFoundText(groupName: string, reasons?: string[]): string {
  if ((reasons ?? []).some((r) => /discussion/i.test(r))) {
    return `Group "${groupName}" is a discussion. Lending/inviting bots in discussions isn't supported yet coming soon.`;
  }

  const forbidden = (reasons ?? []).some((r) =>
    /not.authorized|not-authorized|forbidden|permission|not.member|not.allowed/i.test(r),
  );

  let hint: string;
  if (forbidden) {
    hint =
      "exists but requires permission this usually happens with private groups where the acting account isn't a member or lacks permission";
  } else {
    hint =
      "not found this could be a private group the acting account isn't a member of, or a discussion (will be supported soon)";
  }
  return `Group "${groupName}" ${hint}.`;
}

export function shouldHandleInboundEvent(
  event: InboundEvent,
  options: ChannelRuleOptions,
): boolean {
  if (event.senderId === options.botUserId) {
    return false;
  }

  if (options.knownBotUserIds?.has(event.senderId)) {
    return false;
  }

  if (event.roomType === "direct") {
    return true;
  }

  const aliases = new Set(
    options.mentionNames.map((a) => a.trim().replace(/^@+/, "").toLowerCase()),
  );

  for (const mention of event.mentions) {
    const name = mention.toLowerCase();
    if (BROADCAST_MENTIONS.has(name)) continue;
    if (aliases.has(name)) return true;
  }

  const normalizedText = event.text.toLowerCase();
  for (const alias of aliases) {
    // Match the alias as a whole word (e.g. "@ocrcbot") so that a mention of a
    // different bot does not match a prefix alias (@ocrcbot2 must not match @ocrcbot).
    if (new RegExp(`(^|[^\\w])@${escapeRegex(alias)}(?![\\w])`, "i").test(normalizedText)) {
      return true;
    }
  }

  return false;
}

export type CommandContext = {
  accountId: string;
  account: ExistingAccount;
  client: RocketChatClient;
  channelRuntime?: import("../types.js").ChannelRuntimeLike;
  senderName?: string;
  roomId?: string;
  roomType?: import("../types.js").InboundEvent["roomType"];
  limits?: {
    maxAccounts?: number | undefined;
    maxBotsPerServer?: number | undefined;
    botCreationCooldownMs?: number | undefined;
  };
};

export type CommandResult =
  | { action: "reply"; replyText: string; command?: string }
  | { action: "passthrough" }
  | { action: "openclaw-command"; command: string };

/**
 * Commands restricted to the bot owner (`accounts.<id>.owner`). Any other user
 * with access who tries one of these gets a permission reply and the command is
 * never executed or forwarded to OpenClaw.
 */
const OWNER_ONLY_COMMANDS = new Set([
  "add-bot",
  "remove-bot",
  "add-group",
  "revoke",
  "access",
  "bots",
  "email",
  "configure",
]);

function isOwner(ctx: CommandContext): boolean {
  const owner = ctx.account.owner?.trim().replace(/^@+/, "").toLowerCase();
  const actor = ctx.senderName?.trim().replace(/^@+/, "").toLowerCase();
  return !!owner && !!actor && owner === actor;
}

export async function matchCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  const normalized = text
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/^\s*(@\S+\s+)+/, "")
    .trim()
    .replace(/^!\s+/, "!");
  const parsed = CommandParser.parse(normalized);
  if (!parsed) return { action: "passthrough" };
  const result = await runCommand(parsed.command, parsed.raw, ctx);
  return result.action === "reply" ? { ...result, command: parsed.command } : result;
}

async function runCommand(
  cmd: string,
  argStr: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (OWNER_ONLY_COMMANDS.has(cmd) && !isOwner(ctx)) {
    return {
      action: "reply",
      replyText: `\`!${cmd}\` is owner-only. Contact ${ctx.account.owner ? `@${ctx.account.owner}` : "the bot owner"}.`,
    };
  }

  switch (cmd) {
    case "help":
      return { action: "reply", replyText: buildHelpText(isOwner(ctx)) };
    case "access":
      return { action: "reply", replyText: await runAccess(ctx) };
    case "bots":
      return { action: "reply", replyText: runBots() };
    case "groups":
      return { action: "reply", replyText: await runGroups(ctx) };
    case "status":
      return { action: "reply", replyText: await runStatus(ctx) };
    case "add-bot":
      return { action: "reply", replyText: await runAddBot(ctx, argStr) };
    case "lend":
      return { action: "reply", replyText: await runLend(ctx, argStr) };
    case "revoke":
      return { action: "reply", replyText: await runRevoke(ctx, argStr) };
    case "remove-bot":
      return { action: "reply", replyText: await runRemoveBot(ctx, argStr) };
    case "add-group":
      return { action: "reply", replyText: await runAddGroup(ctx, argStr) };
    case "compact":
      return { action: "openclaw-command", command: `/compact${argStr ? " " + argStr : ""}` };
    case "reset":
      return { action: "openclaw-command", command: `/reset${argStr ? " " + argStr : ""}` };
    case "new":
      return { action: "openclaw-command", command: `/new${argStr ? " " + argStr : ""}` };
    case "model":
      return await runModel(argStr);
    case "tools":
      return { action: "openclaw-command", command: `/tools${argStr ? " " + argStr : ""}` };
    case "skill": {
      const skillName = argStr.trim().split(/\s+/)[0] ?? "";
      const owner = isOwner(ctx);
      if (skillName.toLowerCase() === "cron") {
        return { action: "reply", replyText: [CRON_HEADING, CRON_USAGE].join("\n") };
      }
      if (
        (skillName.toLowerCase() === "email" || skillName.toLowerCase() === "configure") &&
        !owner
      ) {
        return {
          action: "reply",
          replyText: `\`!skill ${skillName}\` is owner-only. Contact ${ctx.account.owner ? `@${ctx.account.owner}` : "the bot owner"}.`,
        };
      }
      if (skillName.toLowerCase() === "email") {
        return { action: "reply", replyText: [EMAIL_HEADING, EMAIL_USAGE].join("\n") };
      }
      if (skillName.toLowerCase() === "configure") {
        return { action: "reply", replyText: [CONFIGURE_HEADING, CONFIGURE_USAGE].join("\n") };
      }
      return { action: "openclaw-command", command: `/skill${argStr ? " " + argStr : ""}` };
    }
    case "skills":
      return { action: "reply", replyText: runSkills(isOwner(ctx)) };
    case "cron":
      return { action: "reply", replyText: await runCronCommand(ctx, argStr) };
    case "email":
      return { action: "reply", replyText: await runEmailCommand(ctx, argStr) };
    case "configure":
      return { action: "reply", replyText: runConfigureCommand() };
    case "think":
      return { action: "openclaw-command", command: `/think${argStr ? " " + argStr : ""}` };
    case "abort":
      return { action: "openclaw-command", command: `/abort${argStr ? " " + argStr : ""}` };
    case "reasoning":
      return { action: "openclaw-command", command: `/reasoning${argStr ? " " + argStr : ""}` };
    case "verbose":
      return { action: "openclaw-command", command: `/verbose${argStr ? " " + argStr : ""}` };
    default:
      return {
        action: "reply",
        replyText: `Unknown command \`!${cmd}\`. Type \`!help\` to see available commands.`,
      };
  }
}

function buildHelpText(showAll: boolean): string {
  const groups: Array<[string, Array<[string, string]>]> = [
    [
      "Bot",
      [
        ["help", "this menu"],
        ["status", "gateway status"],
        ["bots", "bots and agents"],
        ["groups", "groups joined by bots"],
        ["access", "who can use"],
        ["add-bot <user>", "create a bot"],
        [
          "remove-bot <user...>",
          "delete bot(s); clears config, creds, agent\ngateway auto-restarts; run `openclaw sessions cleanup` for old sessions",
        ],
        ["add-group <group> [bot]", "invite bot to group"],
        ["lend <group> <user>", "grant group access"],
        ["lend dm <user>", "grant DM access"],
        ["revoke <group> <user>", "revoke group access"],
        ["revoke dm <user>", "revoke DM access"],
      ],
    ],
    [
      "Context",
      [
        ["compact", "compress history"],
        ["reset", "wipe all"],
        ["new [model]", "fresh start"],
      ],
    ],
    [
      "Model",
      [
        ["model", "show current + list"],
        ["model set <name>", "switch model"],
      ],
    ],
    [
      "Behavior",
      [
        ["think <level>", "off, low, medium, high"],
        ["abort", "stop reply"],
        ["reasoning on/off", "show reasoning"],
        ["verbose on/off", "debug details"],
      ],
    ],
    [
      "Tools & Skills",
      [
        ["tools", "list agent tools"],
        ["skills", "installed skills"],
        ["skill <name>", "run a skill"],
      ],
    ],
  ];

  const visibleGroups = groups
    .map(
      ([title, cmds]) =>
        [
          title,
          showAll ? cmds : cmds.filter(([cmd]) => !OWNER_ONLY_COMMANDS.has(cmd.split(/\s/)[0]!)),
        ] as [string, Array<[string, string]>],
    )
    .filter(([, cmds]) => cmds.length > 0);

  const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
  const width = Math.max(
    0,
    ...visibleGroups.flatMap(([, cmds]) => cmds.map(([cmd]) => cmd.length)),
  );

  const descIndent = " ".repeat(width + 5);
  const lines: string[] = ["Rocket.Chat bot commands:"];
  for (const [title, cmds] of visibleGroups) {
    lines.push("", title);
    for (const [cmd, desc] of cmds) {
      const [first, ...rest] = desc.split("\n");
      lines.push(`  ${pad("!" + cmd, width + 1)}  ${first}`);
      for (const cont of rest) {
        lines.push(`${descIndent}${cont}`);
      }
    }
  }
  if (!showAll) lines.push("", "owner-only commands hidden - run as owner to see");
  const footer =
    "\n\n💡 These commands are for quick, small tasks. For better and more precise results, use direct inbound messages.";
  return "```\n" + lines.join("\n") + "\n```" + footer;
}

function shortModelId(full: string): string {
  return full.split("/").pop() ?? full;
}

function getUsableModels(): { current: string; usable: string[] } {
  const defaults = (readConfig() as Record<string, any>)?.agents?.defaults as
    Record<string, any> | undefined;
  const models = (defaults?.models ?? {}) as Record<string, unknown>;
  const usable = Object.keys(models)
    .filter(Boolean)
    .sort((a, b) => {
      const ka = shortModelId(a).toLowerCase();
      const kb = shortModelId(b).toLowerCase();
      return ka.localeCompare(kb) || a.localeCompare(b);
    });
  return { current: readDefaultModel(), usable };
}

function shortIdCounts(usable: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of usable) {
    const s = shortModelId(m);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

function modelLabel(full: string, usable: string[]): string {
  const s = shortModelId(full);
  const counts = shortIdCounts(usable);
  return (counts.get(s) ?? 0) > 1 ? full : s;
}

function matchingModels(requested: string, usable: string[]): string[] {
  const q = requested.trim().toLowerCase();
  if (!q) return [];
  return usable.filter((m) => m.toLowerCase() === q || shortModelId(m).toLowerCase() === q);
}

async function runModel(argStr: string): Promise<CommandResult> {
  const trimmed = argStr.trim();
  const { current, usable } = getUsableModels();

  if (trimmed) {
    const requested = /^set\b/i.test(trimmed) ? trimmed.replace(/^set\b/i, "").trim() : trimmed;
    const matches = matchingModels(requested, usable);
    if (matches.length === 0) {
      return {
        action: "reply",
        replyText: `Unknown model \`${requested}\`. Run \`!model\` to see the usable models.`,
      };
    }
    if (matches.length > 1) {
      return {
        action: "reply",
        replyText:
          `\`${requested}\` matches multiple models. Use one of the full ids: ` +
          matches.map((m) => `\`${m}\``).join(", "),
      };
    }
    const target = matches[0]!;
    if (target === current) {
      return {
        action: "reply",
        replyText: `Already on \`${modelLabel(target, usable)}\`.`,
      };
    }
    setDefaultModel(target);
    return {
      action: "reply",
      replyText:
        `Switched model to \`${modelLabel(target, usable)}\`.\n` +
        "The new default is saved. Start a fresh turn (\`!new\`) for it to apply.",
    };
  }

  if (usable.length === 0) {
    return {
      action: "reply",
      replyText: "No usable models found. Configure providers in openclaw.json first.",
    };
  }

  const lines = [
    "**Model**",
    current ? `- current - ${modelLabel(current, usable)}` : "- current - (not set)",
    "",
    "**Usable**",
    ...usable.map((m) => {
      const label = modelLabel(m, usable);
      const mark = current && current === m ? " (current)" : "";
      return `- \`${label}\`${mark}`;
    }),
    "",
    "Switch: `!model set <name>`",
  ];
  return { action: "reply", replyText: lines.join("\n") };
}

function runBots(): string {
  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    return "No Rocket.Chat bot accounts configured.";
  }
  const lines: string[] = [];
  for (const account of accounts) {
    const mention = account.mentionNames[0] ?? account.accountId;
    const bindings = readBindingsForAccount(account.accountId);
    const disabled = account.enabled === false ? " (disabled)" : "";
    const dead = connectionStatus.get(account.accountId) === "failed" ? " (dead)" : "";
    if (bindings.length === 0) {
      lines.push(`- ${mention}${disabled}${dead} - (no agent bound)`);
      continue;
    }
    for (const binding of bindings) {
      const agent = binding.agentId === `rc-${mention}` ? "" : ` → ${binding.agentId}`;
      lines.push(`- ${mention}${disabled}${dead}${agent}`);
    }
  }

  return ["**Bot accounts**", ...lines].join("\n");
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const fm = fmMatch[1]!;
  const result: { name?: string; description?: string } = {};
  const nameLine = fm.match(/^name:\s*(.+)$/m);
  if (nameLine) result.name = nameLine[1]!.trim().replace(/^["']|["']$/g, "");
  const descLine = fm.match(/^description:\s*(.+)$/m);
  if (descLine) result.description = descLine[1]!.trim().replace(/^["']|["']$/g, "");
  return result;
}

function runSkills(showOwnerOnly: boolean): string {
  const skillsDir = resolve(homedir(), ".openclaw", "skills");
  if (!existsSync(skillsDir)) {
    return "No skills installed (expected at ~/.openclaw/skills).";
  }
  const entries = readdirSync(skillsDir).filter((name) => {
    const full = resolve(skillsDir, name);
    try {
      return statSync(full).isDirectory() || statSync(full).isSymbolicLink();
    } catch {
      return false;
    }
  });
  const skills: Array<{ name: string; description: string }> = [];
  for (const name of entries) {
    const skillMd = resolve(skillsDir, name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let content = "";
    try {
      content = readFileSync(skillMd, "utf8");
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(content);
    if (!fm.name) continue;
    skills.push({ name: fm.name, description: fm.description ?? "" });
  }
  if (skills.length === 0) {
    return "No skills installed (expected at ~/.openclaw/skills).";
  }
  const cap = (s: string, n = 80): string => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);
  const lines = ["**Skills**"];
  const has = (name: string): boolean => skills.some((s) => s.name === name);
  lines.push("", CRON_HEADING, CRON_USAGE);
  if (showOwnerOnly) {
    if (has("email") || has("agentmail")) {
      lines.push("", EMAIL_HEADING, EMAIL_USAGE);
    }
    lines.push("", CONFIGURE_HEADING, CONFIGURE_USAGE);
  }
  for (const s of skills) {
    if (s.name === "cron" || s.name === "email" || s.name === "agentmail") continue;
    if (!showOwnerOnly && s.name === "configure") continue;
    const title = s.name.charAt(0).toUpperCase() + s.name.slice(1);
    lines.push("", `**${title}**`);
    lines.push(`• ${s.description ? cap(s.description) : "No description available."}`);
    lines.push(`• Run with: \`!skill ${s.name}\``);
  }
  return lines.join("\n");
}

async function runGroups(ctx: CommandContext): Promise<string> {
  try {
    const subs = await ctx.client.listSubscriptions(null);
    const rooms = subs
      .filter((s) => s.t === "c" || s.t === "p")
      .map((s) => (s.fname ? `#${s.fname}` : s.name ? `#${s.name}` : ""))
      .filter(Boolean);

    if (rooms.length === 0) {
      return "This bot is not in any groups or channels yet.";
    }
    return ["**Groups this bot is in**", ...rooms.map((r) => `- ${r}`)].join("\n");
  } catch {
    return "Could not load group memberships.";
  }
}

async function runAccess(ctx: CommandContext): Promise<string> {
  const account = ctx.account;
  const mention = account.mentionNames[0] ?? account.accountId;
  const owner = readOwner(account.accountId);

  const store = new AccessStore();
  const grants = store.loadGrants(account.accountId);
  store.close();

  const lines: string[] = [];
  lines.push(`owner - ${owner ? `${owner}` : "(unset)"}`);
  if (grants.length === 0) {
    lines.push("No grants. Only the owner can use the bot.");
  } else {
    const byUser = new Map<string, string[]>();
    for (const grant of grants) {
      const scope =
        grant.roomId === "*"
          ? "everywhere"
          : grant.roomId === DM_SCOPE
            ? "dm"
            : `#${grant.roomName ?? grant.roomId}`;
      const list = byUser.get(grant.username) ?? [];
      list.push(scope);
      byUser.set(grant.username, list);
    }
    for (const [username, scopes] of byUser) {
      lines.push(`- ${username} - ${scopes.join(", ")}`);
    }
  }

  return [`**Access for ${mention}**`, ...lines].join("\n");
}

function adminAuth(ctx: CommandContext): RCLoginResult {
  const { userId, accessToken } = ctx.account.auth;
  return { userId, authToken: accessToken };
}

/**
 * Resolve an admin credential to call privileged APIs (e.g. users.create).
 * Prefers the dedicated admin credential saved during setup; falls back to the
 * bot account's own token if no admin was configured.
 */
async function adminAuthForServer(serverUrl: string, ctx: CommandContext): Promise<RCLoginResult> {
  const admin = await loadAdmin(serverUrl);
  if (admin) return { userId: admin.userId, authToken: admin.authToken };
  return adminAuth(ctx);
}

/**
 * Resolve a group/channel by name on the Rocket.Chat server. Private rooms
 * (`groups.info`) are deliberately hidden from callers that are not members and
 * lack `view-room-administration`, so an insufficient credential produces a false
 * "not found" even though the room exists. Tries the admin credential, then the
 * bot's own token (it is a member of its rooms), then the bot's own
 * subscriptions — which list private rooms it belongs to. Reasons are appended
 * to `reasons` when a lookup fails, so callers can tell "missing" from "denied".
 */
async function resolveGroupByName(
  ctx: CommandContext,
  auth: RCLoginResult,
  groupName: string,
  reasons?: string[],
): Promise<RocketChatGroup | null> {
  let group = await getGroupByName(ctx.account.serverUrl, auth, groupName, reasons);
  if (group) return group;
  const botAuth = adminAuth(ctx);
  if (botAuth.userId !== auth.userId) {
    group = await getGroupByName(ctx.account.serverUrl, botAuth, groupName, reasons);
  }
  if (group) return group;
  return resolveGroupFromSubscriptions(ctx, groupName, reasons);
}

/** Find a subscribed room (private or public) by name via the bot's own subscriptions. */
async function resolveGroupFromSubscriptions(
  ctx: CommandContext,
  groupName: string,
  reasons?: string[],
): Promise<RocketChatGroup | null> {
  const normalized = normalizeRoomName(groupName);
  try {
    const subs = await ctx.client.listSubscriptions(null);
    const match = subs.find(
      (s) =>
        s.rid &&
        !s.prid &&
        (s.t === "p" || s.t === "c") &&
        s.name !== undefined &&
        normalizeRoomName(s.name) === normalized,
    );
    if (match) {
      return { _id: match.rid, name: match.name ?? groupName, isPrivate: match.t === "p" };
    }
    const disc = subs.find(
      (s) =>
        s.rid &&
        s.prid &&
        (normalizeRoomName(s.name ?? "") === normalized ||
          normalizeRoomName(s.fname ?? "") === normalized),
    );
    if (disc) {
      reasons?.push("/api/v1/subscriptions.get: discussion");
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse `key value --flag value` style args into a positional list + flags map. */
function parseArgs(argStr: string): { positional: string[]; flags: Record<string, string> } {
  const tokens = argStr.trim().length ? argStr.trim().split(/\s+/) : [];
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

async function runStatus(ctx: CommandContext): Promise<string> {
  const mention = ctx.account.mentionNames[0] ?? ctx.account.accountId;
  const gateway =
    connectionStatus.get(ctx.account.accountId) ??
    (activeClients.has(ctx.account.accountId) ? "online" : "stopped");
  const bindings = readBindingsForAccount(ctx.account.accountId);
  const agent = bindings[0]?.agentId ?? "(unbound)";
  const runtime = ctx.channelRuntime ? "ready" : "unavailable";
  return [
    "**Status**",
    `- gateway - ${gateway}`,
    `- bot - ${mention}`,
    `- agent - ${agent}`,
    `- runtime - ${runtime}`,
  ].join("\n");
}

async function runAddBot(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional, flags } = parseArgs(argStr);
  const username = positional[0];
  if (!username) {
    return [
      'Usage: !add-bot <username> [--name "..."] [--email ...] [--agent <id>]',
      "Creates a bot with its own agent (rc-<username>); --agent binds a shared one.",
      "A random password is generated and shown once. The bot comes online automatically.",
    ].join("\n");
  }

  const name = flags.name ?? username;
  const email = flags.email ?? `${username.toLowerCase()}@openclaw.local`;
  const password = randomToken(16);

  let agent: string;
  let agentNote = "";
  if (flags.agent) {
    agent = flags.agent;
  } else {
    const result = ensureAgentForBot(username);
    agent = result.agentId;
    if (result.fallback) {
      agentNote = ` (agent auto-creation failed: ${result.reason ?? "unknown error"} - bound to 'main'; memory is still isolated per-bot via session keys)`;
    } else if (result.created) {
      agentNote = ` (auto-created dedicated agent '${agent}')`;
    }
  }

  try {
    const limitCheck = checkBotCreationLimit("inline", {
      serverUrl: ctx.account.serverUrl,
      maxAccounts: ctx.limits?.maxAccounts,
      maxBotsPerServer: ctx.limits?.maxBotsPerServer,
      cooldownMs: ctx.limits?.botCreationCooldownMs,
    });
    if (!limitCheck.allowed) {
      return limitCheck.reason ?? "Bot creation limit reached.";
    }

    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);

    const existingServer = await getUserInfo(ctx.account.serverUrl, auth, { username });
    const existingConfig = readAccount(username.toLowerCase());
    if (existingServer) {
      return `Bot ${username} already exists on the Rocket.Chat server. Use \`!remove-bot ${username}\` first if you want to recreate it.`;
    }
    if (existingConfig) {
      return `Bot ${username} already exists in OpenClaw config. Use \`!remove-bot ${username}\` first if you want to recreate it.`;
    }

    await createBotUser(ctx.account.serverUrl, auth, { username, name, password, email });
    const botAuth = await loginAs(ctx.account.serverUrl, username, password);
    recordBotCreation(username, "inline");
    const accountId = username;

    addAccount({
      accountId,
      serverUrl: ctx.account.serverUrl,
      auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken } as TokenAuth,
      mentionNames: [username],
      ...(ctx.account.owner ? { owner: ctx.account.owner } : {}),
    });
    addBinding({ channel: "rocketchat", accountId, agentId: agent });

    const owner = ctx.account.owner?.trim().replace(/^@+/, "") || undefined;

    let dmNote = "";
    if (owner) {
      try {
        const dmRoom = await createDirectMessage(ctx.account.serverUrl, botAuth, owner);
        await sendMessage(
          ctx.account.serverUrl,
          botAuth,
          dmRoom,
          `Hi! I'm ${username}, your new Rocket.Chat bot connected to OpenClaw (agent \`${agent}\`). ` +
            `Once you see status online, confirm with \`!status\` or \`!help\` to know more.`,
        );
        dmNote = `Welcome DM sent to ${owner}.`;
      } catch (e: unknown) {
        dmNote = `Could not DM ${owner}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    void startBotAccount(ctx, {
      accountId,
      serverUrl: ctx.account.serverUrl,
      auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
      ...(owner ? { owner } : {}),
      agent,
    });

    return [
      `**Created bot ${username}**`,
      `agent - ${agent}${agentNote}`,
      `password (shown once) - \`${password}\``,
      ...(dmNote ? [dmNote] : []),
    ].join("\n");
  } catch (e: unknown) {
    return `Failed to create bot: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Bring a freshly created bot account online immediately (hot-start), without a full OpenClaw restart. */
function startBotAccount(
  ctx: CommandContext,
  account: {
    accountId: string;
    serverUrl: string;
    auth: { mode: "token"; userId: string; accessToken: string };
    owner?: string;
    agent: string;
  },
): void {
  const controller = new AbortController();
  const botCtx = {
    accountId: account.accountId,
    account: {
      accountId: account.accountId,
      enabled: true,
      serverUrl: account.serverUrl,
      auth: account.auth,
      transport: { mode: "websocket" as const },
      mentionNames: [account.accountId],
      ...(account.owner ? { owner: account.owner } : {}),
    },
    channelRuntime: ctx.channelRuntime,
    abortSignal: controller.signal,
    setStatus: (status: string) =>
      console.log(`[RC] [rocketchat:${account.accountId}] hot-start: ${status}`),
  };
  startGateway(botCtx as Parameters<typeof startGateway>[0]).catch((err) =>
    console.error(
      `[RC] [rocketchat:${account.accountId}] hot-start failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

/**
 * Notify the affected user about a lend/revoke. The notice is always sent
 * via DM to the user so that group chats only show the command reply, not a
 * second personal notification. Returns an error note to append to the
 * command reply if the notice could not be delivered.
 */
async function notifyAccessChange(
  ctx: CommandContext,
  cleanUser: string,
  roomId: string,
  scopeLabel: string,
  action: "granted" | "revoked",
  targetIsBot: boolean,
): Promise<string | undefined> {
  const botMention = ctx.account.mentionNames[0] ?? ctx.accountId;
  const how =
    roomId === DM_SCOPE ? "You can now DM the bot." : "You can now mention the bot there.";
  const text =
    action === "granted"
      ? `You've been granted access to ${botMention} in ${scopeLabel}. ${how}`
      : `Your access to ${botMention} in ${scopeLabel} has been revoked.`;
  try {
    const botAuth = adminAuth(ctx);
    const dmRoomId = await createDirectMessage(ctx.account.serverUrl, botAuth, cleanUser);
    await ctx.client.postMessage(dmRoomId, text);
    return undefined;
  } catch (e: unknown) {
    return ` (notice to ${cleanUser} failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

async function runLend(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional, flags } = parseArgs(argStr);
  const wantDm = flags.dm === "true";
  let groupName: string | undefined;
  let username: string | undefined;
  if (positional[0]?.toLowerCase() === "dm") {
    username = positional[1];
    groupName = undefined;
  } else if (wantDm) {
    username = positional[0];
    groupName = undefined;
  } else {
    groupName = positional[0];
    username = positional[1];
  }
  if (!username)
    return [
      "Usage:",
      "  `!lend <group> <user>` - grant group/channel access",
      "  `!lend dm <user>` (or `!lend <user> --dm`) - grant DM access only",
    ].join("\n");

  const cleanUser = username.replace(/^@+/, "");

  try {
    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);
    const targetUser = await getUserInfo(ctx.account.serverUrl, auth, { username: cleanUser });
    if (!targetUser) return `User ${cleanUser} not found on the Rocket.Chat server.`;

    let roomId: string;
    let roomName: string;
    if (groupName) {
      const reasons: string[] = [];
      const group = await resolveGroupByName(ctx, auth, groupName, reasons);
      if (!group) return groupNotFoundText(groupName, reasons);
      roomId = group._id;
      roomName = group.name;
    } else {
      roomId = DM_SCOPE;
      roomName = "direct";
    }

    const denial = assertCanDelegate(ctx, roomId);
    if (denial) return denial;

    const store = new AccessStore();
    const ok = store.addGrant({
      accountId: ctx.accountId,
      roomId,
      roomName,
      username: cleanUser,
      ...(ctx.account.owner ? { grantedBy: ctx.account.owner } : {}),
    });
    store.close();

    const scope = roomId === DM_SCOPE ? "direct messages" : `#${roomName}`;
    if (ok) {
      const notice = await notifyAccessChange(
        ctx,
        cleanUser,
        roomId,
        scope,
        "granted",
        !!targetUser.roles?.includes("bot"),
      );
      return `Granted ${cleanUser} access to ${ctx.account.mentionNames[0] ?? ctx.accountId} in ${scope}.${notice ?? ""}`;
    }
    return `That grant already exists.`;
  } catch (e: unknown) {
    return `Failed to lend: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function runRevoke(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional, flags } = parseArgs(argStr);
  const wantDm = flags.dm === "true";
  let groupName: string | undefined;
  let username: string | undefined;
  if (positional[0]?.toLowerCase() === "dm") {
    username = positional[1];
    groupName = undefined;
  } else if (wantDm) {
    username = positional[0];
    groupName = undefined;
  } else {
    groupName = positional[0];
    username = positional[1];
  }
  if (!username)
    return [
      "Usage:",
      "  `!revoke <group> <user>` - remove a user's group/channel access",
      "  `!revoke dm <user>` (or `!revoke <user> --dm`) - remove a user's DM access",
    ].join("\n");

  const cleanUser = username.replace(/^@+/, "");

  try {
    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);
    const targetUser = await getUserInfo(ctx.account.serverUrl, auth, { username: cleanUser });
    if (!targetUser) return `User ${cleanUser} not found on the Rocket.Chat server.`;

    let roomId: string;
    let roomName: string;
    if (groupName) {
      const reasons: string[] = [];
      const group = await resolveGroupByName(ctx, auth, groupName, reasons);
      if (group) {
        roomId = group._id;
        roomName = group.name;
      } else {
        // The group can't be resolved via the API (private room with insufficient
        // credentials, archived, renamed, or deleted). Fall back to the persisted
        // grant, which carries the same roomName that `!access` displays.
        const store = new AccessStore();
        const grants = store.loadGrants(ctx.accountId);
        store.close();
        const match = grants.find(
          (g) =>
            g.username.toLowerCase() === cleanUser.toLowerCase() &&
            g.roomName !== undefined &&
            normalizeRoomName(g.roomName) === normalizeRoomName(groupName),
        );
        if (!match) return groupNotFoundText(groupName, reasons);
        roomId = match.roomId;
        roomName = match.roomName ?? groupName;
      }
    } else {
      roomId = DM_SCOPE;
      roomName = "direct";
    }

    const store = new AccessStore();
    const ok = store.removeGrant({
      accountId: ctx.accountId,
      roomId,
      username: cleanUser,
      ...(ctx.account.owner ? { revokedBy: ctx.account.owner } : {}),
    });
    store.close();

    const scope = roomId === DM_SCOPE ? "direct messages" : `#${roomName}`;
    if (ok) {
      const notice = await notifyAccessChange(
        ctx,
        cleanUser,
        roomId,
        scope,
        "revoked",
        !!targetUser.roles?.includes("bot"),
      );
      return `Revoked ${cleanUser}'s access to ${ctx.account.mentionNames[0] ?? ctx.accountId} in ${scope}.${notice ?? ""}`;
    }
    return `No such grant found. ${cleanUser} did not have access in ${scope}.`;
  } catch (e: unknown) {
    return `Failed to revoke: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Non-owners may only delegate access within scopes where they themselves hold a grant.
 * Returns an error string when delegation is not allowed, otherwise undefined.
 */
function assertCanDelegate(ctx: CommandContext, roomId: string): string | undefined {
  const owner = ctx.account.owner?.trim().replace(/^@+/, "").toLowerCase();
  const actor = ctx.senderName?.trim().replace(/^@+/, "").toLowerCase();
  if (!actor || actor === owner) return undefined;

  const store = new AccessStore();
  const actorGrants = store.loadGrants(ctx.accountId);
  store.close();

  const allowed = actorGrants.some((g) => {
    const gu = g.username.trim().replace(/^@+/, "").toLowerCase();
    if (gu !== actor) return false;
    if (roomId === DM_SCOPE) return g.roomId === DM_SCOPE;
    return g.roomId === "*" || g.roomId === roomId;
  });

  return allowed ? undefined : "You can only grant access in spaces where you already have access.";
}

async function runRemoveBot(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const usernames = positional.map((p) => p.trim().replace(/^@+/, "")).filter(Boolean);
  if (usernames.length === 0)
    return "Usage: `!remove-bot <username...>` - delete one or more bot accounts (server user + OpenClaw config). Clears config, creds & agent; gateway auto-restarts. Optional: run `openclaw sessions cleanup` to also purge old shared-agent sessions.";

  try {
    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);
    const blocks: string[] = [];
    let removedCount = 0;

    for (const username of usernames) {
      const result = await removeSingleBot(ctx, auth, username);
      if (result.removed) removedCount++;
      blocks.push(result.text);
    }

    return [`**Removed ${removedCount}/${usernames.length} bot(s)**`, ...blocks].join("\n");
  } catch (e: unknown) {
    return `Failed to remove bot(s): ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function removeSingleBot(
  ctx: CommandContext,
  auth: RCLoginResult,
  username: string,
): Promise<{ removed: boolean; text: string }> {
  const configured = readAccount(username);
  const onServer = await getUserInfo(ctx.account.serverUrl, auth, { username });
  if (!configured && !onServer) {
    return {
      removed: false,
      text: `- ${username}: not found on server or in OpenClaw config. Skipped.`,
    };
  }

  activeClients.delete(username);

  let serverNote = "";
  try {
    await deleteUser(ctx.account.serverUrl, auth, username);
    serverNote = "Rocket.Chat user deleted.";
  } catch (e: unknown) {
    serverNote = `Could not delete Rocket.Chat user: ${e instanceof Error ? e.message : String(e)}`;
  }

  const existingBindings = readBindingsForAccount(username);
  const boundAgent = existingBindings[0]?.agentId;
  const ownsDedicatedAgent = boundAgent === `rc-${username}`;

  const steps: string[] = [];

  try {
    removeBindingsForAccount(username);
    steps.push("OpenClaw binding removed");
  } catch (e: unknown) {
    steps.push(`binding cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    removeAccount(username);
    steps.push("OpenClaw account removed");
  } catch (e: unknown) {
    steps.push(`account cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let credNote = "kept no credentials (none stored)";
  try {
    if (await removeBotCredentials(username)) {
      credNote = "local credentials deleted";
    } else {
      credNote = "no local credential file found";
    }
  } catch (e: unknown) {
    credNote = `credential cleanup failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  steps.push(credNote);

  if (ownsDedicatedAgent) {
    try {
      removeAgentDir(username);
      steps.push(`workspace \`rc-${username}\` removed`);
    } catch (e: unknown) {
      steps.push(`workspace cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    steps.push(`kept shared agent \`${boundAgent}\``);
  }

  const trims = [serverNote, ...steps].join(", ");

  return { removed: true, text: `- ${username}: ${trims}.` };
}

async function runAddGroup(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const groupName = positional[0]?.trim().replace(/^#+/, "");
  const botName =
    positional[1]?.trim().replace(/^@+/, "") || ctx.account.mentionNames[0] || ctx.accountId;
  if (!groupName)
    return "Usage: `!add-group <group> [<bot>]` - invite a bot into a group/channel (defaults to this bot)";

  try {
    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);

    const botExists = await getUserInfo(ctx.account.serverUrl, auth, { username: botName });
    if (!botExists) {
      return `Bot ${botName} not found on the Rocket.Chat server. Use \`!add-bot ${botName}\` to create it first.`;
    }
    const botConfigured = readAccount(botName.toLowerCase());
    if (!botConfigured) {
      return `${botName} exists on the server but is not configured in OpenClaw. Use \`!add-bot ${botName}\` to set it up.`;
    }

    const reasons: string[] = [];
    const group = await resolveGroupByName(ctx, auth, groupName, reasons);
    if (!group) return groupNotFoundText(`#${groupName}`, reasons);

    const isPrivate = group.isPrivate;

    const members = await listGroupMembers(ctx.account.serverUrl, auth, group._id);
    const alreadyIn = members.some((m) => m.username.toLowerCase() === botName.toLowerCase());
    if (alreadyIn) {
      return `${botName} is already a member of #${group.name}. No action needed.`;
    }

    try {
      await inviteToGroup(ctx.account.serverUrl, auth, group._id, botName, isPrivate);
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      const denied = /not.authorized|not-authorized|forbidden|permission/i.test(err);
      return denied
        ? `Can't add ${botName} to #${group.name}: the ${isPrivate ? "admin" : "acting"} account lacks invite permission for this ${isPrivate ? "private group" : "channel"}. Ensure that account is a member or has the right to invite (${err}).`
        : `Failed to add ${botName} to #${group.name}: ${err}`;
    }

    return `Invited ${botName} to #${group.name}${isPrivate ? " (private group)" : " (channel)"}. The bot will start receiving messages there.`;
  } catch (e: unknown) {
    return `Failed to add bot to group: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function randomToken(length: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
