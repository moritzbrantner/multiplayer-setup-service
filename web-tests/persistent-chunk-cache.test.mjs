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

import { ContentChunkExchange } from "../web/content-chunk-exchange.js";
import { ContentSwarmDownloader } from "../web/content-swarm-downloader.js";
import { PersistentVerifiedChunkCache } from "../web/persistent-chunk-cache.js";
import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import { VerifiedChunkStore } from "../web/verified-chunk-store.js";

const WHOLE_SHA256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
const CHUNK_SHA256 = [
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "43cf897720cc5a693b2508c9e95e8711942a96ed98d772fe37123d31603ce20f",
  "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4",
];
const PATH = "assets/greeting.bin";

function bytes(value) {
  return new TextEncoder().encode(value);
}

function manifest(version = "1.0.0") {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "cache-game", version },
    files: [
      {
        path: PATH,
        bytes: 11,
        sha256: WHOLE_SHA256,
        role: "asset",
        chunks: { bytes: 5, sha256: CHUNK_SHA256 },
      },
    ],
  };
}

function cloneRecord(record) {
  return {
    ...record,
    bytes: record.bytes instanceof ArrayBuffer ? record.bytes.slice(0) : record.bytes,
  };
}

class MemoryCacheBackend {
  constructor() {
    this.records = new Map();
  }

  async get(key) {
    const record = this.records.get(key);
    return record ? cloneRecord(record) : null;
  }

  async put(record) {
    this.records.set(record.key, cloneRecord(record));
  }

  async delete(key) {
    this.records.delete(key);
  }

  async listFile(namespace) {
    return [...this.records.values()]
      .filter((record) => record.fileNamespace === namespace)
      .map(cloneRecord);
  }

  async listScope(scope) {
    return [...this.records.values()]
      .filter((record) => record.scope === scope)
      .map(cloneRecord);
  }

  async clearScope(scope) {
    for (const [key, record] of this.records) {
      if (record.scope === scope) this.records.delete(key);
    }
  }
}

class FakeTransport extends EventTarget {
  constructor(participantId) {
    super();
    this.participantId = participantId;
    this.contentSharing = true;
    this.peer = null;
  }

  connect(peer) {
    this.peer = peer;
  }

  async sendContent(peerId, data) {
    if (!this.peer || this.peer.participantId !== peerId) throw new Error("missing content peer");
    queueMicrotask(() => {
      this.peer.dispatchEvent(
        new CustomEvent("content", {
          detail: { peerId: this.participantId, data },
        }),
      );
    });
  }
}

function transportPair() {
  const left = new FakeTransport("11111111");
  const right = new FakeTransport("22222222");
  left.connect(right);
  right.connect(left);
  return { left, right };
}

test("persistent cache accepts only trusted chunks and stores independent byte copies", async () => {
  const backend = new MemoryCacheBackend();
  let now = 1;
  const cache = new PersistentVerifiedChunkCache({
    manifest: manifest(),
    backend,
    maxBytes: 100,
    now: () => now++,
  });

  const source = bytes("hello");
  await cache.putChunk(PATH, 0, source);
  source[0] = "X".charCodeAt(0);

  assert.deepEqual(await cache.stats(), { chunks: 1, bytes: 5, maxBytes: 100 });
  const persisted = [...backend.records.values()][0];
  assert.equal(new TextDecoder().decode(new Uint8Array(persisted.bytes)), "hello");

  await assert.rejects(() => cache.putChunk(PATH, 1, bytes("world")), /Chunk hash mismatch/);
  assert.equal((await cache.stats()).chunks, 1);
});

test("restored persistent chunks are reverified before becoming seedable", async () => {
  const backend = new MemoryCacheBackend();
  const cache = new PersistentVerifiedChunkCache({ manifest: manifest(), backend, maxBytes: 100 });
  await cache.putChunk(PATH, 0, bytes("hello"));
  await cache.putChunk(PATH, 1, bytes(" worl"));

  const stored = [...backend.records.values()].find((record) => record.index === 1);
  const corrupted = new Uint8Array(stored.bytes);
  corrupted[0] ^= 0xff;
  stored.bytes = corrupted.buffer;

  const store = new VerifiedChunkStore({ manifest: manifest() });
  const result = await cache.restorePath(PATH, store);
  assert.deepEqual(result.restored, [0]);
  assert.deepEqual(result.discarded, [1]);
  assert.deepEqual(store.availableChunks(PATH), [0]);
  assert.equal((await cache.stats()).chunks, 1);
});

