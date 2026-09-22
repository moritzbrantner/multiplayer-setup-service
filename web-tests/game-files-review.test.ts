import assert from "node:assert/strict";
import { test } from "node:test";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import { FileRequestRejectedError, GameFiles } from "../web/game-files.js";

const WHOLE_SHA256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
const CHUNK_SHA256 = [
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "43cf897720cc5a693b2508c9e95e8711942a96ed98d772fe37123d31603ce20f",
  "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4",
];

function bytes(value) {
  return new TextEncoder().encode(value);
}

function manifest() {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "protocol-game", version: "1.0.0" },
    files: [
      {
        path: "assets/greeting.bin",
        bytes: 11,
        sha256: WHOLE_SHA256,
        role: "asset",
        chunks: { bytes: 5, sha256: CHUNK_SHA256 },
      },
    ],
  };
}

class ManualTransfer extends EventTarget {
  close() {}
}

class LinkedSession extends EventTarget {
  constructor(participantId) {
    super();
    this.participantId = participantId;
    this.hostParticipantId = "HOST0001";
    this.contentSharing = true;
    this.peers = new Map();
    this.reliableSent = [];
  }

  connect(peer) {
    this.peers.set(peer.participantId, peer);
  }

  contentPeerIds() {
    return [...this.peers.keys()];
  }

  sendReliable(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} is not ready`);
    const copy = JSON.parse(JSON.stringify(data));
    this.reliableSent.push({ peerId, data: copy });
    peer.dispatchEvent(
      new CustomEvent("reliable", { detail: { peerId: this.participantId, data: copy } }),
    );
  }

  async sendContent() {
    throw new Error("Unexpected content send in review regression test");
  }
}

function linkedPair() {
  const host = new LinkedSession("HOST0001");
  const guest = new LinkedSession("GUEST001");
  host.connect(guest);
  guest.connect(host);
  return { host, guest };
}

test("abandoned incoming requests expire instead of permanently occupying peer capacity", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const hostFiles = new GameFiles({
    session: host,
    manifest: trusted,
    incomingRequestTimeoutMs: 20,
  });
  const guestFiles = new GameFiles({ session: guest, manifest: trusted, requestTimeoutMs: 200 });
  let requestCount = 0;
  hostFiles.addEventListener("request", () => {
    requestCount += 1;
  });

  await assert.rejects(
    guestFiles.requestFile("HOST0001", "assets/greeting.bin"),
    (error) => error instanceof FileRequestRejectedError && error.reason === "request-timeout",
  );
  await assert.rejects(
    guestFiles.requestFile("HOST0001", "assets/greeting.bin"),
    (error) => error instanceof FileRequestRejectedError && error.reason === "request-timeout",
  );
  assert.equal(requestCount, 2);

  hostFiles.close();
  guestFiles.close();
});

test("GameFiles reverifies bytes against its own manifest when a transfer is injected", async () => {
  const { guest } = linkedPair();
  const transfer = new ManualTransfer();
  const files = new GameFiles({
    session: guest,
    manifest: manifest(),
    transfer,
    requestTimeoutMs: 1_000,
  });

  const requested = files.requestFile("HOST0001", "assets/greeting.bin");
  const requestId = guest.reliableSent.at(-1).data.id;
  transfer.dispatchEvent(
    new CustomEvent("file", {
      detail: {
        peerId: "HOST0001",
        path: "assets/greeting.bin",
        requestId,
        bytes: bytes("HELLO WORLD"),
      },
    }),
  );

  await assert.rejects(requested, /Content hash mismatch/);
  files.close();
});

test("participant disconnect clears outgoing and incoming file request state promptly", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const hostFiles = new GameFiles({ session: host, manifest: trusted, incomingRequestTimeoutMs: 1_000 });
  const guestFiles = new GameFiles({ session: guest, manifest: trusted, requestTimeoutMs: 1_000 });

  const requested = guestFiles.requestFile("HOST0001", "assets/greeting.bin");
  guest.dispatchEvent(
    new CustomEvent("participant-disconnected", { detail: { participantId: "HOST0001" } }),
  );
  host.dispatchEvent(
    new CustomEvent("participant-disconnected", { detail: { participantId: "GUEST001" } }),
  );

  await assert.rejects(requested, /disconnected during file request/);
  assert.doesNotThrow(() => {
    guestFiles.requestFile("HOST0001", "assets/greeting.bin").catch(() => {});
  });

  hostFiles.close();
  guestFiles.close();
});
