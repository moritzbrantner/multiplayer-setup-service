# multiplayer-setup-service

Small, provider-neutral rendezvous/signaling service for browser multiplayer games.

The default deployment target is a basic Hetzner VPS. The service is a single Rust binary and keeps short-lived room/lobby state only in memory. Game rules, gameplay state, and peer-content bytes intentionally stay outside this repository's server authority.

## Product direction: reusable multiplayer lobby

Owner-approved steering decision (2026-10-12, question 1): **B — reusable multiplayer lobby**.

Games should be able to reuse a common player-facing lobby experience: create a game, invite friends, view participants, indicate readiness, and start together. This experience is shared across games rather than independently reinvented for each title.

The reusable lobby interface belongs in browser-side reusable components; this Rust service remains the short-lived rendezvous/control plane. This decision does **not** authorize accounts, public game discovery, matchmaking, shared gameplay authority, or server-side game rules. Owner-approved steering decision (2026-10-12, question 2): **B — each player marks themselves ready; when all participants are ready, the host may manually start the game.** Readiness alone never automatically starts the game. The host retains start control.

Owner-approved steering decision (2026-10-12, question 3): **B — temporarily reserve disconnected participants' lobby slots.** Show the affected participant as disconnected and preserve their place for reconnection during a bounded recovery window. While their slot is reserved and disconnected, the game cannot start, even if everyone else is ready. Owner-approved steering decision (2026-10-12, question 4): **B — reserve the disconnected participant's place for two minutes (120 seconds).** Reconnection within that window restores the original slot. Owner-approved steering decision (2026-10-12, question 5): **B — after the 120-second recovery window expires, keep the disconnected participant listed and let the host either remove them or continue waiting.** Expiry alone never ejects the participant or closes the lobby. The host cannot start while retaining a disconnected participant; removing them permits readiness to be evaluated for the remaining participants. Owner-approved steering decision (2026-10-12, question 6): **A — a disconnected player can reconnect to the original slot even after 120 seconds, without fresh host approval, provided the host has not removed that participant and the lobby still exists.** Once the host removes the participant, the old slot cannot be reclaimed through reconnection. Owner-approved steering decision (2026-10-12, question 7): **B — if the lobby host remains disconnected when the 120-second recovery window expires, automatically transfer lobby-host control to another connected participant.** This only transfers lobby privileges (such as Start and removal), not the game's simulation authority or active gameplay hosting. Owner-approved steering decision (2026-10-12, question 8): **A — select the connected participant who joined earliest as replacement lobby host.** Disconnected participants are not eligible; among connected participants the join order determines succession, not measured network quality or randomness. Owner-approved steering decision (2026-10-12, question 9): **A — after automatic succession, the replacement remains lobby host when the original host reconnects.** The returning former host resumes as an ordinary participant and does not automatically regain host privileges. These rules concern lobby authority only. These decisions do not establish permanent reservation or server-side gameplay authority.

Owner-approved steering decision (2026-10-13, question 10): **B — whenever a new participant joins a lobby before the game starts, reset every participant's ready status to not ready, including the host and previously ready participants.** The joining participant also starts not ready. The host cannot start until everyone in the updated group explicitly marks themselves ready again. This decision applies to new joins, not automatically to reconnecting to an existing reserved slot.

Owner-approved steering decision (2026-10-13, question 11): **B — when a participant explicitly leaves or the lobby host removes a participant before the game starts, reset every remaining participant's ready status to not ready.** The host and all remaining players must explicitly confirm readiness again for the changed group before the host can start. A temporary disconnection with a reserved slot is not an explicit leave or removal; reconnecting to that slot is handled separately in question 12.

Owner-approved steering decision (2026-10-13, question 12): **B — when a disconnected participant reconnects to their existing reserved lobby slot, reset only that returning participant's ready status to not ready.** The returning player must explicitly mark themselves ready again before the host can start. Other participants keep their existing ready statuses; reconnection is not treated as a new join or a membership change. Starting remains blocked while the participant is disconnected. This applies whether reconnection occurs within 120 seconds or later while the host still retains the slot.

