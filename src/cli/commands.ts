import type { Command } from "commander";
import { readAccount, readAllAccounts, readAgentsList, readBindingsForAccount, addAccount, addBinding, removeBindingsForAccount, removeAccount, readOwner, type ExistingAccount } from "./config-updater.js";
import { checkServerHealth, listGroups, listGroupMembers, listPublicChannels, inviteToGroup, kickFromGroup, getGroupByName, loginAs, getSelfInfo, createBotUser, getUserByUsername, createDirectMessage, sendMessage, verifyAdmin, type RocketChatGroup, type RocketChatMember } from "./admin-api.js";
import { loadAdmin, saveBotCredentials, loadBotCredentials, loadOwnerCredentials, saveOwnerCredentials } from "./credentials.js";
import { resolveAdminAuth } from "./setup.js";
import { AccessStore } from "../config/access-store.js";
import type { RCLoginResult } from "../types.js";
import { color, printSummary, withSpinner, promptText, promptConfirm, promptSelect, promptAutocomplete, promptAutocompleteMultiselect, promptPassword, prompts as p, normalizeRocketChatUrl, showServerStatus, printNextSteps } from "./ui.js";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");
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
    .command("bots")
    .description("List all Rocket.Chat bot accounts and their agent bindings")
    .action(async () => {
      await runBots();
    });

  program
    .command("lend [bot]")
    .description("Lend a bot to members inside a specific group")
    .action(async (bot: string | undefined) => {
      await runLend(bot);
    });

  program
    .command("revoke [bot]")
    .description("Revoke a user's access to a bot in a group")
    .action(async (bot: string | undefined) => {
      await runRevoke(bot);
    });

  program
    .command("access [bot]")
    .description("Show who can use a bot and where")
    .action(async (bot: string | undefined) => {
      await runAccess(bot);
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
    .command("add-bot [username]")
    .description("Create a new Rocket.Chat bot account and wire it into OpenClaw")
    .action(async (username: string | undefined) => {
      await runAddBot(username);
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

    // Clean up lingering credentials + access grants so nothing is orphaned.
    for (const name of account.mentionNames) {
      for (const file of [`bot-${name}.json`, `owner-${name}.json`]) {
        const credPath = join(CREDS_DIR, file);
        if (existsSync(credPath)) rmSync(credPath, { force: true });
      }
    }

    const store = new AccessStore();
    const grants = store.loadGrants(account.accountId);
    for (const grant of grants) {
      store.removeGrant({ accountId: account.accountId, roomId: grant.roomId, username: grant.username });
    }
    store.close();

    p.log.success(`Removed @${mention} and its bindings`);
    p.log.step(color.cyan("Restart OpenClaw to apply changes."));
    p.outro(color.green("Bot removed"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    p.log.error(`Failed: ${msg}`);
    p.outro(color.red("Failed"));
  }
}

async function promptServerUrl(defaultValue: string): Promise<string> {
  const urlInput = await promptText({
    message: "Rocket.Chat URL",
    placeholder: "https://chat.example.com",
    defaultValue,
    validate: (value) => {
      const normalized = normalizeRocketChatUrl(value ?? "");
      if (!normalized) return "Enter a valid http(s) URL";
      return undefined;
    },
  });
  const url = normalizeRocketChatUrl(urlInput)!;

  await showServerStatus(url, () => checkServerHealth(url));
  if (!(await checkServerHealth(url))) {
    p.log.error("Rocket.Chat server is unreachable. Check the URL and try again.");
    p.outro(color.dim("Aborted."));
    return "";
  }
  return url;
}

async function resolveRcUrl(): Promise<string> {
  const existing = readAccount(ACCOUNT_ID);
  if (existing) {
    await showServerStatus(existing.serverUrl, () => checkServerHealth(existing.serverUrl));
    if (await checkServerHealth(existing.serverUrl)) {
      return existing.serverUrl;
    }
    p.log.warn("Saved server is unreachable. Enter a Rocket.Chat URL to continue.");
  }
  return promptServerUrl("http://localhost:3000");
}

async function runAddBot(usernameArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Add Bot`);

  const rcUrl = await resolveRcUrl();
  if (!rcUrl) return;

  const adminAuth = await resolveAdminAuth(rcUrl);
  if (!adminAuth) {
    p.outro(color.red("Admin authentication required."));
    return;
  }

  const botUsername = (
    usernameArg ??
    (await promptText({
      message: "Bot Rocket.Chat username",
      placeholder: "rocketbot",
      validate: (value) => {
        const trimmed = (value ?? "").trim();
        if (!trimmed) return "Username is required";
        if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return "Use letters, numbers, dots, dashes, or underscores";
        if (readAccount(trimmed)) return `A bot account "${trimmed}" already exists`;
        return undefined;
      },
    }))
  ).trim();

  if (!botUsername) {
    p.outro(color.dim("Aborted."));
    return;
  }

  let botUser: { _id: string; username: string };
  let botAuth: RCLoginResult | null = null;

  const existingUser = await withSpinner(`Checking @${botUsername} on Rocket.Chat`, () =>
    getUserByUsername(rcUrl, adminAuth, botUsername),
  );

  if (existingUser) {
    p.log.success(`Bot ${color.cyan(`@${botUsername}`)} already exists — verifying its credentials`);
    botUser = existingUser;

    let botPassword = (await loadBotCredentials(botUsername))?.password;
    if (botPassword) {
      botAuth = await tryBotLogin(rcUrl, botUsername, botPassword);
    }

    if (!botAuth) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        botPassword = await promptPassword({
          message:
            attempt === 1
              ? `Password for existing bot @${botUsername}`
              : `Wrong password — re-enter password for @${botUsername} (${2 - attempt + 1} attempt left)`,
          validate: (value) => (value ? undefined : "Password is required"),
        });
        botAuth = await tryBotLogin(rcUrl, botUsername, botPassword);
        if (botAuth) break;
        p.log.error("Login failed: Unauthorized. Check the password and try again.");
      }
      if (!botAuth) {
        p.log.error("Too many failed attempts. Re-run add-bot with the correct password.");
        p.outro(color.red("Aborted."));
        return;
      }
    }

    await saveBotCredentials(botUsername, { userId: botAuth.userId, password: botPassword! });
    p.log.success(`Verified bot ${color.cyan(`@${botUsername}`)}`);
  } else {
    const botName = await promptText({
      message: "Bot display name",
      defaultValue: botUsername,
    });
    const botEmail = await promptText({
      message: "Bot email",
      defaultValue: `${botUsername.toLowerCase()}@openclaw.local`,
      validate: (value) => ((value ?? "").includes("@") ? undefined : "Enter a valid email"),
    });
    let botPassword: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      botPassword = await promptPassword({
        message: attempt === 0 ? "Bot password" : "Bot password (min 6 characters)",
        validate: (value) => {
          if (!value) return "Password is required";
          if (value.length < 6) return "Password must be at least 6 characters";
          return undefined;
        },
      });
      break;
    }

    botUser = await withSpinner(`Creating bot ${color.cyan(`@${botUsername}`)}`, async () => {
      try {
        return await createBotUser(rcUrl, adminAuth, {
          username: botUsername,
          name: botName,
          password: botPassword!,
          email: botEmail,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        p.log.error(`Failed to create bot: ${message}`);
        p.outro(color.red("Aborted."));
        return { _id: "", username: botUsername };
      }
    });
    if (!botUser._id) return;
    p.log.success(`Created bot ${color.cyan(`@${botUser.username}`)} ${color.dim(`(${botUser._id})`)}`);

    botAuth = await withSpinner("Obtaining bot auth token", async () => {
      try {
        const auth = await loginAs(rcUrl, botUsername, botPassword!);
        await saveBotCredentials(botUsername, { userId: auth.userId, password: botPassword! });
        return auth;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        p.log.error(`Bot login failed: ${message}`);
        p.outro(color.red("Aborted."));
        return null;
      }
    });
    if (!botAuth) return;
  }

  if (!botAuth) {
    p.log.error("Bot authentication was not resolved.");
    p.outro(color.red("Aborted."));
    return;
  }

  let ownerUsername: string | undefined;
  try {
    const self = await getSelfInfo(rcUrl, adminAuth);
    ownerUsername = self?.username;
  } catch {
    // owner stays undefined; can be set later in openclaw.json
  }

  try {
    await withSpinner("Saving bot account", async () => {
      addAccount({
        accountId: botUsername,
        serverUrl: rcUrl,
        auth: { mode: "token", userId: botAuth!.userId, accessToken: botAuth!.authToken },
        mentionNames: [botUsername],
        transport: { mode: "websocket" },
        ...(ownerUsername ? { owner: ownerUsername } : {}),
      });
    });
    p.log.success(`Saved @${botUsername} as account "${botUsername}"`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    p.log.error(`Failed to save account: ${message}`);
    p.outro(color.red("Aborted."));
    return;
  }

  p.log.step("Agent binding");
  const agents = readAgentsList();
  if (agents.length > 0) {
    const defaultAgent = agents.find((a) => a.id === "main") ?? agents[0]!;
    try {
      addBinding({ channel: "rocketchat", accountId: botUsername, agentId: defaultAgent.id });
      p.log.success(`Bound @${botUsername} to agent '${defaultAgent.id}'`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      p.log.warn(`Could not create binding: ${message}`);
    }
  } else {
    p.log.warn("No agents found. Create one with `openclaw agents add <name>`, then bind with `bind-agent`.");
  }

  try {
    await withSpinner("Sending welcome DM", async () => {
      const dmRoomId = await createDirectMessage(rcUrl, adminAuth, botUsername);
      await sendMessage(
        rcUrl,
        botAuth,
        dmRoomId,
        "You've been added to OpenClaw! Restart OpenClaw (openclaw restart) then send me a message to start chatting.",
      );
    });
    p.log.success(`Welcome message sent to ${color.cyan(`@${botUsername}`)}`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    p.log.warn(`Welcome message skipped: ${message}`);
  }

  printNextSteps([
    `Restart OpenClaw: ${color.cyan("openclaw restart")}`,
    `Message ${color.cyan(`@${botUsername}`)} in Rocket.Chat`,
  ]);

  p.outro(color.green("Bot added"));
}

async function pickBotAccount(botArg?: string): Promise<ExistingAccount | null> {
  const accounts = readAllAccounts();
  if (accounts.length === 0) {
    p.log.warn("No accounts configured. Run `npm run setup`.");
    return null;
  }
  const owned = accounts.filter((a) => readOwner(a.accountId));

  if (botArg) {
    const found = accounts.find((a) => a.accountId === botArg || a.mentionNames.includes(botArg));
    if (!found) {
      p.log.error(`Bot "${botArg}" not found.`);
      return null;
    }
    if (!readOwner(found.accountId)) {
      p.log.error(`@${found.mentionNames[0] ?? found.accountId} has no owner set. Set the owner in openclaw.json first.`);
      p.outro(color.red("No owner."));
      return null;
    }
    return found;
  }

  if (owned.length === 0) {
    p.log.warn("No bots with an owner are configured. Set an owner in openclaw.json first.");
    p.outro(color.dim("Nothing to act on."));
    return null;
  }
  const options = owned.map((a) => ({
    label: `@${a.mentionNames[0] ?? a.accountId}`,
    value: a,
  }));
  return promptSelect<ExistingAccount>({
    message: "Which bot?",
    options,
  });
}

const EVERYONE = "__everyone__";

async function fetchVisibleGroups(serverUrl: string, auth: RCLoginResult): Promise<RocketChatGroup[]> {
  const [privateGroups, channels] = await Promise.all([
    listGroups(serverUrl, auth).catch(() => []),
    listPublicChannels(serverUrl, auth).catch(() => []),
  ]);
  const seen = new Map<string, RocketChatGroup>();
  for (const group of [...privateGroups, ...channels]) {
    if (!seen.has(group._id)) seen.set(group._id, group);
  }
  return [...seen.values()];
}

async function resolveOwnerAuth(account: ExistingAccount): Promise<RCLoginResult | null> {
  const owner = readOwner(account.accountId);
  if (!owner) {
    p.log.error(
      `@${account.mentionNames[0] ?? account.accountId} has no owner yet. Set the owner in openclaw.json first.`,
    );
    p.outro(color.red("No owner."));
    return null;
  }

  const cached = await loadOwnerCredentials(owner);
  if (cached && cached.serverUrl === account.serverUrl) {
    const self = await getSelfInfo(account.serverUrl, { userId: cached.userId, authToken: cached.authToken });
    if (self && self.username.trim().replace(/^@+/, "").toLowerCase() === owner.toLowerCase()) {
      return { userId: cached.userId, authToken: cached.authToken };
    }
  }

  const password = await promptPassword({
    message: `Owner password for @${owner} (required to modify this bot's access)`,
    validate: (value) => (value ? undefined : "Password is required"),
  });

  try {
    const auth = await withSpinner(`Verifying @${owner}`, () => loginAs(account.serverUrl, owner, password));
    await saveOwnerCredentials({
      serverUrl: account.serverUrl,
      username: owner,
      userId: auth.userId,
      authToken: auth.authToken,
    });
    p.log.success(`Verified as owner @${owner}`);
    return auth;
  } catch (e: unknown) {
    p.log.error(`Owner verification failed: ${e instanceof Error ? e.message : String(e)}`);
    p.outro(color.red("Verification failed."));
    return null;
  }
}

async function verifyOwner(account: ExistingAccount): Promise<boolean> {
  return (await resolveOwnerAuth(account)) !== null;
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

async function runLend(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Lend Bot`);

  const account = await pickBotAccount(botArg);
  if (!account) {
    p.outro(color.dim("Cancelled."));
    return;
  }
  const mention = account.mentionNames[0] ?? account.accountId;

  const ownerAuth = await resolveOwnerAuth(account);
  if (!ownerAuth) return;

  const groups = await fetchVisibleGroups(account.serverUrl, ownerAuth);
  if (groups.length === 0) {
    p.log.warn("No groups or channels are visible to the bot owner.");
    p.outro(color.dim("Nothing to lend into."));
    return;
  }

  const group = await promptAutocomplete<RocketChatGroup>({
    message: `Which group should @${mention} be used in?`,
    options: groups.map((g) => ({
      value: g,
      label: `#${g.name}`,
      hint: g.isPrivate ? "private" : "channel",
    })),
    placeholder: "Type to search…",
    maxItems: 10,
  });

  const members = await listGroupMembers(account.serverUrl, ownerAuth, group._id);
  if (members.length === 0) {
    p.log.warn(`No members are visible to the owner in #${group.name}.`);
    p.outro(color.dim("Nothing to grant."));
    return;
  }

  const picked = await promptAutocompleteMultiselect<string>({
    message: `Who in #${group.name} should use @${mention}?`,
    options: [
      { value: EVERYONE, label: `Everyone in #${group.name}` },
      ...members.map((m) => ({
        value: m.username,
        label: `@${m.username}`,
        hint: m.name ?? "",
      })),
    ],
    placeholder: "Type to search…",
    maxItems: 10,
    required: true,
  });

  const usernames = picked.includes(EVERYONE) ? members.map((m) => m.username) : picked;

  const confirm = await promptConfirm({
    message: `Lend @${mention} to ${usernames.map((u) => `@${u}`).join(", ")} inside #${group.name}?`,
    initialValue: true,
  });
  if (!confirm) {
    p.outro(color.dim("Cancelled."));
    return;
  }

  const store = new AccessStore();
  let added = 0;
  const grantedBy = readOwner(account.accountId);
  for (const username of usernames) {
    const grantParams = {
      accountId: account.accountId,
      roomId: group._id,
      roomName: group.name,
      username,
      ...(grantedBy ? { grantedBy } : {}),
    };
    if (store.addGrant(grantParams)) {
      added++;
    }
  }
  store.close();

  p.log.success(`Lent @${mention} to ${added} ${added === 1 ? "member" : "members"} in #${group.name}`);
  p.log.step(color.dim("Applied live — no restart needed."));
  p.outro(color.green("Done"));
}

