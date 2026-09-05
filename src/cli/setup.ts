import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import {
  checkServerHealth,
  createDirectMessage,
  getUserInfo,
  getGroupByName,
  inviteToGroup,
  sendMessage,
} from "./admin-api.js";
import {
  addBinding,
  ensureAgentForBot,
  isAgentBound,
  readAllAccounts,
  updateConfig,
  type ExistingAccount,
} from "./config-updater.js";
import { loadAdmin } from "./credentials.js";
import { resolveAdminAuth } from "./auth.js";
import { resolveBotAuth } from "./bot.js";
import {
  color,
  normalizeRocketChatUrl,
  printNextSteps,
  printSummary,
  promptConfirm,
  promptSelect,
  promptText,
  prompts as p,
  showServerStatus,
  withSpinner,
} from "./ui.js";
import type { RCLoginResult } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");
const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");
const DOC_LINK = "https://github.com/RocketChat/Openclaw/blob/main/docs/SETUP.md#remove-a-bot";

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

  const online = await showServerStatus(url, () => checkServerHealth(url));
  if (!online) {
    p.log.error("Rocket.Chat server is unreachable. Check the URL and try again.");
    p.outro(color.dim("Setup aborted."));
    process.exit(1);
  }
  return url;
}

async function promptAddToGroup(
  rcUrl: string,
  adminAuth: RCLoginResult,
  botUsername: string,
): Promise<void> {
  p.log.step("Add to group");
  while (true) {
    const typedName = await promptText({
      message: `Which group should @${botUsername} join? (leave empty to skip)`,
      validate: () => undefined,
    });
    const trimmed = (typedName ?? "").trim();
    if (!trimmed) {
      p.log.info("Skipped group invite.");
      return;
    }

    const group = await getGroupByName(rcUrl, adminAuth, trimmed);
    if (!group) {
      p.log.warn(`Group "${trimmed}" not found. Try again or leave empty to skip.`);
      continue;
    }

    const confirm = await promptConfirm({
      message: `Add @${botUsername} to #${group.name}?`,
      initialValue: true,
    });
    if (!confirm) return;

    try {
      await withSpinner("Inviting bot", () =>
        inviteToGroup(rcUrl, adminAuth, group._id, botUsername, group.isPrivate ?? false),
      );
      p.log.success(`Added @${botUsername} to #${group.name}`);
    } catch (e: unknown) {
      p.log.warn(`Could not add bot to group: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
}

async function printLoggedInAccounts(): Promise<void> {
  const admin = await loadAdmin();
  if (!admin) return;

  let adminUser = admin.userId;
  try {
    const info = await getUserInfo(admin.serverUrl, admin, { userId: admin.userId });
    if (info?.username) adminUser = info.username;
  } catch {
    // fall back to the saved user id if the server is unreachable
  }

  p.note(
    [`  ${color.dim("admin")} @${adminUser}`, `  ${color.dim("server")} ${admin.serverUrl}`].join(
      "\n",
    ),
    "Currently logged in",
  );
}

export async function runSetup(): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Rocket.Chat Setup`);

  const allAccounts = readAllAccounts();

  const serversMap = new Map<string, typeof allAccounts>();
  for (const a of allAccounts) {
    const list = serversMap.get(a.serverUrl) ?? [];
    list.push(a);
    serversMap.set(a.serverUrl, list);
  }
  const uniqueServers = [...serversMap.entries()].map(([url, accs]) => ({ url, accounts: accs }));

  const hasExisting = uniqueServers.length > 0;
  if (hasExisting) {
    await printLoggedInAccounts();
  }

  let action: string;
  if (hasExisting) {
    action = await promptSelect<string>({
      message: "What would you like to do?",
      options: [
        { value: "create", label: "Create new bot" },
        { value: "relogin", label: "Login as different admin" },
        { value: "delete", label: "Delete account data" },
        { value: "cancel", label: "Exit" },
      ],
    });
  } else {
    action = "create";
  }

  if (action === "cancel") {
    p.outro(color.dim("Setup aborted."));
    return;
  }
  if (action === "delete") {
    p.note(`To delete account data, visit:\n${color.cyan(DOC_LINK)}`, "Delete account data");
    p.outro(color.dim("Setup aborted."));
    return;
  }

  let rcUrl: string;
  let serverAccounts: typeof allAccounts | null = null;

  if (action === "create" || action === "relogin") {
    if (uniqueServers.length > 1) {
      const serverOptions = uniqueServers.map((s, i) => ({
        value: String(i),
        label: `${i + 1}. ${s.url} (${s.accounts.length} bot${s.accounts.length === 1 ? "" : "s"})`,
      }));
      serverOptions.push({
        value: "new",
        label: `${uniqueServers.length + 1}. New server`,
      });
      const choice = await promptSelect<string>({
        message: "Which server?",
        options: serverOptions,
      });
      if (choice === "new") {
        rcUrl = await promptServerUrl("http://localhost:3000");
      } else {
        const selected = uniqueServers[Number(choice)]!;
        rcUrl = selected.url;
        serverAccounts = selected.accounts;
      }
    } else if (uniqueServers.length === 1) {
      rcUrl = uniqueServers[0]!.url;
      serverAccounts = uniqueServers[0]!.accounts;
    } else {
      rcUrl = await promptServerUrl("http://localhost:3000");
    }
  } else {
    rcUrl = await promptServerUrl("http://localhost:3000");
  }

  let adminAuth: RCLoginResult | null = null;

  if (serverAccounts) {
    const online = await showServerStatus(rcUrl, () => checkServerHealth(rcUrl));

    if (!online) {
      const recovery = await promptSelect<string>({
        message: "Saved server is unreachable. What would you like to do?",
        options: [
          { value: "newurl", label: "Enter a different Rocket.Chat URL" },
          { value: "cancel", label: "Exit" },
        ],
      });
      if (recovery === "cancel") {
        p.outro(color.dim("Setup aborted."));
        return;
      }
      rcUrl = await promptServerUrl("https://chat.example.com");
      adminAuth = await resolveAdminAuth(rcUrl, true);
    } else if (action === "relogin") {
      adminAuth = await resolveAdminAuth(rcUrl, true);
    } else {
      adminAuth = await resolveAdminAuth(rcUrl);
    }
  }

  if (!adminAuth) {
    adminAuth = await resolveAdminAuth(rcUrl);
    if (!adminAuth) {
      p.log.error("Admin authentication failed. Setup aborted.");
      return;
    }
  }

  p.log.step("Bot account");
  const botUsername = await promptText({
    message: "Bot Rocket.Chat username",
    placeholder: "rocketbot",
    defaultValue: serverAccounts?.[0]?.mentionNames[0] ?? "rocketbot",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) return "Username is required";
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed))
        return "Use letters, numbers, dots, dashes, or underscores";
      return undefined;
    },
  });

  const botAuth = await resolveBotAuth(rcUrl, adminAuth, botUsername);
  if (!botAuth) {
    p.log.error("Bot authentication failed. Setup aborted.");
    return;
  }

  const accountId = botUsername;
  const dedicatedId = `rc-${accountId}`;
  const mainAlreadyBound = isAgentBound("main");

  const agentChoices: Array<{ value: string; label: string; hint?: string }> = [];
  if (!mainAlreadyBound) {
    agentChoices.push({
      value: "main",
      label: "main (shared default agent)",
      hint: "Recommended for the first bot",
    });
  }
  agentChoices.push({
    value: dedicatedId,
    label: `${dedicatedId} (dedicated agent, auto-created)`,
    hint: mainAlreadyBound ? "Recommended isolates memory" : "Isolates memory per bot",
  });

  let chosenAgent: string;
  if (agentChoices.length === 1) {
    chosenAgent = agentChoices[0]!.value;
  } else {
    chosenAgent =
      (await promptSelect({
        message: `Which agent should @${accountId} use?`,
        options: agentChoices,
        initialValue: "main",
      })) ?? dedicatedId;
  }

  const agentResult =
    chosenAgent === "main"
      ? { agentId: "main", created: false, fallback: false }
      : ensureAgentForBot(accountId);

  try {
    await withSpinner("Sending welcome DM", async () => {
      const dmRoomId = await createDirectMessage(rcUrl, adminAuth, botUsername);
      await sendMessage(
        rcUrl,
        botAuth,
        dmRoomId,
        `Hi! I'm @${botUsername}, your new Rocket.Chat bot connected to OpenClaw (agent \`${agentResult.agentId}\`). ` +
          `Once you see status online, confirm with \`!status\` or \`!help\` to know more.`,
      );
    });
    p.log.success(`Welcome message sent to ${color.cyan(`@${botUsername}`)}`);
  } catch (e: unknown) {
    p.log.warn(`Welcome message skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  let ownerUsername: string | undefined;
  try {
    ownerUsername = (await getUserInfo(rcUrl, adminAuth, { userId: adminAuth.userId }))?.username;
  } catch {
    // owner can be set later in openclaw.json
  }

  try {
    await withSpinner("Updating openclaw.json", async () => {
      updateConfig({
        pluginPath: PLUGIN_PATH,
        pluginId: "rocketchat",
        accountId,
        serverUrl: rcUrl,
        transport: { mode: "websocket" },
        mentionNames: [botUsername],
        auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
        replaceConnection: !serverAccounts || !serverAccounts.some((a) => a.serverUrl === rcUrl),
        ...(ownerUsername ? { owner: ownerUsername } : {}),
      });
    });
    p.log.success(`Updated ${color.cyan(OC_CONFIG_PATH)}`);
  } catch (e: unknown) {
    p.log.warn(`Config update skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (agentResult.fallback) {
    p.log.warn(
      `Could not auto-create dedicated agent 'rc-${accountId}'. Bound to 'main' ` +
        `memory is isolated per-bot via session keys, but shares the main agent workspace.`,
    );
  } else if (agentResult.created) {
    p.log.success(
      `agent ${agentResult.agentId} (auto-created dedicated agent '${agentResult.agentId}')`,
    );
  } else {
    p.log.success(`agent ${agentResult.agentId}`);
  }
  try {
    addBinding({ channel: "rocketchat", accountId, agentId: agentResult.agentId });
    p.log.success(`Bound @${botUsername} to agent '${agentResult.agentId}'`);
  } catch (e: unknown) {
    p.log.warn(`Could not create binding: ${e instanceof Error ? e.message : String(e)}`);
  }

  const addToGroup = await promptConfirm({
    message: `Add @${botUsername} to a Rocket.Chat group/channel?`,
    initialValue: false,
  });
  if (addToGroup) {
    await promptAddToGroup(rcUrl, adminAuth, botUsername);
  }

  printSummary([
    { label: "Server", value: rcUrl },
    { label: "Bot", value: `@${botUsername}` },
    { label: "Config", value: OC_CONFIG_PATH },
    { label: "Transport", value: "websocket" },
  ]);
  printNextSteps([
    `Message ${color.cyan(`@${botUsername}`)} in Rocket.Chat OpenClaw reloads the config automatically, so the bot comes online on its own`,
  ]);

  p.outro(color.green("Setup complete"));
}
