# Local multiplayer demos

The demos exercise the browser-to-browser layer above the signaling service without adding demo code to the production Rust runtime.

## Run

Requirements: Rust 1.98.0 (pinned by the repository) and Python 3.

```bash
./run-local-demos.sh
```

Then open:

```text
http://127.0.0.1:5173/
```

Open the same game in two tabs. In the first tab choose **Host game**. Copy the displayed room code into the second tab and choose **Join game**.

The script runs the real signaling service on `127.0.0.1:8787` and a local static-file server for `web/` on `127.0.0.1:5173`.

## What the demos exercise

### Tic-Tac-Toe

- reliable, ordered `RTCDataChannel`;
- deterministic turn validation on both peers;
- ply and pre-move board key checks to reject stale/desynchronized moves;
- host-controlled reset.

### Pong

- unordered channel with `maxRetransmits: 0` for realtime paddle input and snapshots;
- monotonically increasing realtime sequence numbers so stale packets are ignored;
- host peer owns the ball simulation for the demo;
- guest renders interpolated host snapshots;
- reliable channel carries score/reset events.

The host-authoritative Pong model is only a demo networking strategy. It is not an anti-cheat boundary because the host is still an untrusted browser.

## Reusable browser foundation

`web/session.js` owns only connection/session transport:

- room creation/joining;
- signaling WebSocket authentication;
- WebRTC offer/answer/ICE exchange;
- one reliable ordered DataChannel;
- one unordered zero-retransmit realtime DataChannel;
- realtime sequence filtering;
- releasing signaling after peer-to-peer setup is complete.

Game semantics stay in their game modules.

By default the demos use `http://127.0.0.1:8787`. Override the signaling endpoint with the `api` query parameter, for example:

```text
http://127.0.0.1:5173/pong.html?api=https://multiplayer.example.com
```

The signaling service must allow the page origin through `ALLOWED_ORIGINS`.
