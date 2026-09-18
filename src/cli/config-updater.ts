import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import JSON5 from "json5";
import type { AuthCredentials, JsonObject } from "../types.js";

export const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");
const SHARED_WORKSPACE_DIR = resolve(homedir(), ".openclaw", "workspace");

export type TokenAuth = Extract<AuthCredentials, { mode: "token" }>;

export function readConfig(): JsonObject {
  if (!existsSync(OC_CONFIG_PATH)) return {};
  return JSON5.parse(readFileSync(OC_CONFIG_PATH, "utf-8"));
}

function writeConfig(cfg: JsonObject): void {
  const dir = dirname(OC_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = OC_CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, OC_CONFIG_PATH);
}

export function getAgentWorkspaceDir(agentId: string): string {
  return resolve(SHARED_WORKSPACE_DIR, agentId);
}

export type ExistingAccount = {
  accountId: string;
  serverUrl: string;
  mentionNames: string[];
  auth: TokenAuth;
  enabled: boolean;
  owner?: string;
  agentId?: string;
};

export function readAllAccounts(): ExistingAccount[] {
  const cfg = readConfig() as Record<string, any>;
  const accounts = cfg?.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts)
    .map((id) => readAccount(id))
    .filter((a): a is ExistingAccount => a !== null);
}

export type ChannelLimits = {
  maxAccounts?: number;
  maxBotsPerServer?: number;
  botCreationCooldownMs?: number;
  maxReconnects?: number;
  maxConcurrentTurns?: number;
};

export function readChannelLimits(): ChannelLimits {
  const cfg = readConfig() as Record<string, any>;
  const limits = cfg?.channels?.rocketchat?.limits;
  if (!limits || typeof limits !== "object") return {};
  const out: ChannelLimits = {};
  if (typeof limits.maxAccounts === "number" && limits.maxAccounts > 0)
    out.maxAccounts = limits.maxAccounts;
  if (typeof limits.maxBotsPerServer === "number" && limits.maxBotsPerServer > 0)
    out.maxBotsPerServer = limits.maxBotsPerServer;
  if (typeof limits.botCreationCooldownMs === "number" && limits.botCreationCooldownMs > 0)
    out.botCreationCooldownMs = limits.botCreationCooldownMs;
  if (typeof limits.maxReconnects === "number" && limits.maxReconnects > 0)
    out.maxReconnects = limits.maxReconnects;
  if (typeof limits.maxConcurrentTurns === "number" && limits.maxConcurrentTurns > 0)
    out.maxConcurrentTurns = limits.maxConcurrentTurns;
  return out;
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
  const agentIdRaw =
    typeof account.agentId === "string"
      ? account.agentId
      : typeof account.agent === "string"
        ? account.agent
        : undefined;
  const agentId = typeof agentIdRaw === "string" && agentIdRaw.length > 0 ? agentIdRaw : undefined;
  const enabled = account.enabled !== false;
  return {
    accountId,
    serverUrl,
    mentionNames,
    auth: { mode: "token", userId: auth.userId, accessToken: auth.accessToken },
    enabled,
    ...(owner ? { owner } : {}),
    ...(agentId ? { agentId } : {}),
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

/** Set the default model for all agents (agents.defaults.model.primary). */
export function setDefaultModel(modelId: string): void {
  const cfg = readConfig() as Record<string, any>;
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  const current = cfg.agents.defaults.model;
  const existing =
    typeof current === "object" &&
    current &&
    typeof (current as { fallbacks?: unknown }).fallbacks === "object"
      ? { fallbacks: (current as { fallbacks: unknown }).fallbacks }
      : {};
  cfg.agents.defaults.model = { primary: modelId, ...existing };
  writeConfig(cfg);
}

/** Read the current default model (primary) for all agents. */
export function readDefaultModel(): string {
  const cfg = readConfig() as Record<string, any>;
  const raw = cfg?.agents?.defaults?.model;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return String(raw.primary ?? "");
  return "";
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
  agentId?: string;

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
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };

  if (opts.agentId) {
    applyAgentBinding(cfg, opts.accountId, opts.agentId);
  }

  writeConfig(cfg);
}

function readAgentsList(): Array<{ id: string; name?: string }> {
  const cfg = readConfig() as Record<string, any>;
  const agents: Array<{ id: string; name?: string }> = [];
  const push = (id: string, name?: string): void => {
    if (agents.some((a) => a.id === id)) return;
    agents.push(name !== undefined ? { id, name } : { id });
  };

  const entries = cfg?.agents?.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [id, rawEntry] of Object.entries(entries)) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name : undefined;
      push(id, name);
    }
  }

  const accounts = cfg?.channels?.rocketchat?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts) as Array<Record<string, unknown>>) {
      const id =
        typeof account?.agentId === "string"
          ? account.agentId
          : typeof account?.agent === "string"
            ? account.agent
            : "";
      if (id) push(id);
    }
  }

  return agents;
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
  agentId?: string;
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
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };

  writeConfig(cfg);
}

