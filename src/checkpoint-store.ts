import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CheckpointState } from "./types/types.js";

export class FileCheckpointStore {
  constructor(
    private readonly filePath: string,
    private readonly limit = 250
  ) {}

  async read(): Promise<CheckpointState> {
    const data = await this.load();
    return {
      updatedSince: data.updatedSince ?? null,
      recentMessageIds: Array.isArray(data.recentMessageIds) ? [...data.recentMessageIds] : [],
    };
  }

  async write(state: CheckpointState): Promise<void> {
    await this.save({
      updatedSince: state.updatedSince ?? null,
      recentMessageIds: state.recentMessageIds.slice(-this.limit),
    });
  }

  async hasSeen(messageId: string): Promise<boolean> {
    const state = await this.read();
    return state.recentMessageIds.includes(messageId);
  }

  async markSeen(messageId: string): Promise<void> {
    const state = await this.read();
    if (!state.recentMessageIds.includes(messageId)) {
      state.recentMessageIds.push(messageId);
      state.recentMessageIds = state.recentMessageIds.slice(-this.limit);
      await this.write(state);
    }
  }

  private async load(): Promise<{ updatedSince?: string | null; recentMessageIds?: string[] }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return {};
    }
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as { updatedSince?: string | null; recentMessageIds?: string[] };
      }
    } catch {
    }
    return {};
  }

  private async save(state: { updatedSince: string | null; recentMessageIds: string[] }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
