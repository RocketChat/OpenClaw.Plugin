import type { InboundEvent } from "../types.js";
import type { ChannelRuleOptions } from "../types.js";
import { RocketChatClient } from "../client/rest.js";
import type { RCLoginResult } from "../types.js";
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
  checkServerHealth,
  createDirectMessage,
  sendMessage,
  deleteUser,
  inviteToGroup,
  listGroupMembers,
} from "../cli/admin-api.js";
import { loadAdmin } from "../cli/credentials.js";
import { startGateway, activeClients } from "./gateway.js";
import { AccessStore } from "../config/access-store.js";

const BROADCAST_MENTIONS = new Set(["here", "all", "everyone"]);

export function shouldHandleInboundEvent(
  event: InboundEvent,
  options: ChannelRuleOptions,
): boolean {
  if (event.senderId === options.botUserId) {
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
};

export type CommandResult = { action: "reply"; replyText: string } | { action: "passthrough" };

const COMMAND_RE = /^\s*!(\S+)(?:\s+([\s\S]*))?$/i;

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

  switch (cmd) {
    case "help":
      return { action: "reply", replyText: buildHelpText() };
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
    case "bindings":
      return { action: "reply", replyText: buildBindingsHelpText() };
    case "lend":
      return { action: "reply", replyText: await runLend(ctx, argStr) };
    case "revoke":
      return { action: "reply", replyText: await runRevoke(ctx, argStr) };
    case "remove-bot":
      return { action: "reply", replyText: await runRemoveBot(ctx, argStr) };
    case "add-group":
      return { action: "reply", replyText: await runAddGroup(ctx, argStr) };
    default:
      return {
        action: "reply",
        replyText: `Unknown command \`!${cmd}\`. Type \`!help\` to see available commands.`,
      };
  }
}

function buildHelpText(): string {
  return [
    "**OpenClaw commands**",
    "",
    "- `!help` - show this message",
    "- `!status` - server/bot/agent status",
    "- `!bots` - list bot accounts and their agent bindings",
    "- `!groups` - list groups this bot is in",
    "- `!access` - who can use this bot and where",
    "- `!add-bot <username>` - create a new bot (comes online + DMs you, no restart)",
    "- `!remove-bot <username>` - delete a bot account (server user + config)",
    "- `!add-group <group> [<bot>]` - invite a bot into a group/channel (defaults to this bot)",
    "- `!lend <group> <user>` - grant a user access to this bot in a group",
    "- `!revoke <group> <user>` - remove a user's access to this bot in a group",
    "- `!bindings` - how to manage agents/bindings via OpenClaw CLI (official docs)",
    "",
    "Agent/model binding is managed by OpenClaw itself (see docs: openclaw.ai/cli/agents).",
  ].join("\n");
}

function buildBindingsHelpText(): string {
  return [
    "**Agent & bindings (managed by OpenClaw CLI)**",
    "This plugin does not manage agents/bindings - use the official OpenClaw commands:",
    "",
    "List agents + bindings:",
    "  `openclaw agents list --bindings`",
    "",
    "Add a new agent:",
    "  `openclaw agents add <id>`",
    "",
    "Set agent identity (name/emoji/avatar):",
    '  `openclaw agents set-identity --agent <id> --name "..."`',
    "",
    "Check channel connectivity:",
    "  `openclaw channels status --probe`",
    "",
    "Restart the gateway (apply binding changes):",
    "  `openclaw gateway restart`",
    "",
    "Docs:",
    "- Agents CLI: https://docs.openclaw.ai/cli/agents",
    "- Multi-agent routing: https://docs.openclaw.ai/concepts/multi-agent",
    "- Models: https://docs.openclaw.ai/concepts/models",
  ].join("\n");
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
    if (bindings.length === 0) {
      lines.push(`- @${mention} - (no agent bound)`);
      continue;
    }
    for (const binding of bindings) {
      const scope = binding.peer ? `${binding.peer.kind} ${binding.peer.id}` : "global";
      lines.push(`- @${mention} → ${binding.agentId} (${scope})`);
    }
  }

  return ["**Bot accounts**", ...lines].join("\n");
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
  lines.push(`owner - ${owner ? `@${owner}` : "(unset)"}`);
  if (grants.length === 0) {
    lines.push("No grants. Only the owner can use the bot.");
  } else {
    for (const grant of grants) {
      const where = grant.roomId === "*" ? "everywhere" : `#${grant.roomName ?? grant.roomId}`;
      lines.push(`- @${grant.username} - ${where}`);
    }
  }

  return [`**Access for @${mention}**`, ...lines].join("\n");
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
  const online = await checkServerHealth(ctx.account.serverUrl);
  const bindings = readBindingsForAccount(ctx.account.accountId);
  const agent = bindings[0]?.agentId ?? "(unbound)";
  const server = ctx.account.serverUrl;
  return [
    "**Status**",
    `- server - ${online ? "online" : "offline"} (${server})`,
    `- bot - @${mention}`,
    `- agent - ${agent}`,
  ].join("\n");
}

