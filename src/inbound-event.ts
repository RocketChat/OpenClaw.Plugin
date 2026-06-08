import type { RocketChatMessageRecord } from "./types/types.js";

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

export type InboundDispatch = (event: InboundEvent) => Promise<void>;