export function readOwner(accountId: string): string | undefined {
  const cfg = readConfig() as Record<string, any>;
  const account = cfg?.channels?.rocketchat?.accounts?.[accountId];
  const owner = account?.owner;
  return typeof owner === "string" && owner.length > 0 ? owner : undefined;
}

export function resolveAgentIdForAccount(accountId: string): string | undefined {
  const account = readAccount(accountId);
  if (account?.agentId) return account.agentId;
  return readBindingsForAccount(accountId)[0]?.agentId;
}

export function seedBotWorkspace(accountId: string, owner?: string): void {
  const sharedDir = getAgentWorkspaceDir(`rc-${accountId}`);
  const localDir = resolve(homedir(), ".openclaw", "agents", `rc-${accountId}`, "workspace");

  for (const dir of [sharedDir, localDir]) {
    mkdirSync(dir, { recursive: true });

    const bootstrapFile = resolve(dir, "BOOTSTRAP.md");
    if (!existsSync(bootstrapFile)) {
      writeFileSync(
        bootstrapFile,
        "# BOOTSTRAP.md\n\nOnboarding is complete. Do not ask the user to set up identity or workspace files.\n",
      );
    }

    const userFile = resolve(dir, "USER.md");
    if (!existsSync(userFile)) {
      const ownerLine = owner ? `- **Owner:** ${owner}\n` : "";
      writeFileSync(userFile, `# USER.md\n\n${ownerLine}- **Bot:** ${accountId}\n`);
    }
  }
}

export function ensureAgentForBot(accountId: string): {
  agentId: string;
  created: boolean;
  fallback: boolean;
  reason?: string;
} {
  const dedicatedId = `rc-${accountId}`;
  const existed = readAgentsList().some((a) => a.id === dedicatedId);

  if (!existed) {
    const agentDir = resolve(homedir(), ".openclaw", "agents", dedicatedId);
    mkdirSync(agentDir, { recursive: true });
    const agentFile = resolve(agentDir, "agent.md");
    if (!existsSync(agentFile)) {
      writeFileSync(
        agentFile,
        `# ${dedicatedId}\n\nYou are a helpful AI assistant for Rocket.Chat.\n`,
      );
    }
  }

  return { agentId: dedicatedId, created: !existed, fallback: false };
}

export function isAgentBound(agentId: string): boolean {
  const cfg = readConfig() as Record<string, any>;
  const wanted = normalizeAgentId(agentId);
  const accounts = cfg?.channels?.rocketchat?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts) as Array<Record<string, unknown>>) {
      const id =
        typeof account?.agentId === "string"
          ? account.agentId
          : typeof account?.agent === "string"
            ? account.agent
            : "";
      if (id && normalizeAgentId(id) === wanted) return true;
    }
  }
  const bindings = cfg?.bindings;
  if (!Array.isArray(bindings)) return false;
  return bindings.some(
    (b: any) =>
      b?.match?.channel === "rocketchat" &&
      typeof b.agentId === "string" &&
      normalizeAgentId(b.agentId) === wanted,
  );
}

