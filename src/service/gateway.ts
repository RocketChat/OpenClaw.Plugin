import { execFileSync } from "node:child_process";
import { resolveOpenClawDir, extractQuotedMessageId, DM_SCOPE } from "../utils.js";
import { RocketChatClient } from "../client/rest.js";
import { parsePluginConfig } from "../config/schema.js";
import { CheckpointStore } from "../config/store.js";
import { getMessageAttachmentInputs, normalizeInboundAttachments } from "./attachments.js";
import { RocketChatDdpConnection } from "../client/ddp.js";
import type {
  InboundEvent,
  RocketChatSubscriptionRecord,
  RocketChatMessageRecord,
} from "../types.js";
import { shouldHandleInboundEvent, matchCommand } from "./channel.js";
import { readAccount } from "../cli/config-updater.js";
import { collectBotUserIdsForServer, collectBotUsernamesForServer } from "../cli/config-updater.js";
import { AccessStore } from "../config/access-store.js";
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

const MAX_MESSAGE_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;

import { activeClients, connectionStatus, type ClientEntry } from "./runtime-state.js";
export { activeClients, type ClientEntry } from "./runtime-state.js";
let nextGeneration = 0;

const threadRoots = new Map<string, string>();
const THREAD_ROOTS_CAP = 2000;

function recordThreadRoot(messageId: string, tmid: string): void {
  if (threadRoots.size >= THREAD_ROOTS_CAP) {
    const oldest = threadRoots.keys().next().value;
    if (oldest !== undefined) threadRoots.delete(oldest);
  }
  threadRoots.set(messageId, tmid);
  threadRoots.set(tmid, tmid);
}

