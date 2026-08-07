import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AuthCredentials, JsonObject } from "../types.js";

const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");


type TokenAuth = Extract<AuthCredentials, { mode: "token" }>;

function readConfig(): JsonObject {
  if (!existsSync(OC_CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(OC_CONFIG_PATH, "utf-8"));
}

function writeConfig(cfg: JsonObject): void {
  const tmp = OC_CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, OC_CONFIG_PATH);
}

export type ExistingAccount = {
  accountId: string;
  serverUrl: string;
  mentionNames: string[];
  auth: TokenAuth;
};


export function readAccount(accountId = "main"): ExistingAccount | null {
  const cfg = readConfig() as Record<string, any>;
  const account = cfg?.channels?.rocketchat?.accounts?.[accountId];
  if (!account || typeof account !== "object") return null;
  const serverUrl = typeof account.serverUrl === "string" ? account.serverUrl : "";
  const auth = account.auth;
  if (!serverUrl || !auth || auth.mode !== "token") return null;
  if (typeof auth.userId !== "string" || typeof auth.accessToken !== "string") return null;
  if (!auth.userId || !auth.accessToken) return null;
  const mentionNames = Array.isArray(account.mentionNames)
    ? account.mentionNames.filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
    : [];
  return {
    accountId,
    serverUrl,
    mentionNames,
    auth: { mode: "token", userId: auth.userId, accessToken: auth.accessToken },
  };
}

function normalizeMention(name: string): string {
  return name.trim().replace(/^@+/, "");
}

export function updateConfig(opts: {
  pluginPath: string;
  pluginId: string;
  accountId: string;
  serverUrl: string;
  transport?: { mode: "websocket" };
  mentionNames?: string[];
  auth: TokenAuth;

  replaceConnection?: boolean;
}) {
  const cfg = readConfig() as Record<string, any>;

  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.load) cfg.plugins.load = {};
  if (!cfg.plugins.load.paths) cfg.plugins.load.paths = [];
  if (!cfg.plugins.load.paths.includes(opts.pluginPath)) {
    cfg.plugins.load.paths.push(opts.pluginPath);
  }
  if (!cfg.plugins.allow) cfg.plugins.allow = [];
  if (!cfg.plugins.allow.includes(opts.pluginId)) {
    cfg.plugins.allow.push(opts.pluginId);
  }

  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.rocketchat) cfg.channels.rocketchat = {};
  if (!cfg.channels.rocketchat.accounts) cfg.channels.rocketchat.accounts = {};

  const accounts = cfg.channels.rocketchat.accounts as Record<string, any>;
  const existing = accounts[opts.accountId] as Record<string, any> | undefined;

  const existingMentions = Array.isArray(existing?.mentionNames)
    ? existing.mentionNames.map((n: unknown) => (typeof n === "string" ? normalizeMention(n) : "")).filter(Boolean)
    : [];
  const incomingMentions = (opts.mentionNames ?? []).map(normalizeMention).filter(Boolean);
  const mergedMentions = [...existingMentions];
  for (const m of incomingMentions) {
    if (!mergedMentions.includes(m)) mergedMentions.push(m);
  }


  const serverUrl = opts.replaceConnection ? opts.serverUrl : (existing?.serverUrl ?? opts.serverUrl);
  const auth = opts.replaceConnection
    ? { mode: "token" as const, userId: opts.auth.userId, accessToken: opts.auth.accessToken }
    : (existing?.auth ?? { mode: "token" as const, userId: opts.auth.userId, accessToken: opts.auth.accessToken });

  accounts[opts.accountId] = {
    enabled: true,
    serverUrl,
    auth,
    transport: existing?.transport ?? opts.transport ?? { mode: "websocket" },
    mentionNames: opts.replaceConnection ? incomingMentions : mergedMentions,
  };

  writeConfig(cfg);
}
