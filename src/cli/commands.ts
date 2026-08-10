import type { Command } from "commander";
import { readAccount, readAllAccounts, readAgentsList, readBindingsForAccount, addAccount, addBinding, removeBindingsForAccount, removeAccount, readAllowedUsers, addAllowedUser, removeAllowedUser, type ExistingAccount } from "./config-updater.js";
import { checkServerHealth, listGroups, inviteToGroup, kickFromGroup, getGroupByName, loginAs, createBotUser, getUserByUsername, type RocketChatGroup } from "./admin-api.js";
import { loadAdmin, saveBotCredentials, loadBotCredentials } from "./credentials.js";
import type { RCLoginResult } from "../types.js";
import { color, printSummary, withSpinner, promptText, promptConfirm, promptSelect, prompts as p } from "./ui.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

  program
    .command("remove-group")
    .description("Remove the bot from a Rocket.Chat group/channel")
    .action(async () => {
      await runRemoveGroup();
    });

  program
    .command("add-bot")
    .description("Create a new bot account and bind it to an agent")
    .action(async () => {
      await runAddBot();
    });

  program
    .command("bots")
    .description("List all Rocket.Chat bot accounts and their agent bindings")
    .action(async () => {
      await runBots();
    });

  program
    .command("bind-agent [bot]")
    .description("Assign or reassign an agent to a bot")
    .action(async (bot: string | undefined) => {
      await runBindAgent(bot);
    });

  program
    .command("remove-bot [bot]")
    .description("Remove a bot account and all its bindings")
    .action(async (bot: string | undefined) => {
      await runRemoveBot(bot);
    });

  program
    .command("allow-user [bot]")
    .description("Grant a user access to a bot in group chats")
    .action(async (bot: string | undefined) => {
      await runAllowUser(bot);
    });

  program
    .command("remove-user [bot]")
    .description("Revoke a user's access to a bot in group chats")
    .action(async (bot: string | undefined) => {
      await runRemoveUser(bot);
    });

  program
    .command("users [bot]")
    .description("List users allowed to use a bot in group chats")
    .action(async (bot: string | undefined) => {
      await runUsers(bot);
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
  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.warn("No Rocket.Chat accounts configured. Run `npm run setup`.");
    return;
  }

  // Pick which bot to invite
  let account: ExistingAccount;
  if (accounts.length === 1) {
    account = accounts[0]!;
  } else {
    const botOptions = accounts.map((a) => ({
      label: `@${a.mentionNames[0] ?? a.accountId}`,
      value: a.accountId,
    }));
    const picked = await promptSelect<string>({
      message: "Which bot to invite?",
      options: botOptions,
    });
    account = accounts.find((a) => a.accountId === picked)!;
  }

  const botUsername = account.mentionNames[0] ?? account.accountId;

  const admin = await requireAdminAuth(account.serverUrl);
  if (!admin) return;

  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Add Bot to Group`);

  while (true) {
    const typedName = await promptText({
      message: `Which group should @${botUsername} join? (Enter name, or leave empty to skip)`,
      validate: () => undefined,
    });

    const trimmed = (typedName ?? "").trim();
    if (!trimmed) {
      p.outro(color.dim("Skipped."));
      return;
    }

    const group = await getGroupByName(account.serverUrl, admin, trimmed);
    if (!group) {
      p.log.warn(`Group "${trimmed}" not found. Try again or leave empty to skip.`);
      continue;
    }

    const confirm = await promptConfirm({
      message: `Add @${botUsername} to #${group.name}?`,
      initialValue: true,
    });
    if (!confirm) {
      p.outro(color.dim("Cancelled."));
      return;
    }

    try {
      await withSpinner("Inviting bot", () => inviteToGroup(account.serverUrl, admin, group._id, botUsername, group.isPrivate ?? false));
      p.log.success(`Added @${botUsername} to #${group.name}`);
      p.log.step(`Mention @${botUsername} in #${group.name} to talk to it`);
    } catch (e: unknown) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }

    p.outro(color.green("Done"));
    return;
  }
}

