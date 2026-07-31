import { resolveOpenClawDir } from "../utils.js";
import { RocketChatClient } from "../client/rest.js";
import { parsePluginConfig } from "../config/schema.js";
import { CheckpointStore } from "../config/store.js";
import { getMessageAttachmentInputs, normalizeInboundAttachments } from "./attachments.js";
import { RocketChatDdpConnection } from "../client/ddp.js";
import type { InboundEvent, RocketChatSubscriptionRecord, RocketChatMessageRecord } from "../types.js";
import { shouldHandleInboundEvent, matchCommand } from "./channel.js";
import { appendGroupHistory, getAndClearGroupHistory } from "./group-history.js";
import { dispatchInboundEventWithChannelRuntime } from "./inbound.js";
import type {
  ResolvedAccount,
  OpenClawConfig,
  GatewayContext,
  OpenClawConfigLike,
  RocketChatIdentity,
  OutboundReplyPayload,
  ReplyDeliverInfo,
} from "../types.js";

const MAX_MESSAGE_LENGTH = 10_000;
const MAX_ATTACHMENTS = 5;

export type ClientEntry = { client: RocketChatClient; generation: number; wakeup: () => void };
export const activeClients = new Map<string, ClientEntry>();
let nextGeneration = 0;

let logger: { info: (msg: string) => void; error: (msg: string) => void } = {
  info: (msg: string) => console.log(`[RC] ${msg}`),
  error: (msg: string) => console.error(`[RC] ${msg}`),
};

export function resolveAccount(cfg: unknown, accountId?: string): ResolvedAccount | null {
  const config = parseChannelConfig(cfg as OpenClawConfig);
  if (!accountId) return null;
  const account = config.accounts[accountId];
  return account ? { ...account, accountId } : null;
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(parseChannelConfig(cfg).accounts);
}

export function isConfigured(account: Partial<ResolvedAccount> | null | undefined): boolean {
  if (!account?.serverUrl) return false;
  return Boolean(account.auth);
}



async function handleMessage(
  ctx: GatewayContext,
  event: InboundEvent,
  client: RocketChatClient,
  ddp: RocketChatDdpConnection | null,
  accountId: string,
  identityUsername: string,
): Promise<void> {
  const replyTmid = event.tmid ?? undefined;
  const channelRuntime = ctx.channelRuntime;
  if (!channelRuntime) return;

  const emoji = PROCESSING_EMOJIS[Math.floor(Math.random() * PROCESSING_EMOJIS.length)]!;
  await (ddp?.reactToMessage(event.messageId, emoji).catch(() => client.reactToMessage(event.messageId, emoji)) ?? client.reactToMessage(event.messageId, emoji)
  ).catch((err) => logger.error(`[rocketchat:${accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`));

  await ddp?.sendTyping(event.roomId, true).catch(() => {});

  const groupHistory = event.roomType === "direct" ? [] : getAndClearGroupHistory(accountId, event.roomId);

  await dispatchInboundEventWithChannelRuntime({
    cfg: (ctx.cfg ?? {}) as OpenClawConfigLike,
    accountId,
    event,
    groupHistory,
    identityUsername,
    channelRuntime,
    client,
    deliver: (payload, info) => sendReply(client, ddp, event.roomId, event.messageId, replyTmid, accountId, payload, info),
    onRecordError: (error) => {
      logger.error(`[rocketchat:${accountId}] failed to record inbound session: ${error instanceof Error ? error.message : String(error)}`);
    },
    onDispatchError: (error, info) => {
      const detail = error instanceof Error ? `${error.message}\n${error.stack}` : JSON.stringify(error);
      logger.error(`[rocketchat:${accountId}] ${info.kind} dispatch failed: ${detail}`);
    },
  });

  await ddp?.sendTyping(event.roomId, false).catch(() => {});
}