Owner-approved steering decision (2026-10-13, question 13): **A — if the lobby host explicitly leaves before the game starts, transfer lobby-host control immediately to the earliest-joined remaining connected participant.** Do not wait for the 120-second disconnection recovery timer or close the lobby merely because its host left. Because the host's departure changes membership, reset all remaining participants to not ready under question 11; the new host can Start only after everyone still present confirms readiness. This changes lobby control only, never game simulation authority. If no connected participants remain, the behavior is not settled by this decision.

Owner-approved steering decision (2026-10-13, question 14): **B — each game decides whether new participants may join an already-started game.** A game that supports joining in progress may admit new participants after Start; a game that does not support it closes new-player admission at Start. The reusable lobby must respect the integrating game's admission policy rather than imposing a universal always-open or always-closed rule. This does not give the setup service authority over gameplay rules, state synchronization, or how a late entrant becomes playable; those stay game-owned. Pre-start readiness-reset rules do not restart a running game when its game-specific policy admits someone late.

Owner-approved steering decision (2026-10-13, question 15): **C — each integrating game chooses whether a valid invitation permits immediate lobby admission or requires explicit approval by the current lobby host.** For immediate-admission games, an invited player joins directly if otherwise eligible; for approval-required games, they request entry and remain unadmitted until the host accepts (or are declined if rejected). The shared lobby experience must support both paths, and admission must be enforced at the actual service boundary rather than only by a browser button. A pending request must not receive participant privileges or trigger the ready-status reset for a newly joined player until accepted. Invitation URLs and pending-request surfaces must not expose participant capabilities or other secrets. This choice does not require player accounts or delegate game rules to the setup service; it is distinct from each game's late-join-after-Start policy in question 14. Whether an approved player receives automatic admission to future sessions, and how the host is notified of requests, remain separate choices.

Owner-approved steering decision (2026-10-13, question 16): **A — lobby invitations are reusable.** The same shareable invitation link may be used by multiple distinct invited players while the lobby remains open and has available capacity. Admission through that link still obeys the integrating game's immediate-vs-host-approved admission mode (question 15), its in-progress join policy after Start (question 14), and the lobby participant limit. When full, new participants are not admitted; after the lobby closes, the link can no longer admit anyone. An invitation contains only public routing/join information, never participant capability or TURN credentials. Whether admission resumes via the same link if capacity later becomes available, and whether a host may revoke or replace a shared invitation without closing the lobby, are not decided here.

Owner-approved steering decision (2026-10-13, question 17): **C — the current lobby host can invalidate the existing reusable invitation link and generate a replacement without closing the lobby.** Once regenerated, the previous link may no longer admit new participants or grant new join requests; new invitations use the replacement link. Players already admitted retain their lobby membership and connections, and regenerating the invitation does not itself reset their ready statuses. The replacement still obeys lobby capacity and each game's admission approval (question 15) and in-progress join (question 14) policies. A revoked link must be rejected by the actual admission path, not merely hidden in the browser interface. Invitation links must never carry participant capabilities or TURN credentials. Owner-approved steering decision (2026-10-13, question 18): **A — regenerating the invitation automatically cancels every pending join request submitted through the previous link.** A canceled request can no longer be accepted or used to gain admission; the requesting guest must use the replacement invitation to submit a new request. The requester should see that their request is no longer valid, not remain waiting indefinitely. Participants already admitted before regeneration keep their membership, connections, and readiness; cancellation of pending requests does not trigger a membership or readiness reset. Approval and regeneration must respect one definitive ordering: if approval finished first, the guest is already admitted; if regeneration invalidated the link first, an attempted approval of that pending request must fail. The current host's approval mode and late-join rules continue to apply to requests made with the replacement link.

Owner-approved steering decision (2026-10-13, question 19): **A — when a full lobby later has a participant slot available again, its current valid reusable invitation automatically permits new admission attempts without requiring the host to reopen joining.** The existing invitation link remains valid; invitations explicitly revoked or replaced under question 17 stay invalid and must never reactivate when capacity changes. If the integrating game requires host approval (question 15), a guest may request admission but does not join until accepted; if it forbids joining after Start (question 14), freeing a slot does not override that rule. A reserved disconnected participant still occupies their slot until formally removed (questions 3–6). Actual capacity, security, and expiry limits remain enforced on the service admission path. A successful new join before Start resets readiness as approved in question 10; a rejected attempt or pending request does not.

