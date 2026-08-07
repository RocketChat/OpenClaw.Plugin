import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin, startGateway } from "./plugin.js";

export { startGateway } from "./plugin.js";

const entry: OpenClawPluginDefinition = defineChannelPluginEntry({
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin with DDP/websocket outbound/inbound",
  plugin: rocketchatPlugin,
});

export default entry;
