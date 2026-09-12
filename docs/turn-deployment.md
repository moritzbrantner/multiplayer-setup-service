# TURN fallback deployment

`multiplayer-setup-service` keeps direct WebRTC as the normal path. TURN is a fallback for peers that cannot establish a usable direct route through NAT or firewall restrictions.

TURN is optional. If `TURN_URLS` and `TURN_SHARED_SECRET` are not configured, the authenticated credential endpoint returns `503 turn-not-configured` and existing direct WebRTC behavior is unchanged.

## Trust boundary

The coturn shared secret is infrastructure authority and must remain server-side. It is never embedded in GitHub Pages, sent to peers, or stored in lobby state.

An authenticated lobby participant requests short-lived credentials from:

```text
POST /lobbies/:lobbyId/turn-credentials
Authorization: Bearer <participant capability>
Content-Type: application/json

{"participantId":"1234ABCD"}
```

The setup service verifies that the capability belongs to that participant in that lobby before issuing credentials.

The response is standard WebRTC ICE configuration:

```json
{
  "iceServers": [
    {
      "urls": [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turn.example.com:5349?transport=tcp"
      ],
      "username": "1789170000:1234ABCD",
      "credential": "<temporary password>"
    }
  ],
  "expiresAt": 1789170000000
}
```

The timestamp embedded in the username is the credential expiry. The temporary password follows coturn's TURN REST authentication convention: Base64(HMAC-SHA1(shared-secret, username)). The browser never learns the shared secret.

## Setup service configuration

Set all TURN values in the service environment, not in the static client bundle:

```text
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=<long random secret>
TURN_CREDENTIAL_TTL_SECONDS=600
```

`TURN_CREDENTIAL_TTL_SECONDS` is bounded to 60–3600 seconds. Ten minutes is the default.

`TURN_URLS` and `TURN_SHARED_SECRET` must be configured together. Partial or invalid configuration fails closed with `503 turn-misconfigured` after participant authentication.

## coturn configuration

Use coturn's REST-auth/shared-secret mode. A minimal starting point is:

```text
fingerprint
use-auth-secret
static-auth-secret=<same value as TURN_SHARED_SECRET>
realm=turn.example.com

listening-port=3478
tls-listening-port=5349

min-port=49152
max-port=65535

cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

Keep coturn's `static-auth-secret` and the setup service's `TURN_SHARED_SECRET` synchronized. For rotation, configure coturn to accept the old and new secret during the overlap window, switch the credential issuer to the new secret, then remove the old secret after all previously issued credentials have expired.

The exact coturn service/user paths vary by distribution. Run coturn as a dedicated unprivileged service account and keep the configuration containing the shared secret readable only by that account/root.

## DNS and firewall

Create a dedicated DNS name such as `turn.example.com` pointing directly to the TURN server.

Allow the transport ports you actually advertise:

- UDP/TCP 3478 for `turn:`;
- TCP 5349 for `turns:` when TLS is enabled;
- the configured UDP relay range, for example 49152–65535.

TURN media/relay traffic should go directly to coturn. Do not try to carry UDP TURN relay traffic through the Caddy HTTP reverse proxy used for the signaling API.

If the host is behind NAT, configure coturn's external/public address according to the coturn deployment documentation.

## Browser integration

The browser helper requests credentials using the existing participant capability and installs them on the resilient lobby session:

```js
import { refreshTurnIceServers } from "./turn-credentials.js";

await refreshTurnIceServers(session);
```

`ResilientLobbySession` remains direct-first. It uses the TURN configuration during peer recovery rather than forcing every peer through the relay from the start.

Refresh credentials before their `expiresAt` when a long-lived lobby still needs future recovery. Do not persist temporary TURN passwords longer than their lifetime.

## Bulk-content cost boundary

Gameplay may need TURN to remain connected, but large peer-content transfers can create substantial relay bandwidth cost. `ContentPeerPool` therefore denies bulk sends over a positively identified relay path by default.

Games may explicitly choose:

```js
new ContentPeerPool({ session, relayPolicy: "deny" });  // default
new ContentPeerPool({ session, relayPolicy: "allow" });
new ContentPeerPool({
  session,
  relayPolicy: "limit",
  relayMaxBytesPerSecond: 256 * 1024,
});
```

The relay decision is derived locally from the selected ICE candidate pair reported by WebRTC statistics, never from a peer's claim.

## Operational verification

Before production use, verify all of the following from a network that cannot establish the direct path:

1. lobby creation and normal signaling still work without TURN;
2. an authenticated participant can obtain temporary credentials;
3. invalid/missing participant capabilities cannot obtain credentials;
4. coturn accepts the generated username/password before `expiresAt` and rejects it after expiry;
5. failed direct connectivity recovers through TURN;
6. gameplay remains functional on the relay;
7. bulk content remains blocked on relay unless the game explicitly selected an allow/limit policy;
8. the shared secret never appears in browser bundles, API responses, logs, or repository history.
