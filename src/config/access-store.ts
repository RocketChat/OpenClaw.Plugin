import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export type AccessGrant = {
  accountId: string;
  roomId: string;
  roomName?: string;
  username: string;
  grantedBy?: string;
  grantedAt: number;
};

export type AuditAction = "grant" | "revoke";

export type AuditEntry = {
  at: number;
  actor: string;
  action: AuditAction;
  accountId: string;
  roomId?: string;
  username?: string;
};

const SCHEMA_VERSION = "1";

export function getAccessDbPath(): string {
  return resolve(homedir(), ".openclaw", "rocketchat", "access.db");
}

export class AccessStore {
  private db: DatabaseSync;
  private readonly dbPath: string;

  constructor(filePath: string = getAccessDbPath()) {
    this.dbPath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS grants (
        account_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        room_name TEXT,
        username TEXT NOT NULL,
        granted_by TEXT,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, room_id, username)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT,
        action TEXT NOT NULL,
        account_id TEXT NOT NULL,
        room_id TEXT,
        username TEXT
      );
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
  }

  loadGrants(accountId: string): AccessGrant[] {
    const rows = this.db
      .prepare(
        "SELECT account_id, room_id, room_name, username, granted_by, granted_at FROM grants WHERE account_id = ?",
      )
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(toGrant);
  }

  loadAllGrants(): AccessGrant[] {
    const rows = this.db
      .prepare(
        "SELECT account_id, room_id, room_name, username, granted_by, granted_at FROM grants",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toGrant);
  }

  addGrant(grant: {
    accountId: string;
    roomId: string;
    roomName?: string;
    username: string;
    grantedBy?: string;
  }): boolean {
    const existing = this.db
      .prepare("SELECT 1 FROM grants WHERE account_id = ? AND room_id = ? AND username = ?")
      .get(grant.accountId, grant.roomId, grant.username);
    if (existing) return false;

    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO grants (account_id, room_id, room_name, username, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        grant.accountId,
        grant.roomId,
        grant.roomName ?? null,
        grant.username,
        grant.grantedBy ?? null,
        now,
      );
    this.appendAudit({
      at: now,
      actor: grant.grantedBy ?? "",
      action: "grant",
      accountId: grant.accountId,
      roomId: grant.roomId,
      username: grant.username,
    });
    return true;
  }

  removeGrant(params: {
    accountId: string;
    roomId: string;
    username: string;
    revokedBy?: string;
  }): boolean {
    const removed = this.db
      .prepare("DELETE FROM grants WHERE account_id = ? AND room_id = ? AND username = ?")
      .run(params.accountId, params.roomId, params.username).changes;
    if (removed === 0) return false;

    this.appendAudit({
      at: Date.now(),
      actor: params.revokedBy ?? "",
      action: "revoke",
      accountId: params.accountId,
      roomId: params.roomId,
      username: params.username,
    });
    return true;
  }

  listAudit(accountId?: string, limit = 50): AuditEntry[] {
    const rows = accountId
      ? (this.db
          .prepare(
            "SELECT at, actor, action, account_id, room_id, username FROM audit WHERE account_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(accountId, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            "SELECT at, actor, action, account_id, room_id, username FROM audit ORDER BY id DESC LIMIT ?",
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map(toAuditEntry);
  }

  /** Last write time to the db file, used by the gateway watcher to detect changes cheaply. */
  mtimeMs(): number {
    try {
      return statSync(this.dbPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.db.close();
  }

  private appendAudit(entry: Omit<AuditEntry, "id">): void {
    this.db
      .prepare(
        "INSERT INTO audit (at, actor, action, account_id, room_id, username) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.at,
        entry.actor,
        entry.action,
        entry.accountId,
        entry.roomId ?? null,
        entry.username ?? null,
      );
  }
}

function toGrant(row: Record<string, unknown>): AccessGrant {
  return {
    accountId: String(row.account_id ?? ""),
    roomId: String(row.room_id ?? ""),
    ...(row.room_name ? { roomName: String(row.room_name) } : {}),
    username: String(row.username ?? ""),
    ...(row.granted_by ? { grantedBy: String(row.granted_by) } : {}),
    grantedAt: Number(row.granted_at ?? 0),
  };
}

function toAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    at: Number(row.at ?? 0),
    actor: String(row.actor ?? ""),
    action: String(row.action ?? "") as AuditAction,
    accountId: String(row.account_id ?? ""),
    ...(row.room_id ? { roomId: String(row.room_id) } : {}),
    ...(row.username ? { username: String(row.username) } : {}),
  };
}
