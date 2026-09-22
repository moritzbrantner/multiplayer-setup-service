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

import { ContentChunkExchange, MAX_CHUNKS_PER_REQUEST } from "../web/content-chunk-exchange.js";
import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import { VerifiedChunkStore } from "../web/verified-chunk-store.js";

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

class FakeTransport extends EventTarget {
  constructor(participantId) {
    super();
    this.participantId = participantId;
    this.contentSharing = true;
    this.peer = null;
    this.transformOutbound = null;
    this.sent = [];
  }

  connect(peer) {
    this.peer = peer;
  }

  async sendContent(peerId, data) {
    if (!this.peer || this.peer.participantId !== peerId) {
      throw new Error(`No content peer ${peerId}`);
    }
    this.sent.push(data);
    const outbound = this.transformOutbound ? this.transformOutbound(data) : data;
    queueMicrotask(() => {
      this.peer.dispatchEvent(
        new CustomEvent("content", {
          detail: { peerId: this.participantId, data: outbound },
        }),
      );
    });
  }

  closePeer(peerId) {
    this.dispatchEvent(new CustomEvent("content-peer-closed", { detail: { peerId } }));
  }
}

function transportPair() {
  const left = new FakeTransport("11111111");
  const right = new FakeTransport("22222222");
  left.connect(right);
  right.connect(left);
  return { left, right };
}

test("verified store is resumable, idempotent, and does not expose mutable trusted bytes", async () => {
  const store = new VerifiedChunkStore({ manifest: manifest() });
  const first = bytes("hello");
  await store.putChunk("assets/greeting.bin", 0, first);
  first[0] = "X".charCodeAt(0);

  assert.deepEqual(store.availableChunks("assets/greeting.bin"), [0]);
  assert.deepEqual(store.missingChunks("assets/greeting.bin"), [1, 2]);
  assert.equal(new TextDecoder().decode(store.getChunk("assets/greeting.bin", 0)), "hello");

  const retrieved = store.getChunk("assets/greeting.bin", 0);
  retrieved[0] = "Y".charCodeAt(0);
  assert.equal(new TextDecoder().decode(store.getChunk("assets/greeting.bin", 0)), "hello");

  await store.putChunk("assets/greeting.bin", 0, bytes("hello"));
  await assert.rejects(
    () => store.putChunk("assets/greeting.bin", 1, bytes("world")),
    /Chunk hash mismatch/,
  );
  await assert.rejects(() => store.assembleFile("assets/greeting.bin"), /Not all trusted chunks/);

  await store.putChunk("assets/greeting.bin", 1, bytes(" worl"));
  await store.putChunk("assets/greeting.bin", 2, bytes("d"));
  assert.equal(
    new TextDecoder().decode(await store.assembleFile("assets/greeting.bin")),
    "hello world",
  );
});

test("whole verified files can seed the chunk store atomically", async () => {
  const store = new VerifiedChunkStore({ manifest: manifest() });
  const result = await store.putFile("assets/greeting.bin", bytes("hello world"));
  assert.equal(result.chunks, 3);
  assert.deepEqual(store.availableChunks("assets/greeting.bin"), [0, 1, 2]);

  const other = new VerifiedChunkStore({ manifest: manifest() });
  await assert.rejects(
    () => other.putFile("assets/greeting.bin", bytes("HELLO WORLD")),
    /hash mismatch/,
  );
  assert.deepEqual(other.availableChunks("assets/greeting.bin"), []);
});

test("requester receives only verified requested chunks", async () => {
  const trusted = manifest();
  const { left, right } = transportPair();
  const leecherStore = new VerifiedChunkStore({ manifest: trusted });
  const seederStore = new VerifiedChunkStore({ manifest: trusted });
  await seederStore.putFile("assets/greeting.bin", bytes("hello world"));

  const leecher = new ContentChunkExchange({ transport: left, manifest: trusted, store: leecherStore });
  const seeder = new ContentChunkExchange({ transport: right, manifest: trusted, store: seederStore });

  const result = await leecher.requestChunks("22222222", "assets/greeting.bin", [2, 0]);
  assert.deepEqual(result.received, [0, 2]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(leecherStore.availableChunks("assets/greeting.bin"), [0, 2]);
  assert.equal(new TextDecoder().decode(leecherStore.getChunk("assets/greeting.bin", 0)), "hello");
  assert.equal(new TextDecoder().decode(leecherStore.getChunk("assets/greeting.bin", 2)), "d");

  leecher.close();
  seeder.close();
});

test("partial seeders return available chunks and leave the rest resumable", async () => {
  const trusted = manifest();
  const { left, right } = transportPair();
  const leecherStore = new VerifiedChunkStore({ manifest: trusted });
  const partialStore = new VerifiedChunkStore({ manifest: trusted });
  await partialStore.putChunk("assets/greeting.bin", 0, bytes("hello"));

  const leecher = new ContentChunkExchange({ transport: left, manifest: trusted, store: leecherStore });
  const partialSeeder = new ContentChunkExchange({
    transport: right,
    manifest: trusted,
    store: partialStore,
  });

  const result = await leecher.requestChunks("22222222", "assets/greeting.bin", [0, 1]);
  assert.deepEqual(result.received, [0]);
  assert.deepEqual(result.missing, [1]);
  assert.deepEqual(leecherStore.availableChunks("assets/greeting.bin"), [0]);

  leecher.close();
  partialSeeder.close();
});

test("corrupt peer chunks reject the request and never enter the verified store", async () => {
  const trusted = manifest();
  const { left, right } = transportPair();
  const leecherStore = new VerifiedChunkStore({ manifest: trusted });
  const seederStore = new VerifiedChunkStore({ manifest: trusted });
  await seederStore.putFile("assets/greeting.bin", bytes("hello world"));

  right.transformOutbound = (value) => {
    if (typeof value === "string") return value;
    const corrupted = new Uint8Array(value.slice(0));
    corrupted[corrupted.length - 1] ^= 0xff;
    return corrupted.buffer;
  };

  const leecher = new ContentChunkExchange({ transport: left, manifest: trusted, store: leecherStore });
  const seeder = new ContentChunkExchange({ transport: right, manifest: trusted, store: seederStore });

  await assert.rejects(
    () => leecher.requestChunks("22222222", "assets/greeting.bin", [0]),
    /Chunk hash mismatch/,
  );
  assert.deepEqual(leecherStore.availableChunks("assets/greeting.bin"), []);

  leecher.close();
  seeder.close();
});

test("chunk requests are bounded and pending requests fail when their peer closes", async () => {
  const trusted = manifest();
  const { left, right } = transportPair();
  const store = new VerifiedChunkStore({ manifest: trusted });
  const exchange = new ContentChunkExchange({
    transport: left,
    manifest: trusted,
    store,
    requestTimeoutMs: 100,
  });

  await assert.rejects(
    () =>
      exchange.requestChunks(
        "22222222",
        "assets/greeting.bin",
        Array.from({ length: MAX_CHUNKS_PER_REQUEST + 1 }, (_, index) => index),
      ),
    /between 1 and/,
  );

  const pending = exchange.requestChunks("22222222", "assets/greeting.bin", [0]);
  left.closePeer("22222222");
  await assert.rejects(() => pending, /Content peer closed/);

  exchange.close();
  right.closePeer("11111111");
});
