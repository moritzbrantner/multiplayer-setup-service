# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling and WebRTC gameplay foundation unchanged.

## Trust boundary

Peers are untrusted byte transports. They are never authoritative for game logic, assets, versions, manifests, file sizes, or chunk hashes.

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

Every path is relative and traversal-free. Every entry has an exact byte length and whole-file SHA-256 digest. `chunks` is optional for content that will never travel over the P2P bulk-transfer path; files transferred by `ContentTransfer` must define trusted per-chunk hashes.

The chunk list length must exactly match the file size and configured chunk size. This allows a receiver to reject a corrupt or substituted chunk immediately and, in later swarm slices, to reseed only chunks that have already been independently verified.

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

## Explicit content channel

`LobbySession` keeps content distribution disabled by default. A game must opt in when constructing the session:

```js
const session = new LobbySession({
  apiBase,
  topology: "mesh",
  contentSharing: true,
});
```

Only opted-in sessions create or accept the original third reliable ordered `content` DataChannel on gameplay peer relationships. The existing `reliable` gameplay-command channel and unordered freshness-first `realtime` channel remain unchanged.

Bulk sends use `RTCDataChannel.bufferedAmount` backpressure with separate high/low water marks. Filling a content channel therefore waits for content capacity instead of deliberately delaying gameplay sends in application code.

The current P2P chunk payload limit is 60 KiB. Games should generate trusted chunk manifests at or below that size; 48 KiB is a conservative default. Large files are represented as many independently hashed chunks rather than single giant DataChannel messages.

## Single-peer transfer

`ContentTransfer` is constructed around a content-capable transport and a previously trusted manifest. Its flow is intentionally strict:

1. the sender verifies the complete local file against the trusted manifest before seeding it;
2. the sender announces only path/size/hash/chunk metadata already present in the trusted manifest;
3. the sender transmits bounded binary chunk frames;
4. the receiver checks the announced metadata against its own trusted manifest;
5. every incoming chunk is verified against its authoritative chunk hash before being retained;
6. after all chunks arrive, the assembled file is verified again against the authoritative whole-file hash;
7. only then is a `file` event emitted to the game.

Peer-provided metadata cannot relax or replace the trusted manifest. A mismatch aborts the transfer.

This layer deliberately uses an in-memory assembly limit (64 MiB by default). Persistent/streaming chunk storage is deferred to the cache/swarm work so the transfer protocol stays small and testable.

## Seeder discovery

Seeder participation is a second opt-in on top of game-level content sharing. A game can support P2P content while a particular player chooses not to upload anything.

`ContentSeederDiscovery` binds a content-enabled `LobbySession` to the already trusted manifest. The player-facing switch can map directly to:

```js
const discovery = new ContentSeederDiscovery({ session, manifest });

discovery.setSeederEnabled(true);  // advertise all transferable trusted files
discovery.setSeederEnabled(false); // stop advertising immediately
```

A game may instead provide `paths` to seed only selected transferable manifest files. Files without trusted chunk hashes are not advertised through this protocol.

Advertisements contain only whole-file SHA-256 content IDs. They are bounded to 128 IDs per participant, sorted, unique, and lowercase. No filenames, arbitrary URLs, or executable metadata are accepted as seeder identifiers.

Availability hints use the existing opaque lobby signaling envelope. Existing volunteer seeders automatically advertise to a participant that joins later, and discovery works between participants that are not gameplay neighbors in host-spoke mode.

The browser still treats advertisements as hints only. `ContentSeederDiscovery` filters every advertised content ID against its own trusted manifest. Unknown peer hashes are ignored. A valid advertisement does not prove possession; actual bytes must still pass per-chunk and whole-file verification before use.

## Bounded content-only peer topology

Discovery must not force the gameplay network to become a full mesh. `ContentPeerPool` therefore owns a separate set of WebRTC connections used only for bulk content.

```js
const contentPeers = new ContentPeerPool({
  session,
  maxPeers: 4,
});

await contentPeers.connect(selectedSeederId);
```

The default cap is four total content peers per browser and the implementation refuses values above eight. Connecting and incoming relationships both consume the same cap, so a browser cannot accidentally build an unbounded content mesh.

Content-peer SDP and ICE data are namespaced inside the existing targeted signaling payload. The Rust server relays the opaque bytes exactly as it does for ordinary WebRTC setup and stores no content topology. A random connection identifier scopes offers, answers, candidates, close messages, collision handling, and capacity rejection so stale signaling cannot silently attach to a replacement relationship.

Each content-only relationship has one reliable ordered `content-swarm-v1` DataChannel. The pool exposes the same `sendContent(...)` method and `content` event shape expected by `ContentTransfer`, including buffered-amount backpressure. The verified transfer layer therefore does not need to know whether bytes travel over a gameplay-adjacent content channel or a sparse content-only peer relationship.

This matters especially for host-spoke gameplay. Two guests can form a temporary direct content relationship while both continue to have only the host as a gameplay neighbor. Closing that content relationship does not change deterministic gameplay topology.

Participant departure tears down its content-only connection. A full receiving pool rejects new offers fail-closed rather than evicting an existing relationship implicitly.

This slice still does not select seeders automatically or split one download across multiple sources. It establishes the bounded transport substrate that the scheduler can use next.

## Optionality invariant

No existing game needs to opt in. With the default `contentSharing: false`, no content DataChannel is created, no content-transfer/discovery/peer-pool helper is constructed, and no bulk-transfer bandwidth is used.

For a game that does opt in, the player still begins with seeding disabled. Uploading starts only after the game explicitly maps a player choice to `setSeederEnabled(true)`.

## Planned slices

1. **Trusted manifest and verification** — merged; fail-closed SHA-256 verification and deterministic logic fingerprints.
2. **Single-peer chunk transport** — merged; bounded chunks, backpressure, per-chunk verification, and final verification.
3. **Seeder advertisement and discovery** — merged; player opt-in, trusted content IDs, late-join advertisement, and topology-independent discovery.
4. **Bounded content peer pool** — current slice; sparse content-only WebRTC relationships independent from gameplay topology.
5. **Resumable multi-source scheduler** — request verified chunk ranges from a few discovered seeders, retry/reassign failures, and reseed only verified chunks.
6. **Persistent cache and relay policy** — browser cache, eviction, TURN-aware bulk-transfer limits, and diagnostics.

Each slice remains independently testable and preserves gameplay priority over bulk transfer.
