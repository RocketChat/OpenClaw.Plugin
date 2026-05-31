import * as dotenv from 'dotenv';
import type { RocketChatConfig } from './types/types.js';

dotenv.config();

export function getConfig(): RocketChatConfig {
    const config = {
        url: process.env.RC_URL || "http://localhost:3000",
        authToken: process.env.RC_AUTH_TOKEN || "",
        userId: process.env.RC_USER_ID || "",
        defaultRoom: process.env.DEFAULT_ROOM || "GENERAL",
        webhookSecret: process.env.RC_WEBHOOK_SECRET || "",
    };

    if (!config.authToken) {
        console.warn("[RC Config] Warning: RC_AUTH_TOKEN is not set.");
    }
    if (!config.userId) {
        console.warn("[RC Config] Warning: RC_USER_ID is not set.");
    }

    return config;
}
