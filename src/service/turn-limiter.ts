const DEFAULT_MAX_CONCURRENT_TURNS = 8;

let limit = DEFAULT_MAX_CONCURRENT_TURNS;
let inflight = 0;
const waiters: Array<() => void> = [];

export function setMaxConcurrentTurns(next: number): void {
  limit = Math.max(1, Math.floor(next));
  while (inflight < limit && waiters.length > 0) {
    const wake = waiters.shift();
    if (wake) {
      inflight++;
      wake();
    }
  }
}

export async function acquireTurnSlot(): Promise<void> {
  if (inflight < limit) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

export function releaseTurnSlot(): void {
  const wake = waiters.shift();
  if (wake) {
    wake();
    return;
  }
  inflight = Math.max(0, inflight - 1);
}

export function turnLimiterStats(): { inflight: number; waiting: number; limit: number } {
  return { inflight, waiting: waiters.length, limit };
}
