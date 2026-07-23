import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CheckpointState, FailedMessageRecord } from "../types.js";

export class CheckpointStore {
  private db: DatabaseSync;

  constructor(
    filePath: string,
    private readonly limit = 250,
    private readonly failureLimit = 100,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS seen_messages (
        id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS failed_messages (
        message_id TEXT PRIMARY KEY,
        room_id TEXT,
        sender_name TEXT,
        sent_at TEXT,
        failed_at TEXT,
        reason TEXT
      );
    `);
  }

  async read(): Promise<CheckpointState> {
    const updatedRow = this.db.prepare("SELECT value FROM meta WHERE key = 'updatedSince'").get() as { value: string } | undefined;
    const seenRows = this.db.prepare("SELECT id FROM seen_messages ORDER BY seen_at DESC LIMIT ?").all(this.limit) as { id: string }[];
    const failedRows = this.db.prepare("SELECT message_id as messageId, room_id as roomId, sender_name as senderName, sent_at as sentAt, failed_at as failedAt, reason FROM failed_messages LIMIT ?").all(this.failureLimit) as FailedMessageRecord[];
    return {
      updatedSince: updatedRow?.value ?? null,
      recentMessageIds: seenRows.map(r => r.id),
      failedMessages: failedRows,
    };
  }

  async write(state: CheckpointState): Promise<void> {
    this.db.exec("BEGIN");
    try {
      if (state.updatedSince) {
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('updatedSince', ?)").run(state.updatedSince);
      }
      this.db.prepare("DELETE FROM seen_messages").run();
      const insertSeen = this.db.prepare("INSERT OR IGNORE INTO seen_messages (id) VALUES (?)");
      for (const id of state.recentMessageIds.slice(-this.limit)) {
        insertSeen.run(id);
      }
      this.db.prepare("DELETE FROM failed_messages").run();
      const insertFailed = this.db.prepare(
        "INSERT OR REPLACE INTO failed_messages (message_id, room_id, sender_name, sent_at, failed_at, reason) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const f of (state.failedMessages ?? []).slice(-this.failureLimit)) {
        insertFailed.run(f.messageId, f.roomId, f.senderName, f.sentAt, f.failedAt, f.reason);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async recordFailure(failure: FailedMessageRecord): Promise<void> {
    this.db.prepare(
      "INSERT OR REPLACE INTO failed_messages (message_id, room_id, sender_name, sent_at, failed_at, reason) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(failure.messageId, failure.roomId, failure.senderName, failure.sentAt, failure.failedAt, failure.reason);
    this.db.prepare(
      "DELETE FROM failed_messages WHERE message_id NOT IN (SELECT message_id FROM failed_messages ORDER BY rowid DESC LIMIT ?)",
    ).run(this.failureLimit);
  }

  async hasSeen(messageId: string): Promise<boolean> {
    const row = this.db.prepare("SELECT 1 FROM seen_messages WHERE id = ?").get(messageId);
    return !!row;
  }

  async markSeen(messageId: string): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO seen_messages (id) VALUES (?)").run(messageId);
    this.db.prepare(
      "DELETE FROM seen_messages WHERE id NOT IN (SELECT id FROM seen_messages ORDER BY seen_at DESC LIMIT ?)",
    ).run(this.limit);
  }
}
