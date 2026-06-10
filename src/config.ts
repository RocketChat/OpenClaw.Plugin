import { z } from "zod";

const tokenAuthSchema = z.object({
  mode: z.literal("token"),
  userId: z.string().min(1),
  accessToken: z.string().min(1)
}).strict();

const passwordAuthSchema = z.object({
  mode: z.literal("password"),
  username: z.string().min(1),
  password: z.string().min(1)
}).strict();

const transportSchema = z.preprocess(
  (value) => value ?? { mode: "polling" },
  z.object({
    mode: z.literal("polling"),
    pollIntervalMs: z.number().int().min(1000).default(3000)
  }).strict()
);

const accountSchema = z.object({
  enabled: z.boolean(),
  serverUrl: z.string().min(1),
  auth: z.union([tokenAuthSchema, passwordAuthSchema]),
  transport: transportSchema,
  mentionNames: z.array(z.string().min(1)).default([]),
  forceThread: z.boolean().default(true),
  agent: z.string().min(1).optional(),
  transcribeAudio: z.boolean().default(true)
}).strict();

const pluginConfigSchema = z.object({
  accounts: z.record(z.string().min(1), accountSchema)
}).strict();

export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type PluginAccountConfig = PluginConfig["accounts"][string];

function substituteEnvVars(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name) => env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnvVars(item, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnvVars(v, env);
    }
    return out;
  }
  return value;
}

export function parsePluginConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(substituteEnvVars(input));
}