async function runAddBot(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional, flags } = parseArgs(argStr);
  const username = positional[0];
  if (!username) {
    return [
      "**Create a new bot user**",
      'Usage: `!add-bot <username> [--name "..."] [--email ...] [--agent <id>]`',
      "",
      "Examples:",
      "  `!add-bot alice` - quick create; auto-creates a dedicated agent `rc-alice`",
      '  `!add-bot alice --name "Alice Smith" --email alice@example.com --agent support`',
      "",
      "By default each bot gets its own dedicated agent (`rc-<username>`), so memory is isolated. " +
        "Pass `--agent <id>` to bind the bot to an existing shared agent instead (e.g. `main`, `work`).",
      "",
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
      return [
        `Created bot @${username}, but could not auto-create a dedicated agent.`,
        `Falling back to 'main' - memory is isolated per-bot via session keys, but the bot shares the main agent workspace.`,
      ].join("\n");
    }
    if (result.created) {
      agentNote = ` (auto-created dedicated agent '${agent}')`;
    }
  }

  try {
    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);
    await createBotUser(ctx.account.serverUrl, auth, { username, name, password, email });
    const botAuth = await loginAs(ctx.account.serverUrl, username, password);
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
          `Hi! I'm @${username}, your new Rocket.Chat bot connected to OpenClaw (agent \`${agent}\`). ` +
            `Once you see status online, confirm with \`!status\` or \`!help\` to know more.`,
        );
        dmNote = `Welcome DM sent to @${owner}.`;
      } catch (e: unknown) {
        dmNote = `Could not DM @${owner}: ${e instanceof Error ? e.message : String(e)}`;
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
      `**Created bot @${username}**`,
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

async function runLend(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const groupName = positional[0];
  const username = positional[1];
  if (!groupName || !username)
    return "Usage: `!lend <group> <user>` - grant a user access to this bot in a group";

  try {
    const auth = adminAuth(ctx);
    const group = await getGroupByName(ctx.account.serverUrl, auth, groupName);
    if (!group) return `Group "${groupName}" not found.`;

    const store = new AccessStore();
    const ok = store.addGrant({
      accountId: ctx.accountId,
      roomId: group._id,
      roomName: group.name,
      username: username.replace(/^@+/, ""),
      ...(ctx.account.owner ? { grantedBy: ctx.account.owner } : {}),
    });
    store.close();

    return ok
      ? `Granted @${username.replace(/^@+/, "")} access to @${ctx.account.mentionNames[0] ?? ctx.accountId} in #${group.name}.`
      : `That grant already exists.`;
  } catch (e: unknown) {
    return `Failed to lend: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function runRevoke(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const groupName = positional[0];
  const username = positional[1];
  if (!groupName || !username)
    return "Usage: `!revoke <group> <user>` - remove a user's access to this bot in a group";

  try {
    const auth = adminAuth(ctx);
    const group = await getGroupByName(ctx.account.serverUrl, auth, groupName);
    if (!group) return `Group "${groupName}" not found.`;

    const store = new AccessStore();
    const ok = store.removeGrant({
      accountId: ctx.accountId,
      roomId: group._id,
      username: username.replace(/^@+/, ""),
      ...(ctx.account.owner ? { revokedBy: ctx.account.owner } : {}),
    });
    store.close();

    return ok
      ? `Revoked @${username.replace(/^@+/, "")}'s access to @${ctx.account.mentionNames[0] ?? ctx.accountId} in #${group.name}.`
      : `No such grant found.`;
  } catch (e: unknown) {
    return `Failed to revoke: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function runRemoveBot(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const username = positional[0]?.trim().replace(/^@+/, "");
  if (!username)
    return "Usage: `!remove-bot <username>` - delete a bot account (server user + OpenClaw config)";

  try {
    const auth = await adminAuthForServer(ctx.account.serverUrl, ctx);

    const live = activeClients.get(username);
    if (live) {
      try {
        live.wakeup();
      } catch {
        /* no-op */
      }
      activeClients.delete(username);
    }

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

    return [
      `**Removed bot @${username}**`,
      `- ${serverNote}`,
      `- OpenClaw config account + agent binding removed.`,
      ownsDedicatedAgent
        ? `- Agent workspace \`rc-${username}\` removed.`
        : `- Kept shared agent \`${boundAgent}\` (bot was not its owner).`,
    ].join("\n");
  } catch (e: unknown) {
    return `Failed to remove bot: ${e instanceof Error ? e.message : String(e)}`;
  }
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

    const group = await getGroupByName(ctx.account.serverUrl, auth, groupName);
    if (!group) return `Group/channel "#${groupName}" not found.`;

    const isPrivate = group.isPrivate;

    const members = await listGroupMembers(ctx.account.serverUrl, auth, group._id);
    const alreadyIn = members.some((m) => m.username.toLowerCase() === botName.toLowerCase());
    if (alreadyIn) {
      return `@${botName} is already a member of #${group.name}. No action needed.`;
    }

    try {
      await inviteToGroup(ctx.account.serverUrl, auth, group._id, botName, isPrivate);
    } catch (e: unknown) {
      return `Failed to add @${botName} to #${group.name}: ${e instanceof Error ? e.message : String(e)}`;
    }

    return `Invited @${botName} to #${group.name}${isPrivate ? " (private group)" : " (channel)"}. The bot will start receiving messages there.`;
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