function normalizeAgentId(id: string): string {
  return id.trim().toLowerCase();
}

export function removeAccount(accountId: string): void {
  const cfg = readConfig() as Record<string, any>;
  const agentId = `rc-${accountId.toLowerCase()}`;

  // 1. Remove account entry
  const accounts = cfg?.channels?.rocketchat?.accounts as Record<string, any> | undefined;
  if (accounts) {
    delete accounts[accountId];
  }

  // 2. Remove associated bindings
  if (Array.isArray(cfg?.bindings)) {
    cfg.bindings = cfg.bindings.filter(
      (b: any) =>
        !(
          b?.match?.channel === "rocketchat" &&
          b?.match?.accountId?.toLowerCase() === accountId.toLowerCase()
        ),
    );
  }

  // 3. Remove agent from agents.entries if not bound to any remaining binding
  if (cfg?.agents?.entries && cfg.agents.entries[agentId]) {
    const isBoundElsewhere =
      Array.isArray(cfg.bindings) && cfg.bindings.some((b: any) => b?.agentId === agentId);
    if (!isBoundElsewhere) {
      delete cfg.agents.entries[agentId];
    }
  }

  writeConfig(cfg);
}

export function removeAgentDir(accountId: string): void {
  const dir = resolve(homedir(), ".openclaw", "agents", `rc-${accountId}`);
  const agentWs = resolve(dir, "workspace");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  removeWorkspaceAttestations(dir);
  removeWorkspaceAttestations(agentWs);

  const wsDir = getAgentWorkspaceDir(`rc-${accountId}`);
  if (existsSync(wsDir) && resolve(wsDir) !== SHARED_WORKSPACE_DIR) {
    rmSync(wsDir, { recursive: true, force: true });
    removeWorkspaceAttestations(wsDir);
  }
}

/**
 * Remove OpenClaw workspace attestations for a workspace directory. OpenClaw
 * core names these files `<sha256(absoluteWorkspaceDir)>.attested` in the state
 * dir's `workspace-attestations/` folder (plus a legacy inline `<dir>.attested`).
 * Deleting a workspace without removing its attestation causes
 * `WorkspaceVanishedError` on the next message, so they must be cleaned together.
 */
function removeWorkspaceAttestations(workspaceDir: string): void {
  const key = createHash("sha256").update(resolve(workspaceDir)).digest("hex");
  const stateDirs = [resolve(homedir(), ".openclaw"), resolve(homedir(), ".clawdbot")];
  for (const stateDir of stateDirs) {
    const base = resolve(stateDir, "workspace-attestations");
    if (!existsSync(base)) continue;
    const file = resolve(base, `${key}.attested`);
    if (existsSync(file)) rmSync(file, { force: true });
  }
  const legacy = `${resolve(workspaceDir)}.attested`;
  if (existsSync(legacy)) rmSync(legacy, { force: true });
}

export function applyAgentBinding(
  cfg: Record<string, any>,
  accountId: string,
  agentId: string,
): boolean {
  let changed = false;

  // 1. Ensure the agent is explicitly declared in agents.entries
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.entries) cfg.agents.entries = {};
  if (!cfg.agents.entries[agentId]) {
    cfg.agents.entries[agentId] = {
      name: agentId,
    };
    changed = true;
  }

  // 2. Ensure the binding exists
  if (!Array.isArray(cfg.bindings)) {
    cfg.bindings = [];
  }
  const bindingExists = cfg.bindings.some(
    (b: any) =>
      b.match?.channel === "rocketchat" &&
      b.match?.accountId === accountId &&
      b.agentId === agentId,
  );

  if (!bindingExists) {
    cfg.bindings.push({
      agentId,
      match: {
        channel: "rocketchat",
        accountId,
      },
    });
    changed = true;
  }

  return changed;
}

export function bindAgentToAccount(accountId: string, agentId: string): void {
  const cfg = readConfig() as Record<string, any>;
  const changed = applyAgentBinding(cfg, accountId, agentId);
  if (changed) {
    writeConfig(cfg);
  }
}
