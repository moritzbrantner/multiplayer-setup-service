# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling and WebRTC gameplay foundation unchanged.

## Trust boundary

Peers are untrusted byte transports. They are never authoritative for game logic, assets, versions, manifests, file sizes, chunk hashes, or chunk availability.

A game that opts in configures a trusted manifest URL owned by its original HTTPS origin or repository/release infrastructure. The browser fetches that manifest directly from the configured trusted location and verifies peer-provided content against it before exposing bytes to the game.

The setup/rendezvous server never receives file bytes and never becomes the game authority. Seeder discovery and content-peer negotiation stay inside the existing targeted opaque signaling envelope, so the Rust service does not become a persistent content tracker.

## Manifest v1

```json
{
  "protocol": "multiplayer-content-manifest-v1",
  "game": {
    "id": "example-game",
    "version": "1.2.3"
  },
  "files": [
    {
      "path": "assets/world.glb",
      "bytes": 10485760,
      "sha256": "<whole-file SHA-256>",
      "role": "asset",
      "chunks": {
        "bytes": 49152,
        "sha256": [
          "<chunk 0 SHA-256>",
          "<chunk 1 SHA-256>"
        ]
      }
    },
    {
      "path": "logic/game.wasm",
      "bytes": 524288,
      "sha256": "<whole-file SHA-256>",
      "role": "logic"
    }
  ]
}
```

`asset` files are ordinary textures, models, audio, maps, or data. `logic` files are execution-critical JavaScript, WASM, scripts, deterministic rule data, or other files that influence game behavior.

Every path is relative and traversal-free. Every entry has an exact byte length and whole-file SHA-256 digest. Files exchanged peer-to-peer also define authoritative per-chunk hashes. The chunk count must exactly match the file size and chunk size.

Files absent from the trusted manifest are not authorized, even if a peer offers them.

## Authoritative source

The manifest URL is game configuration, not lobby state and not peer input. Suitable authorities include:

- the game's own HTTPS origin, including GitHub Pages;
- a release-specific path on the game's server;
- an immutable repository/release URL pinned to a commit or release.

The browser helper requires HTTPS except for loopback development, supports an explicit trusted-origin allow-list, disables cache reuse for the manifest fetch, omits credentials, and rejects redirects.

The multiplayer setup service does not copy, rewrite, cache, sign, or approve the manifest.

## Game logic verification

Execution-critical files are verified as a complete trusted set:

1. fetch the manifest directly from the configured authority;
2. identify every `logic` entry;
3. require every trusted logic file to be present;
4. verify exact byte size and SHA-256 for each file;
5. derive a deterministic logic fingerprint from game id, version, paths, sizes, and hashes;
6. expose only the verified trusted logic entries to the game.

Extra files supplied by a peer are never part of the verified logic set. A peer fingerprint is useful only as a compatibility hint; it is not a source of trust.

## Explicit content transport

`LobbySession` keeps content distribution disabled by default. A game must opt in with `contentSharing: true` before constructing content helpers.

The original optional content channel follows gameplay peer relationships. `ContentPeerPool` adds a separate sparse content-only topology for bulk transfer, capped at four peers by default and eight maximum. This lets two host-spoke guests exchange large files directly without turning gameplay into a full mesh.

Content DataChannels are reliable and ordered. Bulk sends use `bufferedAmount` high/low-water backpressure. The current chunk payload limit is 60 KiB; 48 KiB is a conservative manifest chunk size.

## Whole-file single-peer transfer

`ContentTransfer` remains the simple path for small games or assets where one peer owns the complete file:

1. sender verifies the full local file before seeding;
2. receiver validates announced metadata against its own trusted manifest;
3. every received chunk is verified immediately;
4. the assembled file is re-verified against its whole-file SHA-256;
5. only then is it emitted to the game.

Peer metadata can never relax or replace the trusted manifest.

## Seeder discovery

Seeder participation is a second opt-in on top of game-level content sharing. A game can support P2P content while an individual player chooses not to upload.

`ContentSeederDiscovery` advertises bounded whole-file SHA-256 IDs from the trusted manifest over existing targeted signaling. Existing volunteer seeders automatically advertise to participants who join later, including between guests that are not gameplay neighbors.

