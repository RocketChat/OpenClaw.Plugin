import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin, startGateway } from "./plugin.js";

export { startGateway } from "./plugin.js";

export default function register(api: OpenClawPluginApi): void {
  api.registerChannel({ plugin: rocketchatPlugin });

  api.registerCli(
    ({ program }: { program: any }) => {
      const rc = program.command("rocketchat").description("Rocket.Chat channel plugin commands");

      rc.command("setup")
        .description("Interactive setup wizard - connect Rocket.Chat to OpenClaw")
        .action(async () => {
          const { runSetup } = await import("./cli/setup.js");
          await runSetup();
        });

      rc.command("list")
        .description("List configured Rocket.Chat bot accounts and their status")
        .action(async () => {
          const { runList } = await import("./cli/accounts.js");
          await runList();
        });

      rc.command("disable")
        .description("Disable a Rocket.Chat bot account (stops auto-connect retries)")
        .argument("<bot>", "bot account id")
        .action(async (bot: string) => {
          const { runSetEnabled } = await import("./cli/accounts.js");
          await runSetEnabled(bot, false);
        });

      rc.command("enable")
        .description("Enable a previously disabled Rocket.Chat bot account")
        .argument("<bot>", "bot account id")
        .action(async (bot: string) => {
          const { runSetEnabled } = await import("./cli/accounts.js");
          await runSetEnabled(bot, true);
        });
    },
    {
      commands: ["rocketchat"],
    },
  );
}
