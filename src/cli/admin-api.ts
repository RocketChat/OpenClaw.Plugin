import { RocketChatClientError } from "../client/rest.js";
import { getErrorMessage } from "../utils.js";
import type { RCLoginResult, RCUser, JsonObject } from "../types.js";

function extractRecord(json: JsonObject, field: string): Record<string, unknown> {
  const value = json[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RocketChatClientError(`RC API response missing or invalid "${field}"`);
  }
  return value as Record<string, unknown>;
}

function extractString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new RocketChatClientError(`RC API response missing or invalid "${key}"`);
  }
  return v;
}

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
  const res = await fetch(new URL(path, baseUrl), {
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

export async function loginAs(baseUrl: string, user: string, password: string): Promise<RCLoginResult> {
  const json = await adminFetch(baseUrl, "/api/v1/login", { body: { user, password } });
  const data = extractRecord(json, "data");
  return { userId: extractString(data, "userId"), authToken: extractString(data, "authToken") };
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
  const userRecord = extractRecord(json, "user");
  return { _id: extractString(userRecord, "_id"), username: extractString(userRecord, "username"), name: extractString(userRecord, "name") };
}

export async function getUserRoles(baseUrl: string, auth: RCLoginResult, username: string): Promise<string[] | null> {
  const url = new URL("/api/v1/users.info", baseUrl);
  url.searchParams.set("username", username);
  const json = await adminFetch(baseUrl, url.toString(), {
    method: "GET",
    userId: auth.userId,
    authToken: auth.authToken,
  });
  const user = json.user as { roles?: string[] } | undefined;
  return user?.roles ?? null;
}

export type VerifyAdminResult =
  | { ok: true }
  | { ok: false; reason: "not-admin" }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "unreachable" };

export async function verifyAdmin(baseUrl: string, auth: RCLoginResult): Promise<VerifyAdminResult> {
  let roles: string[] | null;
  try {
    roles = await getUserRoles(baseUrl, auth, auth.userId);
  } catch (e: unknown) {
    if (e instanceof RocketChatClientError && /401|unauthorized/i.test(e.message)) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: "unreachable" };
  }

  if (roles) {
    return roles.includes("admin") ? { ok: true } : { ok: false, reason: "not-admin" };
  }


  try {
    const url = new URL("/api/v1/users.info", baseUrl);
    url.searchParams.set("userId", auth.userId);
    const json = await adminFetch(baseUrl, url.toString(), {
      method: "GET",
      userId: auth.userId,
      authToken: auth.authToken,
    });
    const user = json.user as { roles?: string[] } | undefined;
    return user?.roles?.includes("admin") ? { ok: true } : { ok: false, reason: "not-admin" };
  } catch (e: unknown) {
    if (e instanceof RocketChatClientError && /401|unauthorized/i.test(e.message)) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: "unreachable" };
  }
}

export async function getUserByUsername(
  baseUrl: string,
  auth: RCLoginResult,
  username: string,
): Promise<RCUser | null> {
  try {
    const url = new URL("/api/v1/users.info", baseUrl);
    url.searchParams.set("username", username);
    const json = await adminFetch(baseUrl, url.toString(), {
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
  const room = extractRecord(json, "room");
  return extractString(room, "_id");
}

export async function sendMessage(baseUrl: string, auth: RCLoginResult, roomId: string, text: string): Promise<void> {
  await adminFetch(baseUrl, "/api/v1/chat.postMessage", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { roomId, text },
  });
}

export interface RocketChatGroup {
  _id: string;
  name: string;
 
  isPrivate?: boolean;
}


export async function listGroups(baseUrl: string, auth: RCLoginResult, count = 100): Promise<RocketChatGroup[]> {
  const json = await adminFetch(baseUrl, `/api/v1/groups.list?count=${count}`, {
    method: "GET",
    userId: auth.userId,
    authToken: auth.authToken,
  });
  const groups = (json.groups as Array<{ _id: string; name: string; t?: string }>) ?? [];
  return groups
    .filter((g) => g.name && g.name !== g._id)
    .map((g) => ({ _id: g._id, name: g.name, isPrivate: g.t === "p" }));
}


export async function getGroupByName(baseUrl: string, auth: RCLoginResult, name: string): Promise<RocketChatGroup | null> {
  try {
    const url = new URL("/api/v1/groups.info", baseUrl);
    url.searchParams.set("name", name);
    const json = await adminFetch(baseUrl, url.toString(), {
      method: "GET",
      userId: auth.userId,
      authToken: auth.authToken,
    });
    const group = json.group as { _id: string; name?: string; t?: string } | undefined;
    if (!group?._id) return null;
    return { _id: group._id, name: group.name ?? name, isPrivate: group.t === "p" };
  } catch {
    return null;
  }
}

export async function inviteToGroup(baseUrl: string, auth: RCLoginResult, groupId: string, username: string): Promise<void> {
  await adminFetch(baseUrl, "/api/v1/groups.invite", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { roomId: groupId, username },
  });
}

export async function checkServerHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/info", baseUrl), { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
