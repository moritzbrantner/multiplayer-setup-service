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

import {
  CONTENT_MANIFEST_PROTOCOL,
  validateTrustedManifest,
  verifyContentChunk,
} from "../web/content-verification.js";
import { ContentTransfer } from "../web/content-transfer.js";

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
    game: { id: "chunk-game", version: "1.0.0" },
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

class FakeContentSession extends EventTarget {
  constructor() {
    super();
    this.contentSharing = true;
    this.sent = [];
  }

  async sendContent(peerId, data) {
    this.sent.push({ peerId, data });
  }

  receive(peerId, data) {
    this.dispatchEvent(new CustomEvent("content", { detail: { peerId, data } }));
  }
}

function once(target, type) {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

test("trusted manifests validate exact chunk counts and hashes", async () => {
  const value = manifest();
  assert.equal(validateTrustedManifest(value), value);
  const verified = await verifyContentChunk(value, "assets/greeting.bin", 1, bytes(" worl"));
  assert.equal(verified.index, 1);
  await assert.rejects(
    () => verifyContentChunk(value, "assets/greeting.bin", 1, bytes("world")),
    /Chunk hash mismatch/,
  );

  const invalid = manifest();
  invalid.files[0].chunks.sha256 = invalid.files[0].chunks.sha256.slice(0, 2);
  assert.throws(() => validateTrustedManifest(invalid), /exactly 3 hashes/);
});

test("single-peer transfer emits only bytes that verify against the trusted manifest", async () => {
  const trusted = manifest();
  const senderSession = new FakeContentSession();
  const receiverSession = new FakeContentSession();
  const sender = new ContentTransfer({ session: senderSession, manifest: trusted });
  const receiver = new ContentTransfer({ session: receiverSession, manifest: trusted });

  await sender.sendFile("receiver", "assets/greeting.bin", bytes("hello world"));
  assert.equal(senderSession.sent.length, 5);
  assert.equal(typeof senderSession.sent[0].data, "string");
  assert.equal(typeof senderSession.sent.at(-1).data, "string");

  const receivedFile = once(receiver, "file");
  for (const message of senderSession.sent) {
    receiverSession.receive("sender", message.data);
  }
  const event = await receivedFile;
  assert.equal(event.detail.path, "assets/greeting.bin");
  assert.equal(new TextDecoder().decode(event.detail.bytes), "hello world");
  assert.equal(event.detail.verification.sha256, WHOLE_SHA256);

  sender.close();
  receiver.close();
});

test("sender refuses to seed bytes that do not match the authoritative file hash", async () => {
  const session = new FakeContentSession();
  const transfer = new ContentTransfer({ session, manifest: manifest() });
  await assert.rejects(
    () => transfer.sendFile("receiver", "assets/greeting.bin", bytes("HELLO WORLD")),
    /hash mismatch/,
  );
  assert.equal(session.sent.length, 0);
  transfer.close();
});

test("receiver rejects peer metadata that disagrees with the trusted manifest", async () => {
  const trusted = manifest();
  const senderSession = new FakeContentSession();
  const receiverSession = new FakeContentSession();
  const sender = new ContentTransfer({ session: senderSession, manifest: trusted });
  const receiver = new ContentTransfer({ session: receiverSession, manifest: trusted });
  await sender.sendFile("receiver", "assets/greeting.bin", bytes("hello world"));

  const start = JSON.parse(senderSession.sent[0].data);
  start.sha256 = "0".repeat(64);
  const error = once(receiver, "error");
  receiverSession.receive("sender", JSON.stringify(start));
  const event = await error;
  assert.match(event.detail.error.message, /does not match the trusted manifest/);

  sender.close();
  receiver.close();
});

test("receiver aborts immediately when a chunk fails its trusted hash", async () => {
  const trusted = manifest();
  const senderSession = new FakeContentSession();
  const receiverSession = new FakeContentSession();
  const sender = new ContentTransfer({ session: senderSession, manifest: trusted });
  const receiver = new ContentTransfer({ session: receiverSession, manifest: trusted });
  await sender.sendFile("receiver", "assets/greeting.bin", bytes("hello world"));

  const corrupted = senderSession.sent.map((message) => ({ ...message }));
  const frame = new Uint8Array(corrupted[2].data.slice(0));
  frame[frame.length - 1] ^= 0xff;
  corrupted[2].data = frame.buffer;

  let files = 0;
  receiver.addEventListener("file", () => {
    files += 1;
  });
  const error = once(receiver, "error");
  for (const message of corrupted.slice(0, 3)) {
    receiverSession.receive("sender", message.data);
  }
  const event = await error;
  assert.match(event.detail.error.message, /Chunk hash mismatch/);
  assert.equal(files, 0);

  sender.close();
  receiver.close();
});

test("content transfer remains opt-in at construction time", () => {
  const session = new FakeContentSession();
  session.contentSharing = false;
  assert.throws(
    () => new ContentTransfer({ session, manifest: manifest() }),
    /contentSharing enabled/,
  );
});
