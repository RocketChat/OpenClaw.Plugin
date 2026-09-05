import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { pluginConfigSchema } from "../src/config/schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifestPath = resolve(root, "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const schema = z.toJSONSchema(pluginConfigSchema, {
  target: "draft-7",
  unrepresentable: "any",
}) as Record<string, unknown>;

manifest.version = pkg.version;
manifest.configSchema = { type: "object", additionalProperties: true };
if (manifest.channelConfigs?.rocketchat) {
  manifest.channelConfigs.rocketchat.schema = schema;
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated openclaw.plugin.json (version ${pkg.version})`);
