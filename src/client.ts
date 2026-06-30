import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveOpenClawDir, resolveUrl, getExt, getErrorMessage } from "./utils.js";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_DOWNLOAD_MIME_PREFIXES = ["image/"];

import type {
  PluginAccountConfig,
  RocketChatIdentity,
  RocketChatSubscriptionRecord,
  RocketChatMessageRecord,
  RocketChatClientOptions,
  JsonObject,
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
  private readonly fetchFn: typeof fetch;
  private readonly mediaDir: string;
  private identity: RocketChatIdentity | null = null;
  private resolvedUserId: string | null = null;
  private resolvedAuthToken: string | null = null;

  constructor(options: RocketChatClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.mediaDir = join(resolveOpenClawDir(), "media");

    if (this.auth.mode === "token") {
      this.resolvedUserId = this.auth.userId;
      this.resolvedAuthToken = this.auth.accessToken;
    }
  }

  async initialize(): Promise<void> {
    if (this.resolvedUserId && this.resolvedAuthToken) return;
    if (this.auth.mode !== "password") {
      throw new RocketChatClientError("cannot initialize: no credentials available");
    }
    const response = await this.fetchFn(new URL("/api/v1/login", this.serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ user: this.auth.username, password: this.auth.password }),
    });
    if (!response.ok) {
      throw new RocketChatClientError(`login failed: ${response.statusText}`);
    }
    const payload = await response.json() as JsonObject;
    const data = asObject(payload.data);
    this.resolvedUserId = getString(data, "userId");
    this.resolvedAuthToken = getString(data, "authToken");
  }

  async getIdentity(): Promise<RocketChatIdentity> {
    if (this.identity) return this.identity;
    await this.ensureInitialized();
    const payload = await this.requestJson(new URL("/api/v1/me", this.serverUrl), { method: "GET" });
    const user = asObject(payload.user ?? payload.me ?? payload);
    this.identity = {
      userId: this.resolvedUserId!,
      authToken: this.resolvedAuthToken!,
      username: getString(user, "username"),
      displayName: getOptionalString(user, "name") ?? getString(user, "username"),
    };
    return this.identity;
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

  async downloadAttachmentToTempFile(
    url: string,
    options?: { fileName?: string },
  ): Promise<string> {
    await this.ensureInitialized();
    const requestUrl = resolveUrl(url, this.serverUrl);
    if (isBlockedUrl(requestUrl)) {
      throw new RocketChatClientError(`attachment download blocked: ${requestUrl} resolves to a private/internal address`);
    }
    const response = await this.fetchFn(requestUrl, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "X-User-Id": this.resolvedUserId!,
        "X-Auth-Token": this.resolvedAuthToken!,
      },
    });
    if (!response.ok) {
      throw new RocketChatClientError(`attachment download failed: ${response.statusText}`);
    }
    const contentTypeHeader = response.headers.get("Content-Type");
    const rawContentType = (contentTypeHeader ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!rawContentType || !ALLOWED_DOWNLOAD_MIME_PREFIXES.some((p) => rawContentType.startsWith(p))) {
      throw new RocketChatClientError(
        `attachment download refused: unsupported content type "${contentTypeHeader ?? ""}"`,
      );
    }
    const contentLength = response.headers.get("Content-Length");
    if (contentLength) {
      const bytes = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(bytes) && bytes > MAX_DOWNLOAD_BYTES) {
        throw new RocketChatClientError(
          `attachment download refused: Content-Length ${bytes} exceeds max ${MAX_DOWNLOAD_BYTES}`,
        );
      }
    }
    const inboundDir = join(this.mediaDir, "inbound");
    await mkdir(inboundDir, { recursive: true });
    const ext = getExt(options?.fileName ?? url ?? "attachment");
    const safeName = (options?.fileName ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = join(inboundDir, `${safeName}---${randomUUID().slice(0, 12)}${ext ? `.${ext}` : ""}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new RocketChatClientError(
        `attachment download refused: actual size ${bytes.length} exceeds max ${MAX_DOWNLOAD_BYTES}`,
      );
    }
    await writeFile(filePath, bytes);
    return filePath;
  }

  async uploadAttachment(
    roomId: string,
    filePath: string,
    text?: string,
    options?: { tmid?: string },
  ): Promise<string> {
    await this.ensureInitialized();
    const fileName = basename(filePath);
    const fileBytes = await readFile(filePath);
    const formData = new FormData();
    if (text?.trim()) formData.append("msg", text.trim());
    if (options?.tmid) formData.append("tmid", options.tmid);
    formData.append("file", new Blob([fileBytes]), fileName);
    const uploadResponse = await this.fetchFn(
      new URL(`/api/v1/rooms.media/${encodeURIComponent(roomId)}`, this.serverUrl).toString(),
      {
        method: "POST",
        headers: {
          "X-User-Id": this.resolvedUserId!,
          "X-Auth-Token": this.resolvedAuthToken!,
        },
        body: formData,
      },
    );
    if (!uploadResponse.ok) {
      throw new RocketChatClientError(`attachment upload failed: ${uploadResponse.statusText}`);
    }
    const uploadPayload = await this.parseJsonResponse(uploadResponse);
    const file = asObject(uploadPayload.file ?? {});
    const fileId = getString(file, "_id");
    const confirmResponse = await this.fetchFn(
      new URL(
        `/api/v1/rooms.mediaConfirm/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}`,
        this.serverUrl,
      ).toString(),
      {
        method: "POST",
        headers: {
          "X-User-Id": this.resolvedUserId!,
          "X-Auth-Token": this.resolvedAuthToken!,
        },
      },
    );
    if (!confirmResponse.ok) {
      throw new RocketChatClientError(`attachment confirm failed: ${confirmResponse.statusText}`);
    }
    const confirmPayload = await this.parseJsonResponse(confirmResponse);
    const message = asObject(confirmPayload.message ?? {});
    return getString(message, "_id");
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.resolvedUserId || !this.resolvedAuthToken) {
      await this.initialize();
    }
  }

  private async requestJson(url: URL, init: RequestInit): Promise<JsonObject> {
    await this.ensureInitialized();
    const signal = init.signal ?? AbortSignal.timeout(15_000);
    const response = await this.fetchFn(url.toString(), {
      ...init,
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-User-Id": this.resolvedUserId!,
        "X-Auth-Token": this.resolvedAuthToken!,
        ...(init.headers as Record<string, string> ?? {}),
      },
    });
    return this.parseJsonResponse(response);
  }

  private async parseJsonResponse(response: Response): Promise<JsonObject> {
    let payload: JsonObject;
    try {
      const parsed = await response.json();
      payload = asObject(parsed);
    } catch (err) {
      if (err instanceof RocketChatClientError) throw err;
      throw new RocketChatClientError(
        `Rocket.Chat API returned non-JSON response (status ${response.status}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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

function isBlockedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
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



