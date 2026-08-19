import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin, startGateway } from "./plugin.js";

export { startGateway } from "./plugin.js";

export default function register(api: OpenClawPluginApi): void {
  api.registerChannel({ plugin: rocketchatPlugin });

  api.registerCli(
    ({ program }: { program: any }) => {
      const rc = program.command("rocket-chat").description("Rocket.Chat channel plugin commands");

      rc.command("setup")
        .description("Interactive setup wizard - connect Rocket.Chat to OpenClaw")
        .action(async () => {
          const { runSetup } = await import("./cli/setup.js");
          await runSetup();
        });
    },
    {
      commands: ["rocket-chat", "rocket-chat setup"],
    },
  );
}
