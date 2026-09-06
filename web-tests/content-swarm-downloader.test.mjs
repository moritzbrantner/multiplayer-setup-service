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

import { ContentSwarmDownloader } from "../web/content-swarm-downloader.js";
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

function manifest() {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "swarm-game", version: "1.0.0" },
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

const TRUSTED_CHUNKS = new Map([
  [0, bytes("hello")],
  [1, bytes(" worl")],
  [2, bytes("d")],
]);

class FakeDiscovery {
  constructor(seedByPath = new Map()) {
    this.seedByPath = seedByPath;
  }

  seedersForPath(path) {
    return [...(this.seedByPath.get(path) ?? [])];
  }
}

class FakePeerPool extends EventTarget {
  constructor({ ready = [], capacity = 4, failures = [] } = {}) {
    super();
    this.ready = new Set(ready);
    this.connecting = new Set();
    this.capacity = capacity;
    this.failures = new Set(failures);
    this.connectCalls = [];
  }

  contentPeerIds() {
    return [...this.ready].sort();
  }

  peerIds() {
    return [...new Set([...this.ready, ...this.connecting])].sort();
  }

  hasCapacity() {
    return this.peerIds().length < this.capacity;
  }

  async connect(peerId) {
    this.connectCalls.push(peerId);
    if (this.failures.has(peerId)) throw new Error(`connect failed: ${peerId}`);
    if (!this.hasCapacity()) throw new Error("pool is full");
    this.connecting.add(peerId);
    queueMicrotask(() => {
      this.connecting.delete(peerId);
      this.ready.add(peerId);
      this.dispatchEvent(
        new CustomEvent("content-peer-ready", { detail: { peerId } }),
      );
    });
    return `${peerId}-connection`;
  }
}

class FakeExchange {
  constructor({ store, chunksByPeer = new Map(), failPeers = [] } = {}) {
    this.store = store;
    this.chunksByPeer = chunksByPeer;
    this.failPeers = new Set(failPeers);
    this.calls = [];
    this.blocker = null;
  }

  async requestChunks(peerId, path, indexes) {
    this.calls.push({ peerId, path, indexes: [...indexes] });
    if (this.blocker) await this.blocker;
    if (this.failPeers.has(peerId)) throw new Error(`source failed: ${peerId}`);

    const available = this.chunksByPeer.get(peerId) ?? new Set();
    const received = [];
    const missing = [];
    for (const index of indexes) {
      if (!available.has(index)) {
        missing.push(index);
        continue;
      }
      await this.store.putChunk(path, index, TRUSTED_CHUNKS.get(index));
      received.push(index);
    }
    return { peerId, path, received, missing };
  }
}

function createDownloader({
  seeders = ["A", "B"],
  ready = [],
  capacity = 4,
  connectFailures = [],
  chunksByPeer = new Map(),
  failPeers = [],
  store = new VerifiedChunkStore({ manifest: manifest() }),
  maxSources = 3,
  batchSize = 32,
} = {}) {
  const discovery = new FakeDiscovery(new Map([[PATH, seeders]]));
  const peerPool = new FakePeerPool({ ready, capacity, failures: connectFailures });
  const exchange = new FakeExchange({ store, chunksByPeer, failPeers });
  const downloader = new ContentSwarmDownloader({
    manifest: manifest(),
    discovery,
    peerPool,
    exchange,
    store,
    maxSources,
    batchSize,
    peerReadyTimeoutMs: 100,
  });
  return { downloader, discovery, peerPool, exchange, store };
}

test("multi-source download partitions missing chunks deterministically and verifies final file", async () => {
  const { downloader, exchange } = createDownloader({
    seeders: ["B", "A"],
    chunksByPeer: new Map([
      ["A", new Set([0, 2])],
      ["B", new Set([1])],
    ]),
  });

  const result = await downloader.download(PATH);
  assert.equal(new TextDecoder().decode(result.bytes), "hello world");
  assert.equal(result.sha256, WHOLE_SHA256);
  assert.deepEqual(result.sources, ["A", "B"]);
  assert.deepEqual(exchange.calls, [
    { peerId: "A", path: PATH, indexes: [0, 2] },
    { peerId: "B", path: PATH, indexes: [1] },
  ]);
});

