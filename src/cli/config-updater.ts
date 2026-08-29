import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import JSON5 from "json5";
import type { AuthCredentials, JsonObject } from "../types.js";

export const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");

export type TokenAuth = Extract<AuthCredentials, { mode: "token" }>;

export function readConfig(): JsonObject {
  if (!existsSync(OC_CONFIG_PATH)) return {};
  return JSON5.parse(readFileSync(OC_CONFIG_PATH, "utf-8"));
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
  enabled: boolean;
  owner?: string;
};

export function readAllAccounts(): ExistingAccount[] {
  const cfg = readConfig() as Record<string, any>;
  const accounts = cfg?.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts)
    .map((id) => readAccount(id))
    .filter((a): a is ExistingAccount => a !== null);
}

export function collectBotUserIdsForServer(serverUrl: string): Set<string> {
  return new Set(
    readAllAccounts()
      .filter((a) => a.serverUrl === serverUrl)
      .map((a) => a.auth.userId),
  );
}

export function collectBotUsernamesForServer(serverUrl: string): Set<string> {
  return new Set(
    readAllAccounts()
      .filter((a) => a.serverUrl === serverUrl)
      .flatMap((a) => (a.mentionNames.length > 0 ? a.mentionNames : [a.accountId])),
  );
}

export function readAccount(accountId = "main"): ExistingAccount | null {
  const cfg = readConfig() as Record<string, any>;
  const accounts = cfg?.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") return null;
  const target = accountId.toLowerCase();
  const key = Object.keys(accounts).find((k) => k.toLowerCase() === target);
  const account = key ? accounts[key] : undefined;
  if (!account || typeof account !== "object") return null;
  const serverUrl = typeof account.serverUrl === "string" ? account.serverUrl : "";
  const auth = account.auth;
  if (!serverUrl || !auth || auth.mode !== "token") return null;
  if (typeof auth.userId !== "string" || typeof auth.accessToken !== "string") return null;
  if (!auth.userId || !auth.accessToken) return null;
  const mentionNames = Array.isArray(account.mentionNames)
    ? account.mentionNames.filter(
        (n: unknown): n is string => typeof n === "string" && n.length > 0,
      )
    : [];
  const owner =
    typeof account.owner === "string" && account.owner.length > 0 ? account.owner : undefined;
  const enabled = account.enabled !== false;
  return {
    accountId,
    serverUrl,
    mentionNames,
    auth: { mode: "token", userId: auth.userId, accessToken: auth.accessToken },
    enabled,
    ...(owner ? { owner } : {}),
  };
}

function normalizeMention(name: string): string {
  return name.trim().replace(/^@+/, "");
}

export function setAccountEnabled(accountId: string, enabled: boolean): boolean {
  const cfg = readConfig() as Record<string, any>;
  const accounts = cfg?.channels?.rocketchat?.accounts as Record<string, any> | undefined;
  if (!accounts || typeof accounts !== "object") return false;
  const target = accountId.toLowerCase();
  const key = Object.keys(accounts).find((k) => k.toLowerCase() === target);
  if (!key || typeof accounts[key] !== "object" || accounts[key] === null) return false;
  accounts[key].enabled = enabled;
  writeConfig(cfg);
  return true;
}

export function updateConfig(opts: {
  pluginPath: string;
  pluginId: string;
  accountId: string;
  serverUrl: string;
  transport?: { mode: "websocket" };
  mentionNames?: string[];
  auth: TokenAuth;
  owner?: string;

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
    ? existing.mentionNames
        .map((n: unknown) => (typeof n === "string" ? normalizeMention(n) : ""))
        .filter(Boolean)
    : [];
  const incomingMentions = (opts.mentionNames ?? []).map(normalizeMention).filter(Boolean);
  const mergedMentions = [...existingMentions];
  for (const m of incomingMentions) {
    if (!mergedMentions.includes(m)) mergedMentions.push(m);
  }

  const serverUrl = opts.replaceConnection
    ? opts.serverUrl
    : (existing?.serverUrl ?? opts.serverUrl);
  const auth = opts.replaceConnection
    ? { mode: "token" as const, userId: opts.auth.userId, accessToken: opts.auth.accessToken }
    : (existing?.auth ?? {
        mode: "token" as const,
        userId: opts.auth.userId,
        accessToken: opts.auth.accessToken,
      });

  accounts[opts.accountId] = {
    ...(existing ?? {}),
    enabled: true,
    serverUrl,
    auth,
    transport: existing?.transport ?? opts.transport ?? { mode: "websocket" },
    mentionNames: opts.replaceConnection ? incomingMentions : mergedMentions,
    ...(opts.owner ? { owner: opts.owner.trim().replace(/^@+/, "") } : {}),
  };

  writeConfig(cfg);
}

export function readAgentsList(): Array<{ id: string; name?: string }> {
  // OpenClaw 2026+ stores agents as directories under ~/.openclaw/agents/
  const agentsDir = resolve(homedir(), ".openclaw", "agents");
  if (existsSync(agentsDir)) {
    try {
      const entries = readdirSync(agentsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => ({ id: e.name }));
    } catch {
      // fall through
    }
  }

  // Fallback: agents.list array in config
  const cfg = readConfig() as Record<string, any>;
  const list = cfg?.agents?.list;
  if (Array.isArray(list)) {
    return list
      .filter((a: unknown) => a && typeof a === "object")
      .map((a: Record<string, unknown>) => {
        const id = typeof a.id === "string" ? a.id : "";
        const name = typeof a.name === "string" ? a.name : undefined;
        const result: { id: string; name?: string } = { id };
        if (name !== undefined) result.name = name;
        return result;
      })
      .filter((a) => a.id.length > 0);
  }

  return [];
}

export function readBindingsForAccount(
  accountId: string,
): Array<{ agentId: string; peer?: { kind: string; id: string } }> {
  const cfg = readConfig() as Record<string, any>;
  const bindings = cfg?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings
    .filter((b: any) => b?.match?.channel === "rocketchat" && b?.match?.accountId === accountId)
    .map((b: any) => {
      const result: { agentId: string; peer?: { kind: string; id: string } } = {
        agentId: typeof b.agentId === "string" ? b.agentId : "(unknown)",
      };
      if (b.match?.peer) {
        result.peer = { kind: b.match.peer.kind, id: b.match.peer.id };
      }
      return result;
    });
}

export function addAccount(opts: {
  accountId: string;
  serverUrl: string;
  auth: TokenAuth;
  mentionNames: string[];
  transport?: { mode: "websocket" };
  owner?: string;
}): void {
  const cfg = readConfig() as Record<string, any>;

  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.rocketchat) cfg.channels.rocketchat = {};
  if (!cfg.channels.rocketchat.accounts) cfg.channels.rocketchat.accounts = {};

  const accounts = cfg.channels.rocketchat.accounts as Record<string, any>;

  const owner = opts.owner?.trim().replace(/^@+/, "");
  accounts[opts.accountId] = {
    ...(accounts[opts.accountId] ?? {}),
    enabled: true,
    serverUrl: opts.serverUrl,
    auth: {
      mode: "token",
      userId: opts.auth.userId,
      accessToken: opts.auth.accessToken,
    },
    transport: opts.transport ?? { mode: "websocket" },
    mentionNames: opts.mentionNames.map(normalizeMention).filter(Boolean),
    ...(owner ? { owner } : {}),
  };

  writeConfig(cfg);
}

