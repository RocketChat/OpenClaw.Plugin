import { homedir } from "node:os";
import { join } from "node:path";

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
} from "./types/types.js";

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

export async function startGateway(ctx: GatewayContext): Promise<void> {
  const account = ctx.account ?? resolveAccount(ctx.cfg ?? {}, ctx.accountId);
  if (!account || !account.enabled) {
    ctx.setStatus?.("disabled");
    return;
  }

  const log = logger;
  const auth = account.auth;
  const client = new RocketChatClient({
    serverUrl: account.serverUrl,
    auth,
  });

  const identity = await client.getIdentity();
  const generation = nextGeneration++;
  ctx.setStatus?.("connected");
  log.info(`[rocketchat:${account.accountId}] connected as ${identity.username}`);

  const stateDir = resolveStateDir();
  const checkpointPath = `${stateDir}/rocketchat/${account.accountId}.json`;
  const checkpoint = new FileCheckpointStore(checkpointPath, 250);

  let blockedUntilMs = 0;
  let consecutiveEmptyPolls = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let warnedAboutMissingRuntime = false;

  const getPollInterval = (): number => {
    if (consecutiveEmptyPolls < 3) return 3_000;
    if (consecutiveEmptyPolls < 10) return 10_000;
    if (consecutiveEmptyPolls < 20) return 30_000;
    return 60_000;
  };

  const mentionNames = dedupeMentions([identity.username, ...account.mentionNames]);

  const safePollOnce = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() < blockedUntilMs) {
      log.info(`[rocketchat:${account.accountId}] poll skipped, blocked for ${blockedUntilMs - Date.now()}ms`);
      return;
    }
    log.info(`[rocketchat:${account.accountId}] poll tick (CEP=${consecutiveEmptyPolls}, interval=${getPollInterval()}ms)`);

    try {
      const state = await checkpoint.read();
      if (!state.updatedSince) {
        await checkpoint.write({ updatedSince: new Date().toISOString(), recentMessageIds: state.recentMessageIds });
        return;
      }

      const seenIds = new Set(state.recentMessageIds);
      const subscriptions = await client.listSubscriptions(state.updatedSince);
      let nextUpdatedSince = state.updatedSince;
      let foundMessages = false;

      for (const sub of subscriptions) {
        const subTs = sub._updatedAt ?? sub.updatedAt ?? null;
        if (subTs && subTs > nextUpdatedSince) {
          nextUpdatedSince = subTs;
        }

        const messages = await client.syncMessages(sub.rid, state.updatedSince);
        messages.sort((a, b) => (a.ts ?? a._updatedAt ?? "").localeCompare(b.ts ?? b._updatedAt ?? ""));
        for (const msg of messages) {
          const msgTs = msg.ts ?? msg._updatedAt ?? null;
          if (msgTs && msgTs > nextUpdatedSince) {
            nextUpdatedSince = msgTs;
          }

          if (shouldSkipMessage(msg, identity.userId, seenIds)) {
            continue;
          }

          const event = toInboundEvent(account.accountId, sub, msg, account.serverUrl);

          if (!shouldHandleInboundEvent(event, { botUserId: identity.userId, mentionNames })) {
            continue;
          }

          foundMessages = true;

          log.info(
            `[rocketchat:${account.accountId}] inbound from ${event.senderName}: "${event.text.slice(0, 80)}"`,
          );

          if (ctx.channelRuntime) {
            const channelRuntime = ctx.channelRuntime;
            const replyTmid = event.tmid ?? undefined;

            await client.reactToMessage(
              event.messageId,
              PROCESSING_EMOJIS[Math.floor(Math.random() * PROCESSING_EMOJIS.length)]!
            ).catch((err) => log.error(`[rocketchat:${account.accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`));

            await dispatchInboundEventWithChannelRuntime({
              cfg: (ctx.cfg ?? {}) as OpenClawConfigLike,
              accountId: account.accountId,
              event,
              channelRuntime,
              client,
              deliver: async (payload, info) => {
                if (info.kind === "final") {
                  await client.reactToMessage(event.messageId, ":white_check_mark:").catch((err) => log.error(`[rocketchat:${account.accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`));
                  if (payload.attachmentPath) {
                    try {
                      await client.uploadAttachment(event.roomId, payload.attachmentPath, payload.text, replyTmid ? { tmid: replyTmid } : undefined);
                    } catch (err) {
                      log.error(`[rocketchat:${account.accountId}] upload failed: ${err instanceof Error ? err.message : String(err)}`);
                      await client.postMessage(event.roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
                    }
                  } else {
                    await client.postMessage(event.roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
                  }
                }
              },
              onRecordError: (error) => {
                log.error(
                  `[rocketchat:${account.accountId}] failed to record inbound session: ${error instanceof Error ? error.message : String(error)}`,
                );
              },
              onDispatchError: (error, info) => {
                log.error(
                  `[rocketchat:${account.accountId}] ${info.kind} dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              },
            });
          } else {
            if (!warnedAboutMissingRuntime) {
              warnedAboutMissingRuntime = true;
              log.error(
                `[rocketchat:${account.accountId}] channel runtime is unavailable; inbound messages will be ignored`,
              );
            }
          }

          seenIds.add(msg._id);
          await checkpoint.write({ updatedSince: nextUpdatedSince, recentMessageIds: [...seenIds].slice(-250) });
        }
      }

      consecutiveEmptyPolls = foundMessages ? 0 : consecutiveEmptyPolls + 1;
      log.info(`[rocketchat:${account.accountId}] poll done (found=${foundMessages}, CEP=${consecutiveEmptyPolls}, nextInterval=${getPollInterval()}ms)`);
    } catch (err) {
      if (err instanceof RocketChatRateLimitError) {
        blockedUntilMs = Date.now() + err.retryAfterMs;
        consecutiveEmptyPolls = Math.max(consecutiveEmptyPolls, 10);
        log.error(`[rocketchat:${account.accountId}] rate limited, backing off ${err.retryAfterMs}ms`);
      } else {
        log.error(`[rocketchat:${account.accountId}] poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const delay = getPollInterval();
    log.info(`[rocketchat:${account.accountId}] next poll in ${delay}ms (CEP=${consecutiveEmptyPolls})`);
    timer = setTimeout(async () => {
      await safePollOnce();
      scheduleNext();
    }, delay);
  };

  const wakeup = () => {
    if (stopped) return;
    log.info(`[rocketchat:${account.accountId}] wakeup triggered, resetting CEP`);
    consecutiveEmptyPolls = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    scheduleNext();
  };
  
  activeClients.set(account.accountId, { client, generation, wakeup });

  await safePollOnce();
  scheduleNext();

  try {
    await new Promise<void>((resolve) => {
      if (ctx.abortSignal?.aborted) {
        stopped = true;
        resolve();
        return;
      }
      ctx.abortSignal?.addEventListener("abort", () => {
        stopped = true;
        resolve();
      }, { once: true });
    });
  } finally {
    if (timer) clearTimeout(timer);
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
  return {
    accountId,
    roomId: msg.rid,
    roomType: mapRoomType(sub.t),
    messageId: msg._id,
    tmid: msg.tmid ?? null,
    senderId: msg.u?._id ?? "",
    senderName: msg.u?.username ?? msg.u?.name ?? "",
    text: msg.msg ?? "",
    mentions: (msg.mentions ?? []).map((m) => m.username ?? m.name ?? "").filter(Boolean),
    attachments: normalizeInboundAttachments(getMessageAttachmentInputs(msg), serverUrl ? { serverUrl } : undefined),
    sentAt: msg.ts ?? new Date(0).toISOString(),
    raw: msg,
  };
}

function mapRoomType(t: string | undefined): InboundEvent["roomType"] {
  if (t === "d") return "direct";
  if (t === "p") return "group";
  return "channel";
}

function resolveStateDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME?.trim();
  if (home) return join(home, ".openclaw");
  return join(homedir(), ".openclaw");
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
