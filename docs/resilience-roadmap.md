# Resilient multiplayer foundation implementation plan

This roadmap keeps `multiplayer-setup-service` responsible for rendezvous/signaling and optional peer-content coordination only. Gameplay state remains game-owned, peers remain untrusted byte transports, and bulk content must never outrank gameplay traffic.

## Status

The reconnect/ICE recovery, TURN fallback, persistent verified cache, and signed-manifest foundations are implemented. Lobby renewal completes the remaining continuity item in Slice 1: only the existing host participant capability may extend signaling lifetime, each renewal is bounded, and renewal never persists or transfers gameplay state.

## Slice 1 — reconnect, renew, and ICE recovery

Goal: survive transient signaling and peer-transport failures without requiring a new game session.

- Add an explicit `LobbySession` reconnect state machine with bounded exponential backoff and jitter-free deterministic retry delays for testability.
- Reuse the existing participant capability to reconnect while the lobby is still valid; never mint a second participant identity during an automatic reconnect.
- Rebuild the roster from the server `connected` event and reconcile missing/stale peer links idempotently.
- Attempt `RTCPeerConnection.restartIce()` on failed/disconnected peers before replacing the peer connection.
- Bound reconnect attempts and expose state events so the game can present recovery/failure UI.
- Add a lobby-renew protocol guarded by the host participant capability, with a bounded extension policy and no gameplay persistence.
- Tests: signaling close/reconnect, duplicate reconnect suppression, failed peer ICE restart, renewal authorization/expiry.

## Slice 2 — TURN fallback policy

Goal: make connectivity robust across restrictive NAT/firewall environments while retaining direct WebRTC when available.

- Keep ICE server configuration game-owned.
- Add an optional TURN credential endpoint contract that returns short-lived credentials without exposing deployment secrets to static GitHub Pages bundles.
- Add a browser `icePolicy` helper: direct-first, then TURN-enabled ICE restart after a bounded connectivity timeout.
- Ensure bulk content can be disabled or bandwidth-capped when the selected candidate pair is relayed.
- Document a Hetzner `coturn` deployment with TLS/UDP/TCP firewall requirements and ephemeral credentials.
- Tests: direct path unchanged, TURN fallback trigger, no permanent credential persistence, relay-aware content policy.

## Slice 3 — persistent verified P2P cache

Goal: persist only cryptographically verified chunks across page reloads and sessions.

- Introduce a storage adapter boundary with an IndexedDB/OPFS-backed implementation and an in-memory test implementation.
- Persist chunks only after exact size + SHA-256 verification against the trusted manifest.
- Namespace cache entries by game id, release/version fingerprint, file path, and chunk index.
- Re-verify metadata on cache load; corrupt or stale entries are evicted fail-closed.
- Add quota/budget controls, LRU-style eviction, and a game-visible storage-pressure signal.
- Preserve optional seeding: cached chunks are advertised only after explicit player seeder opt-in.
- Tests: reload resume, corrupt cache rejection, release isolation, idempotent writes, bounded eviction.

## Slice 4 — signed manifests

Goal: make release authenticity independent of transport peers and stronger than origin-only trust.

- Define `multiplayer-content-manifest-v2` with canonical signing bytes and an Ed25519 signature envelope.
- Keep SHA-256 chunk/file hashes as the byte-integrity authority.
- Pin one or more trusted public verification keys in game configuration; never accept keys supplied by peers or lobby state.
- Require a valid signature for `logic` content; optionally allow HTTPS-only v1 manifests for non-executable assets during migration.
- Bind the signature to game id, version, paths, sizes, roles, chunk sizes, and hashes.
- Add deterministic key-id handling for rotation and reject unknown/revoked keys.
- Tests: valid signature, modified manifest rejection, unknown key rejection, key rotation, logic fail-closed behavior.

## Integration order

1. Slice 1 establishes continuity semantics required by all later work.
2. Slice 2 adds network-path fallback without changing gameplay authority.
3. Slice 3 makes verified content resumable across browser sessions.
4. Slice 4 strengthens release authenticity and execution-critical content trust.

Each slice should remain independently mergeable and must keep signaling payloads bounded, content sharing opt-in, and the Rust service ignorant of gameplay state and file bytes.
