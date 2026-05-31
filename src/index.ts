import { getConfig } from "./config.js";
const configvars = getConfig();

export default function register(api: any): void {
    const logger = api.logger || {
        info: (msg: string) => console.log(`[RC] ${msg}`),
        error: (msg: string) => console.error(`[RC] ${msg}`),
    };

    const config = {
        url: configvars.url  || "http://localhost:3000",
        authToken: configvars.authToken || "",
        userId: configvars.userId || "",
        defaultRoom: configvars.defaultRoom || "GENERAL",
        webhookSecret: configvars.webhookSecret || "",
    };

    if (!config.webhookSecret) {
       console.warn("[RC Config] Warning: RC_WEBHOOK_SECRET is not set — webhook auth disabled.");
    }


    logger.info("Initializing Unified Rocket.Chat Plugin...");
    logger.info(`[Config] RC_URL:          ${config.url}`);
    logger.info(`[Config] RC_USER_ID:      ${config.userId || "NOT SET"}`);
    logger.info(`[Config] RC_AUTH_TOKEN:   ${config.authToken ? config.authToken.slice(0, 6) + "..." : "NOT SET"}`);
    logger.info(`[Config] DEFAULT_ROOM:    ${config.defaultRoom || "NOT SET"}`);

    api.registerChannel({
        plugin: {
            id: "rocketchat",
            meta: {
                id: "rocketchat",
                label: "Rocket.Chat",
                selectionLabel: "Rocket.Chat",
                blurb: "Unified Rocket.Chat Plugin with Inbound Webhook and Outbound REST",
                aliases: ["rc"],
            },
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
                listAccountIds: (_cfg: any) => ["default"],
                resolveAccount: (_cfg: any, accountId?: string) => ({
                    accountId: accountId || "default",
                }),
            },
            outbound: {
                deliveryMode: "direct" as const,
                resolveTarget: ({ to }: { to: string }) => {
                    const target = (to && to.trim()) ? to.trim() : config.defaultRoom;
                    return { ok: true, to: target };
                },
                sendText: async (ctx: { to: string; text: string; accountId?: string; threadId?: string | number | null }) => {
                    try {
                        const room = ctx.to || config.defaultRoom;
                        const payload: any = { rid: room, msg: ctx.text };
                        if (ctx.threadId) {
                            payload.tmid = String(ctx.threadId);
                        }

                        const res = await fetch(`${config.url}/api/v1/chat.sendMessage`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-Auth-Token": config.authToken,
                                "X-User-Id": config.userId,
                            },
                            body: JSON.stringify({ message: payload }),
                        });

                        if (!res.ok) {
                            const body = await res.text();
                            logger.error(`Outbound failed: ${res.status} ${body}`);
                            return { ok: false, channel: "rocketchat" };
                        }

                        return { ok: true, channel: "rocketchat" };
                    } catch (err) {
                        logger.error(`Outbound error: ${(err as Error).message}`);
                        return { ok: false, channel: "rocketchat" };
                    }
                },
            },
            gateway: {
                startAccount: async (ctx: any) => {
                    ctx.setStatus({ accountId: ctx.account?.accountId ?? "default", state: "connected" });
                    return new Promise(() => { });
                },
            },
        },
    });

   if (api.registerHttpRoute) {
    api.registerHttpRoute({
        method: "POST",
        path: "/rocketchat/webhook",
        auth: "plugin",
        handler: async (req: any, res: any) => {
    try {
        let body: any = (req.body && Object.keys(req.body).length > 0) ? req.body : null;
if (!body) {
    const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk: any) => { data += chunk; });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }
}

        logger.info("[Webhook] Incoming payload received");
        logger.info(`[Webhook] user_id:      ${body.user_id}`);
        logger.info(`[Webhook] user_name:    ${body.user_name}`);
        logger.info(`[Webhook] channel_id:   ${body.channel_id}`);
        logger.info(`[Webhook] channel_name: ${body.channel_name}`);
        logger.info(`[Webhook] text:         ${body.text}`);
        logger.info(`[Webhook] message_id:   ${body.message_id}`);
        logger.info(`[Webhook] bot:          ${body.bot}`);
        logger.info(`[Webhook] tmid:         ${body.tmid}`);

        // ignore bot self-messages
        if (body.bot || body.user_id === config.userId) {
            logger.info("[Webhook] Skipping bot message");
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // dispatch into OpenClaw
        await api.scheduleSessionTurn({
            channel: "rocketchat",
            accountId: "default",
            to: body.channel_id || config.defaultRoom,
            from: body.user_name,
            text: body.text ?? "",
            threadId: body.tmid ?? null,
            messageId: body.message_id,
        });


        // New API per sdk-channel-inbound docs. Use this once scheduleSessionTurn
                    // is confirmed removed or broken. Replace approach 1 with this block.
                    //
                    // await api.runtime.channel.inbound.run({
                    //     channel: "rocketchat",
                    //     accountId: "default",
                    //     raw: body,
                    //     adapter: {
                    //         // ingest: normalize the raw RC webhook payload into OpenClaw's
                    //         // inbound message shape expected by the agent layer.
                    //         ingest: (raw: any) => ({
                    //             id: raw.message_id ?? `${Date.now()}`,
                    //             rawText: raw.text ?? "",
                    //             textForAgent: raw.text ?? "",
                    //             textForCommands: raw.text ?? "",
                    //             from: raw.user_name,
                    //             to: raw.channel_id || config.defaultRoom,
                    //             threadId: raw.tmid ?? null,
                    //             raw,
                    //         }),
                    //         // resolveTurn: assemble the full turn context for the agent —
                    //         // routing, session store path, reply target, and delivery fn.
                    //         // Signature and required fields TBD from channel-ingress docs:
                    //         // https://docs.openclaw.ai/plugins/sdk-channel-ingress
                    //         resolveTurn: (input: any) => {
                    //             const room = body.channel_id || config.defaultRoom;
                    //             return {
                    //                 // TODO: fill once ingress API shape is confirmed
                    //                 delivery: {
                    //                     deliver: async (payload: any) => {
                    //                         const text = payload.text ?? payload.message ?? "";
                    //                         const sendRes = await fetch(`${config.url}/api/v1/chat.sendMessage`, {
                    //                             method: "POST",
                    //                             headers: {
                    //                                 "Content-Type": "application/json",
                    //                                 "X-Auth-Token": config.authToken,
                    //                                 "X-User-Id": config.userId,
                    //                             },
                    //                             body: JSON.stringify({ message: { rid: room, msg: text } }),
                    //                         });
                    //                         if (!sendRes.ok) {
                    //                             const errBody = await sendRes.text().catch(() => "");
                    //                             logger.error(`[Delivery] Failed: ${sendRes.status} ${errBody}`);
                    //                         }
                    //                     },
                    //                 },
                    //             };
                    //         },
                    //     },
                    // });


        logger.info("[Webhook] Dispatched to OpenClaw via scheduleSessionTurn");

        res.statusCode = 200;
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        logger.error(`[Webhook] Error: ${(err as Error).message}`);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
},
    });
    logger.info("Registered Inbound Webhook at /rocketchat/webhook");
}

    logger.info("Rocket.Chat Unified Plugin initialization complete.");
}
