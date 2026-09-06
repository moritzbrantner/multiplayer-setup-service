# Security

`multiplayer-setup-service` is a signaling service, not an authoritative gameplay server.

Do not put host/guest capability tokens, TURN credentials, TLS private keys, deployment credentials, or other secrets in issues, logs, analytics events, or committed configuration. The service keeps only SHA-256 digests of room capability tokens in memory.

The public room code is an invitation identifier: anyone who obtains it before the intended guest can claim the guest seat. Share room links accordingly. The host and guest WebSocket capabilities are separate 256-bit random values.

The default production layout binds the Rust service to `127.0.0.1` and exposes it only through a TLS reverse proxy such as Caddy. GitHub Pages is HTTPS, so browsers should connect to the signaling service over HTTPS/WSS rather than plaintext HTTP/WS.

Rooms are ephemeral. A service restart intentionally invalidates rooms that have not finished setup. Existing games whose WebRTC DataChannel is already established do not depend on the signaling service.

Game clients should stop sending traffic through signaling once their WebRTC DataChannel is established. Ranked or otherwise adversarial games require a separate authoritative server because peer browsers cannot be trusted to enforce rules or prevent cheating.
