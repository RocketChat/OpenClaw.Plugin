import type { PluginAccountConfig } from "../config.js";
export type { PluginConfig, PluginAccountConfig } from "../config.js";

export type InboundAttachmentKind = "image" | "audio" | "document" | "video" | "unknown";

export type InboundAttachment = {
  kind: InboundAttachmentKind;
  mimeType?: string;
  fileName?: string;
  url?: string;
  sizeBytes?: number;
  source: "rocketchat-attachment" | "rocketchat-file";
  raw: unknown;
};

export type RocketChatIdentity = {
  userId: string;
  authToken: string;
  username: string;
  displayName: string;
};

export type RocketChatSubscriptionRecord = {
  rid: string;
  name?: string;
  fname?: string;
  t?: string;
  _updatedAt?: string;
  updatedAt?: string;
};

export type RocketChatMessageRecord = {
  _id: string;
  rid: string;
  msg?: string;
  ts?: string;
  _updatedAt?: string;
  t?: string;
  tmid?: string;
  u?: {
    _id?: string;
    username?: string;
    name?: string;
  };
  mentions?: Array<{
    username?: string;
    name?: string;
  }>;
  attachments?: unknown[];
  file?: unknown;
  files?: unknown[];
};

export type RocketChatClientOptions = {
  serverUrl: string;
  auth: PluginAccountConfig["auth"];
  fetch?: typeof fetch;
};

export type JsonObject = Record<string, unknown>;

export type ResolvedAccount = PluginAccountConfig & {
  accountId: string;
};

export type OpenClawConfig = {
  session?: { store?: string };
  channels?: { rocketchat?: unknown };
};

export type GatewayContext = {
  accountId: string;
  account?: ResolvedAccount;
  cfg?: OpenClawConfig;
  abortSignal?: AbortSignal;
  channelRuntime?: ChannelRuntimeLike;
  setStatus?: (status: string) => void;
};

export type InboundEvent = {
  accountId: string;
  roomId: string;
  roomType: "direct" | "group" | "channel";
  messageId: string;
  tmid: string | null;
  senderId: string;
  senderName: string;
  text: string;
  mentions: string[];
  attachments: InboundAttachment[];
  sentAt: string;
  raw: RocketChatMessageRecord;
};

export type OpenClawConfigLike = OpenClawConfig;

export type RoutePeer = {
  kind: InboundEvent["roomType"];
  id: string;
};

export type ResolvedAgentRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
  mainSessionKey?: string;
};

export type FinalizedContext = Record<string, unknown> & {
  SessionKey?: string;
};

export type OutboundReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  attachmentPath?: string;
  replyToId?: string;
};

export type ReplyDeliverInfo = {
  kind: "tool" | "block" | "final";
};

export type ChannelRuntimeLike = {
  routing: {
    resolveAgentRoute(params: {
      cfg: OpenClawConfigLike;
      channel: string;
      accountId: string;
      peer: RoutePeer;
    }): ResolvedAgentRoute;
  };
  session: {
    resolveStorePath(store: string | undefined, opts: { agentId: string }): string;
    readSessionUpdatedAt(params: { storePath: string; sessionKey: string }): number | undefined;
    recordInboundSession(params: {
      storePath: string;
      sessionKey: string;
      ctx: FinalizedContext;
      updateLastRoute?: {
        sessionKey: string;
        channel: string;
        to: string;
        accountId?: string;
      };
      onRecordError(err: unknown): void;
    }): Promise<void>;
  };
  reply: {
    resolveEnvelopeFormatOptions(cfg: OpenClawConfigLike): unknown;
    formatAgentEnvelope(params: {
      channel: string;
      from: string;
      timestamp?: number | undefined;
      previousTimestamp?: number | undefined;
      envelope: unknown;
      body: string;
    }): string;
    finalizeInboundContext<T extends Record<string, unknown>>(ctx: T): T & FinalizedContext;
    dispatchReplyWithBufferedBlockDispatcher(params: {
      ctx: FinalizedContext;
      cfg: OpenClawConfigLike;
      dispatcherOptions: {
        deliver(payload: unknown, info: { kind: "tool" | "block" | "final" }): Promise<void>;
        onError?(err: unknown, info: { kind: "tool" | "block" | "final" }): void;
      };
    }): Promise<unknown>;
  };
};

export type ChannelRuleOptions = {
  botUserId: string;
  mentionNames: string[];
};

export type CheckpointState = {
  updatedSince: string | null;
  recentMessageIds: string[];
};

export type GatewayApi = {
  registerGatewayMethod(name: string, handler: (ctx: unknown) => Promise<void>): void;
  registerChannel?(args: { plugin: unknown }): void;
};

export type AuthCredentials =
  | { mode: "token"; userId: string; accessToken: string }
  | { mode: "password"; username: string; password: string };

export type AccountCredentials = {
  accountId: string;
  auth: AuthCredentials;
  bot?: {
    username: string;
    userId: string;
  };
  createdAt: string;
};

export type RCLoginResult = {
  userId: string;
  authToken: string;
};

export type RCUser = {
  _id: string;
  username: string;
  name: string;
};

export type AttachmentRecord = {
  _id?: string;
  title?: string;
  title_link?: string;
  url?: string;
  image_url?: string;
  video_url?: string;
  audio_url?: string;
  type?: string;
  mimeType?: string;
  mimetype?: string;
  contentType?: string;
  name?: string;
  filename?: string;
  size?: number;
};


