import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AuthCredentials, JsonObject } from "../types/types.js";

const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");

/** Config updater only writes token auth (CLI setup always resolves to a token) */
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

export function updateConfig(opts: {
  pluginPath: string;
  pluginId: string;
  accountId: string;
  serverUrl: string;
  transport?: { mode: string };
  mentionNames?: string[];
  auth: TokenAuth;
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

  cfg.channels.rocketchat.accounts[opts.accountId] = {
    enabled: true,
    serverUrl: opts.serverUrl,
    auth: { mode: "token", userId: opts.auth.userId, accessToken: opts.auth.accessToken },
    transport: opts.transport ?? { mode: "polling" },
    mentionNames: opts.mentionNames ?? [],
  };

  writeConfig(cfg);
}