Owner-approved steering decision (2026-10-13, question 20): **B — the current lobby host may voluntarily transfer lobby-host control to a chosen connected participant without leaving the lobby.** The previous host stays present as an ordinary participant; the recipient becomes the sole current lobby host and gains host-only lobby-management privileges, while the previous host no longer has those privileges. The transfer is explicitly initiated by the current host and does not wait for a disconnection timeout or change any game's authoritative simulation host. Other participants cannot transfer host control themselves, and a disconnected/nonparticipant target is not eligible. Owner-approved steering decision (2026-10-13, question 21): **A — a voluntary lobby-host transfer without a participant leaving preserves every participant's existing ready status.** If all eligible participants were ready before the transfer and nothing else blocks starting, the new host can deliberately Start immediately; the previous host can no longer Start. No automatic start occurs. This does not alter the readiness reset on an actual departure, arrival, or reconnection (questions 10–12), nor does it transfer gameplay simulation authority.

### Mobile and cross-device multiplayer

Owner-approved steering decision (2026-10-13, mobile question F1): **A — smartphones have full multiplayer lobby parity with desktop browsers.** A player using a supported mobile browser can create and host a lobby, join through an invitation, view and manage participants, approve or reject join requests when the game enables approval, control their own ready status, deliberately start a ready lobby as host, and participate in the same host handover and reconnection rules as a desktop player. The shared multiplayer setup experience must not categorically exclude mobile devices from lobby hosting or leadership. Individual games remain responsible for whether their gameplay and input controls are usable on mobile devices; this is not a promise that every game's gameplay supports touch. Lobby control is separate from authoritative gameplay simulation or transport topology. Mobile acceptance requires actual cross-device browser evidence, not touch emulation alone.


Owner-approved steering decision (2026-10-13, mobile question F2): **A — every reusable lobby presents a scannable QR code alongside its invitation link and join code.** The QR code encodes exactly the same current, shareable, public invitation URL as the link; scanning it with a phone's normal camera opens that game's browser join flow without typing. Joining from the scanned URL must respect the game's host-approval policy (question 15), capacity and lobby availability (questions 16 and 19), and after-Start admission policy (question 14). When a host regenerates an invitation (questions 17–18), the displayed QR updates to the new link and any previously photographed or printed QR for the old link remains invalid for new admission. No QR code may contain participant capability tokens, TURN credentials, or other secrets. Keep direct link sharing and manual code entry available as alternatives; this decision does not require an in-app camera scanner or introduce a separate QR-only admission protocol.

Owner-approved steering decision (2026-10-13, mobile question F3): **A — when a mobile player's browser transitions between Wi-Fi and cellular networks during a multiplayer session, the shared networking client automatically attempts to recover its WebRTC/signaling connectivity without requiring the player to press Reconnect.** Recovery reuses the existing participant identity and authenticated lobby membership while they remain valid, and must not silently create a duplicate participant or request new-player admission. The client exposes connection and recovery state to the game so it can communicate interruption and manage gameplay pause, catch-up, or state resynchronization according to the game's own rules. Existing lobby reconnection reservations and host succession decisions (questions 3–9 and 12) continue to apply, including possible reassignment of lobby-host privileges if the former host is absent beyond the recovery window. Do not promise uninterrupted gameplay, indefinite automatic retries, or connectivity when the browser or operating system prevents networking; on unsuccessful recovery, report a clear failure instead of silently claiming reconnection. Physical-device Wi-Fi-to-cellular and cellular-to-Wi-Fi acceptance remains necessary; touch emulation and loopback TURN tests do not establish it. The setup service remains rendezvous/control-plane only and does not acquire gameplay state or simulation authority.