async function sendReply(
  client: RocketChatClient,
  ddp: RocketChatDdpConnection | null,
  roomId: string,
  messageId: string,
  replyTmid: string | undefined,
  accountId: string,
  payload: OutboundReplyPayload,
  info: ReplyDeliverInfo,
): Promise<void> {
  if (info.kind !== "final") return;

  await (ddp?.reactToMessage(messageId, ":white_check_mark:").catch(() => client.reactToMessage(messageId, ":white_check_mark:")) ?? client.reactToMessage(messageId, ":white_check_mark:")
  ).catch((err) => logger.error(`[rocketchat:${accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`));

  await ddp?.sendTyping(roomId, false).catch(() => {});

  const sendMsg = ddp?.sendMessage.bind(ddp) ?? client.postMessage.bind(client);

  if (payload.attachmentPath) {
    try {
      await client.uploadAttachment(roomId, payload.attachmentPath, payload.text, replyTmid ? { tmid: replyTmid } : undefined);
    } catch (err) {
      logger.error(`[rocketchat:${accountId}] upload failed: ${err instanceof Error ? err.message : String(err)}`);
      await sendMsg(roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
    }
  } else {
    await sendMsg(roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
  }
}

export async function startGateway(ctx: GatewayContext): Promise<void> {
  const account = ctx.account ?? resolveAccount(ctx.cfg ?? {}, ctx.accountId);
  if (!account || !account.enabled) {
    ctx.setStatus?.("disabled");
    return;
  }

  const client = new RocketChatClient({
    serverUrl: account.serverUrl,
    auth: account.auth,
  });

  const identity = await client.getIdentity();
  const generation = nextGeneration++;
  ctx.setStatus?.("connected");
  logger.info(`[rocketchat:${account.accountId}] connected as ${identity.username}`);

  const stateDir = resolveOpenClawDir();
  const checkpointPath = `${stateDir}/rocketchat/${account.accountId}.db`;
  const checkpoint = new CheckpointStore(checkpointPath, 250);
  const mentionNames = dedupeMentions([identity.username, ...account.mentionNames]);

  return startDdpGateway(ctx, account, identity, client, checkpoint, mentionNames, generation);
}

async function startDdpGateway(
  ctx: GatewayContext,
  account: ResolvedAccount,
  identity: RocketChatIdentity,
  client: RocketChatClient,
  checkpoint: CheckpointStore,
  mentionNames: string[],
  generation: number,
): Promise<void> {
  const accountId = account.accountId;
  const wsUrl = account.serverUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
  const reconnectDelayMs =
    account.transport.mode === "websocket" ? account.transport.reconnectDelayMs ?? 2_000 : 2_000;

  const stateData = await checkpoint.read();
  const seenIds = new Set(stateData.recentMessageIds);
  const processingMessages = new Set<string>();

  const markSeen = async (msgId: string): Promise<void> => {
    seenIds.add(msgId);
    await checkpoint.write({
      updatedSince: stateData.updatedSince,
      recentMessageIds: [...seenIds].slice(-250),
      failedMessages: stateData.failedMessages ?? [],
    });
  };

  const roomTypes = new Map<string, string>();
  try {
    const subs = await client.listSubscriptions(null);
    for (const sub of subs) {
      if (sub.rid && sub.t) roomTypes.set(sub.rid, sub.t);
    }
  } catch (err) {
    logger.error(`[rocketchat:${accountId}] failed to fetch subscriptions: ${err instanceof Error ? err.message : String(err)}`);
  }

  const connection = new RocketChatDdpConnection({
    wsUrl,
    authToken: identity.authToken,
    username: identity.username,
    reconnectDelayMs,
    onStatus: (status) => {
      logger.info(`[rocketchat:${accountId}] ddp status: ${status}`);
    },
    onError: (error) => logger.error(`[rocketchat:${accountId}] ddp error: ${error.message}`),
    onMessage: async (msg: RocketChatMessageRecord) => {
      if (shouldSkipMessage(msg, identity.userId, seenIds)) return;
      if (processingMessages.has(msg._id)) return;

      const sub: RocketChatSubscriptionRecord = { rid: msg.rid, t: roomTypes.get(msg.rid) ?? "c" };
      const event = await toInboundEvent(accountId, sub, msg, account.serverUrl, client);
      logger.info(`[rocketchat:${accountId}] inbound from ${event.senderName}: "${event.text.slice(0, 80)}"`);
      if (event.quotedText) {
        logger.info(`[rocketchat:${accountId}] quoted context (${event.quotedText.length} chars): "${event.quotedText.slice(0, 120)}"`);
      }

      if (!shouldHandleInboundEvent(event, { botUserId: identity.userId, mentionNames })) {
        if (event.roomType !== "direct") {
          appendGroupHistory(accountId, event.roomId, {
            sender: event.senderName,
            body: event.text,
            timestamp: Date.now(),
          });
        }
        return;
      }

      const cmdResult = matchCommand(event.text);
      if (cmdResult.action === "reply") {
        const sendCmd = connection?.sendMessage.bind(connection) ?? client.postMessage.bind(client);
        const tmidOpt = event.tmid ? { tmid: event.tmid } : undefined;
        try {
          await sendCmd(event.roomId, cmdResult.replyText, tmidOpt);
        } catch (err) {
          logger.error(`[rocketchat:${accountId}] command reply failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await markSeen(msg._id);
        return;
      }

      await markSeen(msg._id);

      if (ctx.channelRuntime) {
        processingMessages.add(msg._id);
        try {
          await handleMessage(ctx, event, client, connection, accountId, identity.username);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.error(`[rocketchat:${accountId}] failed to handle message ${event.messageId}: ${reason}`);
          await checkpoint.recordFailure({
            messageId: event.messageId,
            roomId: event.roomId,
            senderName: event.senderName,
            sentAt: event.sentAt,
            failedAt: new Date().toISOString(),
            reason,
          });
        } finally {
          processingMessages.delete(msg._id);
        }
      } else {
        logger.error(`[rocketchat:${accountId}] channel runtime unavailable; inbound message ignored`);
      }
    },
  });

  const wakeup = () => {
    logger.info(`[rocketchat:${accountId}] ddp wakeup (no-op for websocket transport)`);
  };

  activeClients.set(accountId, { client, generation, wakeup });
  connection.start();

  try {
    await new Promise<void>((resolve) => {
      if (ctx.abortSignal?.aborted) {
        resolve();
        return;
      }
      ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    connection.stop();
    const current = activeClients.get(accountId);
    if (current?.generation === generation) {
      activeClients.delete(accountId);
    }
    ctx.setStatus?.("stopped");
  }
}

function shouldSkipMessage(
  msg: import("../types.js").RocketChatMessageRecord,
  botUserId: string,
  seenIds: Set<string>,
): boolean {
  if (!msg._id) return true;
  if (msg.t && getMessageAttachmentInputs(msg).length === 0) return true;
  if ((!msg.msg || msg.msg.trim().length === 0) && getMessageAttachmentInputs(msg).length === 0) return true;
  if (msg.u?._id === botUserId) return true;
  if (seenIds.has(msg._id)) return true;
  return false;
}

async function toInboundEvent(
  accountId: string,
  sub: import("../types.js").RocketChatSubscriptionRecord,
  msg: import("../types.js").RocketChatMessageRecord,
  serverUrl: string | undefined,
  client: RocketChatClient | null,
): Promise<InboundEvent> {
  const rawAttachments = getMessageAttachmentInputs(msg);

  let quotedText: string | undefined;
  let nextQuotedId: string | null = msg.tmid ?? extractQuotedMessageId(msg) ?? null;
  const maxDepth = 4;
  let depth = 0;
  while (nextQuotedId && client && depth < maxDepth) {
    try {
      const fetched = await client.getMessage(nextQuotedId);
      const fetchedText = fetched.text;
      if (fetchedText && !isQuoteLinkOnly(fetchedText)) {
        quotedText = fetchedText.slice(0, MAX_MESSAGE_LENGTH);
        break;
      }
      nextQuotedId = fetched.quotedId;
    } catch {
      break;
    }
    depth++;
  }

  return {
    accountId,
    roomId: msg.rid,
    roomType: mapRoomType(sub.t),
    messageId: msg._id,
    tmid: msg.tmid ?? null,
    senderId: msg.u?._id ?? "",
    senderName: msg.u?.username ?? msg.u?.name ?? "",
    text: (msg.msg ?? "").slice(0, MAX_MESSAGE_LENGTH),
    mentions: (msg.mentions ?? []).map((m) => m.username ?? m.name ?? "").filter(Boolean),
    attachments: normalizeInboundAttachments(rawAttachments.slice(0, MAX_ATTACHMENTS), serverUrl ? { serverUrl } : undefined),
    ...(quotedText ? { quotedText } : {}),
    sentAt: msg.ts ?? new Date(0).toISOString(),
    raw: msg,
  };
}

function extractQuotedMessageId(msg: import("../types.js").RocketChatMessageRecord): string | undefined {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  for (const att of attachments) {
    const record = att as { message_link?: string };
    const link = typeof record.message_link === "string" ? record.message_link : "";
    const match = link.match(/[?&]msg=([A-Za-z0-9]+)/);
    if (match) return match[1];
  }
  return undefined;
}

function isQuoteLinkOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[ ](") && !trimmed.startsWith("[![](")) return false;
  return /[?&]msg=[A-Za-z0-9]+/.test(trimmed);
}

function mapRoomType(t: string | undefined): InboundEvent["roomType"] {
  if (t === "d") return "direct";
  if (t === "p") return "group";
  return "channel";
}

const PROCESSING_EMOJIS = [
  ":eyes:", ":thinking:", ":hourglass:", ":gear:",
  ":robot:", ":arrows_counterclockwise:", ":bulb:", ":mag:"
];

function dedupeMentions(mentions: string[]): string[] {
  return [...new Set(mentions.map((mention) => mention.trim()).filter(Boolean))];
}

function parseChannelConfig(cfg: OpenClawConfig): ReturnType<typeof parsePluginConfig> {
  const nestedConfig = cfg.channels?.rocketchat;
  if (nestedConfig) return parsePluginConfig(nestedConfig);
  if (isPluginConfigLike(cfg)) return parsePluginConfig(cfg);
  return { accounts: {} };
}

function isPluginConfigLike(input: unknown): input is Parameters<typeof parsePluginConfig>[0] {
  return Boolean(input && typeof input === "object" && "accounts" in input);
}
