import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import JSON5 from "json5";
import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthCredentials, JsonObject } from "../types.js";

export const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");
const SHARED_WORKSPACE_DIR = resolve(homedir(), ".openclaw", "workspace");

export type TokenAuth = Extract<AuthCredentials, { mode: "token" }>;

export function readConfig(): JsonObject {
  if (!existsSync(OC_CONFIG_PATH)) return {};
  return JSON5.parse(readFileSync(OC_CONFIG_PATH, "utf-8"));
}

/**
 * The OpenClaw core that supports `agents.entries` shipped as 2026.8.1
 * (the v2026.7.2 betas were released as 2026.8.1). Earlier cores (2026.7.x)
 * reject `agents.entries` and instead accept the legacy `agents.list` array,
 * which is only treated as an internal projection.
 */
const AGENTS_ENTRIES_MIN_CORE = "2026.8.0";

function parseCoreVersion(version: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function coreSupportsAgentsEntries(): boolean {
  const current = parseCoreVersion(OPENCLAW_VERSION);
  const min = parseCoreVersion(AGENTS_ENTRIES_MIN_CORE);
  if (!current || !min) return false;
  if (current.major !== min.major) return current.major > min.major;
  if (current.minor !== min.minor) return current.minor > min.minor;
  return current.patch >= min.patch;
}

function writeConfig(cfg: JsonObject): void {
  reconcileAgentListings(cfg as Record<string, any>);
  const dir = dirname(OC_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = OC_CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, OC_CONFIG_PATH);
}

/**
 * Keep the persisted `agents` block compatible with the running OpenClaw core.
 *
 * - Cores >= 2026.8.0 (e.g. 2026.9.2) validate that every non-"main" binding
 *   `agentId` resolves to a `agents.entries` entry and reject the legacy
 *   `agents.list` key. Dedicated `rc-*` agents are discovered on disk, but the
 *   core's config validation does not scan `~/.openclaw/agents/` — it only
 *   reads `agents.entries`. So each dedicated agent the plugin binds must be
 *   declared here, otherwise the config is rejected with
 *   `Unknown agent id "rc-..." (not in agents.entries)` and the bot never
 *   comes online.
 * - Cores < 2026.8.0 (2026.7.x) reject `agents.entries` outright, so those keys
 *   must be scrubbed to keep the whole config valid for them.
 */
function reconcileAgentListings(cfg: Record<string, any>): void {
  const agents = cfg?.agents;

  if (!coreSupportsAgentsEntries()) {
    if (agents && typeof agents === "object") {
      delete agents.entries;
      delete agents.list;
    }
    return;
  }

  if (agents && typeof agents === "object" && agents.list !== undefined) {
    delete agents.list;
  }

  const entries = collectRequiredAgentEntries(cfg);
  if (Object.keys(entries).length === 0) {
    if (agents && typeof agents === "object") {
      cfg.agents.entries = { main: {} };
      // Do not set agents.ownership — unrecognized by core 2026.9.x
    }
    return;
  }

  if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents = {};
  cfg.agents.entries = entries;
  // Note: do NOT set agents.ownership here — the key is unrecognized by the core
  // schema validator and causes gateway reload to be skipped with "Unrecognized key".
}

/**
 * Compute the `agents.entries` record that must be persisted for the new-style
 * cores: every non-"main" agent referenced by a rocketchat binding is declared
 * (rc-* agents pin `workspace` to the shared ~/.openclaw/workspace), while
 * user-defined entries are preserved. Plugin-owned `rc-*` entries whose
 * Rocket.Chat account was removed and that no binding references are pruned.
 */
function collectRequiredAgentEntries(cfg: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  const existing = cfg?.agents?.entries;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    Object.assign(result, existing);
  }

  const bindings = cfg?.bindings;
  const rocketchatBindings = Array.isArray(bindings)
    ? bindings.filter(
        (b) =>
          b &&
          typeof b === "object" &&
          b.match &&
          typeof b.match === "object" &&
          b.match.channel === "rocketchat",
      )
    : [];

  const boundAgentIds = new Set(
    rocketchatBindings
      .map((b) => (typeof b.agentId === "string" ? b.agentId : ""))
      .filter((id) => id.length > 0 && id !== "main"),
  );

  const accountIds = new Set(
    (() => {
      const accounts = cfg?.channels?.rocketchat?.accounts;
      if (typeof accounts !== "object" || accounts === null) return [];
      return Object.keys(accounts).filter((id) => id.length > 0);
    })(),
  );

  for (const agentId of boundAgentIds) {
    if (!(agentId in result)) result[agentId] = {};
  }

  for (const id of Object.keys(result)) {
    if (!id.startsWith("rc-")) continue;
    const accountId = id.slice("rc-".length);
    if (!boundAgentIds.has(id) && !accountIds.has(accountId)) {
      delete result[id];
      continue;
    }
    const raw = result[id];
    result[id] = pinRcAgentWorkspace(raw && typeof raw === "object" ? raw : {}, id);
  }

  return result;
}

export function getAgentWorkspaceDir(agentId: string): string {
  return resolve(SHARED_WORKSPACE_DIR, agentId);
}

