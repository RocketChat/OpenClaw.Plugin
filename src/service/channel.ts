import type { InboundEvent } from "../types.js";
import type { ChannelRuleOptions } from "../types.js";
import { DM_SCOPE } from "../utils.js";
import { RocketChatClient } from "../client/rest.js";
import type { RCLoginResult } from "../types.js";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
import {
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
} from "../cli/admin-api.js";
import { checkBotCreationLimit, recordBotCreation } from "../cli/rate-limiter.js";
import { loadAdmin } from "../cli/credentials.js";
import { startGateway } from "./gateway.js";
import { activeClients, connectionStatus } from "./runtime-state.js";
import { AccessStore } from "../config/access-store.js";

const BROADCAST_MENTIONS = new Set(["here", "all", "everyone"]);

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
    if (normalizedText.includes(`@${alias}`)) return true;
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
  | { action: "reply"; replyText: string }
  | { action: "passthrough" }
  | { action: "openclaw-command"; command: string };

const COMMAND_RE = /^\s*!(\S+)(?:\s+([\s\S]*))?$/i;

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
  const match = normalized.match(COMMAND_RE);
  if (!match) return { action: "passthrough" };
  const cmd = match[1]!.toLowerCase();
  const argStr = match[2] ?? "";

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
      return { action: "openclaw-command", command: `/model${argStr ? " " + argStr : ""}` };
    case "tools":
      return { action: "openclaw-command", command: `/tools${argStr ? " " + argStr : ""}` };
    case "skill":
      return { action: "openclaw-command", command: `/skill${argStr ? " " + argStr : ""}` };
    case "skills":
      return { action: "reply", replyText: runSkills() };
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
        ["remove-bot <user...>", "delete bot(s)"],
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
    ["Model", [["model", "show current + list"], ["model <name>", "switch model"]]],
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
  const width = Math.max(0, ...visibleGroups.flatMap(([, cmds]) => cmds.map(([cmd]) => cmd.length)));

  const lines: string[] = ["Rocket.Chat bot commands:"];
  for (const [title, cmds] of visibleGroups) {
    lines.push("", title);
    for (const [cmd, desc] of cmds) {
      lines.push(`  ${pad("!" + cmd, width + 1)}  ${desc}`);
    }
  }
  if (!showAll) lines.push("", "owner-only commands hidden - run as owner to see");
  lines.push("", "Tip: run !skill <name> to use a skill");
  return "```\n" + lines.join("\n") + "\n```";
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
    if (bindings.length === 0) {
      lines.push(`- ${mention}${disabled} - (no agent bound)`);
      continue;
    }
    for (const binding of bindings) {
      const agent = binding.agentId === `rc-${mention}` ? "" : ` → ${binding.agentId}`;
      lines.push(`- ${mention}${disabled}${agent}`);
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

/**
 * Skills listed in `.skillsignore` (plugin root) are hidden from the `!skills`
 * menu. One name per line; `#` starts a comment. Editing the file needs no rebuild
 * of plugin logic — only a gateway restart to re-read it.
 */
function loadHiddenSkills(): Set<string> {
  const file = resolve(PLUGIN_ROOT, ".skillsignore");
  const hidden = new Set<string>();
  try {
    if (!existsSync(file)) return hidden;
    const content = readFileSync(file, "utf8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      hidden.add(line);
    }
  } catch {
    // ignore — show all skills if the ignore file can't be read
  }
  return hidden;
}

function runSkills(): string {
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
  const hidden = loadHiddenSkills();
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
    if (hidden.has(fm.name) || hidden.has(name)) continue;
    skills.push({ name: fm.name, description: fm.description ?? "" });
  }
  if (skills.length === 0) {
    return "No skills installed (expected at ~/.openclaw/skills).";
  }
  const cap = (s: string, n = 80): string => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);
  const lines = ["Skills"];
  for (const s of skills) {
    lines.push(`- \`!skill ${s.name}\`${s.description ? ` - ${cap(s.description)}` : ""}`);
  }
  lines.push("", "Run a skill: `!skill <name>`");
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
    // Group grants per user so a user with both group + DM access shows on one line.
    const byUser = new Map<string, string[]>();
    for (const grant of grants) {
      const scope =
        grant.roomId === "*"
          ? "everywhere (group + dm)"
          : grant.roomId === DM_SCOPE
            ? "dm"
            : `group: #${grant.roomName ?? grant.roomId}`;
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
      const group = await getGroupByName(ctx.account.serverUrl, auth, groupName);
      if (!group) return `Group "${groupName}" not found.`;
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
      const group = await getGroupByName(ctx.account.serverUrl, auth, groupName);
      if (!group) return `Group "${groupName}" not found.`;
      roomId = group._id;
      roomName = group.name;
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
    return "Usage: `!remove-bot <username...>` - delete one or more bot accounts (server user + OpenClaw config)";

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

  removeBindingsForAccount(username);
  removeAccount(username);
  if (ownsDedicatedAgent) {
    removeAgentDir(username);
  }

  const trims = [
    serverNote,
    "account+binding removed",
    ownsDedicatedAgent
      ? `workspace \`rc-${username}\` removed`
      : `kept shared agent \`${boundAgent}\``,
  ].join(", ");
  return { removed: true, text: `- ${username}: ${trims}` };
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

    const group = await getGroupByName(ctx.account.serverUrl, auth, groupName);
    if (!group) return `Group/channel "#${groupName}" not found.`;

    const isPrivate = group.isPrivate;

    const members = await listGroupMembers(ctx.account.serverUrl, auth, group._id);
    const alreadyIn = members.some((m) => m.username.toLowerCase() === botName.toLowerCase());
    if (alreadyIn) {
      return `${botName} is already a member of #${group.name}. No action needed.`;
    }

    try {
      await inviteToGroup(ctx.account.serverUrl, auth, group._id, botName, isPrivate);
    } catch (e: unknown) {
      return `Failed to add ${botName} to #${group.name}: ${e instanceof Error ? e.message : String(e)}`;
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
