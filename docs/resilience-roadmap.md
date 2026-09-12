# Resilient multiplayer foundation implementation plan

This roadmap keeps `multiplayer-setup-service` responsible for rendezvous/signaling and optional peer-content coordination only. Gameplay state remains game-owned, peers remain untrusted byte transports, and bulk content must never outrank gameplay traffic.

## Status

The repository implementation described by this roadmap is complete.

- reconnect, initial-setup cancellation, lobby renewal, and ICE recovery are implemented and fail closed;
- direct-first TURN fallback uses short-lived coturn-compatible credentials issued only to authenticated lobby participants;
- bulk peer-content transfer detects positively identified relay paths and denies them by default, with explicit allow/capped policies available to games;
- persistent verified chunks are release-namespaced, re-verified on hydration, bounded by a durable byte budget, and evicted with deterministic LRU policy under storage pressure;
- execution-critical manifests use Ed25519 signatures against game-pinned keys, with overlapping-key rotation and explicit revocation support.

Provisioning a production coturn instance, DNS, certificates, firewall rules, and secret rotation is an operator deployment responsibility rather than remaining repository implementation work. See `turn-deployment.md`.

## Slice 1 — reconnect, renew, and ICE recovery — completed

Goal: survive transient signaling and peer-transport failures without requiring a new game session.

Implemented:

- an explicit `LobbySession` reconnect state machine with bounded deterministic retry delays;
- reuse of the existing participant capability and participant identity during reconnect;
- idempotent roster reconciliation after reconnect;
- ICE restart before transport recovery is exhausted;
- bounded recovery attempts with game-visible state events;
- host-capability-authorized lobby renewal with a bounded lifetime cap;
- initial `host()`/`join()` lifecycle cancellation so `close()` or a failed first signaling socket cannot leave a hidden reconnecting session;
- deterministic coverage for reconnect, setup cancellation, ICE recovery, and renewal authorization/expiry.

## Slice 2 — TURN fallback policy — completed

Goal: make connectivity robust across restrictive NAT/firewall environments while retaining direct WebRTC when available.

Implemented:

- game/session-owned ICE configuration with direct-first behavior;
- `POST /lobbies/:lobbyId/turn-credentials`, authenticated by the existing participant capability;
- short-lived coturn REST-auth credentials without exposing the coturn shared secret to static browser bundles;
- browser credential fetch/refresh support wired into `ResilientLobbySession.setTurnIceServers()`;
- TURN-enabled ICE restart during recovery instead of forcing all traffic through a relay;
- selected-candidate-pair inspection for the content-only peer pool;
- relay-aware bulk policy: deny by default, or explicit allow/byte-rate cap;
- coturn deployment, TLS/UDP/TCP, firewall, credential lifetime, and secret-rotation documentation;
- browser and black-box HTTP tests for credential boundaries and relay policy.

## Slice 3 — persistent verified P2P cache — completed

Goal: persist only cryptographically verified chunks across page reloads and sessions.

Implemented:

- an IndexedDB persistence adapter plus an in-memory test adapter;
- persistence only after exact size + SHA-256 verification against the trusted manifest;
- namespace isolation by game id and release/version;
- fail-closed re-verification during hydration with corrupt/stale entry eviction;
- a 256 MiB default durable budget with configurable `maxBytes`;
- deterministic LRU eviction and `storageUsage()` reporting;
- a game-visible `onStoragePressure` callback with requested/persisted/evicted byte counts;
- preservation of verified in-memory chunks when durable retention evicts them;
- explicit player seeder opt-in before cached verified chunks are advertised;
- coverage for reload resume, corruption rejection, release isolation, idempotence, LRU refresh, and bounded eviction.

## Slice 4 — signed manifests — completed

Goal: make release authenticity independent of transport peers and stronger than origin-only trust.

Implemented:

- deterministic canonical signing bytes and an Ed25519 signature envelope;
- SHA-256 chunk/file hashes as the byte-integrity authority;
- one or more public verification keys pinned by game configuration, never accepted from peers or lobby state;
- required signatures for execution-critical `logic` content, with explicit asset-only migration support for unsigned v1 manifests;
- signatures bound to the complete trusted manifest contents;
- deterministic key IDs, overlapping trusted keys for rotation, and an explicit `revokedKeyIds` deny-list that overrides pinned trust;
- tests for valid signatures, modified manifests, unknown/revoked keys, rotation overlap, and unsigned-logic rejection.

## Invariants after completion

All hardening remains additive and preserves the original boundaries:

1. signaling payloads stay bounded and opaque to the Rust rendezvous service;
2. gameplay rules and state mutation remain game-owned;
3. peer-content distribution remains game opt-in and player seeding remains separately opt-in;
4. peers never become authorities for manifests, hashes, logic, or release keys;
5. TURN infrastructure remains external and its shared secret remains server-side;
6. file bytes remain peer-to-peer and never pass through the setup service;
7. gameplay connectivity takes priority over optional bulk content transfer.
