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

import { ContentTransfer } from "../web/content-transfer.js";
import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import { GAME_COMMAND_PROTOCOL, GameCommands } from "../web/game-commands.js";
import { FileRequestRejectedError, GAME_FILE_PROTOCOL, GameFiles } from "../web/game-files.js";

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

function cloneBinary(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

class LinkedSession extends EventTarget {
  constructor(participantId, hostParticipantId = "HOST0001") {
    super();
    this.participantId = participantId;
    this.hostParticipantId = hostParticipantId;
    this.contentSharing = true;
    this.peers = new Map();
    this.reliableSent = [];
    this.contentSent = [];
  }

  connect(peer) {
    this.peers.set(peer.participantId, peer);
  }

  contentPeerIds() {
    return [...this.peers.keys()].sort();
  }

  sendReliable(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} is not ready`);
    const serialized = JSON.stringify(data);
    this.reliableSent.push({ peerId, data: JSON.parse(serialized) });
    peer.dispatchEvent(
      new CustomEvent("reliable", {
        detail: { peerId: this.participantId, data: JSON.parse(serialized) },
      }),
    );
  }

  broadcastReliable(data, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.peers.keys()) {
      if (!excluded.has(peerId)) this.sendReliable(peerId, data);
    }
  }

  async sendContent(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Content channel for peer ${peerId} is not ready`);
    const copy = cloneBinary(data);
    this.contentSent.push({ peerId, data: copy });
    peer.dispatchEvent(
      new CustomEvent("content", {
        detail: { peerId: this.participantId, data: copy },
      }),
    );
  }
}

function linkedPair() {
  const host = new LinkedSession("HOST0001", "HOST0001");
  const guest = new LinkedSession("GUEST001", "HOST0001");
  host.connect(guest);
  guest.connect(host);
  return { host, guest };
}

function once(target, type) {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

test("game commands send only application command semantics over the existing reliable channel", async () => {
  const { host, guest } = linkedPair();
  const hostCommands = new GameCommands({ session: host });
  const guestCommands = new GameCommands({ session: guest });
  const handled = new Promise((resolve) => {
    hostCommands.handle("unit.move", (payload, detail) => resolve({ payload, detail }));
  });

  guestCommands.sendToHost("unit.move", { unitId: "u-7", x: 4, y: 9 });
  const received = await handled;

  assert.deepEqual(received.payload, { unitId: "u-7", x: 4, y: 9 });
  assert.equal(received.detail.peerId, "GUEST001");
  assert.deepEqual(guest.reliableSent[0].data, {
    protocol: GAME_COMMAND_PROTOCOL,
    command: "unit.move",
    payload: { unitId: "u-7", x: 4, y: 9 },
  });

  hostCommands.close();
  guestCommands.close();
});

test("game commands ignore unrelated reliable traffic and fail closed on malformed command envelopes", async () => {
  const { host, guest } = linkedPair();
  const commands = new GameCommands({ session: host });
  let commandCount = 0;
  commands.addEventListener("command", () => {
    commandCount += 1;
  });

  guest.sendReliable("HOST0001", { protocol: "some-other-protocol", value: 1 });
  assert.equal(commandCount, 0);

  const error = once(commands, "error");
  guest.sendReliable("HOST0001", { protocol: GAME_COMMAND_PROTOCOL, command: "bad command" });
  const event = await error;
  assert.match(event.detail.error.message, /protocol-safe name/);
  assert.equal(commandCount, 0);
  commands.close();
});

test("command handlers surface asynchronous failures without inventing request-response semantics", async () => {
  const { host, guest } = linkedPair();
  const hostCommands = new GameCommands({ session: host });
  const guestCommands = new GameCommands({ session: guest });
  hostCommands.handle("turn.end", async () => {
    throw new Error("illegal turn transition");
  });

  const error = once(hostCommands, "error");
  guestCommands.sendToHost("turn.end", null);
  const event = await error;
  assert.equal(event.detail.command, "turn.end");
  assert.match(event.detail.error.message, /illegal turn transition/);

  hostCommands.close();
  guestCommands.close();
});

test("game files request a manifest-authorized file and reuse ContentTransfer for verified bulk bytes", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const hostFiles = new GameFiles({ session: host, manifest: trusted });
  const guestFiles = new GameFiles({ session: guest, manifest: trusted });
  hostFiles.provide("assets/greeting.bin", () => bytes("hello world"));

  const progress = [];
  guestFiles.addEventListener("progress", (event) => progress.push(event.detail.receivedChunks));
  const result = await guestFiles.requestFile("HOST0001", "assets/greeting.bin");

  assert.equal(new TextDecoder().decode(result), "hello world");
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(guest.reliableSent[0].data.protocol, GAME_FILE_PROTOCOL);
  assert.equal(guest.reliableSent[0].data.type, "request");
  assert.equal(host.contentSent.length, 5);

  hostFiles.close();
  guestFiles.close();
});

