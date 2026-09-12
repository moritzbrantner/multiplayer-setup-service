# multiplayer-setup-service

Small, provider-neutral rendezvous/signaling service for browser multiplayer games.

The default deployment target is a basic Hetzner VPS. The service is a single Rust binary and keeps short-lived room/lobby state only in memory. Game rules, gameplay state, and peer-content bytes intentionally stay outside this repository's server authority.

## Ownership boundary

The service owns connection setup and short-lived connectivity capabilities:

- create short-lived two-player rooms and 2–16 participant lobbies;
- issue independent 256-bit participant capabilities and keep only SHA-256 digests in memory;
- authenticate HTTP/WebSocket operations with those capabilities;
- relay bounded opaque WebRTC offer/answer/ICE messages to specific peers;
- report participant connect/disconnect events and replace stale signaling sockets on reconnect;
- provide bounded host-authorized lobby renewal;
- optionally issue short-lived TURN credentials to authenticated lobby participants when coturn shared-secret mode is configured;
- expire abandoned setup state.

It does **not** own:

- game rules, gameplay state, moves, or anti-cheat authority;
- peer-content manifests, hashes, file bytes, or seeder storage;
- STUN/TURN relay infrastructure itself (coturn remains a separately deployed service);
- rankings, accounts, matchmaking, or spectators.

Once WebRTC is established, gameplay uses peer DataChannels rather than routing ordinary gameplay through this service. Optional peer-content distribution remains browser-to-browser; the setup service only carries bounded coordination/signaling.

## Why in-memory state is intentional

Rooms and lobbies exist to establish and recover WebRTC connectivity, not to persist games. Restarting the signaling process can invalidate setup state, but already-established direct peer connections do not depend on the Rust process for gameplay.

```text
GitHub Pages                    Hetzner / provider
┌─────────────────┐            ┌──────────────────────────────┐
│ browser game A  │── setup ──▶│ Caddy (HTTPS / WSS)          │
└────────┬────────┘            │          │                   │
         │                     │          ▼                   │
         │                     │ Rust setup/signaling service │
         │                     └──────────┬───────────────────┘
         │                                │ setup only
         │                     ┌──────────▼───────┐
         └════ WebRTC ═════════│ browser game B  │
       gameplay / optional     └──────────────────┘
          peer content
```

## HTTP API

### Health

`GET /health`

```json
{
  "status": "ok",
  "service": "multiplayer-setup-service",
  "protocolVersion": 1
}
```

### Legacy two-player rooms

- `POST /rooms` — create a host/guest room and return the host capability.
- `POST /rooms/:roomId/join` — claim the guest seat once.
- `GET /rooms/:roomId` — return waiting/paired status and expiry.
- `GET /rooms/:roomId/connect?role=host|guest` — authenticated WebSocket signaling.

WebSocket clients supply both subprotocols:

```text
multiplayer-setup-v1
cap.<host-or-guest-token>
```

The service selects `multiplayer-setup-v1`; the capability subprotocol is used only for authentication.

### Multi-participant lobbies

- `POST /lobbies` — create a 2–16 participant lobby.
- `POST /lobbies/:lobbyId/join` — join and receive an independent participant capability.
- `GET /lobbies/:lobbyId` — public participant-count/expiry metadata without capabilities.
- `POST /lobbies/:lobbyId/renew` — host-capability-authorized bounded lifetime extension.
- `GET /lobbies/:lobbyId/connect?participantId=...` — authenticated targeted WebSocket signaling.
- `POST /lobbies/:lobbyId/turn-credentials` — optional short-lived TURN ICE credentials for an authenticated participant.

Lobby signaling is targeted (`to`/`from`). Topology remains a browser/game choice: full mesh, host-spoke, or separate sparse content-only peers.

## Signaling protocol

Signaling payloads are opaque to the Rust server. A representative client message is:

```json
{"type":"signal","to":"89ABCDEF","payload":{"description":{"type":"offer","sdp":"..."}}}
```

