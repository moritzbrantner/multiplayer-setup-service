# Security

`multiplayer-setup-service` is a signaling service, not an authoritative gameplay server.

Do not put capability tokens, Cloudflare credentials, TURN credentials, or other secrets in issues, logs, analytics events, or committed configuration. The service stores only SHA-256 digests of room capability tokens.

Game clients should stop sending traffic through signaling once their WebRTC data channel is established. Ranked or otherwise adversarial games require a separate authoritative server because peer browsers cannot be trusted to enforce rules or prevent cheating.
