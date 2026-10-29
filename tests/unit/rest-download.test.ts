import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RocketChatClient } from "../../src/client/rest.js";

const VCARD = "BEGIN:VCARD\nVERSION:3.0\nFN:Test Contact\nEND:VCARD\n";
const ATTACHMENT_URL = "https://chat.example.com/file-upload/test/contact.vcf";

describe("RocketChatClient attachment download MIME validation", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeAll(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = await mkdtemp(join(tmpdir(), "rocketchat-vcard-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterAll(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  function clientWithResponse(contentType: string, contentLength?: number): RocketChatClient {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (contentLength !== undefined) {
      headers["Content-Length"] = String(contentLength);
    }
    return new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "token", userId: "test-user", accessToken: "test-token" },
      fetch: async () => new Response(VCARD, { status: 200, headers }),
    });
  }

  it.each(["text/vcard", "text/x-vcard", "TEXT/X-VCARD; charset=utf-8"])(
    "downloads a vCard returned as %s",
    async (contentType) => {
      const client = clientWithResponse(contentType);
      const filePath = await client.downloadAttachmentToTempFile(ATTACHMENT_URL, {
        fileName: "contact.vcf",
      });
      expect(await readFile(filePath, "utf8")).toBe(VCARD);
    },
  );

  it("preserves existing application attachment support", async () => {
    const client = clientWithResponse("application/octet-stream");
    const filePath = await client.downloadAttachmentToTempFile(ATTACHMENT_URL);
    expect(await readFile(filePath, "utf8")).toBe(VCARD);
  });

  it.each(["text/plain", "text/html", "text/x-vcard-untrusted"])(
    "continues rejecting unsupported text type %s",
    async (contentType) => {
      const client = clientWithResponse(contentType);
      await expect(client.downloadAttachmentToTempFile(ATTACHMENT_URL)).rejects.toThrow(
        "attachment download refused: unsupported content type",
      );
    },
  );

  it("keeps the existing 20 MB download limit", async () => {
    const client = clientWithResponse("text/x-vcard", 20 * 1024 * 1024 + 1);
    await expect(client.downloadAttachmentToTempFile(ATTACHMENT_URL)).rejects.toThrow(
      /exceeds max/,
    );
  });
});
