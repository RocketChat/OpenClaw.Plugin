import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./types.js";

export function resolveOpenClawDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME?.trim();
  if (home) return join(home, ".openclaw");
  return join(homedir(), ".openclaw");
}

export function resolveUrl(url: string, base?: string): string {
  try {
    return new URL(url).toString();
  } catch {
    /* relative */
  }
  if (!base) return url;
  try {
    return new URL(url, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return url;
  }
}

export function getErrorMessage(payload: JsonObject, fallback: string): string {
  if (typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  if (typeof payload.message === "string" && payload.message.length > 0) return payload.message;
  return fallback;
}

export function getExt(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const clean = name.trim().toLowerCase();
  const part = clean.split("?").shift()!.split("#").shift()!;
  const dot = part.lastIndexOf(".");
  if (dot <= 0 || dot === part.length - 1) return undefined;
  return part.slice(dot + 1);
}

export function extractQuotedMessageId(link: string): string | undefined {
  try {
    const url = new URL(link);
    const msg = url.searchParams.get("msg");
    return msg && msg.length > 0 ? msg : undefined;
  } catch {
    return undefined;
  }
}

/** Sentinel roomId used for grants that permit direct-message (DM) access only. */
export const DM_SCOPE = "dm";

/**
 * Strip the `@` prefix from any `@username` mention whose username matches a
 * known bot identity. This prevents outbound bot replies from triggering
 * other bots in shared rooms (mention-response loops).
 */
export function stripBotMentions(text: string, botUsernames: Set<string>): string {
  if (!text || botUsernames.size === 0) return text;
  const normalized = new Set(
    [...botUsernames].map((n) => n.trim().replace(/^@+/, "").toLowerCase()),
  );
  return text.replace(/@([a-zA-Z0-9._-]+)/g, (match, name: string) =>
    normalized.has(name.toLowerCase()) ? name : match,
  );
}
