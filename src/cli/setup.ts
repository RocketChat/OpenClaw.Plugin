import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import {
  loginAs,
  TwoFactorRequiredError,
  createBotUser,
  getUserInfo,
  createDirectMessage,
  sendMessage,
  verifyAdmin,
  checkServerHealth,
  inviteToGroup,
  getGroupByName,
} from "./admin-api.js";
import { updateConfig, readAccount, readAgentsList, addBinding, ensureAgentForBot, isAgentBound } from "./config-updater.js";
import { saveAdmin, loadAdmin, saveBotCredentials, loadBotCredentials } from "./credentials.js";
import {
  color,
  isLocalRocketChatUrl,
  normalizeRocketChatUrl,
  printNextSteps,
  printSummary,
  promptConfirm,
  promptPassword,
  promptSelect,
  promptText,
  promptTwoFactorCode,
  prompts as p,
  showServerStatus,
  withSpinner,
} from "./ui.js";
import type { RCLoginResult } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");
let ACCOUNT_ID = "main";
const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");

async function tryBotLogin(
  rcUrl: string,
  username: string,
  password: string,
): Promise<RCLoginResult | null> {
  return loginForServer(rcUrl, username, password, username);
}

async function loginForServer(
  rcUrl: string,
  user: string,
  password: string,
  label: string,
): Promise<RCLoginResult | null> {
  if (isLocalRocketChatUrl(rcUrl)) {
    try {
      return await loginAs(rcUrl, user, password);
    } catch (e: unknown) {
      p.log.error(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  return loginWithTwoFactor(rcUrl, user, password, label);
}

/** Log in, prompting for a 2FA code when the server requires it. */
async function loginWithTwoFactor(
  rcUrl: string,
  user: string,
  password: string,
  label: string,
): Promise<RCLoginResult | null> {
  let lastChallengeTransaction: string | undefined;

  const attemptLogin = (code?: string) =>
    loginAs(rcUrl, user, password, {
      ...(code !== undefined ? { code } : {}),
      ...(lastChallengeTransaction ? { transactionId: lastChallengeTransaction } : {}),
    });

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await attemptLogin();
    } catch (e: unknown) {
      if (e instanceof TwoFactorRequiredError) {
        const method = e.challenge.methods[0] ?? "totp";
        lastChallengeTransaction = e.challenge.transactionId || lastChallengeTransaction;
        if (method === "email") {
          p.log.info(
            `A verification code should have been emailed to ${color.cyan(label)}. If you don't receive it, the account may not have email 2FA enabled — leave empty to abort.`,
          );
        }
        const code = await promptTwoFactorCode({
          message: `Two-factor code for ${label}`,
          method,
          allowEmpty: method === "email",
        });
        if (!code) {
          p.log.error("No code entered. Aborting two-factor login.");
          return null;
        }
        try {
          return await attemptLogin(code);
        } catch (inner: unknown) {
          if (inner instanceof TwoFactorRequiredError) {
            const retryMethod = inner.challenge.methods[0] ?? "totp";
            const hint =
              retryMethod === "email"
                ? "Invalid or expired email code. Check your inbox and try again (leave empty to abort)."
                : "Invalid or expired two-factor code. Please try again.";
            p.log.error(hint);
            lastChallengeTransaction = inner.challenge.transactionId || lastChallengeTransaction;
            continue;
          }
          p.log.error(`Login failed: ${inner instanceof Error ? inner.message : String(inner)}`);
          return null;
        }
      }

      const message = e instanceof Error ? e.message : String(e);
      p.log.error(`Login failed: ${message}`);
      return null;
    }
  }

  p.log.error("Too many two-factor attempts. Re-run setup to try again.");
  return null;
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
    p.outro(color.dim("Setup aborted."));
    process.exit(1);
  }
  return url;
}

