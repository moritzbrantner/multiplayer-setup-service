# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling and WebRTC gameplay foundation unchanged.

## Trust boundary

Peers are untrusted byte transports. They are never authoritative for game logic, assets, versions, manifests, file sizes, chunk hashes, or chunk availability.

A game that opts in configures a trusted manifest URL owned by its original HTTPS origin or repository/release infrastructure. The browser fetches that manifest directly from the configured trusted location and verifies peer-provided content against it before exposing bytes to the game.

The setup/rendezvous server never receives file bytes and never becomes the game authority. Seeder discovery and content-peer negotiation keep the Rust server payload-opaque: both travel inside the existing targeted signaling envelope rather than adding game-content state to the service.

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

`role: "asset"` marks ordinary content such as textures, models, audio, maps, or data. `role: "logic"` marks execution-critical JavaScript, WASM, scripts, deterministic rule data, or other files that influence game behavior.

Every path is relative and traversal-free. Every entry has an exact byte length and whole-file SHA-256 digest. `chunks` is optional for content that will never travel over the P2P bulk-transfer path; files transferred or exchanged peer-to-peer must define trusted per-chunk hashes.

The chunk list length must exactly match the file size and configured chunk size. This lets a receiver reject a corrupt or substituted chunk immediately and reseed only chunks that have already been independently verified.

Files absent from the trusted manifest are not authorized, even if a peer offers them.

## Authoritative source options

The manifest URL is game configuration, not lobby state and not peer input. Suitable authorities include:

- the game's own HTTPS origin, for example a GitHub Pages deployment;
- a release-specific path on the game's server;
- an immutable repository/release URL pinned to a commit or release when stronger reproducibility is desired.

The browser helper requires HTTPS except for loopback development URLs. A game can also configure an explicit allow-list of trusted manifest origins. Redirects are rejected so a configured trusted URL cannot silently move to another location.

The multiplayer setup service does not copy, rewrite, cache, sign, or approve the manifest. This keeps the service provider-neutral and prevents rendezvous infrastructure from becoming the authority for game code.

## Game logic verification

Execution-critical files are verified more strictly as a set:

1. fetch the manifest from the configured trusted source;
2. identify every `logic` entry;
3. require every trusted logic file to be present;
4. verify exact byte size and SHA-256 for each file;
5. derive a deterministic logic fingerprint from the trusted game id, version, paths, sizes, and hashes;
6. expose only the verified trusted logic entries to the game.

Extra files supplied by a peer are not part of the verified logic set. A matching peer-to-peer fingerprint can be used later as a cheap compatibility check, but a fingerprint advertised by another peer is never itself a source of trust.

## Explicit content transport

`LobbySession` keeps content distribution disabled by default. A game must opt in with `contentSharing: true` before constructing any content helpers.

The original content channel follows gameplay peer relationships. `ContentPeerPool` adds a separate sparse content-only topology for bulk transfer, capped at four peers by default and eight maximum. This lets two host-spoke guests exchange large files directly without turning gameplay into a full mesh.

Both surfaces use reliable ordered DataChannels and buffered-amount backpressure. The current P2P chunk payload limit is 60 KiB; 48 KiB is a conservative manifest chunk size.

## Whole-file single-peer transfer

`ContentTransfer` verifies the sender's complete local file before seeding, verifies every received chunk against the authoritative manifest, verifies the assembled file again, and only then emits the file to the game.

Peer-provided metadata cannot relax or replace the trusted manifest. This path remains useful for small or simple games where one peer has the complete asset and resumability is not necessary.

## Seeder discovery

Seeder participation is a second opt-in on top of game-level content sharing. A game can support P2P content while a particular player chooses not to upload anything.

`ContentSeederDiscovery` advertises bounded whole-file SHA-256 IDs from the trusted manifest over the existing opaque lobby signaling channel. Existing volunteer seeders automatically advertise to a participant that joins later, including between participants that are not gameplay neighbors.

Advertisements are only availability hints. The local browser filters them against its own trusted manifest, and actual bytes must still pass cryptographic verification.

## Bounded content-only peer topology

`ContentPeerPool` owns temporary WebRTC relationships used only for bulk content. Incoming and outgoing relationships consume the same hard peer cap. A full pool rejects new offers instead of silently evicting existing peers.

Content-peer SDP and ICE remain inside a namespaced opaque signaling payload. Random connection IDs scope offers, answers, candidates, close messages, collision handling, and capacity rejection. The Rust setup server stores none of this content topology.

The pool exposes `sendContent(...)` and `content` events compatible with the higher-level transfer/exchange layers.

## Verified resumable chunk store

`VerifiedChunkStore` is the authority boundary between received bytes and reusable local chunks.

A chunk can enter the store only after its exact size and SHA-256 match the trusted manifest. The store copies accepted bytes on insertion and on read, so callers cannot mutate a previously verified chunk in place. Re-inserting the same valid chunk is idempotent.

The store supports:

- querying available and missing chunk indexes;
- loading a complete trusted file and staging all of its verified chunks atomically;
- accepting independently verified chunks as they arrive;
- assembling a file only when every trusted chunk is present;
- re-verifying the final whole-file SHA-256 before returning the assembled bytes.

This makes partial reseeding safe: a client does not need to possess the whole asset before it can serve chunks it has already verified.

## Bounded chunk request/response

`ContentChunkExchange` runs over a content-capable transport such as `ContentPeerPool`. A requester asks one peer for at most 64 explicit chunk indexes at a time. Requests and pending operations are bounded, and requests time out or fail when their content peer closes.

The response protocol binds binary chunk frames to the request ID and requested path. The receiver rejects unrequested or duplicate chunks and inserts each response through `VerifiedChunkStore`, so corrupt bytes never become reseedable state.

The responder reads only from its own `VerifiedChunkStore`. It therefore cannot accidentally serve unverified bytes through the normal API. If it has only some requested chunks, it sends those and completes the request; the requester computes the remaining indexes locally and can ask another seeder later.

A peer's claim that it has content is still not trusted. Availability is learned by successful verified responses, while missing or corrupt responses remain recoverable scheduler inputs.

This slice supplies resumability and safe partial reseeding but deliberately does not yet choose seeders or divide work across several peers automatically.

## Optionality invariant

No existing game needs to opt in. With the default `contentSharing: false`, no content DataChannel, peer pool, discovery helper, verified store, or chunk exchange is created and no bulk-transfer bandwidth is used.

For a game that does opt in, the player still begins with seeding disabled. Uploading starts only after the game explicitly maps a player choice to `setSeederEnabled(true)`.

## Planned slices

1. **Trusted manifest and verification** — merged.
2. **Single-peer verified chunk transport** — merged.
3. **Seeder advertisement and discovery** — merged.
4. **Bounded content-only peer pool** — merged.
5. **Verified resumable chunk exchange** — current slice; verified chunk store, bounded requests, partial responses, safe reseeding.
6. **Multi-source swarm scheduler** — choose a few discovered seeders, partition missing chunks, retry/reassign failures, and converge deterministically on the complete verified file.
7. **Persistent cache and relay policy** — browser persistence, eviction, TURN-aware bulk-transfer limits, and diagnostics.

Each slice remains independently testable and preserves gameplay priority over bulk transfer.
