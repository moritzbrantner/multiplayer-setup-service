# Repository guidance

## Authority boundaries

- Keep `multiplayer-setup-service` a rendezvous/control plane. It may own short-lived lobby membership, admission/rate limits, signaling relay, expiry/reconnect handling, and short-lived TURN credentials.
- Do not move gameplay simulation, game rules, authoritative game state, hidden game state, or bulk content bytes into the setup service. Those remain game/peer responsibilities.
- Capability tokens and TURN credentials are secrets: never place them in invite URLs, logs, committed fixtures, browser-visible diagnostics, or durable client storage.
- Lobby chat and latency probes belong on existing peer DataChannels. Host-spoke games may relay peer messages through the host browser, but not through the setup service.
- Optional peer content sharing must remain opt-in, manifest-authorized, hash/signature verified where applicable, bounded, resumable, and backpressured. Do not weaken gameplay traffic to make bulk transfer pass.

## Deterministic validation

- Use the coding-tooling Pages surface for structural preflight when it can observe the repository; local/CI convergence evidence remains authoritative for execution and full-source findings.
- Run cheap checks before broader checks. The canonical capability mapping is in `.coding-tooling.json`.
- Keep Node, Bun, and Rust toolchains exact. `package.json` and `bun.lock` define the JavaScript package-manager state; `web/.node-version` and `e2e/.node-version` mirror the repository Node pin because those directories are independently discoverable package components.
- Preserve exact-head evidence. Missing, skipped, stale, or earlier-head CI is not green evidence for the current revision.
- Do not suppress or baseline a deterministic finding merely to make convergence green. Fix the repository-owned cause, or leave the finding visible when the detector boundary cannot prove the repository behavior.

## Change discipline

- Prefer small changes that preserve the existing protocol and security boundaries.
- Add focused regression coverage for behavioral fixes and keep browser acceptance responsible for real WebRTC/TURN/recovery boundaries.
- Keep runtime-profiler evidence bound to the exact candidate revision and an identical committed workload when comparing base and candidate.
