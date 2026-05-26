export default function register(api: any): void {
    const logger = api.logger || {
        info: (msg: string) => console.log(`[RC] ${msg}`),
        error: (msg: string) => console.error(`[RC] ${msg}`),
    };

    const config = {
        url: "http://localhost:3000",
        authToken: "",
        userId: "",
        defaultRoom: "",
        webhookSecret: "",
    };

    logger.info("Initializing Unified Rocket.Chat Plugin...");

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
            auth: { mode: "none" },
            handler: async (req: any, res: any) => {
                try {
                    const body = req.body || {};

                    const token = req.headers["x-rocketchat-livechat-token"] || req.headers["authorization"] || body.token;
                    if (config.webhookSecret && token !== config.webhookSecret) {
                        logger.error("Webhook authentication failed. Invalid token.");
                        return res.status(401).json({ error: "Unauthorized" });
                    }

                    const text = body.text || "";
                    const roomId = body.channel_id || "GENERAL";
                    const senderId = body.user_id || "unknown";
                    const msgId = body.message_id || Date.now().toString();
                    const isBot = body.bot === true;

                    if (isBot || senderId === config.userId) {
                        return res.status(200).json({ success: true, ignored: true });
                    }

                    if (api.gateway && api.gateway.dispatchInbound) {
                        await api.gateway.dispatchInbound({
                            channel: "rocketchat",
                            accountId: "default",
                            type: "message",
                            message: {
                                id: msgId,
                                text: text,
                                from: senderId,
                                to: roomId,
                                metadata: {
                                    channelName: body.channel_name,
                                    userName: body.user_name,
                                    threadId: body.tmid
                                }
                            },
                            raw: body,
                        });
                        logger.info(`Dispatched inbound message from ${senderId} in ${roomId}`);
                    } else {
                        logger.error("api.gateway.dispatchInbound is not available.");
                    }

                    res.status(200).json({ success: true });
                } catch (err) {
                    logger.error(`Webhook processing error: ${(err as Error).message}`);
                    res.status(500).json({ error: "Internal Server Error" });
                }
            },
        });
        logger.info("Registered Inbound Webhook at /rocketchat/webhook");
    } else {
        logger.error("api.registerHttpRoute is not available on this OpenClaw version.");
    }

    if (api.registerCli) {
        api.registerCli(({ program }: { program: any }) => {
            const rc = program.command("rocketchat").alias("rc").description("Rocket.Chat unified plugin commands");
            rc.command("status")
                .description("Check Rocket.Chat webhook and integration status")
                .action(() => {
                    console.log("Rocket.Chat plugin is loaded.");
                    console.log(`RC_URL: ${config.url}`);
                    console.log(`Webhook Secret Configured: ${!!config.webhookSecret}`);
                });
        }, {
            commands: ["rocketchat"]
        });
    }

    logger.info("Rocket.Chat Unified Plugin initialization complete.");
}