Owner-approved steering decision (2026-10-13, mobile question F4): **B — support an explicit, player-initiated handoff of an existing multiplayer session from one device to another.** For example, a player on a desktop can initiate transfer to their phone; once the transfer completes, the phone takes over the **same logical participant identity, existing lobby slot and current lobby role**, while the desktop relinquishes its connection and participant/host privileges. Handoff is not a new lobby join, must not create a second simultaneous controller of one participant, and must not grant takeover merely because someone possesses a normal invitation link. Never place participant capability tokens, TURN credentials, or other handoff authorization secrets inside shareable transfer links, QR codes, logs, or browser-visible diagnostics. The setup service may coordinate bounded, authenticated transfer of membership/connection authority but must not store or migrate gameplay state, simulation authority, or game rules: each consuming game remains responsible for any gameplay state transfer or synchronization needed to continue play. Owner-approved steering decision (2026-10-13, mobile question F5): **A — the original controlling device must explicitly approve the receiving device's proposed takeover before handoff completes.** Initiating handoff and pairing the receiving device are not sufficient authorization by themselves; the original device displays a clear confirmation for this pending transfer, and only after its affirmative approval may the new device become the sole authorized controller of the same participant. Before approval, the original device remains in control and the proposed destination has no participant or host privileges. Rejection/cancellation must leave authority with the original device, without spawning a second participant. The original-device approval must be authenticated and cannot be bypassed using an ordinary lobby invitation, a shareable link, or a QR code; no participant capability or TURN credential may appear in those artifacts or browser-visible diagnostics. The participant's readiness status during a completed device handoff remains an unresolved product choice; the unavailable-original-device case is answered separately by mobile F6. This decision does not approve an unconfirmed takeover path.

Owner-approved steering decision (2026-10-13, mobile question F6): **A — no unconfirmed cross-device takeover when the original controlling device is unavailable.** If the original device crashes, is offline, or otherwise cannot explicitly approve a pending transfer, the destination device cannot reclaim that existing participant identity, role, or slot through device handoff. An ordinary invitation may let the player join as a **new, separate participant** only if the current lobby has capacity and the integrating game's admission, approval, and late-join policies allow it; this does not restore the old participant's privileges or bypass reserved slots. Existing reconnection/reservation and host-succession rules remain authoritative for the original participant. No account-based identity recovery, preauthorized bypass, or host-approved takeover is implied. The readiness behavior after a successful explicitly approved handoff remains to be decided.

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
- `PUT /lobbies/:lobbyId/game-reference` — register an immutable public Scrabble match reference using the host Bearer capability and JSON `{participantId, application: "scrabble", matchId}`. Canonical match IDs use `b_<16 lowercase hex>_<32 lowercase hex>`; identical retries succeed, replacements return `409 game-reference-conflict`.
- `GET /lobbies/:lobbyId/game-reference` — read only `{application, matchId}` publicly, or `409 game-not-bound` before registration. Expired/missing lobbies return 404. Renewal preserves the reference; service restart discards it with the lobby.
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

For restrictive networks, an authenticated lobby session can fetch and install short-lived TURN configuration with `web/turn-credentials.ts`; `ResilientLobbySession` remains direct-first and uses TURN during recovery rather than forcing every peer through a relay.

Optional bulk asset sharing remains separately opt-in. `ContentPeerPool` denies positively identified TURN-relayed bulk sends by default; a game must explicitly choose an allow or byte-rate-limited relay policy.

See [`docs/peer-content-distribution.md`](docs/peer-content-distribution.md) and [`docs/resilience-roadmap.md`](docs/resilience-roadmap.md) for the completed browser/content hardening boundaries.

### Scrabble launcher

Open `/scrabble.html` (linked from the homepage), create a lobby, share its
Invite link, and open the Scrabble board. The trusted Pages board creates the
actual game and reports its public match ID to the launcher. Guests open the
invite and choose Open Scrabble player; if the board is still creating the game,
choose Check for game when it is ready. A host may also open a player screen.

The launcher trusts only its opened board window at
`https://moritzbrantner.github.io`, the same setup session, and a canonical match
ID. Host credentials stay in launcher memory. Reloading loses host authority and
resolves the existing reference. Repeated Open reuses the board; a closed board
must be recovered through its original address rather than silently creating
another game. Scrabble owns its creation nonce, gameplay and match lifetime.
Canonical Scrabble match invitations continue independently of setup-lobby
expiry.

Production uses the same-origin setup API. A `setupApi` query override is honored
only on loopback for local acceptance. Build the browser assets with
`bun run --cwd web build`; deploy its generated JavaScript alongside HTML/CSS.
The independent boundary contract and its gameplay/live-verification limits are
in [Scrabble launcher acceptance](docs/scrabble-launcher-acceptance.md).

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