test("cache namespaces releases and never restores bytes under another trusted version", async () => {
  const backend = new MemoryCacheBackend();
  const first = new PersistentVerifiedChunkCache({ manifest: manifest("1.0.0"), backend, maxBytes: 100 });
  await first.putChunk(PATH, 0, bytes("hello"));

  const secondManifest = manifest("2.0.0");
  const second = new PersistentVerifiedChunkCache({ manifest: secondManifest, backend, maxBytes: 100 });
  const secondStore = new VerifiedChunkStore({ manifest: secondManifest });
  const result = await second.restorePath(PATH, secondStore);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(secondStore.availableChunks(PATH), []);
  assert.equal((await second.stats()).chunks, 1);
});

test("LRU pruning keeps cache usage within the explicit per-game bound", async () => {
  const backend = new MemoryCacheBackend();
  let clock = 0;
  const cache = new PersistentVerifiedChunkCache({
    manifest: manifest(),
    backend,
    maxBytes: 6,
    now: () => ++clock,
  });

  await cache.putChunk(PATH, 0, bytes("hello"));
  await cache.putChunk(PATH, 2, bytes("d"));
  await cache.putChunk(PATH, 1, bytes(" worl"));

  const records = [...backend.records.values()].sort((left, right) => left.index - right.index);
  assert.deepEqual(records.map((record) => record.index), [1, 2]);
  assert.deepEqual(await cache.stats(), { chunks: 2, bytes: 6, maxBytes: 6 });
});

test("persistence request remains explicit and reports browser storage-manager result", async () => {
  const cache = new PersistentVerifiedChunkCache({
    manifest: manifest(),
    backend: new MemoryCacheBackend(),
    maxBytes: 100,
  });
  assert.equal(await cache.requestPersistence(null), false);
  assert.equal(await cache.requestPersistence({ persist: async () => true }), true);
});

test("chunk exchange cache failures are non-fatal after cryptographic verification", async () => {
  const trusted = manifest();
  const { left, right } = transportPair();
  const leecherStore = new VerifiedChunkStore({ manifest: trusted });
  const seederStore = new VerifiedChunkStore({ manifest: trusted });
  await seederStore.putFile(PATH, bytes("hello world"));

  const cache = {
    async putChunk() {
      throw new Error("quota exceeded");
    },
  };
  const leecher = new ContentChunkExchange({
    transport: left,
    manifest: trusted,
    store: leecherStore,
    cache,
  });
  const seeder = new ContentChunkExchange({ transport: right, manifest: trusted, store: seederStore });
  const cacheErrors = [];
  leecher.addEventListener("cache-error", (event) => cacheErrors.push(event.detail));

  const result = await leecher.requestChunks("22222222", PATH, [0]);
  assert.deepEqual(result.received, [0]);
  assert.deepEqual(leecherStore.availableChunks(PATH), [0]);
  assert.equal(cacheErrors.length, 1);
  assert.match(cacheErrors[0].error.message, /quota exceeded/);

  leecher.close();
  seeder.close();
});

test("swarm restores a complete trusted cache before requiring any seeder", async () => {
  const trusted = manifest();
  const backend = new MemoryCacheBackend();
  const cache = new PersistentVerifiedChunkCache({ manifest: trusted, backend, maxBytes: 100 });
  await cache.putFile(PATH, bytes("hello world"));

  const store = new VerifiedChunkStore({ manifest: trusted });
  const downloader = new ContentSwarmDownloader({
    manifest: trusted,
    discovery: { seedersForPath: () => [] },
    peerPool: {
      connect: async () => {
        throw new Error("network should not be used");
      },
      contentPeerIds: () => [],
      peerIds: () => [],
      hasCapacity: () => false,
    },
    exchange: {
      requestChunks: async () => {
        throw new Error("network should not be used");
      },
    },
    store,
    cache,
  });

  const result = await downloader.download(PATH);
  assert.equal(new TextDecoder().decode(result.bytes), "hello world");
  assert.deepEqual(result.sources, []);
  assert.deepEqual(store.availableChunks(PATH), [0, 1, 2]);
});
