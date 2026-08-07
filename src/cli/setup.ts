import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { loginAs, createBotUser, getUserByUsername, createDirectMessage, sendMessage, verifyAdmin, checkServerHealth, listGroups, inviteToGroup, getGroupByName, type RocketChatGroup } from "./admin-api.js";
import { updateConfig, readAccount } from "./config-updater.js";
import { saveAdmin, loadAdmin, saveBotCredentials, loadBotCredentials } from "./credentials.js";
import {
  color,
  normalizeRocketChatUrl,
  printNextSteps,
  printSummary,
  promptConfirm,
  promptPassword,
  promptSelect,
  promptText,
  prompts as p,
  showServerStatus,
  withSpinner,
} from "./ui.js";
import type { RCLoginResult } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");
const ACCOUNT_ID = "main";
const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");

/** Attempt a bot login; return auth on success, or null if unauthorized. */
async function tryBotLogin(rcUrl: string, username: string, password: string): Promise<RCLoginResult | null> {
  try {
    return await loginAs(rcUrl, username, password);
  } catch {
    return null;
  }
}

/** Prompt for a Rocket.Chat URL, show its health, and require it to be reachable. */
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
    p.outro(color.dim("Setup aborted."));
    process.exit(1);
  }
  return url;
}

async function resolveAdminAuth(rcUrl: string, forceFresh = false): Promise<RCLoginResult> {
  const savedAdmin = await loadAdmin(rcUrl);

  if (savedAdmin && !forceFresh) {
    const reuse = await promptConfirm({
      message: `Reuse saved admin credentials for ${color.cyan(rcUrl)}?`,
      initialValue: true,
    });
    if (reuse) {
      return { userId: savedAdmin.userId, authToken: savedAdmin.authToken };
    }
  }

  const adminUser = await promptText({
    message: "Admin username",
    validate: (value) => ((value ?? "").trim() ? undefined : "Username is required"),
  });

  const adminPass = await promptPassword({
    message: "Admin password",
    validate: (value) => (value ? undefined : "Password is required"),
  });

  return withSpinner("Logging in as admin", async () => {
    try {
      const adminAuth = await loginAs(rcUrl, adminUser, adminPass);
      const verdict = await verifyAdmin(rcUrl, adminAuth);
      if (!verdict.ok) {
        if (verdict.reason === "not-admin") {
          p.log.error(`"${adminUser}" is not an admin (missing 'admin' role). Bot creation requires an admin account.`);
        } else if (verdict.reason === "unauthorized") {
          p.log.error("Admin login expired or invalid. Please log in again.");
        } else {
          p.log.error("Could not verify admin status — Rocket.Chat server unreachable.");
        }
        process.exit(1);
      }
      await saveAdmin({ serverUrl: rcUrl, userId: adminAuth.userId, authToken: adminAuth.authToken });
      p.log.success(`Logged in as ${color.cyan(adminUser)}`);
      return adminAuth;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      p.log.error(`Login failed: ${message}`);
      process.exit(1);
    }
  });
}

async function promptBotPassword(botUsername: string): Promise<string> {
  const savedBot = await loadBotCredentials(botUsername);
  if (savedBot?.password) {
    p.log.info(`Reusing saved password for ${color.cyan(`@${botUsername}`)}`);
    return savedBot.password;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const botPassword = await promptPassword({
      message: attempt === 0 ? "Bot password" : "Bot password (min 6 characters)",
      validate: (value) => {
        if (!value) return "Password is required";
        if (value.length < 6) return "Password must be at least 6 characters";
        return undefined;
      },
    });
    return botPassword;
  }

  throw new Error("Valid bot password required");
}