test("verified local chunks are resumed rather than requested again", async () => {
  const store = new VerifiedChunkStore({ manifest: manifest() });
  await store.putChunk(PATH, 0, TRUSTED_CHUNKS.get(0));
  const { downloader, exchange } = createDownloader({
    store,
    seeders: ["A", "B"],
    chunksByPeer: new Map([
      ["A", new Set([1])],
      ["B", new Set([2])],
    ]),
  });

  const result = await downloader.download(PATH);
  assert.equal(new TextDecoder().decode(result.bytes), "hello world");
  assert.deepEqual(exchange.calls, [
    { peerId: "A", path: PATH, indexes: [1] },
    { peerId: "B", path: PATH, indexes: [2] },
  ]);
});

test("missing chunks from one partial seeder are reassigned to another source", async () => {
  const { downloader, exchange } = createDownloader({
    seeders: ["A", "B"],
    chunksByPeer: new Map([
      ["A", new Set([0])],
      ["B", new Set([0, 1, 2])],
    ]),
  });

  const result = await downloader.download(PATH);
  assert.equal(new TextDecoder().decode(result.bytes), "hello world");
  assert.ok(exchange.calls.some((call) => call.peerId === "A" && call.indexes.includes(2)));
  assert.ok(exchange.calls.some((call) => call.peerId === "B" && call.indexes.includes(2)));
});

test("failed source is excluded and remaining verified source finishes the download", async () => {
  const { downloader, exchange } = createDownloader({
    seeders: ["A", "B", "C"],
    failPeers: ["A"],
    chunksByPeer: new Map([
      ["B", new Set([0, 1, 2])],
      ["C", new Set([0, 1, 2])],
    ]),
  });
  const sourceErrors = [];
  downloader.addEventListener("source-error", (event) => sourceErrors.push(event.detail));

  const result = await downloader.download(PATH);
  assert.equal(new TextDecoder().decode(result.bytes), "hello world");
  assert.equal(sourceErrors.some((detail) => detail.peerId === "A"), true);
  assert.equal(exchange.calls.filter((call) => call.peerId === "A").length, 1);
});

test("scheduler fails closed when all advertised sources make no verified progress", async () => {
  const { downloader, store } = createDownloader({
    seeders: ["A", "B"],
    chunksByPeer: new Map([
      ["A", new Set()],
      ["B", new Set()],
    ]),
  });

  await assert.rejects(
    () => downloader.download(PATH),
    /could not provide all trusted chunks|No available seeder/,
  );
  assert.deepEqual(store.availableChunks(PATH), []);
});

test("scheduler rejects when no trusted seeder advertises the path", async () => {
  const { downloader } = createDownloader({ seeders: [] });
  await assert.rejects(() => downloader.download(PATH), /No seeders advertise/);
});

test("source count is bounded and extra advertised peers are not connected", async () => {
  const { downloader, peerPool } = createDownloader({
    seeders: ["D", "C", "B", "A", "E"],
    maxSources: 3,
    chunksByPeer: new Map([
      ["A", new Set([0, 1, 2])],
      ["B", new Set([0, 1, 2])],
      ["C", new Set([0, 1, 2])],
      ["D", new Set([0, 1, 2])],
      ["E", new Set([0, 1, 2])],
    ]),
  });

  await downloader.download(PATH);
  assert.deepEqual(peerPool.connectCalls, ["A", "B", "C"]);
});

test("concurrent requests for the same path share one deterministic download", async () => {
  const { downloader, exchange } = createDownloader({
    seeders: ["A"],
    chunksByPeer: new Map([["A", new Set([0, 1, 2])]]),
  });
  let release;
  exchange.blocker = new Promise((resolve) => {
    release = resolve;
  });

  const first = downloader.download(PATH);
  const second = downloader.download(PATH);
  assert.equal(first, second);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(exchange.calls.length, 1);
});

test("progress is derived from verified store state", async () => {
  const { downloader } = createDownloader({
    seeders: ["A", "B"],
    chunksByPeer: new Map([
      ["A", new Set([0, 2])],
      ["B", new Set([1])],
    ]),
  });
  const progress = [];
  downloader.addEventListener("progress", (event) => progress.push(event.detail));

  await downloader.download(PATH);
  assert.equal(progress[0].verifiedChunks, 0);
  assert.equal(progress.at(-1).verifiedChunks, 3);
  assert.equal(progress.at(-1).totalChunks, 3);
});