async function runRevoke(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Revoke Access`);

  const account = await pickBotAccount(botArg);
  if (!account) {
    p.outro(color.dim("Cancelled."));
    return;
  }
  if (!(await verifyOwner(account))) return;

  const store = new AccessStore();
  const grants = store.loadGrants(account.accountId);
  if (grants.length === 0) {
    store.close();
    p.log.warn(`@${account.mentionNames[0] ?? account.accountId} has no granted access.`);
    p.outro(color.dim("Nothing to revoke."));
    return;
  }

  const picked = await promptAutocompleteMultiselect<string>({
    message: "Which grants to revoke?",
    options: grants.map((grant) => ({
      value: `${grant.roomId}::${grant.username}`,
      label: `@${grant.username}`,
      hint: grant.roomId === "*" ? "everywhere" : `#${grant.roomName ?? grant.roomId}`,
    })),
    placeholder: "Type to search…",
    maxItems: 10,
    required: true,
  });

  const pickedSet = new Set(picked);
  let revoked = 0;
  for (const grant of grants) {
    if (!pickedSet.has(`${grant.roomId}::${grant.username}`)) continue;
    const revokedBy = readOwner(account.accountId);
    const removeParams = {
      accountId: account.accountId,
      roomId: grant.roomId,
      username: grant.username,
      ...(revokedBy ? { revokedBy } : {}),
    };
    if (store.removeGrant(removeParams)) {
      revoked++;
    }
  }
  store.close();

  p.log.success(`Revoked ${revoked} ${revoked === 1 ? "grant" : "grants"}`);
  p.log.step(color.dim("Applied live — no restart needed."));
  p.outro(color.green("Done"));
}

