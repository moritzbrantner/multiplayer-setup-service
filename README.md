# multiplayer-setup-service

A small, game-agnostic rendezvous service for establishing two-player browser multiplayer sessions. It is intended for static clients hosted on GitHub Pages: the service creates a short-lived room and relays WebRTC setup messages, while gameplay moves to a browser-to-browser `RTCDataChannel` after the peers connect.

## Ownership boundary

This repository owns only multiplayer setup:

- short-lived two-peer rooms;
- host and guest capability tokens;
- room claim and expiry;
- WebSocket signaling transport;
- bounded opaque signaling envelopes;
- peer connect/disconnect notifications.

It deliberately does **not** own chess rules, game state, matchmaking rankings, gameplay traffic, STUN/TURN infrastructure, or an authoritative anti-cheat server.

## Flow

1. The host calls `POST /rooms` and receives a room code plus a private host token.
2. The host shares only the room code, normally as part of a GitHub Pages URL.
3. The guest calls `POST /rooms/:roomId/join` and receives a private guest token. A second guest is rejected.
4. Both browsers open `/rooms/:roomId/connect?role=...` as WebSockets.
5. They relay WebRTC offer/answer and ICE data inside `signal` envelopes.
6. When the `RTCDataChannel` is open, both clients can close their signaling WebSockets. Gameplay no longer needs this service unless the network requires a TURN relay configured by the client.

Rooms expire after 10 minutes by default. Cloudflare Durable Object alarms delete their persisted room state and close any remaining signaling sockets.

## HTTP API

### `GET /health`

Returns the service and protocol version.

### `POST /rooms`

Creates a room.

```json
{
  "roomId": "4W7K9J3Q2MNP",
  "displayCode": "4W7K-9J3Q-2MNP",
  "role": "host",
  "hostToken": "<private capability>",
  "expiresAt": 1788705000000,
  "websocketPath": "/rooms/4W7K9J3Q2MNP/connect"
}
```

The room code is a 60-bit Crockford-style code. The host token is separate and must not be shared.

### `POST /rooms/:roomId/join`

Claims the guest slot and returns a private `guestToken`. A room can be claimed only once.

### `GET /rooms/:roomId`

Returns `waiting` or `paired` plus the expiry time. It never returns capability tokens.

### `GET /rooms/:roomId/connect?role=host|guest`

Requires a WebSocket upgrade. The browser supplies two WebSocket subprotocols: `multiplayer-setup-v1` and `cap.<private capability token>`. The service selects only `multiplayer-setup-v1`, so the capability does not become part of the WebSocket URL. A newer connection with the same role replaces the older one so a browser can recover from a signaling reconnect.

## Signaling protocol

Client messages are intentionally small and generic:

```json
{ "type": "signal", "payload": { "description": { "type": "offer", "sdp": "..." } } }
```

```json
{ "type": "signal", "payload": { "candidate": { "candidate": "..." } } }
```

```json
{ "type": "ping", "nonce": "optional-client-value" }
```

The peer receives the signal with its sender role:

```json
{
  "type": "signal",
  "from": "host",
  "payload": { "description": { "type": "offer", "sdp": "..." } }
}
```

The service also emits `connected`, `peer-connected`, `peer-disconnected`, `pong`, and `error`. Signaling frames are limited to 32 KiB. The service never interprets or persists the signaling payload.

## GitHub Pages client sketch

The WebRTC client remains in the game repository. Its ICE configuration is injected separately so TURN can be added without coupling relay credentials to this service.

```ts
const created = await fetch(`${setupApi}/rooms`, { method: "POST" }).then((response) =>
  response.json(),
);
const socketUrl = new URL(created.websocketPath, setupApi);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
socketUrl.searchParams.set("role", "host");

const signaling = new WebSocket(socketUrl, ["multiplayer-setup-v1", `cap.${created.hostToken}`]);
const peer = new RTCPeerConnection({ iceServers });

// Exchange peer.localDescription and ICE candidates through `signal` envelopes.
// Once the RTCDataChannel opens, close `signaling` and keep gameplay peer-to-peer.
```

## Cloudflare deployment

The implementation uses one SQLite-backed Durable Object per room and the Durable Object WebSocket Hibernation API. `wrangler.jsonc` is the deployment source of truth.

Before production deployment, set `ALLOWED_ORIGINS` to the GitHub Pages origins that may create or join rooms. Localhost origins are enabled for development. `ROOM_TTL_SECONDS` is clamped to 60–3600 seconds.

```sh
bun install
bun run check
bun run dev
bun run deploy
```

A Cloudflare account is required for deployment. No Cloudflare credentials belong in the repository.

## Security properties

- Host and guest tokens are random capabilities; only SHA-256 digests are persisted.
- Room codes are shareable identifiers, not authentication secrets.
- Only two roles can claim a room.
- Signaling messages are bounded and are not persisted.
- Browser origins are allowlisted before HTTP or WebSocket traffic reaches a room.
- Rooms and credentials are short-lived and removed by an alarm.

For ranked or adversarial games, use an authoritative game server instead of trusting either browser. This service is intentionally for setup of casual peer-to-peer sessions.
