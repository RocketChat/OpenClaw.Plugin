import { homedir } from "node:os";
import { join } from "node:path";

import { RocketChatClient, RocketChatRateLimitError } from "./client.js";
import { parsePluginConfig } from "./config.js";
import { FileCheckpointStore } from "./checkpoint-store.js";
import type { InboundEvent } from "./types/types.js";
import { shouldHandleInboundEvent } from "./channel.js";
import { dispatchInboundEventWithChannelRuntime } from "./inbound-dispatch.js";
import type {
  ResolvedAccount,
  OpenClawConfig,
  GatewayContext,
  OpenClawConfigLike,
} from "./types/types.js";

const activeClients = new Map<string, RocketChatClient>();

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

function isConfigured(account: Partial<ResolvedAccount> | null | undefined): boolean {
  return Boolean(account?.serverUrl && account.auth);
}

export async function startGateway(ctx: GatewayContext): Promise<void> {
  const account = ctx.account ?? resolveAccount(ctx.cfg ?? {}, ctx.accountId);
  if (!account || !account.enabled) {
    ctx.setStatus?.("disabled");
    return;
  }

  const log = logger;
  const auth = account.auth as { userId: string; accessToken: string };
  const client = new RocketChatClient({
    serverUrl: account.serverUrl,
    auth,
  });
  
  const identity = await client.getIdentity();
  activeClients.set(account.accountId, client);
  ctx.setStatus?.("connected");
  log.info(`[rocketchat:${account.accountId}] connected as ${identity.username}`);

  const stateDir = resolveStateDir();
  const checkpointPath = `${stateDir}/rocketchat/${account.accountId}.json`;
  const checkpoint = new FileCheckpointStore(checkpointPath, 250);

  const pollIntervalMs = account.transport.pollIntervalMs ?? 3000;
  let blockedUntilMs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let warnedAboutMissingRuntime = false;

  const mentionNames = dedupeMentions([identity.username, ...account.mentionNames]);

  const safePollOnce = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() < blockedUntilMs) return;

    try {
      const state = await checkpoint.read();
      if (!state.updatedSince) {
        await checkpoint.write({ updatedSince: new Date().toISOString(), recentMessageIds: state.recentMessageIds });
        return;
      }

      const seenIds = new Set(state.recentMessageIds);
      const subscriptions = await client.listSubscriptions(state.updatedSince);
      let nextUpdatedSince = state.updatedSince;

      for (const sub of subscriptions) {
        const subTs = sub._updatedAt ?? sub.updatedAt ?? null;
        if (subTs && subTs > nextUpdatedSince) {
          nextUpdatedSince = subTs;
        }

        const messages = await client.syncMessages(sub.rid, state.updatedSince);
        for (const msg of messages) {
          const msgTs = msg.ts ?? msg._updatedAt ?? null;
          if (msgTs && msgTs > nextUpdatedSince) {
            nextUpdatedSince = msgTs;
          }

          if (shouldSkipMessage(msg, identity.userId, seenIds)) {
            continue;
          }

          const event = toInboundEvent(account.accountId, sub, msg);

          if (!shouldHandleInboundEvent(event, { botUserId: identity.userId, mentionNames })) {
            continue;
          }

          log.info(
            `[rocketchat:${account.accountId}] inbound from ${event.senderName}: "${event.text.slice(0, 80)}"`,
          );

          const PROCESSING_EMOJIS = [
            ":eyes:", ":thinking:", ":hourglass:", ":gear:",
            ":robot:", ":arrows_counterclockwise:", ":bulb:", ":mag:"
          ];

          if (ctx.channelRuntime) {
            const channelRuntime = ctx.channelRuntime;
            const replyTmid = event.tmid ?? undefined;

            await client.reactToMessage(
              event.messageId,
              PROCESSING_EMOJIS[Math.floor(Math.random() * PROCESSING_EMOJIS.length)]!
            ).catch(() => {});

            await dispatchInboundEventWithChannelRuntime({
              cfg: (ctx.cfg ?? {}) as OpenClawConfigLike,
              accountId: account.accountId,
              event,
              channelRuntime,
              agent: account.agent,
              deliver: async (payload, info) => {
                if (info.kind === "final") {
                  await client.reactToMessage(event.messageId, ":white_check_mark:").catch(() => {});
                  await client.postMessage(event.roomId, payload.text ?? "", replyTmid ? { tmid: replyTmid } : undefined);
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
    } catch (err) {
      if (err instanceof RocketChatRateLimitError) {
        blockedUntilMs = Date.now() + err.retryAfterMs;
        log.error(`[rocketchat:${account.accountId}] rate limited, backing off ${err.retryAfterMs}ms`);
      } else {
        log.error(`[rocketchat:${account.accountId}] poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await safePollOnce();
      scheduleNext();
    }, pollIntervalMs);
  };

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
    activeClients.delete(account.accountId);
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
  if ((!msg.msg || msg.msg.trim().length === 0)) return true;
  if (msg.u?._id === botUserId) return true;
  if (seenIds.has(msg._id)) return true;
  return false;
}

function toInboundEvent(
  accountId: string,
  sub: import("./types/types.js").RocketChatSubscriptionRecord,
  msg: import("./types/types.js").RocketChatMessageRecord,
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

function dedupeMentions(mentions: string[]): string[] {
  return [...new Set(mentions.map((mention) => mention.trim()).filter(Boolean))];
}

export const rocketchatPlugin = {
  id: "rocketchat",
  meta: {
    id: "rocketchat",
    label: "Rocket.Chat",
    selectionLabel: "Rocket.Chat",
    blurb: "Rocket.Chat channel plugin with REST polling outbound/inbound",
    aliases: ["rc"],
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds,
    resolveAccount,
    isConfigured,
  },
  threading: {
    topLevelReplyToMode: "reply" as const,
  },
  messaging: {
    targetPrefixes: ["rocketchat", "channel", "user", "@"],
    normalizeTarget: (target: string): string | undefined => {
      const trimmed = target?.trim();
      if (!trimmed) return undefined;
      return trimmed.replace(/^rocketchat:(?:channel:|user:)?/i, "").replace(/^channel:/i, "");
    },
    targetResolver: {
      looksLikeId: (id: string): boolean => {
        const trimmed = id?.trim();
        if (!trimmed) return false;
        return /^[a-z0-9_]{4,32}$/i.test(trimmed) || /^rocketchat:/i.test(trimmed) || /^channel:/i.test(trimmed) || /^user:/i.test(trimmed) || /^@/.test(trimmed);
      },
      hint: "<roomId|rocketchat:roomId|channel:roomId|user:userId|@username>",
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to: string }) => {
      const trimmed = to?.trim();
      if (!trimmed) return { ok: false as const, error: new Error("Rocket.Chat send requires a target id") };
      const normalized = trimmed.replace(/^rocketchat:(?:channel:|user:)?/i, "").replace(/^channel:/i, "");
      return { ok: true as const, to: normalized };
    },
    sendText: async (params: {
      cfg?: unknown;
      accountId?: string;
      to: string;
      text: string;
      replyToId?: string;
    }): Promise<{ ok: boolean; messageId: string; channel: string }> => {
      let account = resolveAccount(params.cfg ?? {}, params.accountId);
      if (!account) {
        const accounts = listAccountIds(params.cfg as OpenClawConfig);
        if (accounts.length > 0) {
          account = resolveAccount(params.cfg ?? {}, accounts[0]);
        }
      }
      if (!account) throw new Error(`Unknown Rocket.Chat account: ${params.accountId}`);

      const client = activeClients.get(account.accountId) ?? new RocketChatClient({
        serverUrl: account.serverUrl,
        auth: account.auth as { userId: string; accessToken: string },
      });
      const tmidOptions = params.replyToId ? { tmid: params.replyToId } : undefined;
      const messageId = await client.postMessage(params.to, params.text, tmidOptions);
      return { ok: true, messageId, channel: "rocketchat" };
    },
  },
  gateway: {
    startAccount: startGateway,
  },
};

function parseChannelConfig(cfg: OpenClawConfig): ReturnType<typeof parsePluginConfig> {
  const nestedConfig = cfg.channels?.rocketchat;
  if (nestedConfig) return parsePluginConfig(nestedConfig);
  if (isPluginConfigLike(cfg)) return parsePluginConfig(cfg);
  return { accounts: {} };
}

function isPluginConfigLike(input: unknown): input is Parameters<typeof parsePluginConfig>[0] {
  return Boolean(input && typeof input === "object" && "accounts" in input);
}