async function runAccess(botArg?: string): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Bot Access`);

  const account = await pickBotAccount(botArg);
  if (!account) {
    p.outro(color.dim("Cancelled."));
    return;
  }
  const mention = account.mentionNames[0] ?? account.accountId;
  const owner = readOwner(account.accountId);

  const store = new AccessStore();
  const grants = store.loadGrants(account.accountId);
  const audit = store.listAudit(account.accountId, 10);
  store.close();

  p.log.step(`Access for @${mention}:`);
  p.log.info(`owner — ${owner ? `@${owner}` : color.dim("(unset)")}`);
  if (grants.length === 0) {
    p.log.info(color.dim("No grants. Only the owner can use the bot."));
  } else {
    for (const grant of grants) {
      const where = grant.roomId === "*" ? "everywhere" : `#${grant.roomName ?? grant.roomId}`;
      p.log.info(`- @${grant.username} — ${where}`);
    }
  }

  if (audit.length > 0) {
    p.log.step(color.dim("Recent activity:"));
    for (const entry of audit) {
      const where = entry.roomId === "*" ? "everywhere" : entry.roomId ? `#${entry.roomId}` : "-";
      p.log.info(color.dim(`${new Date(entry.at).toLocaleString()} ${entry.action} @${entry.username ?? ""} ${where}`));
    }
  }

  p.log.step(color.dim("Lend with `npm run lend`, revoke with `npm run revoke`."));
  p.outro(color.green("Done"));
}
