import { rocketchatPlugin, startGateway, listAccountIds, resolveAccount } from "./plugin.js";

type GatewayApi = {
  registerGatewayMethod(name: string, handler: (ctx: unknown) => Promise<void>): void;
  registerChannel?(args: { plugin: unknown }): void;
};

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
      const a = account as { serverUrl?: string; auth?: unknown } | null | undefined;
      return Boolean(a?.serverUrl && a.auth);
    }
  },
  register,
  activate,
};
