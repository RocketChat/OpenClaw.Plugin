export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp: number;
};

const MAX_GROUP_HISTORY_ENTRIES = 10;

// Intentional ephemeral cache: holds recent group-chat messages so the LLM has
// nearby context when it's mentioned. Deliberately in-memory only — it is lost on
// restart and that is acceptable (it's short-term conversational context, not data
// we need to persist). If durability becomes important, back this with sqlite.
const store = new Map<string, GroupHistoryEntry[]>();

function key(accountId: string, roomId: string): string {
  return `${accountId}:${roomId}`;
}

export function appendGroupHistory(accountId: string, roomId: string, entry: GroupHistoryEntry): void {
  const k = key(accountId, roomId);
  let history = store.get(k);
  if (!history) {
    history = [];
    store.set(k, history);
  }
  history.push(entry);
  if (history.length > MAX_GROUP_HISTORY_ENTRIES) {
    history.splice(0, history.length - MAX_GROUP_HISTORY_ENTRIES);
  }
}

export function getAndClearGroupHistory(accountId: string, roomId: string): GroupHistoryEntry[] {
  const k = key(accountId, roomId);
  const history = store.get(k) ?? [];
  store.delete(k);
  return history;
}
