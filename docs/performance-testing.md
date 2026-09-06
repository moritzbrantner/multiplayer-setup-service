# Performance and stress guardrails

The multiplayer foundation uses broad CI performance guardrails in addition to correctness tests. These checks are intentionally workload-oriented rather than microbenchmarks: they should catch order-of-magnitude regressions while remaining stable on shared GitHub runners.

## Browser workload

`web-tests/performance.perf.mjs` runs on pinned Node 24 and verifies:

- 250,000 compact input commands can be applied to two independent 16-player state replicas within 3 seconds while producing identical state;
- a complete 16-player mesh constructs 240 browser-side `RTCPeerConnection` endpoints representing exactly 120 logical peer relationships, with exactly one offer initiator per edge, within 1.5 seconds;
- a complete 16-player host-spoke graph constructs 30 browser-side endpoints representing 15 logical peer relationships within 1 second;
- one 16-player mesh participant can fan out 10,000 compact reliable input commands to 15 peers (150,000 channel sends) within 5 seconds;
- the representative input envelope remains at most 128 bytes in the browser transport model.

The budgets include substantial headroom. They are regression alarms, not claims about end-user frame latency or Internet/WebRTC latency.

## Release service workload

`tests/performance_guardrails.rs` runs only through `cargo test --release` and starts the real compiled Rust service on loopback. It verifies one process can complete:

- 1,600 `/health` requests from 16 concurrent workers within 8 seconds;
- 64 concurrently-created lobbies, each filled to all 16 participant slots and checked for overflow/status correctness, within 15 seconds;
- 256 complete legacy two-player room create/join/status cycles within 10 seconds.

Every request is still checked for the expected HTTP status and relevant state, so the performance suite does not trade correctness for throughput.

## Interpretation

These guardrails validate local CPU/service regressions and concurrency behavior. They deliberately do not assert production Internet latency, NAT traversal time, TURN performance, mobile-device performance, or maximum production capacity. Those require environment-specific load tests and real network telemetry.

If a guardrail becomes noisy, first determine whether the workload regressed or the CI environment changed. Do not loosen a threshold merely to make a failing run green; preserve the measured result and adjust the test only with evidence.
