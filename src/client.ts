import type {
  RocketChatIdentity,
  RocketChatSubscriptionRecord,
  RocketChatMessageRecord,
  JsonObject
} from "./types/types.js";

export class RocketChatClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RocketChatClientError";
  }
}

export class RocketChatRateLimitError extends RocketChatClientError {
  readonly retryAfterMs: number;

  constructor(message: string, options: { retryAfterMs: number }) {
    super(message);
    this.name = "RocketChatRateLimitError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class RocketChatClient {
  private readonly serverUrl: string;
  private readonly userId: string;
  private readonly accessToken: string;

  constructor(options: { serverUrl: string; auth: { userId: string; accessToken: string } }) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.userId = options.auth.userId;
    this.accessToken = options.auth.accessToken;
  }

  async getIdentity(): Promise<RocketChatIdentity> {
    const payload = await this.requestJson(new URL("/api/v1/me", this.serverUrl), { method: "GET" });
    const user = asObject(payload.user ?? payload.me ?? payload);
    return {
      userId: this.userId,
      authToken: this.accessToken,
      username: getString(user, "username"),
      displayName: getOptionalString(user, "name") ?? getString(user, "username"),
    };
  }

  async listSubscriptions(updatedSince: string | null): Promise<RocketChatSubscriptionRecord[]> {
    const url = new URL("/api/v1/subscriptions.get", this.serverUrl);
    if (updatedSince) url.searchParams.set("updatedSince", updatedSince);
    const payload = await this.requestJson(url, { method: "GET" });
    return Array.isArray(payload.update) ? payload.update : [];
  }

  async syncMessages(roomId: string, updatedSince: string | null): Promise<RocketChatMessageRecord[]> {
    const url = new URL("/api/v1/chat.syncMessages", this.serverUrl);
    url.searchParams.set("roomId", roomId);
    if (updatedSince) url.searchParams.set("lastUpdate", updatedSince);
    const payload = await this.requestJson(url, { method: "GET" });
    const result = asObject(payload.result ?? {});
    return Array.isArray(result.updated) ? result.updated : [];
  }

  async postMessage(roomId: string, text: string, options?: { tmid?: string }): Promise<string> {
    const body: Record<string, string> = { roomId, text };
    if (options?.tmid) body.tmid = options.tmid;
    const payload = await this.requestJson(new URL("/api/v1/chat.postMessage", this.serverUrl), {
      method: "POST",
      body: JSON.stringify(body),
    });
    const message = asObject(payload.message);
    return getString(message, "_id");
  }

  async updateMessage(roomId: string, messageId: string, text: string): Promise<void> {
    await this.requestJson(new URL("/api/v1/chat.update", this.serverUrl), {
      method: "POST",
      body: JSON.stringify({ roomId, msgId: messageId, text }),
    });
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    await this.requestJson(new URL("/api/v1/chat.delete", this.serverUrl), {
      method: "POST",
      body: JSON.stringify({ roomId, msgId: messageId, asUser: true }),
    });
  }

  async reactToMessage(messageId: string, reaction: string): Promise<void> {
    await this.requestJson(new URL("/api/v1/chat.react", this.serverUrl), {
      method: "POST",
      body: JSON.stringify({ messageId, reaction }),
    });
  }

  private async requestJson(url: URL, init: RequestInit): Promise<JsonObject> {
    const signal = init.signal ?? AbortSignal.timeout(15_000);
    const response = await fetch(url.toString(), {
      ...init,
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-User-Id": this.userId,
        "X-Auth-Token": this.accessToken,
        ...(init.headers as Record<string, string> ?? {}),
      },
    });
    return this.parseJsonResponse(response);
  }

  private async parseJsonResponse(response: Response): Promise<JsonObject> {
    const payload = (await response.json()) as JsonObject;

    if (response.status === 429 || payload.errorType === "error-too-many-requests") {
      throw new RocketChatRateLimitError(getErrorMessage(payload, "Rocket.Chat API rate limited"), {
        retryAfterMs: getRetryAfterMs(response, payload),
      });
    }

    if (!response.ok) {
      throw new RocketChatClientError(getErrorMessage(payload, response.statusText));
    }

    if (payload.success === false || payload.status === "error") {
      throw new RocketChatClientError(getErrorMessage(payload, "Rocket.Chat API request failed"));
    }

    return payload;
  }
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new RocketChatClientError("Rocket.Chat API returned an invalid payload");
}

function getString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new RocketChatClientError(`Rocket.Chat API payload missing "${key}"`);
}

function getOptionalString(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getErrorMessage(payload: JsonObject, fallback: string): string {
  if (typeof payload.error === "string" && payload.error.length > 0) {
    return payload.error;
  }

  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }

  return fallback;
}

function getRetryAfterMs(response: Response, payload: JsonObject): number {
  const retryAfterHeader = response.headers.get("Retry-After");
  if (retryAfterHeader) {
    const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  const message = getErrorMessage(payload, "");
  const match: RegExpMatchArray | null = message.match(/wait\s+(\d+)\s+seconds/i);
  if (match) {
    const retryAfterSeconds = Number.parseInt(match[1]!, 10);
    if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  return 30_000;
}
