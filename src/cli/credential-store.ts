import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  writeFileSync, unlinkSync, chmodSync, renameSync
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AccountCredentials } from "../types/types.js";

function getBaseDir(): string {
  const home = process.env.OPENCLAW_HOME?.trim() ?? homedir();
  return resolve(home, ".openclaw", "credentials", "rocketchat");
}

function filePath(accountId: string): string {
  return join(getBaseDir(), `${accountId}.json`);
}

function ensureDir(): void {
  const dir = getBaseDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function exists(accountId: string): boolean {
  return existsSync(filePath(accountId));
}

export async function read(accountId: string): Promise<AccountCredentials | null> {
  const path = filePath(accountId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as AccountCredentials;
  } catch {
    return null;
  }
}

export async function write(accountId: string, data: AccountCredentials): Promise<void> {
  ensureDir();
  const path = filePath(accountId);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export async function remove(accountId: string): Promise<boolean> {
  const path = filePath(accountId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export async function list(): Promise<string[]> {
  const dir = getBaseDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}
