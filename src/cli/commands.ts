import type { Command } from "commander";
import { readAccount } from "./config-updater.js";
import { checkServerHealth, listGroups, inviteToGroup, getGroupByName, type RocketChatGroup } from "./admin-api.js";
import { loadAdmin } from "./credentials.js";
import { color, printSummary, withSpinner, promptSelect, promptText, prompts as p } from "./ui.js";
import { homedir } from "node:os";
import { join } from "node:path";

const ACCOUNT_ID = "main";
const CREDS_DIR = join(homedir(), ".openclaw", "credentials", "rocketchat");

export function registerRocketChatCommands(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup wizard — connect Rocket.Chat to OpenClaw")
    .action(async () => {
      const { runSetup } = await import("./setup.js");
      await runSetup();
    });

  program
    .command("status")
    .description("Show Rocket.Chat connection + bot status")
    .action(async () => {
      await runStatus();
    });

  program
    .command("add-group")
    .description("Invite the bot to an existing Rocket.Chat group/channel")
    .action(async () => {
      await runAddGroup();
    });

  program
    .command("groups")
    .description("List groups the bot is a member of")
    .action(async () => {
      await runGroups();
    });
}

async function requireAdminAuth(serverUrl: string) {
  const admin = await loadAdmin(serverUrl);
  if (!admin) {
    p.log.error("Admin credentials missing. Re-run setup to store them.");
    return null;
  }
  return admin;
}

async function runAddGroup(): Promise<void> {
  const account = readAccount(ACCOUNT_ID);
  if (!account) {
    p.log.warn("No Rocket.Chat account configured. Run `openclaw rocketchat setup`.");
    return;
  }
  const botUsername = account.mentionNames[0];
  if (!botUsername) {
    p.log.error("No bot username configured.");
    return;
  }

  const admin = await requireAdminAuth(account.serverUrl);
  if (!admin) return;

  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Add Bot to Group`);

  let groups: RocketChatGroup[];
  try {
    groups = await withSpinner("Loading groups", () => listGroups(account.serverUrl, admin));
  } catch (e: unknown) {
    p.log.error(e instanceof Error ? e.message : String(e));
    return;
  }

  if (groups.length === 0) {
    p.log.info("No groups found. Create one in Rocket.Chat, then try again.");
    p.outro(color.dim("No groups to join."));
    return;
  }

  const selectOptions = [
    ...groups.map((g) => ({
      value: g._id,
      label: g.isPrivate ? `${g.name} 🔒` : g.name,
    })),
    { value: "__manual__", label: "➕ Type a group name manually" },
  ];

  const choice = await promptSelect<string>({
    message: "Select a group/channel to invite the bot to",
    options: selectOptions,
  });

  let group: RocketChatGroup | null = null;
  if (choice === "__manual__") {
    const typedName = await promptText({
      message: "Enter the group/channel name",
      validate: (v) => ((v ?? "").trim() ? undefined : "Name is required"),
    });
    group = await getGroupByName(account.serverUrl, admin, typedName.trim());
    if (!group) {
      p.log.error(`Group "${typedName}" not found on Rocket.Chat.`);
      p.outro(color.red("Not found"));
      return;
    }
  } else {
    group = groups.find((g) => g._id === choice) ?? null;
  }

  if (!group) {
    p.log.error("Group selection failed.");
    return;
  }

  try {
    await withSpinner("Inviting bot", () => inviteToGroup(account.serverUrl, admin, group!._id, botUsername));
    p.log.success(`Added @${botUsername} to #${group.name}`);
    p.log.step(`Mention @${botUsername} in #${group.name} to talk to it`);
  } catch (e: unknown) {
    p.log.error(e instanceof Error ? e.message : String(e));
  }

  p.outro(color.green("Done"));
}

async function runGroups(): Promise<void> {
  const account = readAccount(ACCOUNT_ID);
  if (!account) {
    p.log.warn("No Rocket.Chat account configured. Run `openclaw rocketchat setup`.");
    return;
  }

  const admin = await requireAdminAuth(account.serverUrl);
  if (!admin) return;

  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Rocket.Chat Groups`);

  let groups: RocketChatGroup[];
  try {
    groups = await withSpinner("Loading groups", () => listGroups(account.serverUrl, admin));
  } catch (e: unknown) {
    p.log.error(e instanceof Error ? e.message : String(e));
    return;
  }

  if (groups.length === 0) {
    p.log.info("Bot is not in any groups yet. Run `add-group`.");
    p.outro(color.dim("No group memberships."));
    return;
  }

  const lines = groups.map((g, i) => `${color.dim(`${i + 1}.`)} ${g.isPrivate ? `${g.name} 🔒` : g.name}`).join("\n");
  p.note(lines, "Groups the bot is in");
  p.outro(color.green("Groups listed"));
}

async function runStatus(): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Rocket.Chat Status`);

  const account = readAccount(ACCOUNT_ID);
  if (!account) {
    p.log.warn("No Rocket.Chat account configured. Run `openclaw rocketchat setup`.");
    p.outro(color.dim("No configuration found."));
    return;
  }

  const online = await checkServerHealth(account.serverUrl);
  await printSummary([
    { label: "Server", value: account.serverUrl },
    { label: "Status", value: online ? color.green("online") : color.red("offline") },
    { label: "Bots", value: account.mentionNames.map((n) => `@${n}`).join(", ") || color.dim("(none)") },
    { label: "Config", value: "~/.openclaw/openclaw.json" },
  ]);

  
  const savedBots = account.mentionNames.filter((n) => loadBotCredentialsSync(n));
  if (savedBots.length > 0) {
    p.log.step("Saved bot credentials");
    for (const name of savedBots) {
      p.log.info(`@${name} — ${color.dim(join(CREDS_DIR, `bot-${name}.json`))}`);
    }
  }

  p.outro(color.green("Status complete"));
}

function loadBotCredentialsSync(username: string): boolean {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.existsSync(join(CREDS_DIR, `bot-${username}.json`));
  } catch {
    return false;
  }
}
