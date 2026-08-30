import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readAllAccounts } from "./config-updater.js";

export const DEFAULT_MAX_ACCOUNTS = 10;
export const DEFAULT_MAX_BOTS_PER_SERVER = 5;
export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_RECONNECTS = 20;

const STATE_DIR = resolve(homedir(), ".openclaw", "rocketchat");
const STATE_FILE = resolve(STATE_DIR, "rate-limit.json");

interface RateLimitState {
  lastBotCreatedAt: number;
  botCreations: Array<{ timestamp: number; username: string; source: string }>;
}

function readState(): RateLimitState {
  if (!existsSync(STATE_FILE)) {
    return { lastBotCreatedAt: 0, botCreations: [] };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as RateLimitState;
  } catch {
    return { lastBotCreatedAt: 0, botCreations: [] };
  }
}

function writeState(state: RateLimitState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // best-effort
  }
}

function pruneOldEntries(
  entries: RateLimitState["botCreations"],
  windowMs: number,
): RateLimitState["botCreations"] {
  const cutoff = Date.now() - windowMs;
  return entries.filter((e) => e.timestamp > cutoff);
}

export interface BotCreationLimit {
  allowed: boolean;
  reason?: string;
  remainingCooldownMs?: number;
}

export function checkBotCreationLimit(
  source: "cli" | "inline",
  options?: {
    maxAccounts?: number | undefined;
    maxBotsPerServer?: number | undefined;
    cooldownMs?: number | undefined;
    serverUrl?: string;
  },
): BotCreationLimit {
  const maxAccounts = options?.maxAccounts ?? DEFAULT_MAX_ACCOUNTS;
  const maxBotsPerServer = options?.maxBotsPerServer ?? DEFAULT_MAX_BOTS_PER_SERVER;
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const serverUrl = options?.serverUrl;

  const allAccounts = readAllAccounts();

  if (allAccounts.length >= maxAccounts) {
    return {
      allowed: false,
      reason: `Maximum ${maxAccounts} bot accounts reached. Remove an existing bot with !remove-bot or increase the limit in openclaw.json.`,
    };
  }

  if (serverUrl) {
    const botsForServer = allAccounts.filter((a) => a.serverUrl === serverUrl).length;
    if (botsForServer >= maxBotsPerServer) {
      return {
        allowed: false,
        reason: `Maximum ${maxBotsPerServer} bots per server reached for ${serverUrl}. Remove an existing bot or increase the limit.`,
      };
    }
  }

  const state = readState();
  const recent = pruneOldEntries(state.botCreations, cooldownMs);
  if (recent.length > 0) {
    const lastEntry = recent[recent.length - 1]!;
    const elapsed = Date.now() - lastEntry.timestamp;
    if (elapsed < cooldownMs) {
      return {
        allowed: false,
        reason: `Bot creation cooldown active. Wait ${Math.ceil((cooldownMs - elapsed) / 1000)}s or adjust cooldownMs in openclaw.json.`,
        remainingCooldownMs: cooldownMs - elapsed,
      };
    }
  }

  return { allowed: true };
}

export function recordBotCreation(username: string, source: "cli" | "inline"): void {
  const state = readState();
  const now = Date.now();
  state.lastBotCreatedAt = now;
  state.botCreations = pruneOldEntries(
    [...state.botCreations, { timestamp: now, username, source }],
    600_000,
  );
  writeState(state);
}
