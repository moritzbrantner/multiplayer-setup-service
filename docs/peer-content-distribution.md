# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling and WebRTC gameplay foundation unchanged.

## Trust boundary

Peers and local caches are untrusted byte sources. They are never authoritative for game logic, assets, versions, manifests, file sizes, chunk hashes, or chunk availability.

A game that opts in configures a trusted manifest URL owned by its original HTTPS origin or repository/release infrastructure. The browser fetches that manifest directly from the configured trusted location and verifies all peer-provided or persisted bytes against it before those bytes become usable or seedable.

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

Every path is relative and traversal-free. Every entry has an exact byte length and whole-file SHA-256 digest. Files exchanged peer-to-peer also define authoritative per-chunk hashes. Files absent from the trusted manifest are not authorized, even if a peer offers them.

## Authoritative source and game logic

The manifest URL is game configuration, not lobby state and not peer input. Suitable authorities include the game's own HTTPS origin, a release-specific server path, or an immutable repository/release URL pinned to a commit or release.

The browser helper requires HTTPS except for loopback development, supports an explicit trusted-origin allow-list, disables cache reuse for the manifest fetch, omits credentials, and rejects redirects.

Execution-critical files are verified as a complete trusted set:

1. fetch the manifest directly from the configured authority;
2. identify every `logic` entry;
3. require every trusted logic file to be present;
4. verify exact byte size and SHA-256 for each file;
5. derive a deterministic logic fingerprint from game id, version, paths, sizes, and hashes;
6. expose only the verified trusted logic entries to the game.

Extra files supplied by a peer are never part of the verified logic set. A peer fingerprint is only a compatibility hint; it is not a source of trust.

## Optional transport and seeding

`LobbySession` keeps content distribution disabled by default. A game must opt in with `contentSharing: true` before constructing content helpers.

Seeder participation is a second opt-in. A game can support peer distribution while an individual player chooses not to upload. `ContentSeederDiscovery` advertises bounded whole-file SHA-256 IDs from the trusted manifest over existing targeted signaling. Existing volunteer seeders automatically advertise to participants who join later.

Advertisements are availability hints only. Unknown content IDs are ignored locally, and actual bytes must pass cryptographic verification.

## Bounded content topology

The original optional content channel follows gameplay peer relationships. `ContentPeerPool` adds a separate sparse content-only topology for bulk transfer. The default cap is four peers and configurations above eight are refused. Incoming and outgoing relationships consume the same bound.

This lets two host-spoke guests exchange large content directly without turning gameplay into a full mesh. Content-peer SDP and ICE stay inside a namespaced opaque signaling payload, and the Rust server stores none of the content topology.

Content DataChannels are reliable and ordered. Bulk sends use `bufferedAmount` high/low-water backpressure. The current chunk payload limit is 60 KiB; 48 KiB is a conservative manifest chunk size.

## Verification and resumability

`VerifiedChunkStore` is the in-memory authority boundary between received bytes and reusable local chunks. A chunk enters it only after exact size and SHA-256 verification. Accepted bytes are copied on insertion and read so callers cannot mutate verified state in place.

The store supports available/missing indexes, atomic staging from a fully verified local file, independently verified chunk insertion, and final assembly. `assembleFile` requires every trusted chunk and re-verifies the whole-file SHA-256 before returning bytes.

`ContentChunkExchange` requests at most 64 explicit chunk indexes from a peer at a time. Responses are scoped to request ID and chunk index. Duplicate, unrequested, or corrupt chunks are rejected. Responders read only from their own verified store, so a partially downloaded client can safely reseed only chunks it has already verified.

`ContentTransfer` remains the simpler whole-file path for small assets where one peer owns the complete file.

## Bounded multi-source swarm

`ContentSwarmDownloader` composes discovery, the bounded peer pool, chunk exchange, and verified store.

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

The default is three concurrent sources and the scheduler refuses more than four. It starts from already verified missing indexes, selects a deterministic subset of seeders, partitions missing chunks into bounded batches, requests several sources concurrently, records per-peer missing indexes, reassigns work to other peers, and fails closed if no source can make verified progress.

Progress is derived only from `VerifiedChunkStore`. Two concurrent requests for the same path share one in-flight operation. Completion still goes through final whole-file SHA-256 verification.

This is intentionally not a general BitTorrent client. It is lobby-scoped, bounded, manifest-constrained, and active only for games that explicitly opt into the feature.

## Persistent verified chunk cache

`PersistentVerifiedChunkCache` adds optional browser-local IndexedDB persistence without making storage authoritative.

```js
const cache = new PersistentVerifiedChunkCache({
  manifest,
  maxBytes: 512 * 1024 * 1024,
});

const exchange = new ContentChunkExchange({
  transport: peerPool,
  manifest,
  store,
  cache,
});

const swarm = new ContentSwarmDownloader({
  manifest,
  discovery,
  peerPool,
  exchange,
  store,
  cache,
});
```

The default cache budget is 512 MiB per game, configurable up to 8 GiB. Cache entries are scoped by authoritative game id, version, path, whole-file hash, chunk index, and chunk hash. Old releases can coexist but are not restored into a different trusted version.

A chunk is SHA-256 verified before it is written to persistent storage. On a later refresh/rejoin, every persisted chunk is verified again through the current trusted manifest before it re-enters `VerifiedChunkStore`. Corrupt or metadata-incompatible cache entries are deleted instead of restored.

The cache applies deterministic least-recently-used eviction when its explicit byte budget is exceeded. `requestPersistence()` exposes the browser StorageManager persistence request, but never requests durable storage silently.

`ContentChunkExchange` writes newly verified chunks to the cache opportunistically. IndexedDB/quota errors emit `cache-error` but do not fail a cryptographically valid network transfer. `ContentSwarmDownloader` restores cached chunks before looking for seeders, so a completely cached asset can open without any network source while a partially cached asset resumes only its missing chunks.

The current final-file API still assembles a complete file in memory. Persistent chunks remove refresh/rejoin redownloads and enable long-lived seeding, while a future streaming/OPFS layer can remove that final in-memory assembly requirement for very large multi-gigabyte assets.

## Optionality invariant

No existing game needs to opt in. With the default `contentSharing: false`, no content DataChannel, discovery helper, peer pool, verified store, chunk exchange, swarm downloader, or persistent cache is constructed and no bulk-transfer bandwidth or storage is used.

For a game that opts in, the player still begins with seeding disabled. Uploading starts only after the game maps an explicit player choice to `setSeederEnabled(true)`. Persistent storage is also explicit.

## Implementation slices

1. **Trusted manifest and game-logic verification** — merged.
2. **Single-peer verified chunk transport** — merged.
3. **Seeder advertisement and discovery** — merged.
4. **Bounded content-only peer pool** — merged.
5. **Verified resumable chunk exchange** — merged.
6. **Bounded multi-source swarm scheduler** — merged.
7. **Persistent reverified browser chunk cache** — current slice.
8. **Relay-aware bulk policy and streaming storage** — next: avoid expensive TURN bulk traffic by default, expose diagnostics, and remove final in-memory assembly for very large assets.

Each slice remains independently testable and preserves gameplay priority over bulk transfer.
