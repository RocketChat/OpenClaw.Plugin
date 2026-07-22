# DDP Replacement Plan: `@rocket.chat/ddp-client`s

## Goal
Replace custom DDP implementation (`src/ddp.ts`) with the official `@rocket.chat/ddp-client` SDK.

## Why
- Official RC SDK, actively maintained (1.1.1, 292 versions)
- Built-in TypeScript types, reconnection, auth, streams
- Reduces our maintenance burden

## Dependencies Installed
- `@rocket.chat/ddp-client`
- `@rocket.chat/emitter` (peer dep)

## Migration Steps

### 1. Refactor `src/ddp.ts`
Replace manual WebSocket DDP with:
```ts
import { DDPSDK } from '@rocket.chat/ddp-client';

const sdk = DDPSDK.create(serverUrl);
await sdk.connection.connect();
await sdk.account.loginWithToken({ userId, token });

const stream = sdk.stream('room-messages', roomId, (msg) => {
  onMessage(msg);
});
// later: stream.stop()
```

### 2. Remove Custom DDP Code
Delete or reduce `src/ddp.ts` — no more manual:
- WebSocket connect/handshake
- DDP message serialization (connect, ping, pong, sub, unsub)
- Reconnection logic
- Heartbeat (ping/pong)

### 3. Update `src/gateway.ts`
- Replace `DDPClient` import/usage with new SDK
- Keep `shouldSkipMessage` and `toInboundEvent` (those are RC-message-level, not transport-level)
- The DDP `onMessage` callback stays — just the transport behind it changes

### 4. Update `package.json`
- Move deps from `devDependencies` to `dependencies` if needed
- Remove `"ws"` dep if no longer needed elsewhere

### 5. Types
- `@rocket.chat/ddp-client` provides its own types — evaluate if our `RocketChatMessageRecord` still matches
- Unnecessary to maintain custom DDP types in `types.ts`

### 6. Remove `src/ddp-probe.ts`
The `ddp-probe` CLI script was for debugging our custom DDP — no longer needed.

### 7. Test
- Connect all 7 bot accounts via new SDK
- Verify inbound messages arrive
- Verify reconnection on server restart
- Check audio file uploads still work (file-uploaded messages pass through)
