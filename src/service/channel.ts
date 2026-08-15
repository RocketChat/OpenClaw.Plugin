import type { InboundEvent } from "../types.js";
import type { ChannelRuleOptions } from "../types.js";
import type { RocketChatClient } from "../client/rest.js";
import type { RCLoginResult } from "../types.js";
import {
  readAllAccounts,
  readBindingsForAccount,
  readOwner,
  readAccount,
  addAccount,
  addBinding,
  removeBindingsForAccount,
  type ExistingAccount,
  type TokenAuth,
} from "../cli/config-updater.js";
import {
  createBotUser,
  loginAs,
  getGroupByName,
  checkServerHealth,
} from "../cli/admin-api.js";
import { loadAdmin } from "../cli/credentials.js";
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
};

export type CommandResult =
  | { action: "reply"; replyText: string }
  | { action: "passthrough" };

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
    case "bind":
      return { action: "reply", replyText: await runBind(ctx, argStr) };
    case "lend":
      return { action: "reply", replyText: await runLend(ctx, argStr) };
    case "revoke":
      return { action: "reply", replyText: await runRevoke(ctx, argStr) };
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
    "- `!help` — show this message",
    "- `!status` — server/bot/agent status",
    "- `!bots` — list bot accounts and their agent bindings",
    "- `!groups` — list groups this bot is in",
    "- `!access` — who can use this bot and where",
    "- `!add-bot <username>` — create a new bot user (uses saved admin creds)",
    "- `!bind <agent>` — rebind this bot to a different agent/model",
    "- `!lend <group> <user>` — grant a user access to this bot in a group",
    "- `!revoke <group> <user>` — remove a user's access to this bot in a group",
    "",
    "**`!add-bot` — create a new bot user**",
    "Creates a real Rocket.Chat bot account using the admin credentials saved during setup,",
    "then connects it to OpenClaw and binds it to an agent.",
    "",
    "Format:",
    "  `!add-bot <username>`",
    "",
    "Example:",
    "  `!add-bot nicebot`",
    "",
    "Defaults used automatically: display name = username, email = `<username>@openclaw.local`,",
    "agent = `main`, and a random password is generated and shown once.",
    "Optional flags: `--name`, `--email`, `--agent` (e.g. `!add-bot nicebot --agent support`).",
    "",
    "After a bot is created you must **restart OpenClaw** for the new account to come online.",
    "The auto-generated password is shown only once — save it if you need to log in manually.",
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
      lines.push(`- @${mention} — (no agent bound)`);
      continue;
    }
    for (const binding of bindings) {
      const scope = binding.peer
        ? `${binding.peer.kind} ${binding.peer.id}`
        : "global";
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
  lines.push(`owner — ${owner ? `@${owner}` : "(unset)"}`);
  if (grants.length === 0) {
    lines.push("No grants. Only the owner can use the bot.");
  } else {
    for (const grant of grants) {
      const where = grant.roomId === "*" ? "everywhere" : `#${grant.roomName ?? grant.roomId}`;
      lines.push(`- @${grant.username} — ${where}`);
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
    `- server — ${online ? "online" : "offline"} (${server})`,
    `- bot — @${mention}`,
    `- agent — ${agent}`,
  ].join("\n");
}

async function runAddBot(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional, flags } = parseArgs(argStr);
  const username = positional[0];
  if (!username) {
    return [
      "**Create a new bot user**",
      "Usage: `!add-bot <username> [--name \"...\"] [--email ...] [--agent main]`",
      "",
      "Examples:",
      "  `!add-bot alice` — quick create with defaults",
      "  `!add-bot alice --name \"Alice Smith\" --email alice@example.com --agent support`",
      "",
      "A random password is generated and shown once. Restart OpenClaw to bring the bot online.",
    ].join("\n");
  }

  const name = flags.name ?? username;
  const email = flags.email ?? `${username.toLowerCase()}@openclaw.local`;
  const agent = flags.agent ?? "main";
  const password = randomToken(16);

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

    return [
      `**Created bot @${username}**`,
      `- agent — ${agent}`,
      `- password (auto-generated, shown once) — \`${password}\``,
      `It is now connected. Restart OpenClaw to load the new account.`,
    ].join("\n");
  } catch (e: unknown) {
    return `Failed to create bot: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function runBind(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const agent = positional[0];
  if (!agent) return "Usage: `!bind <agent>` — rebind this bot to a different agent/model";

  try {
    removeBindingsForAccount(ctx.accountId);
    addBinding({ channel: "rocketchat", accountId: ctx.accountId, agentId: agent });
    return `**@${ctx.account.mentionNames[0] ?? ctx.accountId}** is now bound to agent \`${agent}\`. Restart OpenClaw to apply.`;
  } catch (e: unknown) {
    return `Failed to rebind: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function runLend(ctx: CommandContext, argStr: string): Promise<string> {
  const { positional } = parseArgs(argStr);
  const groupName = positional[0];
  const username = positional[1];
  if (!groupName || !username) return "Usage: `!lend <group> <user>` — grant a user access to this bot in a group";

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
  if (!groupName || !username) return "Usage: `!revoke <group> <user>` — remove a user's access to this bot in a group";

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

function randomToken(length: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
