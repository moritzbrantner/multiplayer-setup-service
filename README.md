# multiplayer-setup-service

Small, provider-neutral rendezvous/signaling service for browser multiplayer games.

The first deployment target is a basic Hetzner VPS. The service is a single Rust binary and keeps short-lived room state only in memory. Game rules and gameplay traffic are intentionally outside this repository.

## Ownership boundary

The service owns only connection setup:

- create a short-lived two-player room;
- claim the guest seat once;
- issue separate host/guest capability tokens;
- keep only SHA-256 token digests in memory;
- authenticate WebSocket signaling connections;
- relay bounded opaque WebRTC offer/answer/ICE messages;
- report signaling peer connect/disconnect events;
- replace stale signaling sockets on reconnect;
- expire abandoned rooms.

It does **not** own:

- chess or other game rules;
- gameplay state or moves;
- STUN/TURN infrastructure;
- rankings, accounts, matchmaking, spectators, or anti-cheat state.

Once the browser `RTCDataChannel` is open, the game should stop using this service for gameplay.

## Why in-memory state is intentional

A room exists only long enough to establish WebRTC. Restarting the signaling process can invalidate rooms that have not connected yet, but it does not interrupt games whose peer-to-peer DataChannel is already established.

That keeps the first deployment very small:

```text
GitHub Pages                    Hetzner VPS
┌─────────────────┐            ┌──────────────────────────┐
│ browser game A  │── setup ──▶│ Caddy (HTTPS / WSS)      │
└────────┬────────┘            │          │               │
         │                     │          ▼               │
         │                     │ Rust signaling service   │
         │                     └──────────┬───────────────┘
         │                                │ setup only
         │                     ┌──────────▼───────┐
         └════ WebRTC ═════════│ browser game B  │
              gameplay         └──────────────────┘
```

A future Cloudflare, Fly.io, managed WebSocket, or multi-instance backend can implement the same public protocol without changing game semantics.

## HTTP API

### `GET /health`

Returns:

```json
{
  "status": "ok",
  "service": "multiplayer-setup-service",
  "protocolVersion": 1
}
```

### `POST /rooms`

Creates a room and returns the host capability:

```json
{
  "roomId": "0123ABCDEFGH",
  "displayCode": "0123-ABCD-EFGH",
  "role": "host",
  "hostToken": "<64 hex characters>",
  "expiresAt": 1788700000000,
  "websocketPath": "/rooms/0123ABCDEFGH/connect"
}
```

### `POST /rooms/:roomId/join`

Claims the one guest seat and returns a guest capability. A second join fails with `409 room-full`.

### `GET /rooms/:roomId`

Returns `waiting` or `paired` plus the expiration timestamp.

### `GET /rooms/:roomId/connect?role=host|guest`

WebSocket upgrade endpoint.

The browser supplies these WebSocket subprotocols:

```text
multiplayer-setup-v1
cap.<host-or-guest-token>
```

The service selects `multiplayer-setup-v1`; the capability subprotocol is used only for authentication.

## Signaling protocol

Client messages:

```json
{"type":"signal","payload":{"description":{"type":"offer","sdp":"..."}}}
```

```json
{"type":"ping","nonce":"optional-client-value"}
```

Peer-forwarded signal:

```json
{
  "type": "signal",
  "from": "host",
  "payload": {
    "description": {
      "type": "offer",
      "sdp": "..."
    }
  }
}
```

The service also emits `connected`, `peer-connected`, `peer-disconnected`, `pong`, and `error`.

Signaling messages are limited to 32 KiB. Their payload is opaque and is never persisted.

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDR` | `127.0.0.1:8787` | Local socket the Rust process listens on |
| `ROOM_TTL_SECONDS` | `600` | Room lifetime, clamped to 60–3600 seconds |
| `CLEANUP_INTERVAL_SECONDS` | `30` | Expired-room sweep interval |
| `MAX_ROOMS` | `10000` | Hard in-memory room cap |
| `ALLOWED_ORIGINS` | GitHub Pages + localhost patterns | Comma-separated browser origins |
| `RUST_LOG` | `info` | Runtime log filter |

For production, set `ALLOWED_ORIGINS` to the exact GitHub Pages/custom origins that should use the service.

## Hetzner deployment

The GitHub Pages client is served over HTTPS, so the signaling endpoint must also be HTTPS/WSS. The simplest setup is a DNS name such as `multiplayer.example.com` pointing at the Hetzner server, with Caddy terminating TLS.

### 1. Build the binary

The repository pins Rust in `rust-toolchain.toml`.

```bash
cargo build --release --locked
```

The resulting executable is:

```text
target/release/multiplayer-setup-service
```

### 2. Install it

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin multiplayer-setup || true
sudo install -d -o root -g root -m 0755 /opt/multiplayer-setup-service
sudo install -o root -g root -m 0755 \
  target/release/multiplayer-setup-service \
  /opt/multiplayer-setup-service/multiplayer-setup-service

sudo install -o root -g root -m 0644 \
  deploy/multiplayer-setup-service.service \
  /etc/systemd/system/multiplayer-setup-service.service

sudo install -o root -g root -m 0600 \
  deploy/multiplayer-setup-service.env.example \
  /etc/multiplayer-setup-service.env
```

Edit `/etc/multiplayer-setup-service.env`, especially `ALLOWED_ORIGINS`.

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now multiplayer-setup-service
curl http://127.0.0.1:8787/health
```

### 3. Put Caddy in front

Install Caddy using the package instructions for the server distribution, copy `deploy/Caddyfile.example` into the Caddy configuration, and replace `multiplayer.example.com` with the real DNS name.

Caddy's reverse proxy handles normal HTTP and WebSocket upgrades on the same upstream:

```text
127.0.0.1:8787
```

After reloading Caddy, verify:

```text
https://multiplayer.example.com/health
```

Do not expose port `8787` publicly; keep it bound to loopback and expose only ports 80/443 through Caddy/firewall rules.

## Browser setup

The game repository owns the `RTCPeerConnection`. The setup service URL is just an injected endpoint:

```ts
const created = await fetch(`${setupApi}/rooms`, { method: "POST" }).then((response) =>
  response.json(),
);

const socketUrl = new URL(created.websocketPath, setupApi);
socketUrl.protocol = "wss:";
socketUrl.searchParams.set("role", "host");

const signaling = new WebSocket(socketUrl, [
  "multiplayer-setup-v1",
  `cap.${created.hostToken}`,
]);

const peer = new RTCPeerConnection({ iceServers });

// Exchange localDescription and ICE candidates through `signal` envelopes.
// Once peer.connectionState/DataChannel is ready, gameplay uses WebRTC directly.
```

TURN credentials belong in the game's ICE configuration, not in this signaling service.

## Development and validation

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-targets --all-features --locked
cargo build --release --locked
```

The lockfile is committed and CI uses the exact Rust `1.98.0` toolchain.