export function lookupThreadRoot(messageId: string): string | undefined {
  return threadRoots.get(messageId);
}

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
  isCommand: boolean,
  commandText: string | null,
  owner?: string,
): Promise<void> {
  if (isSenderDenied(event.senderName, owner, accountId, event.roomId, event.roomType)) {
    const ownerLabel = owner ? `@${owner}` : "the bot owner";
    const replyText = `You don't have access to use this bot. Contact ${ownerLabel}.`;
    try {
      await postMessageWithRetry(
        client,
        accountId,
        event.roomId,
        replyText,
        resolveReplyTmid({
          roomType: event.roomType,
          tmid: event.tmid ?? undefined,
          messageId: event.messageId,
          isCommand: true,
        }),
      );
    } catch (err) {
      logger.error(
        `[rocketchat:${accountId}] access denied reply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  const replyTmid = resolveReplyTmid({
    roomType: event.roomType,
    tmid: event.tmid ?? undefined,
    messageId: event.messageId,
    isCommand,
  });
  const channelRuntime = ctx.channelRuntime;
  if (!channelRuntime) return;

  if (!isCommand) {
    const emoji = PROCESSING_EMOJIS[Math.floor(Math.random() * PROCESSING_EMOJIS.length)]!;
    await (
      ddp
        ?.reactToMessage(event.messageId, emoji)
        .catch(() => client.reactToMessage(event.messageId, emoji)) ??
      client.reactToMessage(event.messageId, emoji)
    ).catch((err) =>
      logger.error(
        `[rocketchat:${accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );

    await ddp?.sendTyping(event.roomId, true).catch(() => {});
  }

  const groupHistory =
    event.roomType === "direct" ? [] : getAndClearGroupHistory(accountId, event.roomId);

  await dispatchInboundEventWithChannelRuntime({
    cfg: (ctx.cfg ?? {}) as OpenClawConfigLike,
    accountId,
    event,
    groupHistory,
    identityUsername,
    channelRuntime,
    client,
    deliver: (payload, info) =>
      sendReply(
        client,
        ddp,
        event.roomId,
        event.messageId,
        replyTmid,
        accountId,
        payload,
        info,
        isCommand,
        commandText,
      ),
    onRecordError: (error) => {
      logger.error(
        `[rocketchat:${accountId}] failed to record inbound session: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    onDispatchError: (error, info) => {
      const detail =
        error instanceof Error ? `${error.message}\n${error.stack}` : JSON.stringify(error);
      logger.error(`[rocketchat:${accountId}] ${info.kind} dispatch failed: ${detail}`);
    },
  });

  await ddp?.sendTyping(event.roomId, false).catch(() => {});
}

const OPENCLAW_CMD_NAMES = [
  "acp",
  "activation",
  "agents",
  "approve",
  "btw",
  "commands",
  "compact",
  "config",
  "context",
  "debug",
  "diagnostics",
  "elevated",
  "exec",
  "export-session",
  "export-trajectory",
  "fast",
  "focus",
  "goal",
  "help",
  "learn",
  "login",
  "mcp",
  "models",
  "model",
  "name",
  "new",
  "plugins",
  "queue",
  "reasoning",
  "reset",
  "restart",
  "send",
  "session",
  "skill",
  "status",
  "steer",
  "stop",
  "subagents",
  "tasks",
  "think",
  "tools",
  "trace",
  "tts",
  "unfocus",
  "usage",
  "verbose",
  "whoami",
].join("|");
const OPENCLAW_CMD_RE = new RegExp(`(?<![\\w/])/(${OPENCLAW_CMD_NAMES})(?![\\w-])`, "g");

function shortModelId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function wrapToolLine(line: string, width = 72): string {
  const parts = line.split(", ");
  const rows: string[] = [];
  let cur = "";
  for (const part of parts) {
    if (cur && cur.length + 2 + part.length > width) {
      rows.push(cur);
      cur = part;
    } else {
      cur = cur ? `${cur}, ${part}` : part;
    }
  }
  if (cur) rows.push(cur);
  return rows.join("\n");
}

function cleanToolDesc(s: string): string {
  return s
    .replace(/\*\*\*([^*]+?)\*\*\*/g, (_, c) => "`" + String(c).trim() + "`")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function reformatTools(text: string): string {
  const lines = text.split("\n");
  // Verbose mode: individual "Name - description" entries (not a single comma list).
  const isVerbose = lines.some(
    (l) => /^[\w\s()./:&-]{1,40}?\s-\s/.test(l.trim()) && !/^Use /i.test(l.trim()),
  );
  if (!isVerbose) {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (/^Profile:/i.test(trimmed)) continue;
      if (/^Available tools$/i.test(trimmed)) {
        out.push("**Tools**");
        continue;
      }
      if (/tools$/i.test(trimmed) && !/^Use /i.test(trimmed)) {
        const next = lines[i + 1]?.trim() ?? "";
        const count = next.includes(", ") ? next.split(", ").length : next ? 1 : 0;
        out.push("", `**${trimmed} (${count})**`);
        if (next) {
          out.push(wrapToolLine(next));
          i++;
        }
        continue;
      }
      if (trimmed.includes(", ")) {
        out.push(wrapToolLine(trimmed));
        continue;
      }
      out.push(lines[i]!);
    }
    return out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Verbose: one clean block per tool.
  const out: string[] = [];
  let cur: { name: string; desc: string } | null = null;
  const flush = () => {
    if (cur) {
      out.push("", `**${cur.name}** — ${cur.desc}`);
      cur = null;
    }
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (/^Profile:/i.test(trimmed)) continue;
    if (/^Available tools$/i.test(trimmed)) {
      flush();
      out.push("**Tools**");
      continue;
    }
    if (/^What this agent can use right now:/i.test(trimmed)) continue;
    if (/^(?:Built-in|Connected)\s+tools\b/i.test(trimmed)) {
      flush();
      out.push("", `**${trimmed.replace(/^\*\*|\*\*$/g, "")}**`);
      continue;
    }
    if (/^Tool availability depends/i.test(trimmed)) {
      flush();
      out.push("", `_${trimmed}_`);
      continue;
    }
    const m = trimmed.match(/^([\w\s()./:&-]{1,40}?)\s-\s(.+)$/);
    if (m) {
      flush();
      cur = { name: m[1]!.trim(), desc: cleanToolDesc(m[2]!.trim()) };
    } else if (cur) {
      cur.desc += " " + cleanToolDesc(trimmed);
    } else {
      out.push(trimmed);
    }
  }
  flush();
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function reformatModel(text: string): string {
  try {
    const cli = execFileSync("openclaw", ["models", "list", "--json"], {
      encoding: "utf8",
      timeout: 8000,
    });
    const parsed = JSON.parse(cli) as {
      models?: Array<{ key: string; tags?: string[] }>;
    };
    const models = parsed.models;
    if (Array.isArray(models) && models.length > 0) {
      const current = models.find((m) => m.tags?.includes("default"));
      const available = models.filter((m) => !m.tags?.includes("default"));
      const out: string[] = [];
      if (current) out.push(`Current: ${shortModelId(current.key)}`);
      if (available.length) {
        out.push("", "Available:");
        for (const m of available) out.push(`  ${shortModelId(m.key)}`);
      }
      if (out.length) return out.join("\n");
    }
  } catch {
    // fallback to regex filtering on raw text if JSON path fails
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let current = "";
  const models: string[] = [];
  const SENSITIVE =
    /api[_-]?key|secret|password|oauth|token|credential|bearer|authorization/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (SENSITIVE.test(line)) continue;
    const cur = line.match(/^(?:Current|Default)\s*:\s*(\S+)/i);
    if (cur) {
      current = shortModelId(cur[1]!);
      continue;
    }
    if (/^[\w.\-]+\/[\w.\-]+(?:\/[\w.\-]+)*$/.test(line) || /^-\s+[\w.\-]+\//.test(line)) {
      models.push(shortModelId(line.replace(/^-\s+/, "")));
      continue;
    }
  }
  if (current) out.push(`Current: ${current}`);
  if (models.length) {
    out.push("", "Available:");
    for (const m of models) out.push(`  ${m}`);
  }
  return out.length ? out.join("\n") : text;
}

function reformatCommandReply(command: string | null, text: string): string {
  if (!command || !text) return text;
  let out = text.replace(OPENCLAW_CMD_RE, "!$1");
  // Tidy the model card: keep the current model + a clean available list.
  if (command.startsWith("/model")) {
    const modelArg = command.replace(/^\/model\s*/i, "").trim().toLowerCase();
    const wantsList = modelArg === "" || modelArg === "status" || modelArg === "list";
    if (wantsList) {
      try {
        const cli = execFileSync("openclaw", ["models"], {
          encoding: "utf8",
          timeout: 8000,
        });
        out = reformatModel(cli);
      } catch {
        out = reformatModel(out);
      }
    } else {
      out = reformatModel(out);
    }
  }
  if (command.startsWith("/tools")) {
    out = reformatTools(out);
  }
  out = stripEmojis(out);
  return out;
}

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{25FF}\u{2900}-\u{297F}\u{2022}\u{00B7}]/gu;

function stripEmojis(text: string): string {
  return text.replace(EMOJI_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

const SEND_RETRY_DELAY_MS = 500;

export async function postMessageWithRetry(
  client: Pick<RocketChatClient, "postMessage">,
  accountId: string,
  roomId: string,
  text: string,
  tmid?: string,
): Promise<string> {
  const tmidOpt = tmid ? { tmid } : undefined;
  try {
    return await client.postMessage(roomId, text, tmidOpt);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.info(
      `[rocketchat:${accountId}] send failed, retrying in ${SEND_RETRY_DELAY_MS}ms: ${reason}`,
    );
    await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
    return await client.postMessage(roomId, text, tmidOpt);
  }
}

export function resolveReplyTmid(params: {
  roomType: string;
  tmid?: string | undefined;
  messageId: string;
  isCommand: boolean;
  command?: string | undefined;
}): string | undefined {
  if (params.tmid) return params.tmid;
  if (!params.isCommand) return undefined;
  if (params.roomType === "direct") return undefined;
  if (params.command === "help") return undefined;
  return params.messageId;
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
  isCommand: boolean,
  commandText: string | null,
): Promise<void> {
  if (info.kind !== "final") return;

  const text = reformatCommandReply(commandText, payload.text ?? "");

  if (!isCommand) {
    await (
      ddp
        ?.reactToMessage(messageId, ":white_check_mark:")
        .catch(() => client.reactToMessage(messageId, ":white_check_mark:")) ??
      client.reactToMessage(messageId, ":white_check_mark:")
    ).catch((err) =>
      logger.error(
        `[rocketchat:${accountId}] reaction failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );

    await ddp?.sendTyping(roomId, false).catch(() => {});
  }

  const sendMsg = (roomId: string, text: string, options?: { tmid?: string }) =>
    postMessageWithRetry(client, accountId, roomId, text, options?.tmid);
  const tmidOpt = replyTmid ? { tmid: replyTmid } : undefined;
  logger.info(`[rocketchat:${accountId}] reply tmid=${replyTmid ?? "none"} text="${text.slice(0, 60)}"`);

  try {
    if (payload.attachmentPath) {
      try {
        await client.uploadAttachment(roomId, payload.attachmentPath, text, tmidOpt);
      } catch (err) {
        logger.error(
          `[rocketchat:${accountId}] upload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await sendMessageChunks(sendMsg, roomId, text, tmidOpt);
      }
    } else {
      await sendMessageChunks(sendMsg, roomId, text, tmidOpt);
    }
  } catch (err) {
    logger.error(
      `[rocketchat:${accountId}] sendReply failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Rocket.Chat caps single message size; split long replies into sequential chunks
 * (preferring newline boundaries) so nothing is dropped or truncated.
 */
async function sendMessageChunks(
  sendMsg: (roomId: string, text: string, options?: { tmid?: string }) => Promise<string>,
  roomId: string,
  text: string,
  tmidOpt?: { tmid: string },
): Promise<void> {
  if (!text) return;
  if (text.length <= MAX_MESSAGE_LENGTH) {
    await sendMsg(roomId, text, tmidOpt);
    return;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);

  for (const chunk of chunks) {
    await sendMsg(roomId, chunk, tmidOpt);
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

  const knownBotUserIds = collectBotUserIdsForServer(account.serverUrl);
  client.setBotUsernames(collectBotUsernamesForServer(account.serverUrl));

  const identity = await client.getIdentity();
  const generation = nextGeneration++;
  ctx.setStatus?.("connected");
  logger.info(`[rocketchat:${account.accountId}] connected as ${identity.username}`);

  const stateDir = resolveOpenClawDir();
  const checkpointPath = `${stateDir}/rocketchat/${account.accountId}.db`;
  const checkpoint = new CheckpointStore(checkpointPath, 250);
  const mentionNames = dedupeMentions([identity.username, ...account.mentionNames]);

  return startDdpGateway(
    ctx,
    account,
    identity,
    client,
    checkpoint,
    mentionNames,
    generation,
    knownBotUserIds,
  );
}

async function startDdpGateway(
  ctx: GatewayContext,
  account: ResolvedAccount,
  identity: RocketChatIdentity,
  client: RocketChatClient,
  checkpoint: CheckpointStore,
  mentionNames: string[],
  generation: number,
  knownBotUserIds: Set<string>,
): Promise<void> {
  const accountId = account.accountId;
  const wsBase = new URL(account.serverUrl);
  wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = wsBase.toString().replace(/\/+$/, "");
  const reconnectDelayMs =
    account.transport.mode === "websocket" ? (account.transport.reconnectDelayMs ?? 2_000) : 2_000;
  const channelLimits = parseChannelConfig(ctx.cfg ?? {}).limits;

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
    logger.error(
      `[rocketchat:${accountId}] failed to fetch subscriptions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const connection = new RocketChatDdpConnection({
    wsUrl,
    authToken: identity.authToken,
    username: identity.username,
    reconnectDelayMs,
    maxReconnects: channelLimits?.maxReconnects,
    onStatus: (status) => {
      connectionStatus.set(accountId, status);
      if (status === "failed") {
        logger.error(
          `[rocketchat:${accountId}] connection gave up - bot is dead until daemon restart (run: openclaw daemon restart)`,
        );
      }
      logger.info(`[rocketchat:${accountId}] ddp status: ${status}`);
    },
    onError: (error) => logger.error(`[rocketchat:${accountId}] ddp error: ${error.message}`),
    onMessage: async (msg: RocketChatMessageRecord) => {
      if (shouldSkipMessage(msg, identity.userId, seenIds)) return;
      if (processingMessages.has(msg._id)) return;

      // Room types are snapshotted once at connect; resolve unknown rooms on demand so
      // DMs (and other rooms) created after connect are handled live without a restart.
      let roomType = roomTypes.get(msg.rid);
      if (!roomType && client) {
        try {
          const resolved = await client.getRoomType(msg.rid);
          if (resolved) {
            roomType = resolved;
            roomTypes.set(msg.rid, roomType);
          }
        } catch {
          // Fall back to the default below if the server lookup fails.
        }
      }
      const sub: RocketChatSubscriptionRecord = { rid: msg.rid, t: roomType ?? "c" };
      const event = await toInboundEvent(accountId, sub, msg, account.serverUrl, client);
      logger.info(
        `[rocketchat:${accountId}] inbound from ${event.senderName}: "${event.text.slice(0, 80)}" (tmid=${event.tmid ?? "none"})`,
      );
      if (event.quotedText) {
        logger.info(
          `[rocketchat:${accountId}] quoted context (${event.quotedText.length} chars): "${event.quotedText.slice(0, 120)}"`,
        );
      }

      if (
        !shouldHandleInboundEvent(event, {
          botUserId: identity.userId,
          mentionNames,
          knownBotUserIds,
        })
      ) {
        if (event.roomType !== "direct") {
          appendGroupHistory(accountId, event.roomId, {
            sender: event.senderName,
            body: event.text,
            timestamp: Date.now(),
          });
        }
        return;
      }

      await markSeen(msg._id);

      if (
        isSenderDenied(event.senderName, account.owner, accountId, event.roomId, event.roomType)
      ) {
        const ownerLabel = account.owner ? `@${account.owner}` : "the bot owner";
        const replyText = `You don't have access to use this bot. Contact ${ownerLabel}.`;
        try {
          await postMessageWithRetry(
            client,
            accountId,
            event.roomId,
            replyText,
            resolveReplyTmid({
              roomType: event.roomType,
              tmid: event.tmid ?? undefined,
              messageId: event.messageId,
              isCommand: true,
            }),
          );
        } catch (err) {
          logger.error(
            `[rocketchat:${accountId}] access denied reply failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await markSeen(msg._id);
        return;
      }

      const cmdResult = await matchCommand(event.text, {
        accountId,
        account: readAccount(accountId) ?? {
          accountId,
          serverUrl: account.serverUrl,
          mentionNames: account.mentionNames,
          auth: { mode: "token", userId: "", accessToken: "" },
          enabled: true,
          ...(account.owner ? { owner: account.owner } : {}),
        },
        client,
        senderName: event.senderName,
        roomId: event.roomId,
        roomType: event.roomType,
        ...(ctx.channelRuntime ? { channelRuntime: ctx.channelRuntime } : {}),
        ...(channelLimits
          ? {
              limits: {
                maxAccounts: channelLimits.maxAccounts,
                maxBotsPerServer: channelLimits.maxBotsPerServer,
                botCreationCooldownMs: channelLimits.botCreationCooldownMs,
              },
            }
          : {}),
      });
      logger.info(
        `[rocketchat:${accountId}] matchCommand(${JSON.stringify(event.text)}) -> ${cmdResult.action}`,
      );
      if (cmdResult.action === "reply") {
        const tmid = resolveReplyTmid({
          roomType: event.roomType,
          tmid: event.tmid ?? undefined,
          messageId: event.messageId,
          isCommand: true,
          command: cmdResult.command,
        });
        try {
          await postMessageWithRetry(client, accountId, event.roomId, cmdResult.replyText, tmid);
        } catch (err) {
          logger.error(
            `[rocketchat:${accountId}] command reply failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await markSeen(msg._id);
        return;
      }

      if (cmdResult.action === "openclaw-command") {
        event.text = cmdResult.command;
        logger.info(`[rocketchat:${accountId}] passthrough OpenClaw command: ${cmdResult.command}`);
      }

      await markSeen(msg._id);

      if (!ctx.channelRuntime) {
        logger.error(
          `[rocketchat:${accountId}] channel runtime unavailable; inbound message ignored`,
        );
        return;
      }

      if (processingMessages.has(msg._id)) return;
      processingMessages.add(msg._id);
      void handleMessage(
        ctx,
        event,
        client,
        connection,
        accountId,
        identity.username,
        cmdResult.action === "openclaw-command",
        cmdResult.action === "openclaw-command" ? event.text : null,
        account.owner,
      )
        .catch(async (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          logger.error(
            `[rocketchat:${accountId}] failed to handle message ${event.messageId}: ${reason}`,
          );
          await checkpoint.recordFailure({
            messageId: event.messageId,
            roomId: event.roomId,
            senderName: event.senderName,
            sentAt: event.sentAt,
            failedAt: new Date().toISOString(),
            reason,
          });
        })
        .finally(() => {
          processingMessages.delete(msg._id);
        });
    },
  });

  activeClients.set(accountId, { client, generation });
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
    connectionStatus.delete(accountId);
    ctx.setStatus?.("stopped");
  }
}

function isSenderDenied(
  senderName: string,
  owner: string | undefined,
  accountId: string,
  roomId: string,
  roomType: import("../types.js").InboundEvent["roomType"],
): boolean {
  const norm = senderName.trim().replace(/^@+/, "").toLowerCase();
  if (!norm) return true;
  if (owner && owner.trim().replace(/^@+/, "").toLowerCase() === norm) return false;
  // Per-room grants created by `lend` (falls back to denial if the store is unavailable).
  // A grant with roomId === DM_SCOPE ("dm") allows direct messages only.
  try {
    const store = new AccessStore();
    const granted = store
      .loadGrants(accountId)
      .some(
        (g) =>
          g.username.trim().replace(/^@+/, "").toLowerCase() === norm &&
          (g.roomId === "*" ||
            g.roomId === roomId ||
            (g.roomId === DM_SCOPE && roomType === "direct")),
      );
    store.close();
    if (granted) return false;
  } catch {
    // ignore — treat as not granted
  }
  return true;
}

function shouldSkipMessage(
  msg: import("../types.js").RocketChatMessageRecord,
  botUserId: string,
  seenIds: Set<string>,
): boolean {
  if (!msg._id) return true;
  const hasAttachments = getMessageAttachmentInputs(msg).length > 0;
  if (msg.t && !hasAttachments) return true;
  if ((!msg.msg || msg.msg.trim().length === 0) && !hasAttachments) return true;
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
  if (msg.tmid) recordThreadRoot(msg._id, msg.tmid);

  let quotedText: string | undefined;
  let nextQuotedId: string | null = msg.tmid ?? null;
  if (!nextQuotedId) {
    const link = (Array.isArray(msg.attachments) ? msg.attachments : [])
      .map((att) => (att as { message_link?: string }).message_link)
      .find((l): l is string => typeof l === "string" && l.length > 0);
    nextQuotedId = link ? (extractQuotedMessageId(link) ?? null) : null;
  }
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
    attachments: normalizeInboundAttachments(
      rawAttachments.slice(0, MAX_ATTACHMENTS),
      serverUrl ? { serverUrl } : undefined,
    ),
    ...(quotedText ? { quotedText } : {}),
    sentAt: msg.ts ?? new Date(0).toISOString(),
    raw: msg,
  };
}

function isQuoteLinkOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[ ](") && !trimmed.startsWith("[![](")) return false;
  const open = trimmed.lastIndexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open === -1 || close <= open) return false;
  const url = trimmed.slice(open + 1, close);
  return extractQuotedMessageId(url) !== undefined;
}

function mapRoomType(t: string | undefined): InboundEvent["roomType"] {
  if (t === "d") return "direct";
  if (t === "p") return "group";
  return "channel";
}


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

const PROCESSING_EMOJIS = [
  ":eyes:",
  ":thinking:",
  ":hourglass:",
  ":gear:",
  ":robot:",
  ":arrows_counterclockwise:",
  ":bulb:",
  ":mag:",
];
