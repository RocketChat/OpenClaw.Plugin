import { resolveOpenClawDir } from "./utils.js";
import { RocketChatClient, RocketChatRateLimitError } from "./client.js";
import { parsePluginConfig } from "./config.js";
import { FileCheckpointStore } from "./checkpoint-store.js";
import { getMessageAttachmentInputs, normalizeInboundAttachments } from "./attachments.js";
import type { InboundEvent } from "./types/types.js";
import { shouldHandleInboundEvent } from "./channel.js";
import { dispatchInboundEventWithChannelRuntime } from "./inbound-dispatch.js";
import type {
  ResolvedAccount,
  OpenClawConfig,
  GatewayContext,
  OpenClawConfigLike,
  RocketChatIdentity,
  OutboundReplyPayload,
  ReplyDeliverInfo,
} from "./types/types.js";

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

class PollState {
  blockedUntilMs = 0;
  consecutiveEmptyPolls = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  stopped = false;
  warnedAboutMissingRuntime = false;

  getInterval(): number {
    if (this.consecutiveEmptyPolls < 3) return 1_000;
    if (this.consecutiveEmptyPolls < 10) return 3_000;
    if (this.consecutiveEmptyPolls < 20) return 10_000;
    return 20_000;
  }

  recordCycle(foundMessages: boolean): void {
    this.consecutiveEmptyPolls = foundMessages ? 0 : this.consecutiveEmptyPolls + 1;
  }

  block(ms: number): void {
    this.blockedUntilMs = Date.now() + ms;
    this.consecutiveEmptyPolls = Math.max(this.consecutiveEmptyPolls, 10);
  }

  isBlocked(): boolean {
    return Date.now() < this.blockedUntilMs;
  }

  resetBackoff(): void {
    this.consecutiveEmptyPolls = 0;
  }
}

