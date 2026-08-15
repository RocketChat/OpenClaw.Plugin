import type { InboundEvent } from "../types.js";
import type { ChannelRuleOptions } from "../types.js";
import type { RocketChatClient } from "../client/rest.js";
import { readAllAccounts, readBindingsForAccount, readOwner, type ExistingAccount } from "../cli/config-updater.js";
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
  const stripped = text.replace(/^\s*(@\S+\s+)+/, "").trim();
  const match = stripped.match(COMMAND_RE);
  if (!match) return { action: "passthrough" };
  const cmd = match[1]!.toLowerCase();

  switch (cmd) {
    case "help":
      return { action: "reply", replyText: buildHelpText() };
    case "access":
      return { action: "reply", replyText: await runAccess(ctx) };
    case "bots":
      return { action: "reply", replyText: runBots() };
    case "groups":
      return { action: "reply", replyText: await runGroups(ctx) };
    default:
      return { action: "passthrough" };
  }
}

function buildHelpText(): string {
  return [
    "**OpenClaw commands**",
    "",
    "Help:",
    "- `!help` — show this message",
    "- `!access` — who can use this bot and where",
    "- `!bots` — list bot accounts and their agent bindings",
    "- `!groups` — list groups this bot is in",
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
