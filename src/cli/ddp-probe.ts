import { config as loadDotEnv } from "dotenv";

import WebSocket, { type RawData } from "ws";

loadDotEnv();

// --- Hardcoded WebSocket URL (override via RC_WS_URL if needed) ---
const WS_URL = process.env.RC_WS_URL ?? "ws://localhost:3000/websocket";

const AUTH_TOKEN = process.env.RC_AUTH_TOKEN;
const USER_ID = process.env.RC_USER_ID;

if (!AUTH_TOKEN || !USER_ID) {
  console.error("Missing RC_AUTH_TOKEN / RC_USER_ID in env or .env");
  process.exit(1);
}

console.log(`[probe] connecting to ${WS_URL} as user ${USER_ID}`);

let ddpIdCounter = 0;
const nextDdpId = () => `openclaw-probe-${++ddpIdCounter}`;

const WATCHDOG_MS = 120_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

type DDPMessage = {
  msg?: string;
  id?: string;
  method?: string;
  collection?: string;
  fields?: { eventName?: string; args?: unknown[] };
  result?: unknown;
  error?: unknown;
};

function start(): void {
  let reconnectAttempts = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let authenticated = false;
  let loginId: string | null = null;

  const connect = () => {
    const ws = new WebSocket(WS_URL);

    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        console.error("[probe] watchdog timeout — no DDP traffic, terminating");
        ws.terminate();
      }, WATCHDOG_MS);
    };

    const ddpSend = (msg: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        resetWatchdog();
      }
    };

    ws.on("open", () => {
      console.log("[probe] socket open — sending DDP connect");
      resetWatchdog();
      ddpSend({ msg: "connect", version: "1", support: ["1"] });
    });

    ws.on("message", (raw: RawData) => {
      resetWatchdog();
      let data: DDPMessage;
      try {
        const str = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
        data = JSON.parse(str) as DDPMessage;
      } catch {
        return;
      }

      if (data.msg === "ping") {
        ddpSend({ msg: "pong", id: data.id });
        return;
      }

      if (data.msg === "connected") {
        console.log("[probe] connected — logging in via resume token");
        loginId = nextDdpId();
        ddpSend({ msg: "method", method: "login", id: loginId, params: [{ resume: AUTH_TOKEN }] });
        return;
      }

      if (data.msg === "result" && data.id === loginId) {
        if (data.error) {
          const errMsg =
            typeof data.error === "object"
              ? ((data.error as { message?: string }).message ?? JSON.stringify(data.error))
              : String(data.error);
          console.error(`[probe] login failed: ${errMsg}`);
          ws.close();
          return;
        }
        authenticated = true;
        console.log("[probe] authenticated — subscribing to __my_messages__");
        ddpSend({
          msg: "sub",
          id: nextDdpId(),
          name: "stream-room-messages",
          params: ["__my_messages__", { useCollection: false, args: [] }],
        });
        return;
      }

      if (data.msg === "ready") {
        console.log("[probe] subscription ready — listening for inbound messages");
        reconnectAttempts = 0;
        return;
      }

      if (data.msg === "changed" && data.collection === "stream-room-messages") {
        const args = data.fields?.args;
        if (Array.isArray(args) && args.length > 0) {
          const message = args[0] as Record<string, unknown>;
          const rid = (message.rid as string) ?? data.fields?.eventName;
          const sender = (message.u as { username?: string; _id?: string }) ?? {};
          const text = (message.msg as string) ?? "";
          const t = (message.t as string) ?? null;
          console.log(
            `[probe] <- room=${rid} from=${sender.username ?? sender._id ?? "?"} t=${t ?? "-"}: ${text}`,
          );
          console.dir(message, { depth: null, colors: true });
        }
        return;
      }
    });

    ws.on("close", (code: number) => {
      if (watchdog) clearTimeout(watchdog);
      console.log(`[probe] socket closed (code ${code}) — reconnecting in ${RECONNECT_BASE_MS}ms`);
      authenticated = false;
      loginId = null;
      const delay = reconnectAttempts === 0 ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
      reconnectAttempts += 1;
      setTimeout(connect, delay);
    });

    ws.on("error", (err: Error) => {
      console.error(`[probe] socket error: ${err.message}`);
      ws.close();
    });
  };

  connect();
}

start();