test("manual file requests can be explicitly rejected and reject the requester immediately", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const hostFiles = new GameFiles({ session: host, manifest: trusted });
  const guestFiles = new GameFiles({ session: guest, manifest: trusted });

  hostFiles.addEventListener("request", (event) => {
    hostFiles.rejectRequest(event.detail, "host-policy");
  });

  await assert.rejects(
    guestFiles.requestFile("HOST0001", "assets/greeting.bin"),
    (error) =>
      error instanceof FileRequestRejectedError &&
      error.path === "assets/greeting.bin" &&
      error.reason === "host-policy",
  );

  hostFiles.close();
  guestFiles.close();
});

test("file requests are bounded by a timeout rather than remaining pending forever", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const hostFiles = new GameFiles({ session: host, manifest: trusted });
  const guestFiles = new GameFiles({ session: guest, manifest: trusted, requestTimeoutMs: 20 });

  await assert.rejects(
    guestFiles.requestFile("HOST0001", "assets/greeting.bin"),
    /File request timed out/,
  );

  hostFiles.close();
  guestFiles.close();
});

test("ContentTransfer propagates an optional request id without changing its transport behavior", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const sender = new ContentTransfer({ session: host, manifest: trusted });
  const receiver = new ContentTransfer({ session: guest, manifest: trusted });
  const file = once(receiver, "file");

  await sender.sendFile("GUEST001", "assets/greeting.bin", bytes("hello world"), {
    requestId: "0123456789abcdef",
  });
  const event = await file;

  assert.equal(event.detail.requestId, "0123456789abcdef");
  assert.equal(new TextDecoder().decode(event.detail.bytes), "hello world");
  const start = JSON.parse(host.contentSent[0].data);
  assert.equal(start.requestId, "0123456789abcdef");

  sender.close();
  receiver.close();
});

test("file requests refuse paths outside the trusted manifest before sending anything", () => {
  const { guest } = linkedPair();
  const files = new GameFiles({ session: guest, manifest: manifest() });
  assert.throws(
    () => files.requestFile("HOST0001", "../../secrets.bin"),
    /not authorized by the trusted manifest/,
  );
  assert.equal(guest.reliableSent.length, 0);
  files.close();
});

test("file requests preserve ContentTransfer's one-active-transfer-per-peer bound", async () => {
  const { host, guest } = linkedPair();
  const trusted = manifest();
  const hostFiles = new GameFiles({ session: host, manifest: trusted });
  const guestFiles = new GameFiles({ session: guest, manifest: trusted, requestTimeoutMs: 20 });

  const first = guestFiles.requestFile("HOST0001", "assets/greeting.bin");
  assert.throws(
    () => guestFiles.requestFile("HOST0001", "assets/greeting.bin"),
    /already has a pending file request/,
  );
  await assert.rejects(first, /File request timed out/);

  hostFiles.close();
  guestFiles.close();
});
