# Game application protocols

The browser client exposes two deliberately small helpers for game traffic after WebRTC is established. They add application semantics only; WebRTC DataChannels continue to own reliable delivery, ordering, retransmission, congestion control, encryption, and message transport.

## State-changing commands

`GameCommands` wraps the existing reliable ordered gameplay channel with a namespaced command envelope.

```js
import { GameCommands } from "./game-commands.js";

const commands = new GameCommands({ session });

commands.handle("unit.move", (payload, { peerId }) => {
  // Validate peer authority and game legality before mutating state.
  game.applyMove(peerId, payload);
});

commands.sendToHost("unit.move", { unitId: "unit-7", x: 4, y: 9 });
```

The helper supports `send(peerId, command, payload)`, `sendToHost(...)`, `broadcast(...)`, and command-specific handlers. It intentionally does not add acknowledgements, retries, sequencing, request/response correlation, or state replication. Those concerns either already belong to the DataChannel or require game-specific semantics.

A received command is an untrusted state-change request. The receiving game remains authoritative for validating identity, permissions, turn order, ownership, resources, physics constraints, and every other gameplay rule before applying it.

Unrelated reliable-channel traffic is ignored. A message that explicitly claims the game-command protocol but has an invalid command envelope fails closed through the helper's `error` event.

## Requested files

`GameFiles` adds a small request/reject layer above the existing trusted content-transfer implementation.

```js
import { GameFiles } from "./game-files.js";

const files = new GameFiles({ session, manifest });

files.provide("assets/world.glb", async () => loadWorldBytes());

const worldBytes = await files.requestFile(peerId, "assets/world.glb");
```

Only the request and rejection controls use the reliable gameplay channel. The file bytes themselves are sent through `ContentTransfer`, so the existing content DataChannel, chunk verification, trusted manifest, whole-file verification, and `bufferedAmount` backpressure remain authoritative.

A provider can be registered with `provide(path, provider)`. If a game needs to decide manually, listen for the `request` event and call either `sendFile(request, bytes)` or `rejectRequest(request, reason)`.

`requestFile` resolves only after the received bytes have passed the existing trusted-manifest verification. Requests for paths outside the trusted manifest are rejected before any request is sent. Remote requests for unauthorized paths are rejected without exposing bytes.

Requests are bounded by a timeout and by a configurable total pending-request limit. Because `ContentTransfer` intentionally accepts only one active incoming transfer from a given peer, `GameFiles` preserves that invariant by allowing at most one pending file request per peer at a time rather than adding a second multiplexing layer.

## Ownership boundary

These helpers do not change the signaling service boundary. The Rust rendezvous server still sees no gameplay commands and no file bytes. Once the WebRTC channels are established, all command and file traffic remains peer-to-peer.

The intended layering is:

```text
signaling service
    |
    v
LobbySession / WebRTC DataChannels
    |                    |
    v                    v
GameCommands         GameFiles
                         |
                         v
                  ContentTransfer
```

Use `GameCommands` for state-changing application intent and `GameFiles` for manifest-authorized resource requests. Do not route high-frequency simulation snapshots, voice/video, arbitrary RPC, or generic message-bus traffic through these abstractions unless a concrete game requirement demonstrates that the semantics belong here.

## Validation

`web-tests/game-protocols.test.mjs` covers command routing and handler failures, protocol isolation, verified end-to-end file requests, explicit rejection, timeouts, request correlation, trusted-manifest rejection, and the one-active-transfer-per-peer bound. Existing content-transfer tests continue to cover chunk hashes, whole-file verification, corrupted transfers, and opt-in content sharing.
