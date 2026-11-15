import { DDPSDK } from "@rocket.chat/ddp-client";
import type { RocketChatMessageRecord } from "../types.js";
import { DEFAULT_MAX_RECONNECTS } from "../cli/rate-limiter.js";

export type DdpStatus = "connecting" | "connected" | "ready" | "closed" | "failed";

export type RocketChatDdpConnectionOptions = {
  wsUrl: string;
  authToken: string;
  username: string;
  reconnectDelayMs?: number | undefined;
  maxReconnects?: number | undefined;
  onMessage: (message: RocketChatMessageRecord) => void;
  onStatus?: (status: DdpStatus) => void;
  onError?: (error: Error) => void;
};

type DdpMethodParams = Record<string, unknown>;

export class RocketChatDdpConnection {
  private readonly options: RocketChatDdpConnectionOptions;
  private sdk: DDPSDK | null = null;
  private subscription: ReturnType<DDPSDK["stream"]> | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(options: RocketChatDdpConnectionOptions) {
    this.options = options;
  }

  private getSdk(): DDPSDK {
    if (!this.sdk) throw new Error("DDP SDK not initialized; connection not started");
    return this.sdk;
  }

  private async call(method: string, ...params: unknown[]): Promise<unknown> {
    return this.getSdk().call(method, ...params);
  }

  async sendMessage(roomId: string, text: string, options?: { tmid?: string }): Promise<string> {
    const message: DdpMethodParams = { rid: roomId, msg: text };
    if (options?.tmid) message.tmid = options.tmid;
    const result = (await this.call("sendMessage", message)) as DdpMethodParams;
    return (result as { _id?: string })._id ?? "";
  }

  async reactToMessage(messageId: string, reaction: string): Promise<void> {
    await this.call("setReaction", reaction, messageId);
  }

  async sendTyping(roomId: string, isTyping: boolean): Promise<void> {
    await this.call("stream-notify-room", `${roomId}/typing`, this.options.username, isTyping);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const subscription = this.subscription;
    const sdk = this.sdk;
    this.subscription = null;
    this.sdk = null;
    subscription?.stop();
    sdk?.timeoutControl.stop();
    sdk?.connection.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const maxReconnects = this.options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    const reconnectDelayMs = this.options.reconnectDelayMs ?? 2_000;
    const generation = ++this.generation;
    const isGenerationCurrent = () => !this.stopped && this.generation === generation;

    const previousSubscription = this.subscription;
    const previousSdk = this.sdk;
    this.subscription = null;
    this.sdk = null;
    previousSubscription?.stop();
    previousSdk?.timeoutControl.stop();
    previousSdk?.connection.close();

    this.options.onStatus?.("connecting");
    if (!isGenerationCurrent()) return;

    let currentSdk: DDPSDK | null = null;
    const isCurrent = () => isGenerationCurrent() && currentSdk !== null && this.sdk === currentSdk;

    try {
      const sdk = DDPSDK.create(this.options.wsUrl, {
        retryCount: maxReconnects,
        retryTime: reconnectDelayMs,
      });
      currentSdk = sdk;
      this.sdk = sdk;
      this.reconnectAttempts = 0;

      const scheduleReconnect = () => {
        if (!isCurrent() || this.reconnectTimer !== null) return;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (isCurrent()) void this.connect();
        }, reconnectDelayMs);
      };

      sdk.connection.on("connection", (status) => {
        if (!isCurrent()) return;

        switch (status) {
          case "connecting":
          case "reconnecting":
            this.options.onStatus?.("connecting");
            break;
          case "connected":
            this.reconnectAttempts = 0;
            this.options.onStatus?.("connected");
            break;
          case "disconnected":
            this.options.onStatus?.("closed");
            this.reconnectAttempts++;
            if (this.reconnectAttempts > maxReconnects) scheduleReconnect();
            break;
          case "closed":
            this.options.onStatus?.("closed");
            scheduleReconnect();
            break;
          case "failed":
            this.options.onStatus?.("failed");
            break;
          case "idle":
            break;
        }
      });

      await sdk.connection.connect();
      if (!isCurrent()) return;

      await sdk.account.loginWithToken(this.options.authToken);
      if (!isCurrent()) return;

      const sub = sdk.stream("room-messages", "__my_messages__", (...args: unknown[]) => {
        if (!isCurrent()) return;
        const message = args[0] as RocketChatMessageRecord | undefined;
        if (message) this.options.onMessage(message);
      });
      this.subscription = sub;
      await sub.ready();
      if (!isCurrent()) return;
      this.options.onStatus?.("ready");
    } catch (err) {
      if (!isGenerationCurrent()) return;
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