Advertisements are availability hints only. Unknown content IDs are ignored locally, and actual bytes must still pass cryptographic verification.

## Bounded content-only peer topology

`ContentPeerPool` owns temporary WebRTC relationships used only for bulk content. Incoming and outgoing relationships consume the same hard cap. A full pool rejects new offers instead of silently evicting existing peers.

Content-peer SDP and ICE remain inside a namespaced opaque signaling payload. Random connection IDs scope offers, answers, candidates, close messages, collision handling, and capacity rejection. The Rust setup server stores none of this content topology.

The pool exposes `sendContent(...)` and `content` events compatible with the higher-level transfer and exchange layers.

## Verified resumable chunk store

`VerifiedChunkStore` is the authority boundary between received bytes and reusable local chunks.

A chunk enters the store only after exact size and SHA-256 verification against the trusted manifest. Accepted bytes are copied on insertion and on read, so callers cannot mutate verified state in place. Re-inserting the same valid chunk is idempotent.

The store supports available/missing indexes, atomic staging from a fully verified local file, independently verified chunk insertion, and final assembly. `assembleFile` requires every trusted chunk and re-verifies the whole-file SHA-256 before returning bytes.

A partially downloaded client can therefore safely reseed only the chunks it has already verified.

## Bounded chunk request/response

`ContentChunkExchange` runs over a content-capable transport such as `ContentPeerPool`. A requester asks one peer for at most 64 explicit chunk indexes at a time. Pending requests and timeouts are bounded.

Binary responses are scoped to request ID and chunk index. The receiver rejects duplicate, unrequested, or corrupt chunks and inserts successful responses only through `VerifiedChunkStore`.

The responder reads only from its own verified store. A partial seeder returns the requested chunks it has and completes the request; the requester computes the missing indexes locally. A peer's claim of availability is never trusted over observed verified responses.

## Bounded multi-source swarm scheduler

`ContentSwarmDownloader` composes discovery, the bounded peer pool, chunk exchange, and verified store into the first automatic swarm layer.

```js
const swarm = new ContentSwarmDownloader({
  manifest,
  discovery,
  peerPool,
  exchange,
  store,
  maxSources: 3,
});

const result = await swarm.download("assets/world.glb");
```

The default is three concurrent sources and the scheduler refuses more than four. This remains below the content peer pool's hard transport bound.

For each download the scheduler:

1. starts from `VerifiedChunkStore.missingChunks(path)`, so previously verified chunks are automatically resumed;
2. selects a deterministic sorted subset of discovered seeders and makes only those content peers ready;
3. partitions missing indexes across ready sources in bounded batches;
4. requests the batches concurrently;
5. records which peer explicitly failed to provide which chunk and avoids assigning that chunk to the same peer again;
6. excludes a source from the current download after a request error;
7. recomputes progress only from the verified local store;
8. reassigns remaining indexes to other sources while any verified progress remains possible;
9. fails closed if no source can provide the remaining trusted chunks;
10. completes only through `VerifiedChunkStore.assembleFile`, which re-verifies the authoritative whole-file SHA-256.

Two concurrent calls for the same path share one in-flight operation rather than duplicating peer requests. The scheduler emits progress from verified chunk counts plus source-error and complete events for diagnostics.

This is intentionally not a general BitTorrent client. It is lobby-scoped, bounded, manifest-constrained, and useful only for content that the game explicitly opted into sharing.

## Optionality invariant

No existing game needs to opt in. With the default `contentSharing: false`, no content DataChannel, discovery helper, peer pool, verified store, chunk exchange, or swarm downloader is constructed and no bulk-transfer bandwidth is used.

For a game that opts in, the player still begins with seeding disabled. Uploading starts only after the game maps an explicit player choice to `setSeederEnabled(true)`.

## Implementation slices

1. **Trusted manifest and verification** — merged.
2. **Single-peer verified chunk transport** — merged.
3. **Seeder advertisement and discovery** — merged.
4. **Bounded content-only peer pool** — merged.
5. **Verified resumable chunk exchange** — merged.
6. **Bounded multi-source swarm scheduler** — current slice.
7. **Persistent cache and relay policy** — next: durable browser chunk storage, eviction, TURN-aware bulk limits, and diagnostics.

Each slice remains independently testable and preserves gameplay priority over bulk transfer.
