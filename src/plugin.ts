import { RocketChatClient } from "./client.js";
import { startGateway, resolveAccount, listAccountIds, isConfigured, activeClients } from "./gateway.js";
import type { OpenClawConfig } from "./types/types.js";

export { startGateway, resolveAccount, listAccountIds, isConfigured };

export const rocketchatPlugin = {
  id: "rocketchat",
  meta: {
    id: "rocketchat",
    label: "Rocket.Chat",
    selectionLabel: "Rocket.Chat",
    blurb: "Rocket.Chat channel plugin with REST polling outbound/inbound",
    aliases: ["rc"],
  },
  capabilities: { chatTypes: ["direct", "group", "channel"] },
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

      const entry = activeClients.get(account.accountId);
      let client = entry?.client ?? null;
      if (!client) {
        client = new RocketChatClient({ serverUrl: account.serverUrl, auth: account.auth });
      }
      const tmidOptions = params.replyToId ? { tmid: params.replyToId } : undefined;
      const messageId = await client.postMessage(params.to, params.text, tmidOptions);
      entry?.wakeup?.();
      return { ok: true, messageId, channel: "rocketchat" };
    },
  },
  gateway: {
    startAccount: startGateway,
  },
};
