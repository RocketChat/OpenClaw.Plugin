import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./types/types.js";

export function resolveOpenClawDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME?.trim();
  if (home) return join(home, ".openclaw");
  return join(homedir(), ".openclaw");
}

export function resolveUrl(url: string, base?: string): string {
  try { return new URL(url).toString(); } catch { /* relative */ }
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
