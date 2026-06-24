import { RocketChatClientError } from "../client.js";
import type { RCLoginResult, RCUser, JsonObject } from "../types/types.js";

type RCFetchOpts = {
  method?: string;
  body?: Record<string, unknown>;
  userId?: string;
  authToken?: string;
};

async function adminFetch(baseUrl: string, path: string, opts: RCFetchOpts = {}): Promise<JsonObject> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.userId && opts.authToken) {
    headers["X-Auth-Token"] = opts.authToken;
    headers["X-User-Id"] = opts.userId;
  }
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = (await res.json()) as JsonObject;
  if (!res.ok || json.success === false) {
    const msg = getErrorMessage(json, res.statusText);
    throw new RocketChatClientError(`RC API ${path} failed: ${msg}`);
  }
  return json;
}

function getErrorMessage(payload: JsonObject, fallback: string): string {
  if (typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  if (typeof payload.message === "string" && payload.message.length > 0) return payload.message;
  return fallback;
}

export async function loginAs(baseUrl: string, user: string, password: string): Promise<RCLoginResult> {
  const json = await adminFetch(baseUrl, "/api/v1/login", { body: { user, password } });
  const data = json.data as { userId: string; authToken: string };
  return { userId: data.userId, authToken: data.authToken };
}

export async function createBotUser(
  baseUrl: string,
  auth: RCLoginResult,
  opts: { username: string; name: string; password: string; email: string }
): Promise<RCUser> {
  const json = await adminFetch(baseUrl, "/api/v1/users.create", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: {
      username: opts.username,
      name: opts.name,
      password: opts.password,
      email: opts.email,
      roles: ["bot", "user"],
      verified: true,
      requirePasswordChange: false,
      sendWelcomeEmail: false,
    },
  });
  const user = json.user as RCUser;
  return { _id: user._id, username: user.username, name: user.name };
}

export async function getUserByUsername(
  baseUrl: string,
  auth: RCLoginResult,
  username: string,
): Promise<RCUser | null> {
  try {
    const json = await adminFetch(baseUrl, `/api/v1/users.info?username=${encodeURIComponent(username)}`, {
      method: "GET",
      userId: auth.userId,
      authToken: auth.authToken,
    });
    const user = json.user as RCUser;
    return { _id: user._id, username: user.username, name: user.name };
  } catch {
    return null;
  }
}

export async function createDirectMessage(baseUrl: string, auth: RCLoginResult, username: string): Promise<string> {
  const json = await adminFetch(baseUrl, "/api/v1/im.create", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { username },
  });
  const room = json.room as { _id: string };
  return room._id;
}

export async function sendMessage(baseUrl: string, auth: RCLoginResult, roomId: string, text: string): Promise<void> {
  await adminFetch(baseUrl, "/api/v1/chat.postMessage", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { roomId, text },
  });
}
