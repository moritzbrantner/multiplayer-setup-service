# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling and WebRTC gameplay foundation unchanged.

## Trust boundary

Peers are untrusted byte transports. They are never authoritative for game logic, assets, versions, manifests, file sizes, or chunk hashes.

A game that opts in configures a trusted manifest URL owned by its original HTTPS origin or repository/release infrastructure. The browser fetches that manifest directly from the configured trusted location and verifies peer-provided content against it before exposing bytes to the game.

The setup/rendezvous server never receives file bytes and never becomes the game authority.

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

Only opted-in sessions create or accept the third reliable ordered `content` DataChannel. The existing `reliable` gameplay-command channel and unordered freshness-first `realtime` channel remain unchanged.

Bulk sends use `RTCDataChannel.bufferedAmount` backpressure with separate high/low water marks. Filling the content channel therefore waits for content capacity instead of deliberately delaying gameplay sends in application code.

The current P2P chunk payload limit is 60 KiB. Games should generate trusted chunk manifests at or below that size; 48 KiB is a conservative default. Large files are represented as many independently hashed chunks rather than single giant DataChannel messages.

## Single-peer transfer slice

`ContentTransfer` is constructed only around an opted-in `LobbySession` and a previously trusted manifest. Its current flow is intentionally small:

1. the sender verifies the complete local file against the trusted manifest before seeding it;
2. the sender announces only path/size/hash/chunk metadata already present in the trusted manifest;
3. the sender transmits bounded binary chunk frames over the content channel;
4. the receiver checks the announced metadata against its own trusted manifest;
5. every incoming chunk is verified against its authoritative chunk hash before being retained;
6. after all chunks arrive, the assembled file is verified again against the authoritative whole-file hash;
7. only then is a `file` event emitted to the game.

Peer-provided metadata cannot relax or replace the trusted manifest. A mismatch aborts the transfer.

This slice deliberately uses an in-memory assembly limit (64 MiB by default). Persistent/streaming chunk storage is deferred to the cache/swarm work so the first transfer protocol stays small and testable.

## Optionality invariant

No existing game needs to opt in. With the default `contentSharing: false`, no content DataChannel is created, incoming unsolicited content channels are closed, no content-transfer helper is constructed, and no bulk-transfer bandwidth is used.

A game's decision to use the feature is separate from a player's later decision to volunteer as a seeder. The next slice will add seeder advertisement without making content sharing mandatory for every multiplayer game.

## Planned slices

1. **Trusted manifest and verification** — implemented and merged; fail-closed SHA-256 verification and deterministic logic fingerprints.
2. **Single-peer chunk transport** — implemented in the current slice; explicit content DataChannel, bounded chunks, backpressure, per-chunk verification, and final verification.
3. **Seeder advertisement** — lobby-scoped opt-in availability metadata; the signaling service coordinates introductions but never receives asset bytes.
4. **Bounded swarm** — a small number of upload/download peers, multi-source scheduling, resumable verified chunks, and reseeding.
5. **Persistent cache and relay policy** — browser cache, eviction, TURN-aware bulk-transfer limits, and diagnostics.

Each slice remains independently testable and preserves gameplay priority over bulk transfer.
