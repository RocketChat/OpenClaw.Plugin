import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { RocketChatClient } from "./client.js";
import { startGateway, resolveAccount, listAccountIds, isConfigured, activeClients } from "./gateway.js";
import type { ResolvedAccount } from "./types/types.js";

export { startGateway, resolveAccount, listAccountIds, isConfigured };

export const rocketchatPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    id: "rocketchat",
    meta: {
      id: "rocketchat",
      label: "Rocket.Chat",
      selectionLabel: "Rocket.Chat",
      docsPath: "https://rocket.chat/docs",
      blurb: "Rocket.Chat channel plugin with REST polling outbound/inbound",
      aliases: ["rc"],
    },
    capabilities: { chatTypes: ["direct", "group", "channel"] },
    config: {
      listAccountIds: listAccountIds as (cfg: OpenClawConfig) => string[],
      resolveAccount: resolveAccount as (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount,
      isConfigured: ((account: unknown, _cfg: OpenClawConfig): boolean => isConfigured(account as Parameters<typeof isConfigured>[0])) as (account: ResolvedAccount, cfg: OpenClawConfig) => boolean,
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
    gateway: {
      startAccount: (ctx: unknown) => startGateway(ctx as Parameters<typeof startGateway>[0]),
    },
  },
  threading: {
    topLevelReplyToMode: "reply",
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      resolveTarget: (params) => {
        const to = params?.to?.trim();
        if (!to) return { ok: false as const, error: new Error("Rocket.Chat send requires a target id") };
        const normalized = to.replace(/^rocketchat:(?:channel:|user:)?/i, "").replace(/^channel:/i, "");
        return { ok: true as const, to: normalized };
      },
    },
    attachedResults: {
      channel: "rocketchat",
      sendText: async (ctx) => {
        const accountId = ctx.accountId ?? undefined;
        let account = resolveAccount(ctx.cfg as Parameters<typeof resolveAccount>[0], accountId);
        if (!account) {
          const accounts = listAccountIds(ctx.cfg as Parameters<typeof listAccountIds>[0]);
          if (accounts.length > 0) {
            account = resolveAccount(ctx.cfg as Parameters<typeof resolveAccount>[0], accounts[0]);
          }
        }
        if (!account) throw new Error(`Unknown Rocket.Chat account: ${ctx.accountId}`);

        const entry = activeClients.get(account.accountId);
        let client = entry?.client ?? null;
        if (!client) {
          client = new RocketChatClient({ serverUrl: account.serverUrl, auth: account.auth });
        }
        const tmidOptions = ctx.replyToId ? { tmid: ctx.replyToId } : undefined;
        const messageId = await client.postMessage(ctx.to, ctx.text, tmidOptions);
        entry?.wakeup?.();
        return { ok: true, messageId };
      },
    },
  },
});
