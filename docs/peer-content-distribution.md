# Optional peer content distribution

Peer-assisted content distribution is an optional browser capability for games with large shared assets. It is not part of the default lobby or gameplay path. Games that do not opt in continue to use the existing signaling and WebRTC gameplay foundation unchanged.

## Trust boundary

Peers are untrusted byte transports. They are never authoritative for game logic, assets, versions, or manifests.

A game that opts in configures a trusted manifest URL owned by its original HTTPS origin or repository/release infrastructure. The browser fetches that manifest directly from the configured trusted location and then verifies every byte received from another player against the manifest before making it available to the game.

The first browser slice implements only this trust foundation. It does not create asset DataChannels, advertise seeders, or transfer chunks yet.

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
      "sha256": "<64 lowercase hex characters>",
      "role": "asset"
    },
    {
      "path": "logic/game.wasm",
      "bytes": 524288,
      "sha256": "<64 lowercase hex characters>",
      "role": "logic"
    }
  ]
}
```

`role: "asset"` marks ordinary content such as textures, models, audio, maps, or data. `role: "logic"` marks execution-critical JavaScript, WASM, scripts, deterministic rule data, or other files that influence game behavior.

Every path is relative and traversal-free. Every entry has an exact byte length and SHA-256 digest. Files absent from the trusted manifest are not authorized, even if a peer offers them.

## Authoritative source options

The manifest URL is game configuration, not lobby state and not peer input. Suitable authorities include:

- the game's own HTTPS origin, for example a GitHub Pages deployment;
- a release-specific path on the game's server;
- an immutable repository/release URL pinned to a commit or release when stronger reproducibility is desired.

The browser helper requires HTTPS except for loopback development URLs. A game can also configure an explicit allow-list of trusted manifest origins.

The multiplayer setup service does not copy, rewrite, cache, sign, or approve the manifest. This keeps the setup service provider-neutral and prevents the rendezvous server from becoming the game authority.

## Game logic verification

Execution-critical files are verified more strictly as a set:

1. fetch the manifest from the configured trusted source;
2. identify every `logic` entry;
3. require every trusted logic file to be present;
4. verify exact byte size and SHA-256 for each file;
5. derive a deterministic logic fingerprint from the trusted game id, version, paths, sizes, and hashes;
6. expose only the verified trusted logic entries to the game.

Extra files supplied by a peer are not part of the verified logic set. A matching peer-to-peer fingerprint can be used later as a cheap compatibility check, but the fingerprint advertised by another peer is never itself a source of trust.

## Optionality invariant

No existing game needs to opt in. `LobbySession` remains unchanged in this slice, and no third DataChannel is created automatically. Later slices must preserve the same invariant: content distribution is enabled explicitly by a game and must never consume bandwidth or create content-specific peer relationships for games that do not request it.

## Planned slices

1. **Trusted manifest and verification** — implemented first; fail-closed SHA-256 verification and deterministic logic fingerprints.
2. **Single-peer chunk transport** — explicitly enabled content DataChannel, bounded chunks, backpressure, and per-chunk/final verification.
3. **Seeder advertisement** — lobby-scoped opt-in availability metadata; the signaling service coordinates introductions but never receives asset bytes.
4. **Bounded swarm** — a small number of upload/download peers, multi-source scheduling, resumable verified chunks, and reseeding.
5. **Persistent cache and relay policy** — browser cache, eviction, TURN-aware bulk-transfer limits, and diagnostics.

Each slice should remain independently testable and preserve gameplay priority over bulk transfer.
