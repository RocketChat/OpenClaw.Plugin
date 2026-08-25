import type { RocketChatClient } from "../client/rest.js";

export type ClientEntry = { client: RocketChatClient; generation: number };

export const activeClients = new Map<string, ClientEntry>();
export const connectionStatus = new Map<string, string>();
