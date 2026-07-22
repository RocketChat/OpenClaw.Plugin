import { DDPSDK } from "@rocket.chat/ddp-client";
import type { RocketChatMessageRecord } from "./types/types.js";

export type DdpStatus = "connecting" | "connected" | "ready" | "closed";

export type RocketChatDdpConnectionOptions = {
  wsUrl: string;
  authToken: string;
  reconnectDelayMs?: number;
  onMessage: (message: RocketChatMessageRecord) => void;
  onStatus?: (status: DdpStatus) => void;
  onError?: (error: Error) => void;
};

export class RocketChatDdpConnection {
  private readonly options: RocketChatDdpConnectionOptions;
  private sdk: DDPSDK | null = null;
  private subscription: ReturnType<DDPSDK["stream"]> | null = null;
  private stopped = false;

  constructor(options: RocketChatDdpConnectionOptions) {
    this.options = options;
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
    this.options.onStatus?.("connecting");

    try {
      const sdk = DDPSDK.create(this.options.wsUrl, {
        retryCount: Infinity,
        retryTime: this.options.reconnectDelayMs ?? 2_000,
      });
      this.sdk = sdk;

      sdk.connection.on("connecting", () => this.options.onStatus?.("connecting"));
      sdk.connection.on("connected", () => this.options.onStatus?.("connected"));
      sdk.connection.on("close", () => {
        this.options.onStatus?.("closed");
        if (!this.stopped) this.connect();
      });

      await sdk.connection.connect();

      await sdk.account.loginWithToken(this.options.authToken);

      const sub = sdk.stream(
        "room-messages",
        "__my_messages__",
        (...args: unknown[]) => {
          const message = args[0] as RocketChatMessageRecord | undefined;
          if (message) this.options.onMessage(message);
        },
      );
      this.subscription = sub;
      await sub.ready();
      this.options.onStatus?.("ready");
    } catch (err) {
      this.options.onError?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}
