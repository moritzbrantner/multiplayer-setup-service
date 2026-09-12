# Final hardening and deployment acceptance

Feature scope remains a signaling broker plus opt-in browser content transfer. The broker does not store content bytes, run gameplay, or become an account service.

## Signaling resource limits

Both two-player rooms and multiparty lobbies use the same bounded outbox implementation:

- Each connection has at most 32 queued signaling envelopes. Queued and in-flight relays share a 16 MiB application budget of serialized text capacity plus conservative item overhead. Direct control responses have a separate bounded 2 MiB reserve so queue saturation can still be reported without borrowing more relay capacity. These budgets are not bounds on total process memory, socket buffers, or allocator metadata.
- Outbound frames are bounded by the inbound signaling limit plus 1024 bytes of server-envelope overhead. A recipient whose own queue fills is cancelled rather than silently losing SDP/ICE messages. Exhausting the aggregate relay budget rejects that relay but does not evict an otherwise healthy recipient; the sender receives an overload response when bounded control-response capacity remains available.
- Cancellation has a separate notification path; it cannot wait behind queued signaling. A socket write has a two-second deadline, so a currently stalled write also cannot wait indefinitely.
- A socket accepts a burst of 128 frames and 1 MiB, refilling at 64 frames and 512 KiB per second. Control frames count too. Exceeding either limit disconnects the sender.
- HTTP admission bounds concurrent handlers at 128 with a ten-second processing deadline. Transport-peer IP buckets default to 120 requests/second and a 240-request burst. At most 4096 client buckets are tracked, with idle reclamation; tracking exhaustion fails closed.

`HTTP_REQUESTS_PER_SECOND` and `HTTP_BURST_REQUESTS` configure HTTP admission within 1..100000. Behind a reverse proxy, the proxy is one transport client: configure an appropriate aggregate budget and enforce end-client limits at the edge. Arbitrary forwarded-address headers are deliberately not trusted. This application protection does not replace reverse-proxy connection limits or network-level denial-of-service protection.

The release throughput benchmark explicitly provisions a higher, still bounded HTTP budget. It retains its workloads and timing thresholds. Separate unit and real-service contract tests check rejection, refill, bounded tracking, queue cancellation, aggregate-pressure isolation, and healthy-peer isolation.

## Expiration lookup

Ordinary lobby operations inspect and reject the addressed lobby immediately when it is expired. They do not sweep unrelated lobbies under the shared mutex. Periodic cleanup still reclaims the whole store, and creation performs a full reclamation pass under capacity pressure. Expiration is not extended until the next cleanup tick.

## Client recovery and optional uploads

`ResilientLobbySession` emits `signaling-changed` with `{ socket, previousSocket }` when its socket is replaced or cleared. Old socket messages cannot mutate the recovered session. `ContentPeerPool` rebinds immediately, cancels incomplete negotiation, ignores stale continuations and retired-link events, and keeps locally ready content links intact during rebinding. Remote participant-disconnect behavior remains unchanged; a new content connection may still be necessary. Closing the session closes its dependent pool.

`ContentUploadBudget` supplies a session-shared application token bucket to all default `ContentPeerPool` instances: 1 MiB/second with a 1 MiB burst, at most 64 waiting sends and 4 MiB of waiting payload sizes. A game can inject a custom budget into pools or call `pool.uploadBudget.setPaused(true)` to prioritize gameplay, then resume with `setPaused(false)`. Pausing rejects waiting uploads rather than accumulating them. Consumers may resume missing verified chunks after cancellation. Gameplay channels are not routed through this budget. This budget applies to content pools, not to arbitrary application networking or the legacy session content-channel API, and is not a wire-bandwidth guarantee.

TURN policy remains separate and defaults to denying positively identified relay paths. The selected route is rechecked after delayed sends; a direct-to-relay transition cannot silently bypass denial. A transition into limited relay mode requires retry under that limiter. Route-stat caching is intentionally deferred: no measured benefit justifies caching a possibly stale direct classification.

## Automated evidence

The existing Rust, HTTP, browser-model, performance and identical-workload runtime-profile checks remain in place. `Browser Acceptance` adds two isolated real Chromium contexts in desktop and touch-emulated configurations. It uses the real Rust binary, actual WebSockets, actual RTCPeerConnections and a loopback-only coturn fixture. It covers direct channels, capability-preserving signaling replacement, fresh content negotiation after recovery, verified chunk resume, forced relay with service-issued credentials, relay bulk denial/opt-in, and gameplay while bulk uploads are paused. Test retries are disabled. Browser versions, scoped acceptance results, and failure traces are retained as artifacts.

Run locally after installing the repository Rust toolchain and coturn:

```sh
cargo build --release --locked --bin multiplayer-setup-service
cd e2e
npm ci --ignore-scripts
npx --no-install playwright install --with-deps chromium
npm test
```

The coturn secret and `allow-loopback-peers` setting in `e2e/turnserver.conf` are isolated test fixtures, not production configuration.

## Operator-owned acceptance still required

A green local/CI browser run is not proof of an Internet deployment. Record the tested commit, endpoint, browser/device, date, result and evidence for these checks before declaring a deployed instance production-ready:

1. Enable repository **Settings > Pages > Build and deployment > Source: GitHub Actions**. Source validation is independent from the deployment job. A configure-pages failure remains a deployment failure; it is not converted into success.
2. Validate the live HTTPS/WSS endpoint, certificate renewal, allowed and rejected origins, proxy admission settings, and signaling reconnection against that endpoint.
3. Verify the deployed coturn DNS/firewall/TLS setup, credential expiry, actual relay connectivity from separate networks, secret rotation, and relay bandwidth controls.
4. Run a real mobile-device test across Wi-Fi/cellular changes, including interrupted and resumed content downloads. Touch emulation in CI does not establish this result.

No live VPS, public TURN, mobile-network, certificate, or production secret changes are performed by the hardening PR.
