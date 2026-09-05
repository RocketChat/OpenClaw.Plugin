import { readAllAccounts, setAccountEnabled, OC_CONFIG_PATH } from "./config-updater.js";
import { color, prompts as p } from "./ui.js";

export async function runList(): Promise<void> {
  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.info("No Rocket.Chat bot accounts configured.");
    return;
  }
  p.log.info(`Rocket.Chat bot accounts (${accounts.length}):`);
  for (const a of accounts) {
    const status = a.enabled ? color.green("enabled") : color.dim("disabled");
    const mentions = a.mentionNames.length ? ` @${a.mentionNames.join(", @")}` : "";
    p.log.message(`  ${color.cyan(a.accountId)} [${status}] ${color.dim(a.serverUrl)}${mentions}`);
  }
}

export async function runSetEnabled(accountId: string, enabled: boolean): Promise<void> {
  const ok = setAccountEnabled(accountId, enabled);
  if (!ok) {
    p.log.error(`No bot account named "${accountId}" found in ${OC_CONFIG_PATH}`);
    process.exit(1);
  }
  p.log.success(
    `Bot ${color.cyan(accountId)} ${enabled ? "enabled" : "disabled"} in ${OC_CONFIG_PATH}`,
  );
  p.log.info("Run `openclaw restart` to apply the change.");
}
