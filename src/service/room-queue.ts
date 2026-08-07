export class RoomQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private active = 0;

  constructor(private readonly maxConcurrent = 8) {}

  enqueue(roomId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await task();
    });
    this.chains.set(roomId, next);

    next.finally(() => {
      if (this.chains.get(roomId) === next) this.chains.delete(roomId);
    });

    this.runGlobal(next);
  }

  private runGlobal(p: Promise<void>): void {
    if (this.active >= this.maxConcurrent) return;
    this.active++;
    void p.finally(() => {
      this.active--;
    });
  }
}
