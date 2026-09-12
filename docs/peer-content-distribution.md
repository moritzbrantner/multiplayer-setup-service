# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling/WebRTC gameplay foundation unchanged.

## Trust and optionality invariants

Peers are untrusted byte transports. They are never authoritative for game logic, assets, versions, manifests, file sizes, chunk hashes, signing keys, or chunk availability.

A game that opts in fetches its trusted manifest from its original HTTPS origin or immutable repository/release infrastructure. Peer-provided bytes become usable only after verification against that manifest.

The setup service never receives file bytes. Seeder discovery and content-peer negotiation use bounded opaque signaling messages, so the Rust service does not become a persistent content tracker.

Content distribution is disabled by default with `contentSharing: false`. Even after a game enables it, a player seeds nothing until the game maps an explicit player choice to `setSeederEnabled(true)`.

## Trusted manifests and game logic

A transferable file is described by its relative path, exact byte length, whole-file SHA-256, role, chunk size, and authoritative per-chunk SHA-256 values. Files absent from the trusted manifest are not authorized.

`role: "asset"` covers ordinary content such as textures, models, audio, maps, or data. `role: "logic"` covers execution-critical JavaScript, WASM, scripts, deterministic rule data, or anything else that influences game behavior.

Execution-critical logic uses the signed-manifest boundary:

- Ed25519 signatures are checked against public keys pinned by game configuration;
- peers and lobby state cannot add trusted keys;
- multiple pinned keys may overlap during release-key rotation;
- `revokedKeyIds` overrides an otherwise pinned key immediately;
- unsigned `logic` content is rejected;
- asset-only unsigned v1 manifests remain an explicit migration option;
- file and chunk SHA-256 values remain the byte-integrity authority after signature verification.

A peer-advertised fingerprint is only a compatibility hint; it is never a source of trust.

## Transport layers

The optional content path is intentionally separate from latency-sensitive gameplay.

`ContentTransfer` provides a simple single-peer whole-file path. The sender verifies its complete local file before seeding, the receiver verifies transfer metadata against its own trusted manifest, each received chunk is checked immediately, and the assembled file is re-verified before exposure to the game.

`ContentSeederDiscovery` advertises bounded trusted content IDs to lobby participants. Advertisements are availability hints only and are cleared when participants disconnect.

`ContentPeerPool` owns a sparse content-only WebRTC topology. It is capped at four peers by default and eight maximum, counts incoming and outgoing relationships against the same bound, and rejects new relationships when full rather than evicting existing peers. This lets host-spoke gameplay guests exchange assets without converting gameplay into a full mesh.

Content DataChannels are reliable and ordered. Bulk sends apply `bufferedAmount` backpressure. The current transfer framing keeps chunk payloads below 60 KiB; 48 KiB is a conservative manifest chunk size.

## Verified resumable chunks

`VerifiedChunkStore` is the authority boundary between received bytes and reusable local chunks.

A chunk enters the store only after exact size and SHA-256 verification against the trusted manifest. Accepted bytes are copied on insertion/read so callers cannot mutate verified state in place. Re-inserting the same valid chunk is idempotent.

`ContentChunkExchange` requests bounded explicit chunk-index batches from one peer. Responses are tied to request IDs and locally trusted paths. Duplicate, unrequested, corrupt, or late chunks are rejected. A partial seeder returns only verified chunks it actually owns; the requester computes remaining work locally rather than trusting peer completeness claims.

`ContentSwarmDownloader` composes discovery, the sparse peer pool, chunk exchange, and verified store:

1. resume from locally verified chunks;
2. deterministically choose a bounded source set (three by default, four maximum);
3. partition missing indexes into bounded requests;
4. request several sources concurrently;
5. remember per-peer missing chunks and reassign them elsewhere;
6. exclude failing sources for the current download;
7. derive progress only from verified local state;
8. fail closed when no source can provide the remaining trusted chunks;
9. finish only after whole-file SHA-256 verification;
10. deduplicate concurrent downloads of the same path into one in-flight operation.

The swarm is lobby-scoped and manifest-constrained. It is deliberately not a general BitTorrent client.

## Persistent verified cache

`PersistentVerifiedChunkStore` adds durable browser reuse without weakening the cryptographic boundary.

- IndexedDB is the default persistence adapter; an in-memory adapter exists for deterministic tests.
- Cache namespaces isolate game id + release/version.
- Persisted chunks are re-verified during hydration; corrupt/stale entries are deleted fail-closed.
- The default durable budget is 256 MiB and can be changed with `maxBytes`.
- Durable entries carry touch metadata and are evicted with deterministic LRU ordering under pressure.
- `storageUsage()` exposes current durable usage.
- `onStoragePressure` reports requested/persisted/evicted byte counts.
- Durable eviction does not invalidate already verified bytes held in current-session memory.
- Cached chunks are advertised only when the player has explicitly opted into seeding.

## TURN and relay-cost policy

TURN is a connectivity fallback, not the default asset path. `ResilientLobbySession` remains direct-first and can install short-lived TURN ICE credentials issued by the authenticated setup-service endpoint.

For content-only peers, `ContentPeerPool` inspects the selected ICE candidate pair through WebRTC statistics when available. A positively identified relay path is subject to an explicit bulk policy:

- `relayPolicy: "deny"` — default; reject bulk sends through TURN;
- `relayPolicy: "allow"` — explicitly permit relay bandwidth;
- `relayPolicy: "limit"` — permit it under a deterministic byte-per-second reservation cap.

Unknown/unavailable statistics are not falsely classified as TURN. This policy affects optional bulk content only; gameplay may still use TURN when required for connectivity.

The coturn shared secret remains server-side. Authenticated lobby participants receive short-lived credentials only. See `turn-deployment.md` for DNS, firewall, TLS, shared-secret rotation, and operational verification.

## Implementation status

All planned peer-content slices are merged:

1. **Trusted manifest and verification** — complete.
2. **Single-peer verified chunk transport** — complete.
3. **Seeder advertisement and discovery** — complete.
4. **Bounded content-only peer pool** — complete.
5. **Verified resumable chunk exchange** — complete.
6. **Bounded multi-source swarm scheduler** — complete.
7. **Persistent verified cache, storage budgeting, and relay-aware bulk policy** — complete.
8. **Signed-manifest key rotation/revocation and short-lived TURN credential integration** — complete.

Future work should be driven by concrete consumer needs or production evidence rather than expanding the swarm protocol speculatively.