The service also supports bounded ping/pong and participant connection state events. Signaling messages are limited to 32 KiB and are never persisted.

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDR` | `127.0.0.1:8787` | Local socket the Rust process listens on |
| `ROOM_TTL_SECONDS` | `600` | Room/lobby TTL, clamped to 60–3600 seconds |
| `CLEANUP_INTERVAL_SECONDS` | `30` | Expired-state sweep interval |
| `MAX_ROOMS` | `10000` | Hard in-memory room cap |
| `MAX_LOBBIES` | `10000` | Hard in-memory lobby cap |
| `ALLOWED_ORIGINS` | GitHub Pages + localhost patterns | Comma-separated browser origins |
| `TURN_URLS` | unset | Optional comma-separated `turn:` / `turns:` URLs returned to authenticated participants |
| `TURN_SHARED_SECRET` | unset | Optional coturn REST-auth shared secret; server-side only |
| `TURN_CREDENTIAL_TTL_SECONDS` | `600` | Temporary credential lifetime, clamped to 60–3600 seconds |
| `RUST_LOG` | `info` | Runtime log filter |

Set `ALLOWED_ORIGINS` to exact production browser origins. Configure `TURN_URLS` and `TURN_SHARED_SECRET` together; leaving both unset keeps TURN issuance disabled without affecting direct WebRTC.

See [`docs/turn-deployment.md`](docs/turn-deployment.md) for coturn DNS, TLS, firewall, relay-port, credential, and secret-rotation guidance.

## Hetzner deployment

The browser client is served over HTTPS, so the signaling endpoint must use HTTPS/WSS. The simplest setup is a DNS name such as `multiplayer.example.com` pointing at the server, with Caddy terminating TLS for the HTTP/WebSocket setup API.

### 1. Build the binary

The repository pins Rust in `rust-toolchain.toml`.

```bash
cargo build --release --locked
```

The executable is `target/release/multiplayer-setup-service`.

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

Edit `/etc/multiplayer-setup-service.env`, especially `ALLOWED_ORIGINS` and any optional TURN settings, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now multiplayer-setup-service
curl http://127.0.0.1:8787/health
```

### 3. Put Caddy in front

Copy `deploy/Caddyfile.example` into the Caddy configuration and replace the example hostname. Caddy handles normal HTTP and WebSocket upgrades to `127.0.0.1:8787`.

Do not expose port `8787` publicly; expose only the TLS/HTTP ports needed by Caddy. TURN media/relay traffic goes directly to coturn on its configured TURN/TURNS and relay ports rather than through the Caddy HTTP reverse proxy.

## Browser setup

The browser owns `RTCPeerConnection`, game topology, and gameplay semantics. The setup API provides rendezvous/signaling and optional temporary TURN credentials.

For restrictive networks, an authenticated lobby session can fetch and install short-lived TURN configuration with `web/turn-credentials.js`; `ResilientLobbySession` remains direct-first and uses TURN during recovery rather than forcing every peer through a relay.

Optional bulk asset sharing remains separately opt-in. `ContentPeerPool` denies positively identified TURN-relayed bulk sends by default; a game must explicitly choose an allow or byte-rate-limited relay policy.

See [`docs/peer-content-distribution.md`](docs/peer-content-distribution.md) and [`docs/resilience-roadmap.md`](docs/resilience-roadmap.md) for the completed browser/content hardening boundaries.

## Development and validation

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-targets --all-features --locked
cargo build --release --locked
```

Browser modules/tests and performance guardrails run in the same read-only CI validation workflow. `Cargo.lock` is committed, and CI uses the exact Rust `1.98.0` toolchain.

## Final hardening and browser acceptance

See [final hardening](docs/final-hardening.md) for signaling resource limits, addressed-lobby expiry, content-pool reconnection, session-shared optional upload pacing, real-browser direct/TURN acceptance, and the remaining operator-owned deployment checklist.
