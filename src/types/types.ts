import type { PluginAccountConfig } from "../config.js";
export type { PluginConfig, PluginAccountConfig } from "../config.js";

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

export type RoomInfo = {
  id: string;
  name: string;
  type: "direct" | "group" | "channel";
};

export type RocketChatAttachmentRecord = {
  title?: string;
  title_link?: string;
  description?: string;
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

export type RocketChatFileRecord = {
  _id?: string;
  name?: string;
  type?: string;
  mimeType?: string;
  mimetype?: string;
  size?: number;
  url?: string;
  title_link?: string;
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
  attachments?: RocketChatAttachmentRecord[];
  file?: RocketChatFileRecord;
  files?: RocketChatFileRecord[];
};

export type RocketChatClientOptions = {
  serverUrl: string;
  auth: PluginAccountConfig["auth"];
  mediaDir?: string;
  fetch?: typeof fetch;
};

export type JsonObject = Record<string, unknown>;
