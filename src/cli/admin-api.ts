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
  raw?: boolean;
};

async function adminFetch(
  baseUrl: string,
  path: string,
  opts: RCFetchOpts = {},
): Promise<JsonObject> {
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
  if (!opts.raw && (!res.ok || json.success === false)) {
    const msg = getErrorMessage(json, res.statusText);
    throw new RocketChatClientError(`RC API ${path} failed: ${msg}`);
  }
  return json;
}

export type LoginChallenge = {
  transactionId: string;
  methods: string[];
};

export class TwoFactorRequiredError extends Error {
  readonly challenge: LoginChallenge;

  constructor(message: string, challenge: LoginChallenge) {
    super(message);
    this.name = "TwoFactorRequiredError";
    this.challenge = challenge;
  }
}

function parseLoginChallenge(json: JsonObject): LoginChallenge | null {
  const errorType = typeof json.errorType === "string" ? json.errorType : "";
  const status = typeof json.status === "string" ? json.status : "";
  const message = typeof json.error === "string" ? json.error : "";

  // Only treat as a 2FA challenge on Rocket.Chat's explicit challenge signals.
  // A regular failed login (bad password, rate limit, "user not found") must NOT
  // be mistaken for 2FA, otherwise the wizard hangs waiting for a code that was
  // never sent (e.g. a bot account without 2FA provisioned).
  const explicitChallenge =
    /^(totp-required|code-required|email-required|totp-invalid|code-invalid)$/i.test(errorType) ||
    (status === "error" &&
      /(two-factor|verification code|2fa|totp|enter the code)/i.test(message)) ||
    /totp-required|code-required|email-required/i.test(errorType);

  if (!explicitChallenge) return null;

  const details = (json.details ?? {}) as Record<string, unknown>;
  const methodsRaw = details.method ?? details.methods;
  const methods = Array.isArray(methodsRaw)
    ? methodsRaw.filter((m): m is string => typeof m === "string")
    : typeof methodsRaw === "string"
      ? [methodsRaw]
      : ["totp"];

  const transactionId =
    typeof details.code === "string" && details.code.length > 0
      ? details.code
      : typeof details.token === "string" && details.token.length > 0
        ? details.token
        : "";

  return { transactionId, methods };
}

export type LoginAsOptions = {
  /** Optional TOTP / email 2FA code for an in-progress challenge. */
  code?: string;
  /** Transaction id returned by a prior 2FA challenge. */
  transactionId?: string;
};

export async function loginAs(
  baseUrl: string,
  user: string,
  password: string,
  opts: LoginAsOptions = {},
): Promise<RCLoginResult> {
  const body: Record<string, unknown> = { user, password };
  if (opts.code) {
    body.code = opts.code;
    // Rocket.Chat sends the 2FA transaction id back as `codeAgain`.
    if (opts.transactionId) body.codeAgain = opts.transactionId;
  }

  const json = await adminFetch(baseUrl, "/api/v1/login", { body, raw: true });
  const challenge = parseLoginChallenge(json);
  if (challenge) {
    throw new TwoFactorRequiredError("Two-factor authentication required", challenge);
  }

  const data = extractRecord(json, "data");
  return { userId: extractString(data, "userId"), authToken: extractString(data, "authToken") };
}

export async function createBotUser(
  baseUrl: string,
  auth: RCLoginResult,
  opts: { username: string; name: string; password: string; email: string },
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
  return {
    _id: extractString(userRecord, "_id"),
    username: extractString(userRecord, "username"),
    name: extractString(userRecord, "name"),
  };
}

export async function deleteUser(
  baseUrl: string,
  auth: RCLoginResult,
  username: string,
): Promise<void> {
  await adminFetch(baseUrl, "/api/v1/users.delete", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { username },
  });
}

export async function getUserInfo(
  baseUrl: string,
  auth: RCLoginResult,
  opts: { username?: string; userId?: string },
): Promise<RCUser | null> {
  const url = new URL("/api/v1/users.info", baseUrl);
  if (opts.username) url.searchParams.set("username", opts.username);
  if (opts.userId) url.searchParams.set("userId", opts.userId);
  try {
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

export type VerifyAdminResult =
  | { ok: true }
  | { ok: false; reason: "not-admin" }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "unreachable" };

export async function verifyAdmin(
  baseUrl: string,
  auth: RCLoginResult,
): Promise<VerifyAdminResult> {
  try {
    const user = await getUserInfo(baseUrl, auth, { userId: auth.userId });
    const roles = (user as unknown as { roles?: string[] } | null)?.roles;
    if (!roles) return { ok: false, reason: "unreachable" };
    return roles.includes("admin") ? { ok: true } : { ok: false, reason: "not-admin" };
  } catch (e: unknown) {
    if (e instanceof RocketChatClientError && /401|unauthorized/i.test(e.message)) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: "unreachable" };
  }
}

