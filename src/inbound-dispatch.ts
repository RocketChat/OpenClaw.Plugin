import type { InboundEvent, OpenClawConfigLike, OutboundReplyPayload, ReplyDeliverInfo, ChannelRuntimeLike, InboundAttachment } from "./types/types.js";
import type { RocketChatClient } from "./client.js";

export async function dispatchInboundEventWithChannelRuntime(params: {
  cfg: OpenClawConfigLike;
  accountId: string;
  event: InboundEvent;
  channelRuntime: ChannelRuntimeLike;
  deliver(payload: OutboundReplyPayload, info: ReplyDeliverInfo): Promise<void>;
  onRecordError(err: unknown): void;
  onDispatchError(err: unknown, info: ReplyDeliverInfo): void;
  client?: RocketChatClient;
}): Promise<void> {
  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "rocketchat",
    accountId: params.accountId,
    peer: {
      kind: params.event.roomType,
      id: params.event.roomId,
    },
  });

  const storePath = params.channelRuntime.session.resolveStorePath(
    params.cfg.session?.store,
    { agentId: route.agentId },
  );

  const previousTimestamp = params.channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const envelopeOptions = params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg);
  const timestamp = toEpochMs(params.event.sentAt);
  const to = buildRecipientAddress(params.event);

  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Rocket.Chat",
    from: buildConversationLabel(params.event),
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: params.event.text,
  });

  const ctxPayload = params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.event.text,
    RawBody: params.event.text,
    CommandBody: params.event.text,
    From: buildSenderAddress(params.event),
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: params.event.roomType,
    ConversationLabel: buildConversationLabel(params.event),
    GroupSubject: params.event.roomType === "direct" ? undefined : params.event.roomId,
    SenderId: params.event.senderId,
    Provider: "rocketchat",
    Surface: "rocketchat",
    MessageSid: params.event.messageId,
    MessageSidFull: params.event.messageId,
    Timestamp: timestamp,
    OriginatingChannel: "rocketchat",
    OriginatingTo: to,
    ...(await buildMediaContext(params.event.attachments, params.client)),
  });

  await params.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey ?? route.sessionKey,
      channel: "rocketchat",
      to,
      accountId: route.accountId ?? params.accountId,
    },
    onRecordError: params.onRecordError,
  });

  await params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        await params.deliver(normalizeOutboundReplyPayload(payload), info);
      },
      onError: params.onDispatchError,
    },
  });
}

function normalizeOutboundReplyPayload(payload: unknown): OutboundReplyPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;

  const text = typeof record.text === "string" ? record.text : undefined;
  const mediaUrl = typeof record.mediaUrl === "string" ? record.mediaUrl : undefined;
  const mediaUrls = Array.isArray(record.mediaUrls)
    ? record.mediaUrls.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  const attachmentPath = typeof record.attachmentPath === "string" ? record.attachmentPath : undefined;
  const replyToId = typeof record.replyToId === "string" ? record.replyToId : undefined;

  return {
    ...(text ? { text } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrls && mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(attachmentPath ? { attachmentPath } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
}

function buildConversationLabel(event: InboundEvent): string {
  if (event.roomType === "direct") {
    return `${event.senderName} (${event.senderId})`;
  }
  return `${event.roomType}:${event.roomId}`;
}

function buildSenderAddress(event: InboundEvent): string {
  return `rocketchat:${event.senderId}`;
}

function buildRecipientAddress(event: InboundEvent): string {
  return `rocketchat:${event.roomId}`;
}

async function buildMediaContext(
  attachments: InboundAttachment[],
  client?: RocketChatClient,
): Promise<Record<string, unknown>> {
  if (attachments.length === 0) return {};

  const results = await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.url && client) {
        try {
          const filePath = await client.downloadAttachmentToTempFile(attachment.url, attachment.fileName ? { fileName: attachment.fileName } : undefined);
          return { kind: "path" as const, value: filePath, mimeType: attachment.mimeType };
        } catch {
          // download failed — fall through to URL injection
        }
      }

      if (attachment.url) {
        return { kind: "url" as const, value: attachment.url, mimeType: attachment.mimeType };
      }

      return null;
    }),
  );

  const mediaUrls: string[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];

  for (const r of results) {
    if (!r) continue;
    if (r.kind === "path") {
      mediaPaths.push(r.value);
    } else {
      mediaUrls.push(r.value);
    }
    if (r.mimeType) mediaTypes.push(r.mimeType);
  }

  return {
    ...(mediaUrls.length > 0 ? { MediaUrl: mediaUrls[0], MediaUrls: mediaUrls } : {}),
    ...(mediaPaths.length > 0 ? { MediaPath: mediaPaths[0], MediaPaths: mediaPaths } : {}),
    ...(mediaTypes.length > 0 ? { MediaType: mediaTypes[0], MediaTypes: mediaTypes } : {}),
  };
}

function toEpochMs(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}
