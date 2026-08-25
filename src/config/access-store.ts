import { mkdirSync } from "node:fs";
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

const SCHEMA_VERSION = "1";

export function getAccessDbPath(): string {
  return resolve(homedir(), ".openclaw", "rocketchat", "access.db");
}

export class AccessStore {
  private db: DatabaseSync;

  constructor(filePath: string = getAccessDbPath()) {
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
    return removed !== 0;
  }

  close(): void {
    this.db.close();
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
