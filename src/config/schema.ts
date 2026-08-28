import { z } from "zod";

const tokenAuthSchema = z
  .object({
    mode: z.literal("token"),
    userId: z.string().min(1),
    accessToken: z.string().min(1),
  })
  .strict();

const passwordAuthSchema = z
  .object({
    mode: z.literal("password"),
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

const transportSchema = z.preprocess(
  (value) => value ?? { mode: "websocket" },
  z.discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("websocket"),
        reconnectDelayMs: z.number().int().positive().default(2_000).optional(),
      })
      .strict(),
  ]),
);

const accountSchema = z
  .object({
    enabled: z.boolean(),
    serverUrl: z.string().min(1),
    auth: z.discriminatedUnion("mode", [tokenAuthSchema, passwordAuthSchema]),
    transport: transportSchema,
    mentionNames: z.array(z.string().min(1)).default([]),
    agent: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
  })
  .strict();

export const pluginConfigSchema = z
  .object({
    accounts: z.record(z.string().min(1), accountSchema),
    limits: z
      .object({
        maxAccounts: z.number().int().positive().default(10).optional(),
        maxBotsPerServer: z.number().int().positive().default(5).optional(),
        botCreationCooldownMs: z.number().int().positive().default(60_000).optional(),
        maxReconnects: z.number().int().positive().default(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type PluginAccountConfig = PluginConfig["accounts"][string];

export function parsePluginConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(input);
}
