// Register and load openclaw plugin

export default function register(api: any) {
    const RC_URL = process.env.RC_URL || "http://localhost:3000";
    const RC_AUTH_TOKEN = process.env.RC_AUTH_TOKEN || "";
    const RC_USER_ID = process.env.RC_USER_ID || "";
    const DEFAULT_ROOM = process.env.DEFAULT_ROOM || "GENERAL";

    const plugin = {
        id: "rocketchat-plugin",
        meta: {
            id: "rocketchat-plugin",
            label: "Rocket.Chat (webhook)",
            selectionLabel: "Rocket.Chat (webhook)",
            blurb: "REST outbound to Rocket.Chat (chat.sendMessage).",
            aliases: ["rc-hook", "rocketchat-hook"],
        },
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
            listAccountIds: (_cfg: any) => ["default", "69c3a5f48b90145d5886b115", "69a873434af7ce5b5e37b18f"],
            resolveAccount: (_cfg: any, accountId: string) => ({
                accountId: accountId ?? "default"
            }),
        },
        outbound: {
            deliveryMode: "direct" as const,
            resolveTarget: ({ to }: { to: string }) => {
                const target = (to && to.trim()) ? to.trim() : DEFAULT_ROOM;
                return { ok: true, to: target };
            },
            async sendText({ to, text }: { to?: string; text: string }) {
                const room = to || DEFAULT_ROOM;

                const res = await fetch(`${RC_URL}/api/v1/chat.sendMessage`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Auth-Token": RC_AUTH_TOKEN,
                        "X-User-Id": RC_USER_ID,
                    },
                    body: JSON.stringify({ message: { rid: room, msg: text } }),
                });
                const body = await res.text();

                return { ok: res.ok, channel: "rocketchat" }
            }
        },
        gateway: {
            startAccount: async (ctx: any) => {
                ctx.setStatus({ accountId: ctx.account?.accountId ?? "default", state: "connected" });
                return new Promise(() => { });
            },
        },
    };

    api.registerChannel({ plugin });

}