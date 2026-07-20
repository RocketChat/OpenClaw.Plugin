import WebSocket, { type RawData } from "ws";

import type { RocketChatMessageRecord } from "./types/types.js";

export type DdpStatus = "connecting" | "connected" | "ready" | "closed";

export type RocketChatDdpConnectionOptions = {
  wsUrl: string;
  authToken: string;
  /** Base reconnect delay in ms (seeded from config). Default 2000. */
  reconnectDelayMs?: number;
  /** Max reconnect backoff in ms. Default 60_000. */
  reconnectMaxMs?: number;
  /** Silence (no inbound DDP traffic) before force-terminating, in ms. Default 120_000. */
  watchdogMs?: number;
  onMessage: (message: RocketChatMessageRecord) => void;
  onStatus?: (status: DdpStatus) => void;
  onError?: (error: Error) => void;
};

type DDPMessage = {
  msg?: string;
  id?: string;
  method?: string;
  collection?: string;
  fields?: { eventName?: string; args?: unknown[] };
  result?: unknown;
  error?: unknown;
};

/**
 * Real-time inbound transport for Rocket.Chat using the DDP protocol over a
 * WebSocket. Connects, resumes the session with the existing auth token, and
 * subscribes to `__my_messages__` so every message sent to the bot user in any
 * room is pushed as a `changed` event. Includes a watchdog (detects silently
 * dead sockets) and exponential-backoff reconnection.
 *
 * Outbound (replies, reactions, uploads) remains the responsibility of
 * RocketChatClient over REST — this connection is receive-only.
 */
export class RocketChatDdpConnection {
  private readonly wsUrl: string;
  private readonly authToken: string;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxMs: number;
  private readonly watchdogMs: number;
  private readonly onMessage: (message: RocketChatMessageRecord) => void;
  private readonly onStatus: ((status: DdpStatus) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;

  private ws: WebSocket | null = null;
  private ddpIdCounter = 0;
  private reconnectAttempts = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;
  private loginId: string | null = null;
  private stopped = false;

  constructor(options: RocketChatDdpConnectionOptions) {
    this.wsUrl = options.wsUrl;
    this.authToken = options.authToken;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 60_000;
    this.watchdogMs = options.watchdogMs ?? 120_000;
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.ws?.terminate();
    this.ws = null;
  }

  private nextDdpId(): string {
    return `openclaw-ddp-${++this.ddpIdCounter}`;
  }

  private connect(): void {
    if (this.stopped) return;
    this.onStatus?.("connecting");
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    const resetWatchdog = () => {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        this.onError?.(new Error("DDP watchdog timeout — no traffic, terminating stale connection"));
        ws.terminate();
      }, this.watchdogMs);
    };

    const ddpSend = (msg: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        resetWatchdog();
      }
    };

    ws.on("open", () => {
      resetWatchdog();
      ddpSend({ msg: "connect", version: "1", support: ["1"] });
    });

    ws.on("message", (raw: RawData) => {
      resetWatchdog();
      let data: DDPMessage;
      try {
        const str = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
        data = JSON.parse(str) as DDPMessage;
      } catch {
        return;
      }

      if (data.msg === "ping") {
        ddpSend({ msg: "pong", id: data.id });
        return;
      }

      if (data.msg === "connected") {
        this.loginId = this.nextDdpId();
        ddpSend({ msg: "method", method: "login", id: this.loginId, params: [{ resume: this.authToken }] });
        return;
      }

      if (data.msg === "result" && data.id === this.loginId) {
        if (data.error) {
          const errMsg =
            typeof data.error === "object"
              ? ((data.error as { message?: string }).message ?? JSON.stringify(data.error))
              : String(data.error);
          this.onError?.(new Error(`DDP login failed: ${errMsg}`));
          ws.close();
          return;
        }
        this.authenticated = true;
        ddpSend({
          msg: "sub",
          id: this.nextDdpId(),
          name: "stream-room-messages",
          params: ["__my_messages__", { useCollection: false, args: [] }],
        });
        return;
      }

      if (data.msg === "ready") {
        this.reconnectAttempts = 0;
        this.onStatus?.("ready");
        return;
      }

      if (data.msg === "changed" && data.collection === "stream-room-messages") {
        const args = data.fields?.args;
        if (Array.isArray(args) && args.length > 0) {
          const message = args[0] as RocketChatMessageRecord;
          if (message && message._id) {
            this.onMessage(message);
          }
        }
      }
    });

    ws.on("close", () => {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.authenticated = false;
      this.loginId = null;
      this.onStatus?.("closed");
      if (this.stopped) return;
      const delay = Math.min(
        this.reconnectDelayMs * 2 ** this.reconnectAttempts,
        this.reconnectMaxMs,
      );
      this.reconnectAttempts += 1;
      setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err: Error) => {
      this.onError?.(err);
      ws.close();
    });
  }
}
