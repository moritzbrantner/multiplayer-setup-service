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

## Retired content negotiation regression (#52)

Independent acceptance at baseline `ce257ee` covers the captured recovery defect:
an actual Chromium `addIceCandidate` promise remained pending after its old peer
closed, leaving a replacement answer queued without reaching the new peer.
The original direct/TURN/recovery expectations remain enabled with zero retries.

`web-tests/content-peer-pool.test.ts` holds an old ICE operation through public
pool disconnect/reconnect. Fresh negotiation must complete before it settles.
Both late resolution and rejection must preserve the replacement and current
candidate ordering; a pre-retirement queued offer must not resurrect an old link.
The existing injected RTC seam controls scheduling only; real browser acceptance
owns actual connection, content verification and gameplay transport behavior.

The additional `retired-ice` case in `e2e/networking.spec.ts` first connects real
Chromium peers and transfers a verified chunk. It sends a valid end-of-candidates
signal through the real service and holds the result after native application,
then replaces signaling and retires that connection. A fresh actual connection
must resume all remaining verified chunks and gameplay while the old result is
still pending. Releasing it afterwards must leave the new connection intact.
This deterministic scheduling fault models the observed pending native boundary;
it does not claim every browser naturally hangs that call. Existing direct and
forced-TURN cases retain their actual expectations and timeouts.

Run the normal web tests, plus the complete browser gate documented in
`final-hardening.md`; the focused browser selection is
`--grep 'direct recovery transfers verified content while retired ICE remains pending'`.
These are local loopback/desktop and touch-emulated checks, not public Internet,
physical mobile or Wi-Fi/cellular acceptance.

Baseline evidence before repair: production `ce257ee1aba03e99c31f889a5c822bdf75e34ace`,
freshly generated browser modules and freshly compiled locked release service.
Pinned Bun 1.4.3 reports ten existing pool tests passing and both new cases
failing because the replacement has no remote answer while old ICE is pending
(`/tmp/setup52-pending-ice-unit-baseline.log`). Actual Chromium desktop and touch
both fail at the second connection's unchanged 20-second readiness assertion;
initial connection/chunk, native end-of-candidates application, pending barrier
and signaling replacement were reached. Remaining transfer/gameplay and late
settlement assertions are unrun at baseline
(`/tmp/setup52-pending-ice-browser-baseline.log`). Node 24.20.0 syntax checks and
diff whitespace checks pass; no full-gate pass is claimed on this red baseline.
The browser-only temporary config substitutes private disposable binary/output
paths and leaves assertions, projects, timeouts and retries unchanged. Existing
local coturn 4.6.1 and Playwright 1.63.0 are used; build outputs are disposable.
Shared conventions resolve successfully at
`5ad0db36974c8b0e5f9812c90ee34a4f227852c3`; target inspection is unavailable,
so full repository completion gates remain required.

### Review regression: remote-initiated replacement

Review finding4276967139 identified the complementary lifecycle boundary: the
remote peer's matching close envelope must retire a stalled local link before a
subsequent fresh offer, without requiring a separate local disconnect. The two
additional pool contracts hold old ICE, initiate disconnect/connect only from the
remote public pool, and require a fresh offer/answer before old resolve/reject.
Late completion, stale old-ID closes and nonmember closes must leave the fresh
link intact. This preserves existing roster and connection-identity authority.

At unchanged production `f030ada`, twelve existing pool cases pass and both new
remote-close cases fail because the local old link is still present. Later fresh
answer, stale/nonmember and late-completion assertions are unrun on that baseline.
Log `/tmp/setup52-remote-close-baseline-f030ada.log`; Node24.20 syntax and diff
whitespace checks pass. The additional real-browser mode retires the link from
the remote pool after signaling replacement, retaining actual content, gameplay,
old-pending barrier and timeouts. It supplements the original direct, local
retirement and TURN cases; unit scheduling alone does not prove remote RTC or
public deployment acceptance.

The additional remote-initiated actual Chromium desktop and touch cases both
pass at `f030ada` (17.4 seconds total). They are green integrated invariants,
not a claimed reproduction of the queued-control-envelope defect: the
independently scheduled pool cases above reproduce that defect. Both layers
remain mandatory on the repaired head. Browser baseline log
`/tmp/setup52-remote-browser-baseline-f030ada.log`; private release/output paths
alone were substituted by the same disposable driver, with unchanged inputs,
projects, expectations and timeouts.
