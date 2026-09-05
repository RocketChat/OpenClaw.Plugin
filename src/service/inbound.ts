import type {
  InboundEvent,
  OpenClawConfigLike,
  OutboundReplyPayload,
  ReplyDeliverInfo,
  ChannelRuntimeLike,
  InboundAttachment,
} from "../types.js";
import type { RocketChatClient } from "../client/rest.js";
import type { GroupHistoryEntry } from "./group-history.js";
import { parsePluginConfig } from "../config/schema.js";

const DEFAULT_OWNER_ONLY_SKILLS = ["email"];

function readAccountPolicy(
  cfg: OpenClawConfigLike,
  accountId: string,
): { owner: string | undefined; ownerOnlySkills: string[] } {
  try {
    const nested = cfg.channels?.rocketchat;
    const parsed = nested
      ? parsePluginConfig(nested as never)
      : cfg && typeof cfg === "object" && "accounts" in cfg
        ? parsePluginConfig(cfg as never)
        : { accounts: {} };
    const account = parsed.accounts[accountId];
    return {
      owner: account?.owner,
      ownerOnlySkills:
        account?.ownerOnlySkills && account.ownerOnlySkills.length > 0
          ? account.ownerOnlySkills
          : DEFAULT_OWNER_ONLY_SKILLS,
    };
  } catch {
    return { owner: undefined, ownerOnlySkills: [] };
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/^@+/, "").toLowerCase();
}

function buildOwnerOnlyGuardrail(
  senderName: string,
  owner: string | undefined,
  ownerOnlySkills: string[],
): string {
  if (!owner || ownerOnlySkills.length === 0) return "";
  if (normalizeName(senderName) === normalizeName(owner)) return "";
  return [
    ``,
    `[SECURITY POLICY]`,
    `The sender (@${senderName}) is NOT the bot owner (@${owner}).`,
    `You MUST refuse any request that uses the following owner-only skills: ${ownerOnlySkills.join(", ")}.`,
    `If the user asks for any of these, politely decline and explain that only @${owner} can do it.`,
    `[/SECURITY POLICY]`,
  ].join("\n");
}

export async function dispatchInboundEventWithChannelRuntime(params: {
  cfg: OpenClawConfigLike;
  accountId: string;
  event: InboundEvent;
  groupHistory?: GroupHistoryEntry[];
  identityUsername: string;
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

  // Per-bot, per-sender session isolation: multiple bots bound to the same agent
  // get separate conversation histories by including the bot accountId in the key,
  // and each sender in a shared room gets its own history by including senderId.
  // accountId is the stable routing key (one bot = one agent), so this guarantees
  // two bots sharing an agent (e.g. fallback to main) do not bleed memory into each other,
  // and owner-only context (e.g. email/inbox data) does not leak into non-owner sessions.
  const botAwareSessionKey = `${route.sessionKey}:${params.accountId}:${params.event.senderId}`;

  const storePath = params.channelRuntime.session.resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = params.channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: botAwareSessionKey,
  });

  const envelopeOptions = params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg);
  const timestamp = toEpochMs(params.event.sentAt);
  const to = buildRecipientAddress(params.event);

  const bodyForAgent = buildBodyForAgent(params.event, params.groupHistory);

  const { owner, ownerOnlySkills } = readAccountPolicy(params.cfg, params.accountId);
  const guardrail = buildOwnerOnlyGuardrail(params.event.senderName, owner, ownerOnlySkills);
  const bodyForAgentWithGuardrail = guardrail ? `${bodyForAgent}\n\n${guardrail}` : bodyForAgent;

  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Rocket.Chat",
    from: buildConversationLabel(params.event),
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgentWithGuardrail,
  });

  const isCommand = params.event.text.startsWith("/");
  const ctxPayload = params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgentWithGuardrail,
    RawBody: params.event.text,
    CommandBody: params.event.text,
    From: buildSenderAddress(params.event),
    To: to,
    SessionKey: botAwareSessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: params.event.roomType,
    ConversationLabel: buildConversationLabel(params.event),
    GroupSubject: params.event.roomType === "direct" ? undefined : params.event.roomId,
    SenderId: params.event.senderId,
    WasMentioned:
      params.event.roomType !== "direct" && params.event.mentions.includes(params.identityUsername),
    Provider: "rocketchat",
    Surface: "rocketchat",
    MessageSid: params.event.messageId,
    MessageSidFull: params.event.messageId,
    ...(params.event.tmid ? { ThreadRootSid: params.event.tmid } : {}),
    Timestamp: timestamp,
    OriginatingChannel: "rocketchat",
    OriginatingTo: to,
    ...(isCommand ? { CommandSource: "text" as const, CommandAuthorized: true } : {}),
    ...(await buildMediaContext(params.event.attachments, params.client)),
  });

  await params.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? botAwareSessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey ?? botAwareSessionKey,
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
    ? record.mediaUrls.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : undefined;
  const attachmentPath =
    typeof record.attachmentPath === "string" ? record.attachmentPath : undefined;
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
      if (attachment.source === "rocketchat-file" && attachment.url && client) {
        try {
          const filePath = await client.downloadAttachmentToTempFile(
            attachment.url,
            attachment.fileName ? { fileName: attachment.fileName } : undefined,
          );
          return { kind: "path" as const, value: filePath, mimeType: attachment.mimeType };
        } catch {
          return null;
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

function buildBodyForAgent(event: InboundEvent, groupHistory: GroupHistoryEntry[] = []): string {
  const labeled = labelGroupSender(event);
  const historyText = formatHistoryForBody(groupHistory);

  if (!event.quotedText) {
    return historyText ? `${labeled}\n\n${historyText}` : labeled;
  }

  const trailer = historyText ? `\n\n${historyText}` : "";
  return [
    `The user is replying to / quoting the following message in this channel:`,
    `---`,
    event.quotedText,
    `---`,
    ``,
    `The user's question or instruction about the quoted message above: ${event.text}`,
    ``,
    `Answer the user's question by referring to the quoted content above.`,
    ``,
    `(Sender: ${event.senderName})${trailer}`,
  ].join("\n");
}

function formatHistoryForBody(history: GroupHistoryEntry[]): string {
  if (history.length === 0) return "";
  const lines = history.map((h) => `[${h.sender}]: ${h.body}`).join("\n");
  return `Recent messages in this room (oldest to newest):\n${lines}`;
}

function labelGroupSender(event: InboundEvent): string {
  if (event.roomType === "direct") return event.text;
  return `${event.senderName} (@${event.senderName}): ${event.text}`;
}
