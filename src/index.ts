import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin, startGateway } from "./plugin.js";

export { startGateway } from "./plugin.js";

const _entry = defineChannelPluginEntry({
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin with REST polling outbound/inbound",
  plugin: rocketchatPlugin,
  registerFull: (api: OpenClawPluginApi) => {
    api.registerGatewayMethod("rocketchat.gateway.startAccount", (ctx) => {
      return startGateway(ctx as unknown as Parameters<typeof startGateway>[0]);
    });
  },
});

const entry: OpenClawPluginDefinition & { channelPlugin: typeof rocketchatPlugin } = _entry;

export default entry;
