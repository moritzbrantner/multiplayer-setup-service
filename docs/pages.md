# GitHub Pages explainer

The GitHub Pages site publishes only the static `web/` directory. It explains the rendezvous architecture and hosts the existing browser demos, but it does not contain or replace the Rust signaling service.

The landing page demonstrates three setup phases:

1. create a short-lived room or lobby and issue private participant capabilities;
2. relay authenticated, opaque SDP/ICE signaling over WebSocket;
3. move gameplay onto WebRTC DataChannels whenever a direct route is possible, with TURN remaining a possible transport relay when necessary.

The interactive topology graph reuses `topologyEdgeCount` from `web/arena-model.mjs` rather than maintaining a second connection-count formula. It visualizes both full mesh and host-spoke layouts for 2–16 players.

The demo endpoint field only rewrites links with the existing `?api=` contract. It never stores a capability token, lobby secret, or game state; only the chosen public setup-service base URL is retained in browser local storage for convenience.

The Pages workflow validates JavaScript syntax and all local HTML asset references on pull requests. Deployment runs only after merge to `main`, uploads only `web/`, and grants `pages: write` plus `id-token: write` solely to the deployment job.
