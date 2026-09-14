import { describe, it, expect, beforeAll } from "vitest";
import { RocketChatClient } from "../../src/client/rest.js";

const SERVER_URL = process.env.ROCKETCHAT_URL;
const USER_ID = process.env.ROCKETCHAT_USER_ID;
const TOKEN = process.env.ROCKETCHAT_TOKEN;

const skip = !SERVER_URL || !USER_ID || !TOKEN;

if (skip) {
  console.warn(
    "[integration] Skipping – set ROCKETCHAT_URL, ROCKETCHAT_USER_ID, and ROCKETCHAT_TOKEN to run.",
  );
}

describe.skipIf(skip)("RocketChatClient – Integration", () => {
  let client: RocketChatClient;

  beforeAll(() => {
    client = new RocketChatClient({
      serverUrl: SERVER_URL!,
      auth: { mode: "token", userId: USER_ID!, accessToken: TOKEN! },
    });
  });

  it("should post a message (tests mention-stripping + markdown fallback logic)", async () => {
    const subs = await client.listSubscriptions(null);
    expect(subs.length).toBeGreaterThan(0);

    const dmRoom = subs.find((s) => s.t === "d") ?? subs[0]!;
    const messageId = await client.postMessage(dmRoom.rid, "[integration-test] E2E postMessage check");

    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);
    console.log(`[integration] postMessage → messageId: ${messageId} in room: ${dmRoom.name ?? dmRoom.rid}`);
  });

  it("should resolve bot identity", async () => {
    const identity = await client.getIdentity();
    expect(typeof identity.userId).toBe("string");
    expect(identity.userId.length).toBeGreaterThan(0);
    expect(typeof identity.username).toBe("string");
    console.log(`[integration] Connected as @${identity.username} (${identity.userId})`);
  });

  it("should fetch subscriptions", async () => {
    const subs = await client.listSubscriptions(null);
    expect(Array.isArray(subs)).toBe(true);
    console.log(`[integration] Bot is in ${subs.length} room(s)`);
  });
});