export async function createDirectMessage(
  baseUrl: string,
  auth: RCLoginResult,
  username: string,
): Promise<string> {
  const json = await adminFetch(baseUrl, "/api/v1/im.create", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { username },
  });
  const room = extractRecord(json, "room");
  return extractString(room, "_id");
}

export async function sendMessage(
  baseUrl: string,
  auth: RCLoginResult,
  roomId: string,
  text: string,
): Promise<void> {
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

export interface RocketChatMember {
  _id: string;
  username: string;
  name?: string;
}

export async function listGroupMembers(
  baseUrl: string,
  auth: RCLoginResult,
  roomId: string,
): Promise<RocketChatMember[]> {
  for (const endpoint of ["/api/v1/groups.members", "/api/v1/channels.members"]) {
    try {
      const url = new URL(endpoint, baseUrl);
      url.searchParams.set("roomId", roomId);
      url.searchParams.set("count", "0");
      const json = await adminFetch(baseUrl, url.toString(), {
        method: "GET",
        userId: auth.userId,
        authToken: auth.authToken,
      });
      const members =
        (json.members as Array<{ _id?: string; username?: string; name?: string }> | undefined) ??
        [];
      const resolved = members
        .map((m) => ({ _id: m._id ?? "", username: m.username ?? "", name: m.name ?? "" }))
        .filter((m) => m._id && m.username);
      if (resolved.length > 0 || json.members !== undefined) {
        return resolved;
      }
    } catch {}
  }
  return [];
}

export async function listPublicChannels(
  baseUrl: string,
  auth: RCLoginResult,
  count = 100,
): Promise<RocketChatGroup[]> {
  const url = new URL("/api/v1/channels.list", baseUrl);
  url.searchParams.set("count", String(count));
  const json = await adminFetch(baseUrl, url.toString(), {
    method: "GET",
    userId: auth.userId,
    authToken: auth.authToken,
  });
  const channels = (json.channels as Array<{ _id: string; name: string; t?: string }>) ?? [];
  return channels
    .filter((c) => c.name && c.name !== c._id)
    .map((c) => ({ _id: c._id, name: c.name, isPrivate: c.t === "p" }));
}

export async function listGroups(
  baseUrl: string,
  auth: RCLoginResult,
  count = 100,
): Promise<RocketChatGroup[]> {
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

export async function getGroupByName(
  baseUrl: string,
  auth: RCLoginResult,
  name: string,
): Promise<RocketChatGroup | null> {
  for (const endpoint of ["/api/v1/groups.info", "/api/v1/channels.info"]) {
    try {
      const url = new URL(endpoint, baseUrl);
      url.searchParams.set("roomName", name);
      const json = await adminFetch(baseUrl, url.toString(), {
        method: "GET",
        userId: auth.userId,
        authToken: auth.authToken,
      });
      const group = (json.group ?? json.channel) as
        { _id: string; name?: string; t?: string } | undefined;
      if (group?._id) {
        return { _id: group._id, name: group.name ?? name, isPrivate: group.t === "p" };
      }
    } catch {}
  }
  return null;
}

export async function kickFromGroup(
  baseUrl: string,
  auth: RCLoginResult,
  groupId: string,
  username: string,
  isPrivate = true,
): Promise<void> {
  const endpoint = isPrivate ? "/api/v1/groups.kick" : "/api/v1/channels.kick";
  await adminFetch(baseUrl, endpoint, {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { roomId: groupId, username },
  });
}

export async function inviteToGroup(
  baseUrl: string,
  auth: RCLoginResult,
  groupId: string,
  username: string,
  isPrivate = true,
): Promise<void> {
  const endpoint = isPrivate ? "/api/v1/groups.invite" : "/api/v1/channels.invite";
  await adminFetch(baseUrl, endpoint, {
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
