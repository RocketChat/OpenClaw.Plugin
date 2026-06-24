import { z } from "zod";

const tokenAuthSchema = z.object({
  mode: z.literal("token"),
  userId: z.string().min(1),
  accessToken: z.string().min(1)
}).strict();

const transportSchema = z.preprocess(
  (value) => value ?? { mode: "polling" },
  z.object({
    mode: z.literal("polling"),
  }).strict()
);

const accountSchema = z.object({
  enabled: z.boolean(),
  serverUrl: z.string().min(1),
  auth: tokenAuthSchema,
  transport: transportSchema,
  mentionNames: z.array(z.string().min(1)).default([]),
  agent: z.string().min(1).optional(),
}).strict();

const pluginConfigSchema = z.object({
  accounts: z.record(z.string().min(1), accountSchema)
}).strict();

export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type PluginAccountConfig = PluginConfig["accounts"][string];

export function parsePluginConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(input);
}
