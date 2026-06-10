import type {
  PluginAccountConfig,
  RocketChatIdentity,
  RocketChatSubscriptionRecord,
  RocketChatMessageRecord,
  RocketChatClientOptions,
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
  private readonly auth: PluginAccountConfig["auth"];
  private readonly fetchImpl: typeof fetch;
  private identity: RocketChatIdentity | null = null;

  constructor(options: RocketChatClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async initialize(): Promise<RocketChatIdentity> {
    if (this.identity) {
      return this.identity;
    }

    this.identity =
      this.auth.mode === "password" ? await this.loginWithPassword() : await this.verifyToken();

    return this.identity;
  }

  async listSubscriptions(updatedSince: string | null): Promise<RocketChatSubscriptionRecord[]> {
    await this.initialize();
    const url = new URL("/api/v1/subscriptions.get", this.serverUrl);
    if (updatedSince) {
      url.searchParams.set("updatedSince", updatedSince);
    }

    const payload = await this.requestJson(url, {
      method: "GET"
    });

    return Array.isArray(payload.update) ? payload.update : [];
  }

  async syncMessages(
    roomId: string,
    updatedSince: string | null
  ): Promise<RocketChatMessageRecord[]> {
    await this.initialize();
    const url = new URL("/api/v1/chat.syncMessages", this.serverUrl);
    url.searchParams.set("roomId", roomId);
    if (updatedSince) {
      url.searchParams.set("lastUpdate", updatedSince);
    }

    const payload = await this.requestJson(url, {
      method: "GET"
    });

    const result = asObject(payload.result ?? {});
    return Array.isArray(result.updated) ? result.updated : [];
  }

  async postMessage(roomId: string, text: string, options?: { tmid?: string }): Promise<string> {
    await this.initialize();
    const body: Record<string, string> = { roomId, text };
    if (options?.tmid) {
      body.tmid = options.tmid;
    }
    const payload = await this.requestJson(new URL("/api/v1/chat.postMessage", this.serverUrl), {
      method: "POST",
      body: JSON.stringify(body)
    });

    const message = asObject(payload.message);
    return getString(message, "_id");
  }

  async updateMessage(roomId: string, messageId: string, text: string): Promise<void> {
    await this.initialize();
    await this.requestJson(new URL("/api/v1/chat.update", this.serverUrl), {
      method: "POST",
      body: JSON.stringify({
        roomId,
        msgId: messageId,
        text
      })
    });
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    await this.initialize();
    await this.requestJson(new URL("/api/v1/chat.delete", this.serverUrl), {
      method: "POST",
      body: JSON.stringify({
        roomId,
        msgId: messageId,
        asUser: true
      })
    });
  }

  async reactToMessage(messageId: string, reaction: string): Promise<void> {
    await this.initialize();
    await this.requestJson(new URL("/api/v1/chat.react", this.serverUrl), {
      method: "POST",
      body: JSON.stringify({
        messageId,
        reaction
      })
    });
  }

  private async loginWithPassword(): Promise<RocketChatIdentity> {
    if (this.auth.mode !== "password") {
      throw new RocketChatClientError("Password login requested for a token-auth client");
    }

    const response = await this.fetchImpl(new URL("/api/v1/login", this.serverUrl), {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        user: this.auth.username,
        password: this.auth.password
      })
    });
    const payload = await this.parseJsonResponse(response);
    const data = asObject(payload.data);
    const me = asObject(data.me);

    return {
      userId: getString(data, "userId"),
      authToken: getString(data, "authToken"),
      username: getString(me, "username"),
      displayName: getOptionalString(me, "name") ?? getString(me, "username")
    };
  }

  private async verifyToken(): Promise<RocketChatIdentity> {
    if (this.auth.mode !== "token") {
      throw new RocketChatClientError("Token verification requested for a password-auth client");
    }

    const payload = await this.requestJson(new URL("/api/v1/me", this.serverUrl), {
      method: "GET"
    });
    const user = asObject(payload.user ?? payload.me ?? payload);

    return {
      userId: this.auth.userId,
      authToken: this.auth.accessToken,
      username: getString(user, "username"),
      displayName: getOptionalString(user, "name") ?? getString(user, "username")
    };
  }

  private async requestJson(url: URL, init: RequestInit): Promise<JsonObject> {
    const response = await this.fetchImpl(url.toString(), {
      ...init,
      headers: {
        ...this.baseHeaders(),
        ...this.authHeaders(),
        ...(init.headers ?? {})
      }
    });

    return this.parseJsonResponse(response);
  }

  private async parseJsonResponse(response: Response): Promise<JsonObject> {
    const payload = (await response.json()) as JsonObject;

    if (response.status === 429 || payload.errorType === "error-too-many-requests") {
      throw new RocketChatRateLimitError(getErrorMessage(payload, "Rocket.Chat API rate limited"), {
        retryAfterMs: getRetryAfterMs(response, payload)
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

  private baseHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
  }

  private authHeaders(): Record<string, string> {
    if (this.auth.mode === "token") {
      return {
        "X-User-Id": this.auth.userId,
        "X-Auth-Token": this.auth.accessToken
      };
    }

    if (!this.identity) {
      throw new RocketChatClientError("Client is not authenticated");
    }

    return {
      "X-User-Id": this.identity.userId,
      "X-Auth-Token": this.identity.authToken
    };
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
  const match : any = message.match(/wait\s+(\d+)\s+seconds/i);
  if (match) {
    const retryAfterSeconds = Number.parseInt(match[1], 10);
    if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  return 30_000;
}


