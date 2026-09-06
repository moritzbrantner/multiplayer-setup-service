# Multi-participant lobbies

`/rooms` remains the compact two-player API used by the original Tic-Tac-Toe and Pong demos.

`/lobbies` is the additive multi-participant API. It supports 2–16 authenticated participants and targeted WebRTC signaling without choosing a gameplay topology for the client.

## HTTP

Create a lobby:

```http
POST /lobbies
Content-Type: application/json

{"maxParticipants":16}
```

Response:

```json
{
  "lobbyId": "0123ABCDEFGH",
  "displayCode": "0123-ABCD-EFGH",
  "participantId": "1234ABCD",
  "participantToken": "<64 hex characters>",
  "hostParticipantId": "1234ABCD",
  "expiresAt": 1788700000000,
  "maxParticipants": 16,
  "websocketPath": "/lobbies/0123ABCDEFGH/connect"
}
```

Join with `POST /lobbies/:lobbyId/join`. Each participant receives an independent capability token. Only its SHA-256 digest is kept in memory.

`GET /lobbies/:lobbyId` returns the participant count, configured limit, host participant ID, and expiry.

## Signaling

Connect with:

```text
GET /lobbies/:lobbyId/connect?participantId=<participant-id>
Sec-WebSocket-Protocol: multiplayer-setup-v1, cap.<participant-token>
```

A participant sends WebRTC setup data to one specific participant:

```json
{"type":"signal","to":"89ABCDEF","payload":{"description":{"type":"offer","sdp":"..."}}}
```

The receiver gets the same opaque payload plus `from`. The service also emits `connected`, `participant-connected`, `participant-disconnected`, `pong`, and `error`.

The server validates membership and capability tokens, but the signaling payload remains opaque.

## Topologies

Topology is intentionally a client concern.

### Full mesh

Every participant forms a direct WebRTC link to every other participant. For `n` participants the number of peer relationships is `n × (n - 1) / 2`. At 16 participants that is 120 peer relationships, with 15 connections per browser.

This is useful when messages are small, game state can be simulated deterministically on every client, only player inputs or compact commands need to cross the network, and no authoritative anti-cheat server is required.

### Host-spoke

The host forms one link to every guest. Guests only connect to the host. At 16 participants this is 15 peer relationships. The host can relay the same input command to the other guests while every browser still performs the game calculation locally.

The host is a transport hub in this topology, not automatically an authoritative gameplay server.

## Browser foundation

`web/lobby-session.js` provides `LobbySession` with `mesh` and `host` topologies. It creates one `RTCPeerConnection` per required topology edge and gives each edge a reliable ordered channel plus an unordered `maxRetransmits: 0` realtime channel.

The signaling WebSocket stays open during the lobby lifetime because later participants may need new WebRTC setup exchanges.

## Input-only deterministic model

`web/arena.html` is a deliberately simple test of the model:

1. each participant starts from deterministic integer coordinates derived from its participant ID;
2. holding a movement key produces a compact step command at 20 Hz;
3. the sender applies that command locally;
4. mesh mode sends the command directly to every other participant;
5. host-spoke mode sends guest commands to the host, which relays the unchanged command to the other guests;
6. every receiver applies the exact same integer transition locally.

No continuous position snapshots are required for normal movement. A host snapshot is used only to bootstrap a participant that joins after earlier commands have already happened.

This is a foundation experiment, not a complete lockstep/rollback networking model. Later horizons can add fixed simulation ticks, redundant input windows, state hashes, rollback, host migration, lobby sealing, and TURN testing.