async function runRemoveGroup(): Promise<void> {
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

  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Remove Bot from Group`);

  const typedName = await promptText({
    message: `Which group should @${botUsername} leave? (Enter name)`,
    validate: (v) => ((v ?? "").trim() ? undefined : "Name is required"),
  });

  const trimmed = (typedName ?? "").trim();
  if (!trimmed) {
    p.outro(color.dim("Skipped."));
    return;
  }

  const group = await getGroupByName(account.serverUrl, admin, trimmed);
  if (!group) {
    p.log.error(`Group "${trimmed}" not found.`);
    p.outro(color.red("Not found"));
    return;
  }

  const confirm = await promptConfirm({
    message: `Remove @${botUsername} from #${group.name}?`,
    initialValue: true,
  });
  if (!confirm) {
    p.outro(color.dim("Cancelled."));
    return;
  }

  try {
    await withSpinner("Removing bot", () => kickFromGroup(account.serverUrl, admin, group._id, botUsername, group.isPrivate ?? false));
    p.log.success(`Removed @${botUsername} from #${group.name}`);
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

  const lines = groups.map((g, i) => `${color.dim(`${i + 1}.`)} ${g.name}`).join("\n");
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

async function runAddBot(): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Add New Bot`);

  const mainAccount = readAccount(ACCOUNT_ID);
  if (!mainAccount) {
    p.log.warn("No Rocket.Chat account configured. Run `openclaw rocketchat setup` first.");
    p.outro(color.dim("Setup required."));
    return;
  }

  const admin = await requireAdminAuth(mainAccount.serverUrl);
  if (!admin) return;

  // 1. Bot username
  const botUsername = await promptText({
    message: "Bot username (e.g. reminder-bot)",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) return "Username is required";
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return "Use letters, numbers, dots, dashes, or underscores";
      return undefined;
    },
  });

  // Check if account already exists in config
  const existingAccount = readAccount(botUsername);
  if (existingAccount) {
    p.log.error(`Account "${botUsername}" already exists in openclaw.json.`);
    p.outro(color.red("Duplicate account."));
    return;
  }

  // 2. Check RC user
  const rcUser = await withSpinner(`Checking @${botUsername} on Rocket.Chat`, () =>
    getUserByUsername(mainAccount.serverUrl, admin, botUsername),
  );

  let botAuth: RCLoginResult | null = null;
  let botPassword: string;

  if (rcUser) {
    // Adopt existing user
    p.log.info(`User @${botUsername} already exists on Rocket.Chat.`);
    const savedBot = await loadBotCredentials(botUsername);
    if (savedBot?.password) {
      p.log.info("Trying saved password...");
      botAuth = await tryBotLogin(mainAccount.serverUrl, botUsername, savedBot.password);
    }

    if (!botAuth) {
      botPassword = await promptText({
        message: `Password for existing bot @${botUsername}`,
        validate: (v) => ((v ?? "").trim() ? undefined : "Password is required"),
      });
      botAuth = await tryBotLogin(mainAccount.serverUrl, botUsername, botPassword);
      if (!botAuth) {
        p.log.error("Login failed. Check the password and try again.");
        p.outro(color.red("Authentication failed."));
        return;
      }
    } else {
      botPassword = savedBot!.password;
    }
    p.log.success(`Adopted existing bot @${botUsername}`);
  } else {
    // Create new bot user
    const displayName = await promptText({
      message: "Bot display name",
      defaultValue: botUsername,
    });

    const botEmail = await promptText({
      message: "Bot email",
      defaultValue: `${botUsername.toLowerCase()}@openclaw.local`,
      validate: (v) => ((v ?? "").includes("@") ? undefined : "Enter a valid email"),
    });

    botPassword = randomUUID().slice(0, 16) + "Aa1!";

    let botUser;
    try {
      botUser = await withSpinner(`Creating bot @${botUsername}`, () =>
        createBotUser(mainAccount.serverUrl, admin, {
          username: botUsername,
          name: displayName,
          password: botPassword,
          email: botEmail,
        }),
      );
      p.log.success(`Created bot @${botUser.username} ${color.dim(`(${botUser._id})`)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Invalid email")) {
        p.log.error(`Invalid email: "${botEmail}". Rocket.Chat rejected it.`);
      } else if (msg.includes("already in use") || msg.includes("already exists")) {
        p.log.error(`Username "${botUsername}" is already taken on Rocket.Chat.`);
      } else {
        p.log.error(`Failed to create bot: ${msg}`);
      }
      p.outro(color.red("Bot creation failed."));
      return;
    }

    try {
      botAuth = await withSpinner("Logging in as bot", () =>
        loginAs(mainAccount.serverUrl, botUsername, botPassword),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      p.log.error(`Bot login failed: ${msg}`);
      p.outro(color.red("Authentication failed."));
      return;
    }
  }

  if (!botAuth) {
    p.log.error("Could not obtain bot auth token.");
    p.outro(color.red("Failed."));
    return;
  }

  await saveBotCredentials(botUsername, { userId: botAuth.userId, password: botPassword! });

  // 3. Agent selection
  const agents = readAgentsList();
  if (agents.length === 0) {
    p.log.error("No agents found. Create one with `openclaw agents add <name>`.");
    p.outro(color.red("No agents."));
    return;
  }

  const agentOptions = agents.map((a, i) => ({
    label: `${i + 1}. ${a.name ?? a.id}`,
    value: a.id,
  }));

  const agentId = await promptSelect<string>({
    message: "Which agent should this bot use?",
    options: agentOptions,
  });

  // 4. Write config (global binding — responds in all rooms)
  try {
    await withSpinner("Saving configuration", async () => {
      addAccount({
        accountId: botUsername,
        serverUrl: mainAccount.serverUrl,
        auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
        mentionNames: [botUsername],
        transport: { mode: "websocket" },
      });

      addBinding({
        channel: "rocketchat",
        accountId: botUsername,
        agentId,
      });
    });
    p.log.success(`Updated ~/.openclaw/openclaw.json`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    p.log.error(`Failed to save configuration: ${msg}`);
    p.outro(color.red("Config write failed."));
    return;
  }

  printSummary([
    { label: "Bot", value: `@${botUsername}` },
    { label: "Agent", value: agentId },
    { label: "Scope", value: color.dim("global (all rooms)") },
    { label: "Config", value: "~/.openclaw/openclaw.json" },
  ]);

  p.log.step("Add the bot to groups with `npm run add-group`.");
  p.log.step(color.cyan("Restart OpenClaw to activate the new bot."));
  p.outro(color.green("Bot added"));
}

