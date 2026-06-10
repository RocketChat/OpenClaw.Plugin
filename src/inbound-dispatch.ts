import type { InboundEvent, OpenClawConfigLike, OutboundReplyPayload, ReplyDeliverInfo, ChannelRuntimeLike } from "./types/types.js";

export async function dispatchInboundEventWithChannelRuntime(params: {
  cfg: OpenClawConfigLike;
  accountId: string;
  event: InboundEvent;
  channelRuntime: ChannelRuntimeLike;
  agent?: string | undefined;
  deliver(payload: OutboundReplyPayload, info: ReplyDeliverInfo): Promise<void>;
  onRecordError(err: unknown): void;
  onDispatchError(err: unknown, info: ReplyDeliverInfo): void;
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
  const mediaUrls = Array.isArray(record.mediaUrls)
    ? record.mediaUrls.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;

  const text = typeof record.text === "string" ? record.text : undefined;
  const mediaUrl = typeof record.mediaUrl === "string" ? record.mediaUrl : undefined;
  const replyToId = typeof record.replyToId === "string" ? record.replyToId : undefined;

  return {
    ...(text ? { text } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrls && mediaUrls.length > 0 ? { mediaUrls } : {}),
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

function toEpochMs(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}
