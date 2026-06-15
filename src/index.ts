import type { GatewayApi } from "./types/types.js";
import { rocketchatPlugin, startGateway, listAccountIds, resolveAccount } from "./plugin.js";
import * as store from "./cli/credential-store.js";

export function register(api: GatewayApi) {
  api.registerChannel?.({ plugin: rocketchatPlugin });
}

export function activate(api: GatewayApi) {
  api.registerGatewayMethod("rocketchat.gateway.startAccount", (ctx) => {
    return startGateway(ctx as Parameters<typeof startGateway>[0]);
  });
}

export default {
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin with REST polling outbound/inbound",
  plugin: rocketchatPlugin,
  config: {
    listAccountIds,
    resolveAccount,
    isConfigured(account: unknown) {
      const a = account as { serverUrl?: string; accountId?: string } | null | undefined;
      if (!a?.serverUrl) return false;
      if (a.accountId && store.exists(a.accountId)) return true;
      return Boolean((a as any).auth);
    }
  },
  register,
  activate,
};