async function runBots(): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Bot Accounts`);

  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.warn("No Rocket.Chat accounts configured. Run `npm run setup`.");
    p.outro(color.dim("No bots found."));
    return;
  }

  const rows: Array<{ label: string; value: string }> = [];

  for (const account of accounts) {
    const bindings = readBindingsForAccount(account.accountId);
    const mention = account.mentionNames[0] ?? account.accountId;

    if (bindings.length === 0) {
      rows.push({
        label: `@${mention}`,
        value: `${color.yellow("(no agent bound)")}  ${color.dim("run `npm run bind-agent " + account.accountId + "`")}`,
      });
      continue;
    }

    for (const binding of bindings) {
      const scope = binding.peer
        ? `${binding.peer.kind} ${color.dim(binding.peer.id)}`
        : color.dim("global");
      rows.push({
        label: `@${mention}`,
        value: `${binding.agentId}  ${scope}`,
      });
    }
  }

  await printSummary(rows);
  p.outro(color.green(`${accounts.length} account(s)`));
}

async function runBindAgent(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Bind Agent`);

  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.warn("No accounts configured.");
    p.outro(color.dim("Nothing to bind."));
    return;
  }

  let account: ExistingAccount;
  if (botArg) {
    const found = accounts.find((a) => a.accountId === botArg || a.mentionNames.includes(botArg));
    if (!found) {
      p.log.error(`Bot "${botArg}" not found.`);
      p.outro(color.red("Not found."));
      return;
    }
    account = found;
  } else {
    const options = accounts.map((a) => ({
      label: `@${a.mentionNames[0] ?? a.accountId}`,
      value: a,
    }));
    account = await promptSelect<ExistingAccount>({
      message: "Which bot?",
      options,
    });
  }

  const agents = readAgentsList();
  if (agents.length === 0) {
    p.log.error("No agents found.");
    p.outro(color.red("No agents."));
    return;
  }

  const agentOptions = agents.map((a, i) => ({
    label: `${i + 1}. ${a.name ?? a.id}`,
    value: a.id,
  }));

  const agentId = await promptSelect<string>({
    message: `Which agent for @${account.mentionNames[0] ?? account.accountId}?`,
    options: agentOptions,
  });

  try {
    addBinding({
      channel: "rocketchat",
      accountId: account.accountId,
      agentId,
    });
    p.log.success(`Bound @${account.mentionNames[0] ?? account.accountId} → ${agentId}`);
    p.outro(color.green("Binding updated"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    p.log.error(`Failed: ${msg}`);
    p.outro(color.red("Failed"));
  }
}

async function runRemoveBot(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Remove Bot`);

  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.warn("No accounts configured.");
    p.outro(color.dim("Nothing to remove."));
    return;
  }

  let account: ExistingAccount;
  if (botArg) {
    const found = accounts.find((a) => a.accountId === botArg || a.mentionNames.includes(botArg));
    if (!found) {
      p.log.error(`Bot "${botArg}" not found.`);
      p.outro(color.red("Not found."));
      return;
    }
    account = found;
  } else {
    const options = accounts.map((a) => ({
      label: `@${a.mentionNames[0] ?? a.accountId}`,
      value: a,
    }));
    account = await promptSelect<ExistingAccount>({
      message: "Which bot to remove?",
      options,
    });
  }

  const mention = account.mentionNames[0] ?? account.accountId;
  const confirm = await promptConfirm({
    message: `Remove @${mention} permanently? This deletes the config entry and all bindings.`,
    initialValue: false,
  });

  if (!confirm) {
    p.outro(color.dim("Cancelled."));
    return;
  }

  try {
    removeBindingsForAccount(account.accountId);
    removeAccount(account.accountId);
    p.log.success(`Removed @${mention} and its bindings`);
    p.log.step(color.cyan("Restart OpenClaw to apply changes."));
    p.outro(color.green("Bot removed"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    p.log.error(`Failed: ${msg}`);
    p.outro(color.red("Failed"));
  }
}

async function pickBotAccount(botArg?: string): Promise<ExistingAccount | null> {
  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.warn("No accounts configured. Run `npm run setup`.");
    return null;
  }
  if (botArg) {
    const found = accounts.find((a) => a.accountId === botArg || a.mentionNames.includes(botArg));
    if (!found) {
      p.log.error(`Bot "${botArg}" not found.`);
      return null;
    }
    return found;
  }
  const options = accounts.map((a) => ({
    label: `@${a.mentionNames[0] ?? a.accountId}`,
    value: a,
  }));
  return promptSelect<ExistingAccount>({
    message: "Which bot?",
    options,
  });
}

async function runAllowUser(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Allow User`);
  const account = await pickBotAccount(botArg);
  if (!account) {
    p.outro(color.dim("Cancelled."));
    return;
  }
  const mention = account.mentionNames[0] ?? account.accountId;
  const username = await promptText({
    message: `Username to grant access to @${mention} (omit @):`,
    validate: (v) => ((v ?? "").trim() ? undefined : "Username is required"),
  });
  const name = (username ?? "").trim().replace(/^@+/, "");
  if (!name) return;
  try {
    addAllowedUser(account.accountId, name);
    p.log.success(`@${name} can now use @${mention} in groups`);
    p.log.step(color.cyan("Restart OpenClaw to apply changes."));
    p.outro(color.green("User allowed"));
  } catch (e: unknown) {
    p.log.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    p.outro(color.red("Failed"));
  }
}

