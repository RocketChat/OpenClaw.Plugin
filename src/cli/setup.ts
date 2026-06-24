import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loginAs, createBotUser, getUserByUsername, createDirectMessage, sendMessage } from "./admin-api.js";
import * as store from "./credential-store.js";
import { updateConfig } from "./config-updater.js";
import type { RCLoginResult } from "../types/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");

interface PrevConfig {
  rcUrl?: string;
  bot?: { username?: string; name?: string; email?: string } | undefined;
}

let prev: PrevConfig = {};

function prompt(question: string, fallback?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = fallback ? ` [${fallback}]` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback || "");
    });
  });
}

function info(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  \u2705 ${msg}`); }
function fail(msg: string) { console.log(`  \u274c ${msg}`); }

function heading(n: number, title: string) {
  console.log(`\n\u2500\u2500 Step ${n}: ${title}`);
}

async function main() {
  console.log(`\n  OpenClaw Rocket.Chat Setup\n`);

  const prevConfig = await store.read("main");
  if (prevConfig) {
    if (prevConfig.bot) {
      prev.bot = { username: prevConfig.bot.username };
    }
    info("Existing credentials found for account 'main'.");
    const answer = await prompt("Re-run setup? (y/N)", "N");
    if (answer.toLowerCase() !== "y") {
      info("Aborted.");
      process.exit(0);
    }
  }

  heading(1, "Rocket.Chat Connection");
  const rcUrl = await prompt("Rocket.Chat URL", "http://localhost:3000");
  const adminUser = await prompt("Admin username");
  const adminPass = await prompt("Admin password");

  info("Logging in...");
  let adminAuth: RCLoginResult;
  try {
    adminAuth = await loginAs(rcUrl, adminUser, adminPass);
    ok(`Logged in as ${adminUser}`);
  } catch (e: any) {
    fail(`Login failed: ${e.message}`);
    process.exit(1);
  }

  heading(2, "Bot User");
  const botUsername = await prompt("Bot username", "rocketbot");
  if (!botUsername) { fail("Bot username is required"); process.exit(1); }
  const botName = await prompt("Bot display name", botUsername);
  const botEmail = await prompt("Bot email", `${botUsername.toLowerCase()}@openclaw.local`);
  const botPassword = await prompt("Bot password");

  if (!botPassword) { fail("Password is required"); process.exit(1); }

  info("Checking if bot already exists...");
  let botUser: { _id: string; username: string; name: string };
  const existing = await getUserByUsername(rcUrl, adminAuth, botUsername);

  if (existing) {
    ok(`Bot "${botUsername}" already exists (${existing._id}) -- reusing`);
    botUser = existing;
  } else {
    info("Creating bot...");
    try {
      botUser = await createBotUser(rcUrl, adminAuth, {
        username: botUsername, name: botName, password: botPassword, email: botEmail,
      });
      ok(`Created bot: ${botUser.username} (${botUser._id})`);
    } catch (e: any) {
      fail(`Failed: ${e.message}`);
      process.exit(1);
    }
  }

  info("Getting bot auth token...");
  let botAuth: RCLoginResult;
  try {
    botAuth = await loginAs(rcUrl, botUsername, botPassword);
    ok("Bot token obtained");
  } catch (e: any) {
    fail(`Bot login failed: ${e.message}`);
    process.exit(1);
  }

  heading(3, "Welcome Message");
  let dmRoomId = "";
  try {
    info("Creating DM channel...");
    dmRoomId = await createDirectMessage(rcUrl, adminAuth, botUsername);
    await sendMessage(rcUrl, botAuth, dmRoomId, "OpenClaw is connected! Send me a message to get started.");
    ok(`Welcome message sent to @${botUsername}`);
  } catch (e: any) {
    info(`Welcome message skipped: ${e.message}`);
  }

  heading(4, "Save & Configure");
  await store.write("main", {
    accountId: "main",
    auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
    bot: { username: botUsername, userId: botUser._id },
    createdAt: new Date().toISOString(),
  });
  ok("Saved credentials to ~/.openclaw/credentials/rocketchat/main.json");

  try {
    updateConfig({
      pluginPath: PLUGIN_PATH,
      pluginId: "rocketchat",
      accountId: "main",
      serverUrl: rcUrl,
      transport: { mode: "polling" },
      mentionNames: [botUsername],
      auth: { mode: "token", userId: botAuth.userId, accessToken: botAuth.authToken },
    });
    ok("Updated ~/.openclaw/openclaw.json (plugin paths + channel config)");
  } catch (e: any) {
    info(`Skipped openclaw.json update: ${e.message}`);
  }

  console.log(`\n\u2500\u2500 Done! \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
  console.log(`
  Next steps:
    1. Restart OpenClaw:   openclaw restart
    2. Message @${botUsername} in Rocket.Chat
  `);
}

main().catch((e) => { console.error("\nSetup failed:", e.message ?? e); process.exit(1); });
