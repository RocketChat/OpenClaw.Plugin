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
