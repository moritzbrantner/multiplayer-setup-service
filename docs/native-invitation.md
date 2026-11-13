# Native world invitation and handoff

Stage 4 of [MMORPG #733](https://github.com/moenarch-games/mmorpg/issues/733)
supplies the static landing page. Stage 5 implements the native consumer below;
it is **not implemented by this repository or available in the current client**.
The page offers source-build instructions and a selectable public invitation,
not browser gameplay, an installer download, or a working OS deep link.

## Exact consumer contract for stage 5

The host emits this HTTPS URL, with exactly one of each public identifier:

```text
https://moenarch.com/native.html?lobbyId=0123456789AB&matchId=zone-1
```

- `lobbyId`: 12 uppercase Crockford characters `[0123456789ABCDEFGHJKMNPQRSTVWXYZ]`.
- `matchId`: game-server `MatchId`, 1–64 ASCII letters, digits, `-` or `_`.
- Reject missing, repeated or unknown parameters, fragments, userinfo, another
  origin or path. Canonical emission orders `lobbyId` then `matchId`.
- No API override, executable command, participant capability, admission ticket,
  TURN credential or reconnect secret belongs in this URL.

The agreed native argument is a single URL value:

```text
mmorpg-client --join-invite 'https://moenarch.com/native.html?lobbyId=0123456789AB&matchId=zone-1'
```

This is the **stage 5 target**, not a command supported by today's native client.
A source-built client will use the same argument after Cargo's `--` separator.
An installed client's paste-invitation route should use the same parser and
join operation when that UI exists. No OS scheme registration is required.
The native consumer fixes setup API and browser origin to `https://moenarch.com`,
validates the public IDs, then explicitly joins using the existing `Lobby::join`
and `WebRtcClient::connect` contracts in game-server's `docs/WEBRTC.md`.
The game host must authorize admission and validate match identity; possessing
an invitation does not authorize gameplay. Keep all issued secrets in memory,
out of URLs, logs, diagnostics and durable client storage. Never execute URL text.

## Landing behavior and limits

`web/native.html` reads only same-origin `GET /lobbies/:lobbyId`, without cookies
or credentials, with a five-second timeout and no cached response. It does not
join, reserve a seat, request TURN credentials, open signaling, or call the
Scrabble-only game-reference endpoint. Missing/expired lobbies, full lobbies,
invalid metadata and unavailable services produce actionable messages; users
can check again. The API's 404 cannot distinguish missing from expired.

Public counts and expiry establish only that setup metadata exists. They do not
bind the supplied match to that lobby, prove host health/readiness, or prove
revocation/authorization state. Native joining must recheck current state and
handle races, stale invitations and admission rejection. No health or registry
API is added. Saves, authoritative gameplay and missing-asset delivery stay with
their existing owners and later approved stages.

## Deployment and verification

`bun run --cwd web build` generates `native.js` and its bundled invitation module
alongside HTML/CSS. The existing Pages pipeline includes these files; the actual
`moenarch.com` deployment uses the adjacent Hetzner repository's
`dokploy/moenarch.compose.yml`, which copies this repository's built `web/`.
Merging here does not demonstrate that deployment has rebuilt, or that a native
guest has joined. Production uses the same-origin setup API; a local static
server needs to serve/proxy `/lobbies/` to exercise successful metadata reads.

Focused contract check: `bun run --cwd web build` then
`bun test web-tests/native-invite.test.ts`. Native joining, installed-client
handoff, real host health and two-network end-to-end acceptance remain unverified
until their consumer/deployment stages run.