export function readOwner(accountId: string): string | undefined {
  const cfg = readConfig() as Record<string, any>;
  const account = cfg?.channels?.rocketchat?.accounts?.[accountId];
  const owner = account?.owner;
  return typeof owner === "string" && owner.length > 0 ? owner : undefined;
}

export function ensureAgentForBot(accountId: string): {
  agentId: string;
  created: boolean;
  fallback: boolean;
} {
  const dedicatedId = `rc-${accountId}`;
  const existing = readAgentsList();
  if (existing.some((a) => a.id === dedicatedId)) {
    return { agentId: dedicatedId, created: false, fallback: false };
  }

  try {
    const workspace = resolve(homedir(), ".openclaw", "agents", dedicatedId);
    execFileSync(
      "openclaw",
      ["agents", "add", dedicatedId, "--non-interactive", "--workspace", workspace],
      { stdio: "ignore" },
    );
    return { agentId: dedicatedId, created: true, fallback: false };
  } catch {
    return { agentId: "main", created: false, fallback: true };
  }
}

export function isAgentBound(agentId: string): boolean {
  const cfg = readConfig() as Record<string, any>;
  const bindings = cfg?.bindings;
  if (!Array.isArray(bindings)) return false;
  return bindings.some(
    (b: any) =>
      b?.match?.channel === "rocketchat" &&
      typeof b.agentId === "string" &&
      normalizeAgentId(b.agentId) === normalizeAgentId(agentId),
  );
}

function normalizeAgentId(id: string): string {
  return id.trim().toLowerCase();
}

export function addBinding(opts: {
  channel: string;
  accountId: string;
  agentId: string;
  peer?: { kind: string; id: string };
}): void {
  const cfg = readConfig() as Record<string, any>;

  if (!cfg.bindings) cfg.bindings = [];
  const bindings = cfg.bindings as Array<Record<string, any>>;

  const existingIndex = bindings.findIndex(
    (b) =>
      b.match?.channel === opts.channel &&
      b.match?.accountId === opts.accountId &&
      (!opts.peer || JSON.stringify(b.match?.peer) === JSON.stringify(opts.peer)),
  );

  const binding: Record<string, any> = {
    agentId: opts.agentId,
    match: {
      channel: opts.channel,
      accountId: opts.accountId,
    },
  };

  if (opts.peer) {
    binding.match.peer = opts.peer;
  }

  if (existingIndex >= 0) {
    bindings[existingIndex] = binding;
  } else {
    bindings.push(binding);
  }

  writeConfig(cfg);
}

export function removeBindingsForAccount(accountId: string): void {
  const cfg = readConfig() as Record<string, any>;
  const bindings = cfg?.bindings as Array<Record<string, any>> | undefined;
  if (!bindings) return;

  cfg.bindings = bindings.filter(
    (b) => !(b.match?.channel === "rocketchat" && b.match?.accountId === accountId),
  );

  writeConfig(cfg);
}

export function removeAccount(accountId: string): void {
  const cfg = readConfig() as Record<string, any>;
  const accounts = cfg?.channels?.rocketchat?.accounts as Record<string, any> | undefined;
  if (accounts) {
    delete accounts[accountId];
  }
  writeConfig(cfg);
}

export function removeAgentDir(accountId: string): void {
  const dir = resolve(homedir(), ".openclaw", "agents", `rc-${accountId}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
