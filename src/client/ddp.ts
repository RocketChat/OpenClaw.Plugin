import { DDPSDK } from "@rocket.chat/ddp-client";
import type { RocketChatMessageRecord } from "../types.js";
import { DEFAULT_MAX_RECONNECTS } from "../cli/rate-limiter.js";

export type DdpStatus = "connecting" | "connected" | "ready" | "closed";

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
    this.subscription?.stop();
    this.sdk?.connection.close();
    this.sdk = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const maxReconnects = this.options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    this.options.onStatus?.("connecting");

    try {
      const sdk = DDPSDK.create(this.options.wsUrl, {
        retryCount: maxReconnects,
        retryTime: this.options.reconnectDelayMs ?? 2_000,
      });
      this.sdk = sdk;

      sdk.connection.on("connecting", () => this.options.onStatus?.("connecting"));
      sdk.connection.on("connected", () => {
        this.reconnectAttempts = 0;
        this.options.onStatus?.("connected");
      });
      sdk.connection.on("close", () => {
        this.options.onStatus?.("closed");
        if (!this.stopped) {
          this.reconnectAttempts++;
          if (this.reconnectAttempts > maxReconnects) {
            this.options.onError?.(
              new Error(
                `Max reconnect attempts (${maxReconnects}) exceeded for ${this.options.wsUrl}`,
              ),
            );
            return;
          }
          this.connect();
        }
      });

      await sdk.connection.connect();

      await sdk.account.loginWithToken(this.options.authToken);

      const sub = sdk.stream("room-messages", "__my_messages__", (...args: unknown[]) => {
        const message = args[0] as RocketChatMessageRecord | undefined;
        if (message) this.options.onMessage(message);
      });
      this.subscription = sub;
      await sub.ready();
      this.options.onStatus?.("ready");
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