async function runRemoveUser(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Remove User`);
  const account = await pickBotAccount(botArg);
  if (!account) {
    p.outro(color.dim("Cancelled."));
    return;
  }
  const users = readAllowedUsers(account.accountId);
  if (users.length === 0) {
    p.log.warn(`No allowed users for @${account.mentionNames[0] ?? account.accountId}. The bot is public in groups.`);
    p.outro(color.dim("No users to remove."));
    return;
  }
  const picked = await promptSelect<string>({
    message: "Which user to revoke?",
    options: users.map((u) => ({ label: `@${u}`, value: u })),
  });
  try {
    removeAllowedUser(account.accountId, picked);
    p.log.success(`Revoked @${picked}`);
    p.log.step(color.cyan("Restart OpenClaw to apply changes."));
    p.outro(color.green("User removed"));
  } catch (e: unknown) {
    p.log.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    p.outro(color.red("Failed"));
  }
}

async function runUsers(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Allowed Users`);
  const account = await pickBotAccount(botArg);
  if (!account) {
    p.outro(color.dim("Cancelled."));
    return;
  }
  const users = readAllowedUsers(account.accountId);
  const mention = account.mentionNames[0] ?? account.accountId;
  if (users.length === 0) {
    p.log.warn(`@${mention} is public in group chats (no allow-list configured).`);
  } else {
    p.log.step(`Users allowed to use @${mention} in groups:`);
    for (const u of users) {
      p.log.info(`- @${u}`);
    }
  }
  p.log.step(color.dim(`DMs are always allowed. Manage with \`npm run allow-user\` / \`npm run remove-user\`.`));
  p.outro(color.green("Done"));
}

async function tryBotLogin(rcUrl: string, username: string, password: string): Promise<RCLoginResult | null> {
  try {
    return await loginAs(rcUrl, username, password);
  } catch {
    return null;
  }
}

function loadBotCredentialsSync(username: string): boolean {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.existsSync(join(CREDS_DIR, `bot-${username}.json`));
  } catch {
    return false;
  }
}