async function pollOnce(
  client: RocketChatClient,
  checkpoint: FileCheckpointStore,
  identity: RocketChatIdentity,
  mentionNames: string[],
  ctx: GatewayContext,
  account: ResolvedAccount,
  state: PollState,
): Promise<void> {
  const stateData = await checkpoint.read();
  if (!stateData.updatedSince) {
    const lookback = new Date(Date.now() - 300_000).toISOString();
    await checkpoint.write({ updatedSince: lookback, recentMessageIds: stateData.recentMessageIds });
    stateData.updatedSince = lookback;
  }

  const seenIds = new Set(stateData.recentMessageIds);
  const subscriptions = await client.listSubscriptions(stateData.updatedSince);
  let nextUpdatedSince = stateData.updatedSince;
  let foundMessages = false;

  for (const sub of subscriptions) {
    const subTs = sub._updatedAt ?? sub.updatedAt ?? null;
    if (subTs && subTs > nextUpdatedSince) nextUpdatedSince = subTs;

    const messages = await client.syncMessages(sub.rid, stateData.updatedSince);
    messages.sort((a, b) => (a.ts ?? a._updatedAt ?? "").localeCompare(b.ts ?? b._updatedAt ?? ""));
    for (const msg of messages) {
      const msgTs = msg.ts ?? msg._updatedAt ?? null;
      if (msgTs && msgTs > nextUpdatedSince) nextUpdatedSince = msgTs;

      if (shouldSkipMessage(msg, identity.userId, seenIds)) continue;

      const event = toInboundEvent(account.accountId, sub, msg, account.serverUrl);

      if (!shouldHandleInboundEvent(event, { botUserId: identity.userId, mentionNames })) continue;

      foundMessages = true;

      logger.info(`[rocketchat:${account.accountId}] inbound from ${event.senderName}: "${event.text.slice(0, 80)}"`);

      seenIds.add(msg._id);
      await checkpoint.write({
        updatedSince: nextUpdatedSince,
        recentMessageIds: [...seenIds].slice(-250),
        failedMessages: stateData.failedMessages ?? [],
      });

      if (ctx.channelRuntime) {
        try {
          await handleMessage(ctx, event, client, account.accountId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.error(`[rocketchat:${account.accountId}] failed to handle message ${event.messageId}: ${reason}`);
          await checkpoint.recordFailure({
            messageId: event.messageId,
            roomId: event.roomId,
            senderName: event.senderName,
            sentAt: event.sentAt,
            failedAt: new Date().toISOString(),
            reason,
          });
        }
      } else if (!state.warnedAboutMissingRuntime) {
        state.warnedAboutMissingRuntime = true;
        logger.error(`[rocketchat:${account.accountId}] channel runtime is unavailable; inbound messages will be ignored`);
      }
    }
  }

  state.recordCycle(foundMessages);
  logger.info(`[rocketchat:${account.accountId}] poll done (found=${foundMessages}, CEP=${state.consecutiveEmptyPolls}, nextInterval=${state.getInterval()}ms)`);
}

async function handleMessage(
  ctx: GatewayContext,
  event: InboundEvent,
  client: RocketChatClient,
  accountId: string,
): Promise<void> {
  const replyTmid = event.tmid ?? undefined;
  const channelRuntime = ctx.channelRuntime;
  if (!channelRuntime) return;

  await client.reactToMessage(
    event.messageId,
    PROCESSING_EMOJIS[Math.floor(Math.random() * PROCESSING_EMOJIS.length)]!,
  ).catch((err) => logger.error(`[rocketchat:${accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`));

  await dispatchInboundEventWithChannelRuntime({
    cfg: (ctx.cfg ?? {}) as OpenClawConfigLike,
    accountId,
    event,
    channelRuntime,
    client,
    deliver: (payload, info) => sendReply(client, event.roomId, event.messageId, replyTmid, accountId, payload, info),
    onRecordError: (error) => {
      logger.error(`[rocketchat:${accountId}] failed to record inbound session: ${error instanceof Error ? error.message : String(error)}`);
    },
    onDispatchError: (error, info) => {
      logger.error(`[rocketchat:${accountId}] ${info.kind} dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

async function sendReply(
  client: RocketChatClient,
  roomId: string,
  messageId: string,
  replyTmid: string | undefined,
  accountId: string,
  payload: OutboundReplyPayload,
  info: ReplyDeliverInfo,
): Promise<void> {
  if (info.kind !== "final") return;

  await client.reactToMessage(messageId, ":white_check_mark:").catch((err) =>
    logger.error(`[rocketchat:${accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  if (payload.attachmentPath) {
    try {
      await client.uploadAttachment(roomId, payload.attachmentPath, payload.text, replyTmid ? { tmid: replyTmid } : undefined);
    } catch (err) {
      logger.error(`[rocketchat:${accountId}] upload failed: ${err instanceof Error ? err.message : String(err)}`);
      await client.postMessage(roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
    }
  } else {
    await client.postMessage(roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
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
  const checkpointPath = `${stateDir}/rocketchat/${account.accountId}.json`;
  const checkpoint = new FileCheckpointStore(checkpointPath, 250);
  const state = new PollState();
  const mentionNames = dedupeMentions([identity.username, ...account.mentionNames]);

  const safePollOnce = async (): Promise<void> => {
    if (state.stopped) return;
    if (state.isBlocked()) {
      logger.info(`[rocketchat:${account.accountId}] poll skipped, blocked for ${state.blockedUntilMs - Date.now()}ms`);
      return;
    }

    try {
      await pollOnce(client, checkpoint, identity, mentionNames, ctx, account, state);
    } catch (err) {
      if (err instanceof RocketChatRateLimitError) {
        state.block(err.retryAfterMs);
        logger.error(`[rocketchat:${account.accountId}] rate limited, backing off ${err.retryAfterMs}ms`);
      } else {
        logger.error(`[rocketchat:${account.accountId}] poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const scheduleNext = () => {
    if (state.stopped) return;
    const delay = state.getInterval();
    logger.info(`[rocketchat:${account.accountId}] next poll in ${delay}ms (CEP=${state.consecutiveEmptyPolls})`);
    state.timer = setTimeout(async () => {
      await safePollOnce();
      scheduleNext();
    }, delay);
  };

  const wakeup = () => {
    if (state.stopped) return;
    logger.info(`[rocketchat:${account.accountId}] wakeup triggered, resetting CEP`);
    state.resetBackoff();
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    scheduleNext();
  };

  activeClients.set(account.accountId, { client, generation, wakeup });

  await safePollOnce();
  scheduleNext();

  try {
    await new Promise<void>((resolve) => {
      if (ctx.abortSignal?.aborted) {
        state.stopped = true;
        resolve();
        return;
      }
      ctx.abortSignal?.addEventListener("abort", () => {
        state.stopped = true;
        resolve();
      }, { once: true });
    });
  } finally {
    if (state.timer) clearTimeout(state.timer);
    const current = activeClients.get(account.accountId);
    if (current?.generation === generation) {
      activeClients.delete(account.accountId);
    }
    ctx.setStatus?.("stopped");
  }
}

function shouldSkipMessage(
  msg: import("./types/types.js").RocketChatMessageRecord,
  botUserId: string,
  seenIds: Set<string>,
): boolean {
  if (!msg._id) return true;
  if (msg.t) return true;
  if ((!msg.msg || msg.msg.trim().length === 0) && getMessageAttachmentInputs(msg).length === 0) return true;
  if (msg.u?._id === botUserId) return true;
  if (seenIds.has(msg._id)) return true;
  return false;
}

function toInboundEvent(
  accountId: string,
  sub: import("./types/types.js").RocketChatSubscriptionRecord,
  msg: import("./types/types.js").RocketChatMessageRecord,
  serverUrl?: string,
): InboundEvent {
  const rawAttachments = getMessageAttachmentInputs(msg);
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
    sentAt: msg.ts ?? new Date(0).toISOString(),
    raw: msg,
  };
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