/** Dedicated rc-* agents use isolated workspace ~/.openclaw/workspace/<agentId>. */
function pinRcAgentWorkspace(entry: Record<string, any>, agentId: string): Record<string, any> {
  const targetWs = getAgentWorkspaceDir(agentId);
  const current = typeof entry.workspace === "string" ? entry.workspace : "";
  if (!current || resolve(current) === SHARED_WORKSPACE_DIR) {
    try {
      mkdirSync(targetWs, { recursive: true });
    } catch {
      /* best-effort */
    }
    return { ...entry, workspace: targetWs };
  }
  return entry;
}

// ensureSystemAgent was removed: agents.defaults.systemAgent is a legacy retired key
// in OpenClaw 2026.9.x and causes "Unrecognized key" config validation errors.

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
  };

  if (opts.agentId) {
    applyBinding(cfg, {
      channel: "rocketchat",
      accountId: opts.accountId,
      agentId: opts.agentId,
    });
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

  const legacy = cfg?.agents?.list;
  if (Array.isArray(legacy)) {
    for (const a of legacy) {
      if (!a || typeof a !== "object") continue;
      const id = typeof a.id === "string" ? a.id : "";
      if (!id) continue;
      const name = typeof a.name === "string" ? a.name : undefined;
      push(id, name);
    }
  }

  const agentsDir = resolve(homedir(), ".openclaw", "agents");
  if (existsSync(agentsDir)) {
    try {
      const entries2 = readdirSync(agentsDir, { withFileTypes: true });
      for (const e of entries2) {
        if (!e.isDirectory()) continue;
        push(e.name);
      }
    } catch {
      // fall through
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
  };

  if (opts.agentId) {
    applyBinding(cfg, {
      channel: "rocketchat",
      accountId: opts.accountId,
      agentId: opts.agentId,
    });
  }

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
  reason?: string;
} {
  const dedicatedId = `rc-${accountId}`;
  const existed = readAgentsList().some((a) => a.id === dedicatedId);

  try {
    const agentDir = resolve(homedir(), ".openclaw", "agents", dedicatedId);
    mkdirSync(resolve(agentDir, "agent"), { recursive: true });
    mkdirSync(resolve(agentDir, "sessions"), { recursive: true });

    const staleStateFile = resolve(agentDir, "openclaw-workspace-state.json");
    if (existsSync(staleStateFile)) {
      try {
        rmSync(staleStateFile);
      } catch {
        /* best-effort */
      }
    }

    removeLegacyPerBotWorkspace(dedicatedId);

    return { agentId: dedicatedId, created: !existed, fallback: false };
  } catch (err) {
    return {
      agentId: "main",
      created: false,
      fallback: true,
      reason: err instanceof Error ? err.message : String(err),
    };
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

function applyBinding(
  cfg: Record<string, any>,
  opts: {
    channel: string;
    accountId: string;
    agentId: string;
    peer?: { kind: string; id: string };
  },
): void {
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
}



function stripBindingsForAccount(cfg: Record<string, any>, accountId: string): void {
  const bindings = cfg?.bindings as Array<Record<string, any>> | undefined;
  if (!bindings) return;
  cfg.bindings = bindings.filter(
    (b) => !(b.match?.channel === "rocketchat" && b.match?.accountId === accountId),
  );
}

export function removeAccount(accountId: string): void {
  const cfg = readConfig() as Record<string, any>;
  const accounts = cfg?.channels?.rocketchat?.accounts as Record<string, any> | undefined;
  if (accounts) {
    delete accounts[accountId];
  }
  stripBindingsForAccount(cfg, accountId);
  writeConfig(cfg);
}

export function removeAgentDir(accountId: string): void {
  const dir = resolve(homedir(), ".openclaw", "agents", `rc-${accountId}`);
  const agentWs = resolve(dir, "workspace");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  removeWorkspaceAttestations(dir);
  removeWorkspaceAttestations(agentWs);
  removeLegacyPerBotWorkspace(`rc-${accountId}`);
}

function removeLegacyPerBotWorkspace(agentId: string): void {
  const wsDir = getAgentWorkspaceDir(agentId);
  if (existsSync(wsDir) && resolve(wsDir) !== SHARED_WORKSPACE_DIR) {
    rmSync(wsDir, { recursive: true, force: true });
    removeWorkspaceAttestations(wsDir);
  }
}

let didMigrateRcWorkspaces = false;

/** Pin rc-* agents to the shared workspace and drop leftover workspace/rc-* dirs. */
export function migrateRcWorkspacesIfNeeded(): void {
  if (didMigrateRcWorkspaces) return;
  didMigrateRcWorkspaces = true;

  try {
    if (existsSync(SHARED_WORKSPACE_DIR)) {
      const entries = readdirSync(SHARED_WORKSPACE_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith("rc-")) {
          removeLegacyPerBotWorkspace(e.name);
        }
      }
    }
  } catch {
    /* best-effort */
  }

  const cfg = readConfig() as Record<string, any>;
  const before = JSON.stringify(cfg);
  reconcileAgentListings(cfg);
  if (JSON.stringify(cfg) !== before) {
    writeConfig(cfg);
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
