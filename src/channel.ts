import {
  createReplyProgressState,
  EMPTY_REPLY_FALLBACK,
  formatReplyFailure,
  formatReplyUpdate,
  THINKING_PLACEHOLDER,
  WATCHDOG_STAGES,
} from "./format.js";
import type { InboundEvent } from "./types/types.js";
import type {
  ChannelRuleOptions,
  ReplyClient,
  SendReplyLifecycleOptions,
  ReplyStageKind,
  ReplyStagePayload,
  ReplySession,
} from "./types/types.js";

export function shouldHandleInboundEvent(
  event: InboundEvent,
  options: ChannelRuleOptions,
): boolean {
  if (event.senderId === options.botUserId) {
    return false;
  }

  if (event.roomType === "direct") {
    return true;
  }

  const aliases = options.mentionNames.map(normalizeMention);
  const explicitMentions = event.mentions.map(normalizeMention);
  if (explicitMentions.some((mention) => aliases.includes(mention))) {
    return true;
  }

  const normalizedText = event.text.toLowerCase();
  return aliases.some((alias) => normalizedText.includes(`@${alias}`));
}

export async function sendReplyLifecycle(
  options: SendReplyLifecycleOptions,
): Promise<string> {
  const session = await createReplySession(options.client, options.roomId, options.tmid);

  try {
    if (typeof options.run === "function") {
      await options.run(session);
      if (!session.hasFinalUpdate()) {
        await session.update({
          kind: "final",
          payload: {},
        });
      }
    } else {
      await session.update({
        kind: "final",
        payload: {
          text: options.finalText,
        },
      });
    }
  } catch (error) {
    await session.fail(error);
    throw error;
  }

  return session.messageId;
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

async function createReplySession(
  client: ReplyClient,
  roomId: string,
  tmid: string | undefined,
): Promise<ReplySession> {
  const threadOptions = tmid ? { tmid } : undefined;
  const messageId = await client.postMessage(roomId, THINKING_PLACEHOLDER, threadOptions);
  let finalUpdated = false;

  const progress = createReplyProgressState();

  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let appliedStages = 0;
  const startedAt = Date.now();

  const stopWatchdog = (): void => {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const runWatchdog = async (): Promise<void> => {
    const elapsedS = (Date.now() - startedAt) / 1000;
    while (appliedStages < WATCHDOG_STAGES.length) {
      const stage = WATCHDOG_STAGES[appliedStages]!;
      if (elapsedS < stage.afterSeconds) {
        return;
      }
      appliedStages += 1;
      try {
        await client.updateMessage(roomId, messageId, stage.text);
      } catch {
      }
      if (stage.terminal) {
        stopWatchdog();
        return;
      }
    }
  };

  watchdogTimer = setInterval(() => {
    void runWatchdog();
  }, 15_000);
  if (typeof watchdogTimer === "object" && watchdogTimer !== null && "unref" in watchdogTimer) {
    (watchdogTimer as { unref: () => void }).unref();
  }

  return {
    messageId,
    update: async ({ kind, payload }) => {
      stopWatchdog();
      if (kind === "final") {
        finalUpdated = true;
      }
      const text = formatReplyUpdate(kind, payload, progress);
      const isEmptyFinal =
        kind === "final" &&
        text === EMPTY_REPLY_FALLBACK;
      if (isEmptyFinal && client.deleteMessage) {
        try {
          await client.deleteMessage(roomId, messageId);
          return;
        } catch {
        }
      }
      await client.updateMessage(roomId, messageId, text);
    },
    hasFinalUpdate: () => finalUpdated,
    fail: async (_error) => {
      stopWatchdog();
      await client.updateMessage(roomId, messageId, formatReplyFailure());
    },
  };
}
