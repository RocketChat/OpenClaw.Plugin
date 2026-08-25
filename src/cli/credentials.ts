import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

export interface AdminCredentials {
  serverUrl: string;
  userId: string;
  authToken: string;
}

export interface BotCredentials {
  userId: string;
  password: string;
}

const CREDS_DIR = resolve(homedir(), ".openclaw", "credentials", "rocketchat");
const ADMIN_FILE = resolve(CREDS_DIR, "admin.json");

function botFile(username: string): string {
  return resolve(CREDS_DIR, `bot-${username}.json`);
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function saveAdmin(admin: AdminCredentials): Promise<void> {
  if (existsSync(ADMIN_FILE)) {
    await mkdir(dirname(ADMIN_FILE), { recursive: true });
    await writeFile(ADMIN_FILE + ".bak", await readFile(ADMIN_FILE), { mode: 0o600 });
  }
  await writeJson(ADMIN_FILE, admin);
}

export async function loadAdmin(serverUrl?: string): Promise<AdminCredentials | null> {
  const admin = await readJson<AdminCredentials>(ADMIN_FILE);
  if (!admin) return null;

  if (serverUrl && admin.serverUrl && admin.serverUrl !== serverUrl) return null;
  return admin;
}

export async function saveBotCredentials(username: string, creds: BotCredentials): Promise<void> {
  await writeJson(botFile(username), creds);
}

export async function loadBotCredentials(username: string): Promise<BotCredentials | null> {
  return readJson<BotCredentials>(botFile(username));
}
