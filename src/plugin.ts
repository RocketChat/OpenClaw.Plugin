import { RocketChatClient } from "./client.js";
import { parsePluginConfig, type PluginConfig, type PluginAccountConfig } from "./config.js";

export type ResolvedAccount = PluginAccountConfig & {
  accountId: string;
};

export type OpenClawConfig = {
  session?: { store?: string };
  channels?: { rocketchat?: unknown };
};

export let logger: any = null;

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

export async function startGateway(ctx: {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  setStatus?: (s: { accountId: string; state: string }) => void;
  log?: { info: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  const account = resolveAccount(ctx.cfg ?? {}, ctx.accountId);
  if (!account || !account.enabled) {
    ctx.setStatus?.({ accountId: ctx.accountId ?? "default", state: "disabled" });
    return;
  }

  const client = new RocketChatClient({
    serverUrl: account.serverUrl,
    auth: account.auth,
  });
  await client.initialize();
  ctx.setStatus?.({ accountId: account.accountId, state: "connected" });

  await new Promise<void>((resolve) => {
    if (ctx.abortSignal.aborted) return resolve();
    ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
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

      const client = new RocketChatClient({
        serverUrl: account.serverUrl,
        auth: account.auth,
      });
      await client.initialize();
      const tmidOptions = params.replyToId ? { tmid: params.replyToId } : undefined;
      const messageId = await client.postMessage(params.to, params.text, tmidOptions);
      return { ok: true, messageId, channel: "rocketchat" };
    },
  },
  gateway: {
    startAccount: startGateway,
  },
};

export const registerPlugin = (api: any) => {
  logger = api.logger || {
    info: (msg: string) => console.log(`[RC] ${msg}`),
    error: (msg: string) => console.error(`[RC] ${msg}`),
  };

  try {
    api.registerChannel({ plugin: rocketchatPlugin });
  } catch (error) {
    // already registered
  }
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