export async function runSetup(): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Rocket.Chat Setup`);

  const existing = readAccount(ACCOUNT_ID);
  let rcUrl: string;
  let adminAuth: RCLoginResult | null = null;

  if (existing) {
    p.log.warn("Existing Rocket.Chat configuration found");
    printSummary([
      { label: "Config", value: OC_CONFIG_PATH },
      { label: "Server", value: existing.serverUrl },
      { label: "Bot", value: `@${existing.mentionNames[0] ?? existing.auth.userId}` },
    ]);

    await showServerStatus(existing.serverUrl, () => checkServerHealth(existing.serverUrl));
    if (!(await checkServerHealth(existing.serverUrl))) {
      const recovery = await promptSelect<string>({
        message: "Saved server is unreachable. What would you like to do?",
        options: [
          { value: "newurl", label: "Enter a different Rocket.Chat URL" },
          { value: "cancel", label: "Cancel — exit setup" },
        ],
      });
      if (recovery === "cancel") {
        p.outro(color.dim("Setup aborted."));
        return;
      }
      rcUrl = await promptServerUrl("https://chat.example.com");
      adminAuth = await resolveAdminAuth(rcUrl, true);
    } else {
      const action = await promptSelect<string>({
        message: "What would you like to do?",
        options: [
          { value: "reuse", label: "Keep saved admin and continue to bot setup" },
          { value: "relogin", label: "Log in as a different admin" },
          { value: "cancel", label: "Cancel — make no changes" },
        ],
      });

      if (action === "cancel") {
        p.outro(color.dim("No changes made."));
        return;
      }

      rcUrl = existing.serverUrl;

      if (action === "reuse") {
        const cachedAdmin = await loadAdmin(rcUrl);
        const verdict = cachedAdmin ? await verifyAdmin(rcUrl, cachedAdmin) : null;
        if (verdict?.ok) {
          adminAuth = cachedAdmin;
        } else {
          if (verdict && verdict.reason === "not-admin") {
            p.log.warn("Saved admin is missing the 'admin' role — please log in as a real admin.");
          }
          adminAuth = await resolveAdminAuth(rcUrl, true);
        }
        // Fall through to bot setup below.
      } else {
        adminAuth = await resolveAdminAuth(rcUrl, true);
      }
    }
  } else {
    p.log.step("Rocket.Chat connection");
    rcUrl = await promptServerUrl("http://localhost:3000");
    adminAuth = await resolveAdminAuth(rcUrl);
  }

  await showServerStatus(rcUrl, () => checkServerHealth(rcUrl));

  p.log.step("Bot account");

  const defaultBot = existing?.mentionNames[0] ?? "rocketbot";
  const botUsername = await promptText({
    message: "Bot Rocket.Chat username",
    placeholder: "rocketbot",
    defaultValue: defaultBot,
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) return "Username is required";
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return "Use letters, numbers, dots, dashes, or underscores";
      return undefined;
    },
  });

  if (!adminAuth) {
    p.log.info("Admin login required to create or look up the bot on Rocket.Chat.");
    adminAuth = await resolveAdminAuth(rcUrl);
  }

  const existingUser = await withSpinner(`Checking @${botUsername} on Rocket.Chat`, () =>
    getUserByUsername(rcUrl, adminAuth!, botUsername),
  );

  let botUser: { _id: string; username: string };
  let botAuth: RCLoginResult | null = null;

  if (existingUser) {
    // Bot already exists — ask for its existing password and verify it.
    p.log.success(`Bot ${color.cyan(`@${botUsername}`)} already exists — verifying its credentials`);
    botUser = existingUser;

    const savedBot = await loadBotCredentials(botUsername);
    let botPassword = savedBot?.password;

    if (botPassword) {
      p.log.info(`Trying saved password for ${color.cyan(`@${botUsername}`)}`);
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
        p.log.error("Too many failed attempts. Re-run setup and enter the correct bot password.");
        process.exit(1);
      }
    }

    await saveBotCredentials(botUsername, { userId: botAuth.userId, password: botPassword! });
    p.log.success(`Verified bot ${color.cyan(`@${botUsername}`)}`);
  } else {
    // New bot — collect details and create it.
    const botName = await promptText({
      message: "Bot display name",
      defaultValue: botUsername,
    });

    const botEmail = await promptText({
      message: "Bot email",
      defaultValue: `${botUsername.toLowerCase()}@openclaw.local`,
      validate: (value) => ((value ?? "").includes("@") ? undefined : "Enter a valid email"),
    });

    const botPassword = await promptBotPassword(botUsername);

    botUser = await withSpinner(`Creating bot ${color.cyan(`@${botUsername}`)}`, async () => {
      try {
        return await createBotUser(rcUrl, adminAuth!, {
          username: botUsername,
          name: botName,
          password: botPassword,
          email: botEmail,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        p.log.error(`Failed to create bot: ${message}`);
        process.exit(1);
      }
    });
    p.log.success(`Created bot ${color.cyan(`@${botUser.username}`)} ${color.dim(`(${botUser._id})`)}`);

    botAuth = await withSpinner("Obtaining bot auth token", async () => {
      try {
        const auth = await loginAs(rcUrl, botUsername, botPassword);
        await saveBotCredentials(botUsername, { userId: auth.userId, password: botPassword });
        return auth;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        p.log.error(`Bot login failed: ${message}`);
        process.exit(1);
      }
    });
  }

  if (!botAuth) {
    p.log.error("Bot authentication was not resolved. Please re-run setup.");
    process.exit(1);
  }

  p.log.step("Welcome message");

  try {
    await withSpinner("Sending welcome DM", async () => {
      const dmRoomId = await createDirectMessage(rcUrl, adminAuth!, botUsername);
      await sendMessage(
        rcUrl,
        botAuth,
        dmRoomId,
        "OpenClaw is connected! Restart OpenClaw (openclaw restart) then send me a message to start chatting.",
      );
    });
    p.log.success(`Welcome message sent to ${color.cyan(`@${botUsername}`)}`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    p.log.warn(`Welcome message skipped: ${message}`);
  }

  p.log.step("Save configuration");

  try {
    await withSpinner("Updating openclaw.json", async () => {
      updateConfig({
        pluginPath: PLUGIN_PATH,
        pluginId: "rocketchat",
        accountId: ACCOUNT_ID,
        serverUrl: rcUrl,
        transport: { mode: "websocket" },
        mentionNames: [botUsername],
        auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
        replaceConnection: !existing || existing.serverUrl !== rcUrl,
      });
    });
    p.log.success(`Updated ${color.cyan(OC_CONFIG_PATH)}`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    p.log.warn(`Skipped openclaw.json update: ${message}`);
  }

  printSummary([
    { label: "Server", value: rcUrl },
    { label: "Bot", value: `@${botUsername} ${color.dim(`(${botUser._id})`)}` },
    { label: "Config", value: OC_CONFIG_PATH },
    { label: "Transport", value: "websocket" },
  ]);

  const makePrimary = await promptConfirm({
    message: `Make @${botUsername} your primary chat bot?`,
    initialValue: true,
  });

  if (makePrimary) {
    try {
      await withSpinner("Setting as primary bot", async () => {
        updateConfig({
          pluginPath: PLUGIN_PATH,
          pluginId: "rocketchat",
          accountId: ACCOUNT_ID,
          serverUrl: rcUrl,
          transport: { mode: "websocket" },
          mentionNames: [botUsername],
          auth: { mode: "token", userId: botAuth!.userId, accessToken: botAuth!.authToken },
          replaceConnection: true,
        });
      });
      p.log.success(`@${botUsername} is now the primary bot`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      p.log.warn(`Could not set primary bot: ${message}`);
    }
  }

  const addToGroup = await promptConfirm({
    message: `Add @${botUsername} to a Rocket.Chat group/channel?`,
    initialValue: false,
  });

  if (addToGroup && adminAuth) {
    try {
      const groups = await withSpinner("Loading groups", () => listGroups(rcUrl, adminAuth!));
      if (groups.length === 0) {
        p.log.info("No groups found. You can add the bot later with `openclaw rocketchat add-group`.");
      } else {
        const selectOptions = [
          ...groups.map((g: RocketChatGroup) => ({
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
          group = await getGroupByName(rcUrl, adminAuth!, typedName.trim());
          if (!group) {
            p.log.warn(`Group "${typedName}" not found on Rocket.Chat.`);
          }
        } else {
          group = groups.find((g) => g._id === choice) ?? null;
        }

        if (group) {
          await withSpinner("Inviting bot", () => inviteToGroup(rcUrl, adminAuth!, group!._id, botUsername));
          p.log.success(`Added @${botUsername} to #${group.name}`);
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      p.log.warn(`Could not add bot to group: ${message}`);
    }
  }

  printNextSteps([
    `Restart OpenClaw: ${color.cyan("openclaw restart")}`,
    `Message ${color.cyan(`@${botUsername}`)} in Rocket.Chat`,
  ]);

  p.outro(color.green("Setup complete"));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runSetup().catch((e: unknown) => {
    p.log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
