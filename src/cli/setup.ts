import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loginAs, createBotUser, getUserByUsername, createDirectMessage, sendMessage } from "./admin-api.js";
import { updateConfig } from "./config-updater.js";
import type { RCLoginResult } from "../types/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, "..", "..");

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

function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(`  ${question}: `);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let password = "";

    const onData = (data: Buffer) => {
      const bytes = [...data];

      if (bytes[0] === 0x1b) return;

      if (bytes[0] === 0x0d || bytes[0] === 0x0a) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdout.write("\n");
        resolve(password);
        return;
      }

      if (bytes[0] === 0x03) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        process.exit(1);
        return;
      }

      if (bytes[0] === 0x7f || bytes[0] === 0x08) {
        if (password.length > 0) {
          password = password.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }

      password += data.toString("utf-8");
      stdout.write("*");
    };

    stdin.on("data", onData);
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

  heading(1, "Rocket.Chat Connection");
  const rcUrl = await prompt("Rocket.Chat URL", "http://localhost:3000");
  const adminUser = await prompt("Admin username");
  const adminPass = await promptPassword("Admin password");

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
  let botPassword = "";
  for (let attempts = 0; attempts < 2; attempts++) {
    botPassword = await promptPassword(attempts === 0 ? "Bot password" : "Bot password (min 6 chars)");
    if (!botPassword) { fail("Password is required"); }
    else if (botPassword.length < 6) { fail("Password must be at least 6 characters"); }
    else break;
  }
  if (!botPassword || botPassword.length < 6) { fail("Exiting — valid password required"); process.exit(1); }

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
    await sendMessage(rcUrl, botAuth, dmRoomId, "OpenClaw is connected! Restart OpenClaw (openclaw restart) then send me a message to start chatting.");
    ok(`Welcome message sent to @${botUsername}`);
  } catch (e: any) {
    info(`Welcome message skipped: ${e.message}`);
  }

  heading(4, "Save & Configure");

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
  console.log(`\n  Next steps:
    1. Restart OpenClaw to activate the new bot:   openclaw restart
    2. Message @${botUsername} in Rocket.Chat
  `);
}

main().catch((e) => { console.error("\nSetup failed:", e.message ?? e); process.exit(1); });
