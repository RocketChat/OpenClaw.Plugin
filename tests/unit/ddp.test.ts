import { afterEach, describe, expect, it, vi } from "vitest";
import { DDPSDK } from "@rocket.chat/ddp-client";
import { RocketChatDdpConnection } from "../../src/client/ddp.js";

function makeSession() {
  let status: ((value: string) => void) | undefined;
  let message: ((...args: unknown[]) => void) | undefined;
  const order: string[] = [];
  const sdk = {
    connection: {
      on: vi.fn((event: string, callback: (value: string) => void) => {
        if (event === "connection") status = callback;
      }),
      connect: vi.fn(async () => status?.("connected")),
      close: vi.fn(),
    },
    account: { loginWithToken: vi.fn(async () => order.push("login")) },
    timeoutControl: { stop: vi.fn() },
    stream: vi.fn((_name: string, _selector: string, callback: (...args: unknown[]) => void) => {
      order.push("subscribe");
      message = callback;
      return { ready: vi.fn(async () => {}), stop: vi.fn() };
    }),
    call: vi.fn(),
  } as unknown as DDPSDK;
  return {
    sdk,
    order,
    status: (value: string) => status?.(value),
    message: (value: unknown) => message?.(value),
  };
}

function setup(maxReconnects = 4) {
  const sessions = [makeSession(), makeSession(), makeSession()];
  let created = 0;
  const create = vi.spyOn(DDPSDK, "create").mockImplementation(() => sessions[created++].sdk);
  const messages = vi.fn();
  const statuses = vi.fn();
  const connection = new RocketChatDdpConnection({
    wsUrl: "wss://example.test/websocket",
    authToken: "token",
    username: "user",
    reconnectDelayMs: 20,
    maxReconnects,
    onMessage: messages,
    onStatus: statuses,
  });
  return { sessions, create, messages, statuses, connection };
}
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
describe("RocketChatDdpConnection recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("restarts closed heartbeat sessions, authenticates first, and ignores stale work", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.connection.start();
    await flush();
    const [stale, current] = t.sessions;
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(stale.order).toEqual(["login", "subscribe"]);
    stale.status("closed");
    await vi.advanceTimersByTimeAsync(20);
    await flush();
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(current.order).toEqual(["login", "subscribe"]);
    const received = { _id: "new" };
    current.message(received);
    stale.message({ _id: "stale" });
    expect(t.messages).toHaveBeenCalledTimes(1);
    expect(t.messages).toHaveBeenCalledWith(received);
    const statusCount = t.statuses.mock.calls.length;
    stale.status("connected");
    expect(t.statuses).toHaveBeenCalledTimes(statusCount);
    current.status("closed");
    t.connection.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(t.create).toHaveBeenCalledTimes(2);
  });

  it("keeps transient disconnects on SDK retries until the retry budget is exhausted", async () => {
    vi.useFakeTimers();
    const t = setup(1);
    t.connection.start();
    await flush();
    t.sessions[0].status("disconnected");
    expect(t.create).toHaveBeenCalledTimes(1);
    t.sessions[0].status("disconnected");
    expect(t.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await flush();
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.sessions[1].order).toEqual(["login", "subscribe"]);
    t.connection.stop();
  });
});