export async function resolveAdminAuth(
  rcUrl: string,
  forceFresh = false,
): Promise<RCLoginResult | null> {
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
      const adminAuth = await loginForServer(rcUrl, adminUser, adminPass, adminUser);
      if (!adminAuth) return null;
      const verdict = await verifyAdmin(rcUrl, adminAuth);
      if (!verdict.ok) {
        if (verdict.reason === "not-admin") {
          p.log.error(
            `"${adminUser}" is not an admin (missing 'admin' role). Bot creation requires an admin account.`,
          );
        } else if (verdict.reason === "unauthorized") {
          p.log.error("Admin login expired or invalid. Please log in again.");
        } else {
          p.log.error("Could not verify admin status — Rocket.Chat server unreachable.");
        }
        return null;
      }
      await saveAdmin({
        serverUrl: rcUrl,
        userId: adminAuth.userId,
        authToken: adminAuth.authToken,
      });
      p.log.success(`Logged in as ${color.cyan(adminUser)}`);
      return adminAuth;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      p.log.error(`Login failed: ${message}`);
      return null;
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
    if (botPassword.length >= 6) return botPassword;
    p.log.error("Password must be at least 6 characters.");
  }

  throw new Error("Valid bot password required");
}

export async function runSetup(): Promise<void> {
  p.intro(`${color.bgCyan(color.black(" OpenClaw "))} ${color.dim("×")} Rocket.Chat Setup`);

  const existing = readAccount(ACCOUNT_ID);

  let rcUrl = existing ? existing.serverUrl : await promptServerUrl("http://localhost:3000");
  let adminAuth: RCLoginResult | null = existing ? await loadAdmin(rcUrl) : null;

  if (existing) {
    printSummary([
      { label: "Config", value: OC_CONFIG_PATH },
      { label: "Server", value: existing.serverUrl },
      { label: "Bot", value: `@${existing.mentionNames[0] ?? existing.auth.userId}` },
    ]);

    const online = await checkServerHealth(rcUrl);
    await showServerStatus(rcUrl, async () => online);

    if (!online) {
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
      adminAuth = null;
    } else {
      const action = await promptSelect<string>({
        message: "Existing configuration found. What would you like to do?",
        options: [
          { value: "continue", label: "Continue with existing data" },
          { value: "relogin", label: "Log out and sign in as a different admin" },
          { value: "cancel", label: "Cancel — exit setup" },
        ],
      });

      if (action === "cancel") {
        p.outro(color.dim("Setup aborted."));
        return;
      }
      if (action === "relogin") {
        adminAuth = null;
      }
    }
  }

  if (!adminAuth) {
    adminAuth = await resolveAdminAuth(rcUrl);
    if (!adminAuth) {
      p.log.error("Admin authentication failed. Setup aborted.");
      return;
    }
  }

  await showServerStatus(rcUrl, () => checkServerHealth(rcUrl));

  p.log.step("Bot account");
  const botUsername = await promptText({
    message: "Bot Rocket.Chat username",
    placeholder: "rocketbot",
    defaultValue: existing?.mentionNames[0] ?? "rocketbot",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) return "Username is required";
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed))
        return "Use letters, numbers, dots, dashes, or underscores";
      return undefined;
    },
  });
  ACCOUNT_ID = botUsername;

  const botAuth = await resolveBotAuth(rcUrl, adminAuth, botUsername);
  if (!botAuth) {
    p.log.error("Bot authentication failed. Setup aborted.");
    return;
  }

  const dedicatedId = `rc-${ACCOUNT_ID}`;
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
    hint: mainAlreadyBound ? "Recommended — isolates memory" : "Isolates memory per bot",
  });

  let chosenAgent: string;
  if (agentChoices.length === 1) {
    chosenAgent = agentChoices[0]!.value;
  } else {
    chosenAgent =
      (await promptSelect({
        message: `Which agent should @${ACCOUNT_ID} use?`,
        options: agentChoices,
        initialValue: "main",
      })) ?? dedicatedId;
  }

  const agentResult =
    chosenAgent === "main"
      ? { agentId: "main", created: false, fallback: false }
      : ensureAgentForBot(ACCOUNT_ID);

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
        accountId: ACCOUNT_ID,
        serverUrl: rcUrl,
        transport: { mode: "websocket" },
        mentionNames: [botUsername],
        auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
        replaceConnection: !existing || existing.serverUrl !== rcUrl,
        ...(ownerUsername ? { owner: ownerUsername } : {}),
      });
    });
    p.log.success(`Updated ${color.cyan(OC_CONFIG_PATH)}`);
  } catch (e: unknown) {
    p.log.warn(`Config update skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (agentResult.fallback) {
    p.log.warn(
      `Could not auto-create dedicated agent 'rc-${ACCOUNT_ID}'. Bound to 'main' — ` +
        `memory is isolated per-bot via session keys, but shares the main agent workspace.`,
    );
  } else if (agentResult.created) {
    p.log.success(`agent — ${agentResult.agentId} (auto-created dedicated agent '${agentResult.agentId}')`);
  } else {
    p.log.success(`agent — ${agentResult.agentId}`);
  }
  try {
    addBinding({ channel: "rocketchat", accountId: ACCOUNT_ID, agentId: agentResult.agentId });
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
    `Restart OpenClaw: ${color.cyan("openclaw restart")}`,
    `Message ${color.cyan(`@${botUsername}`)} in Rocket.Chat`,
  ]);

  p.outro(color.green("Setup complete"));
}

async function resolveBotAuth(
  rcUrl: string,
  adminAuth: RCLoginResult,
  botUsername: string,
): Promise<RCLoginResult | null> {
  const existingUser = await withSpinner(`Checking @${botUsername} on Rocket.Chat`, () =>
    getUserInfo(rcUrl, adminAuth, { username: botUsername }),
  );

  if (existingUser) {
    p.log.success(
      `Bot ${color.cyan(`@${botUsername}`)} already exists — verifying its credentials`,
    );
    return verifyExistingBot(rcUrl, botUsername);
  }

  return createNewBot(rcUrl, adminAuth, botUsername);
}

async function verifyExistingBot(
  rcUrl: string,
  botUsername: string,
): Promise<RCLoginResult | null> {
  const savedBot = await loadBotCredentials(botUsername);
  if (savedBot?.password) {
    const cached = await tryBotLogin(rcUrl, botUsername, savedBot.password);
    if (cached) {
      await saveBotCredentials(botUsername, { userId: cached.userId, password: savedBot.password });
      p.log.success(`Verified bot ${color.cyan(`@${botUsername}`)}`);
      return cached;
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const botPassword = await promptPassword({
      message:
        attempt === 1
          ? `Password for existing bot @${botUsername}`
          : `Wrong password — re-enter for @${botUsername} (${2 - attempt + 1} attempt left)`,
      validate: (value) => (value ? undefined : "Password is required"),
    });
    const auth = await loginForServer(rcUrl, botUsername, botPassword, botUsername);
    if (auth) {
      await saveBotCredentials(botUsername, { userId: auth.userId, password: botPassword });
      p.log.success(`Verified bot ${color.cyan(`@${botUsername}`)}`);
      return auth;
    }
    p.log.error("Login failed: Unauthorized. Check the password and try again.");
  }

  p.log.error("Too many failed attempts. Re-run setup with the correct bot password.");
  return null;
}

async function createNewBot(
  rcUrl: string,
  adminAuth: RCLoginResult,
  botUsername: string,
): Promise<RCLoginResult | null> {
  const botName = await promptText({ message: "Bot display name", defaultValue: botUsername });
  const botEmail = await promptText({
    message: "Bot email",
    defaultValue: `${botUsername.toLowerCase()}@openclaw.local`,
    validate: (value) => ((value ?? "").includes("@") ? undefined : "Enter a valid email"),
  });
  const botPassword = await promptBotPassword(botUsername);

  const botUser = await withSpinner(`Creating bot ${color.cyan(`@${botUsername}`)}`, async () => {
    try {
      return await createBotUser(rcUrl, adminAuth, {
        username: botUsername,
        name: botName,
        password: botPassword,
        email: botEmail,
      });
    } catch (e: unknown) {
      p.log.error(`Failed to create bot: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
  if (!botUser) return null;
  p.log.success(
    `Created bot ${color.cyan(`@${botUser.username}`)} ${color.dim(`(${botUser._id})`)}`,
  );

  const auth = await withSpinner("Obtaining bot auth token", async () => {
    const result = await loginForServer(rcUrl, botUsername, botPassword, botUsername);
    if (result)
      await saveBotCredentials(botUsername, { userId: result.userId, password: botPassword });
    return result;
  });
  if (!auth) {
    p.log.error("Bot login failed after creation. Check the bot's credentials and re-run setup.");
    return null;
  }
  return auth;
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
