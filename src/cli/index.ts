import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRocketChatCommands } from "./commands.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, "..", "..", "package.json");

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("openclaw-rocketchat")
  .description("Rocket.Chat channel plugin CLI for OpenClaw")
  .version(readVersion());

registerRocketChatCommands(program);

await program.parseAsync(process.argv);
