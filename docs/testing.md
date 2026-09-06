# Multiplayer testing strategy

The multiplayer foundation is validated at three complementary layers.

## Browser model and session tests

Dependency-free Node tests exercise the pure deterministic arena model and the WebRTC lobby-session coordinator with fake browser transports. They cover mesh and host-spoke edge construction, targeted offer initiation, channel readiness, reliable and freshness-first message envelopes, stale realtime packet rejection, teardown, deterministic input sequencing, topology edge counts, and bootstrap snapshot rules.

These tests intentionally keep game calculation separate from signaling. The input-only model must reject malformed, duplicate, stale, diagonal, and non-member input commands deterministically.

## Rust state and protocol tests

Rust tests exercise room/lobby capacity, expiry, concurrent joins, capability isolation, reconnect replacement, roster semantics, targeted routing, protocol boundaries, and fail-closed unknown operations. Concurrency tests verify that a two-player room has exactly one guest claimant and that a 16-player lobby never exceeds its participant limit under simultaneous joins.

## Black-box service tests

The compiled Rust binary is launched on a temporary loopback port and exercised over HTTP. These tests protect both the additive multi-participant `/lobbies` API and the legacy two-player `/rooms` contract, including the rule that public lobby status never exposes participant capabilities.

## CI contract

Hosted validation must remain fail-closed:

- pinned Node 24 syntax-checks all browser and test modules;
- all dependency-free Node tests pass;
- `cargo fmt --all -- --check` passes;
- Clippy runs on all targets/features with warnings denied;
- all locked Rust tests pass;
- the locked release binary builds successfully.

Temporary formatter bootstrap steps may only persist test-source formatting after the browser tests, Clippy, Rust tests, and release build have all passed. The final merge candidate must use the normal read-only workflow with no source mutation.
