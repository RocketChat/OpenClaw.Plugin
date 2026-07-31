import type { InboundEvent } from "../types.js";
import type { ChannelRuleOptions } from "../types.js";

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

  // Check server-parsed mentions array (authoritative)
  // RC populates this when a user is @mentioned — skip broadcast mentions
  for (const mention of event.mentions) {
    const name = mention.toLowerCase();
    if (BROADCAST_MENTIONS.has(name)) continue;
    if (aliases.has(name)) return true;
  }

  // Fallback: check raw text for @alias (covers clients/plugins that
  // don't populate the mentions array)
  const normalizedText = event.text.toLowerCase();
  for (const alias of aliases) {
    if (normalizedText.includes(`@${alias}`)) return true;
  }

  return false;
}

export type CommandResult =
  | { action: "reply"; replyText: string }
  | { action: "passthrough" };

const COMMAND_RE = /^\s*!(\S+)(?:\s+([\s\S]*))?$/i;

export function matchCommand(text: string): CommandResult {
  const stripped = text.replace(/^\s*(@\S+\s+)+/, "").trim();
  const match = stripped.match(COMMAND_RE);
  if (!match) return { action: "passthrough" };
  const cmd = match[1]!.toLowerCase();

  switch (cmd) {
    case "help":
      return { action: "reply", replyText: buildHelpText() };
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
  ].join("\n");
}
