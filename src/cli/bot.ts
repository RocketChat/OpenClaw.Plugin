import {
  createBotUser,
  getUserInfo,
} from "./admin-api.js";
import { checkBotCreationLimit, recordBotCreation } from "./rate-limiter.js";
import { readChannelLimits } from "./config-updater.js";
import { saveBotCredentials, loadBotCredentials } from "./credentials.js";
import {
  color,
  promptPassword,
  promptPasswordConfirm,
  promptText,
  prompts as p,
  withSpinner,
} from "./ui.js";
import { loginForServer, tryBotLogin } from "./auth.js";
import type { RCLoginResult } from "../types.js";

async function promptBotPassword(botUsername: string): Promise<string> {
  const savedBot = await loadBotCredentials(botUsername);
  if (savedBot?.password) {
    p.log.info(`Reusing saved password for ${color.cyan(`@${botUsername}`)}`);
    return savedBot.password;
  }

  return promptPasswordConfirm({
    message: "Bot password (min 6 characters)",
    validate: (value) => {
      if (!value) return "Password is required";
      if (value.length < 6) return "Password must be at least 6 characters";
      return undefined;
    },
  });
}

export async function resolveBotAuth(
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

  for (let attempt = 1; attempt <= 3; attempt++) {
    const botPassword = await promptPassword({
      message:
        attempt === 1
          ? `Password for existing bot @${botUsername}`
          : `Wrong password — re-enter for @${botUsername} (${3 - attempt} attempt${3 - attempt === 1 ? "" : "s"} left)`,
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
  const limits = readChannelLimits();
  const limitCheck = checkBotCreationLimit("cli", {
    serverUrl: rcUrl,
    maxAccounts: limits.maxAccounts,
    maxBotsPerServer: limits.maxBotsPerServer,
    cooldownMs: limits.botCreationCooldownMs,
  });
  if (!limitCheck.allowed) {
    p.log.error(limitCheck.reason ?? "Bot creation limit reached.");
    return null;
  }

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
  recordBotCreation(botUsername, "cli");
  p.log.success(
    `Created bot ${color.cyan(`@${botUser.username}`)} ${color.dim(`(${botUser._id})`)}`,
  );

  const auth = await loginForServer(rcUrl, botUsername, botPassword, botUsername);
  if (auth) {
    await saveBotCredentials(botUsername, { userId: auth.userId, password: botPassword });
  }
  if (!auth) {
    p.log.error("Bot login failed after creation. Check the bot's credentials and re-run setup.");
    return null;
  }
  return auth;
}
