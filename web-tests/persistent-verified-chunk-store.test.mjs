import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import {
  MemoryChunkPersistence,
  PersistentVerifiedChunkStore,
} from "../web/persistent-verified-chunk-store.js";

const contents = new Map([
  ["assets/hello.bin", { bytes: new TextEncoder().encode("hello"), sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }],
  ["assets/world.bin", { bytes: new TextEncoder().encode("world"), sha256: "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7" }],
  ["assets/cache.bin", { bytes: new TextEncoder().encode("cache"), sha256: "5e1ecee06a7fc06f305ae5c12acfe7a7f67b8ece7af76932ed3afab00c3c6921" }],
]);

const hello = contents.get("assets/hello.bin").bytes;

function file(path) {
  const content = contents.get(path);
  return {
    path,
    bytes: content.bytes.byteLength,
    sha256: content.sha256,
    role: "asset",
    chunks: { bytes: content.bytes.byteLength, sha256: [content.sha256] },
  };
}

function manifest(version = "1", paths = ["assets/hello.bin"]) {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "cache-test", version },
    files: paths.map(file),
  };
}

function monotonicNow(start = 100) {
  let value = start;
  return () => value++;
}

test("verified chunks survive a new store instance", async () => {
  const persistence = new MemoryChunkPersistence();
  const first = new PersistentVerifiedChunkStore({ manifest: manifest(), persistence });
  await first.ready;
  await first.putChunk("assets/hello.bin", 0, hello);

  const second = new PersistentVerifiedChunkStore({ manifest: manifest(), persistence });
  assert.deepEqual(await second.ready, { accepted: 1, rejected: 0 });
  assert.equal(new TextDecoder().decode(second.getChunk("assets/hello.bin", 0)), "hello");
});

test("corrupt persisted chunks are evicted during hydration", async () => {
  const persistence = new MemoryChunkPersistence();
  const first = new PersistentVerifiedChunkStore({ manifest: manifest(), persistence });
  await first.ready;
  await persistence.put(first.namespace, "assets/hello.bin", 0, new TextEncoder().encode("xxxxx"));

  const second = new PersistentVerifiedChunkStore({ manifest: manifest(), persistence });
  assert.deepEqual(await second.ready, { accepted: 0, rejected: 1 });
  assert.equal(second.getChunk("assets/hello.bin", 0), null);
  assert.deepEqual(await persistence.list(first.namespace), []);
});

test("cache namespaces isolate game releases", async () => {
  const persistence = new MemoryChunkPersistence();
  const first = new PersistentVerifiedChunkStore({ manifest: manifest("1"), persistence });
  await first.ready;
  await first.putChunk("assets/hello.bin", 0, hello);

  const second = new PersistentVerifiedChunkStore({ manifest: manifest("2"), persistence });
  assert.deepEqual(await second.ready, { accepted: 0, rejected: 0 });
  assert.equal(second.getChunk("assets/hello.bin", 0), null);
});

test("clearPath removes both memory and persistent state", async () => {
  const persistence = new MemoryChunkPersistence();
  const store = new PersistentVerifiedChunkStore({ manifest: manifest(), persistence });
  await store.ready;
  await store.putChunk("assets/hello.bin", 0, hello);
  await store.clearPath("assets/hello.bin");

  assert.equal(store.getChunk("assets/hello.bin", 0), null);
  assert.deepEqual(await persistence.list(store.namespace), []);
});

test("persistent cache evicts least-recently-used chunks when the byte budget is exceeded", async () => {
  const persistence = new MemoryChunkPersistence();
  const pressure = [];
  const value = manifest("1", ["assets/hello.bin", "assets/world.bin"]);
  const store = new PersistentVerifiedChunkStore({
    manifest: value,
    persistence,
    maxBytes: 5,
    now: monotonicNow(),
    onStoragePressure: (detail) => pressure.push(detail),
  });
  await store.ready;
  await store.putChunk("assets/hello.bin", 0, contents.get("assets/hello.bin").bytes);
  await store.putChunk("assets/world.bin", 0, contents.get("assets/world.bin").bytes);

  const persisted = await persistence.list(store.namespace);
  assert.deepEqual(persisted.map((entry) => entry.path), ["assets/world.bin"]);
  assert.equal(store.hasChunk("assets/hello.bin", 0), true);
  assert.equal(store.hasChunk("assets/world.bin", 0), true);
  assert.deepEqual(await store.storageUsage(), {
    namespace: store.namespace,
    maxBytes: 5,
    entries: 1,
    bytes: 5,
  });
  assert.equal(pressure.length, 1);
  assert.equal(pressure[0].requestedBytes, 10);
  assert.equal(pressure[0].persistedBytes, 5);
  assert.equal(pressure[0].evictedEntries, 1);
  assert.equal(pressure[0].evictedBytes, 5);
});

test("reading a verified chunk refreshes its durable LRU position", async () => {
  const persistence = new MemoryChunkPersistence();
  const value = manifest("1", ["assets/hello.bin", "assets/world.bin", "assets/cache.bin"]);
  const store = new PersistentVerifiedChunkStore({
    manifest: value,
    persistence,
    maxBytes: 10,
    now: monotonicNow(),
  });
  await store.ready;
  await store.putChunk("assets/hello.bin", 0, contents.get("assets/hello.bin").bytes);
  await store.putChunk("assets/world.bin", 0, contents.get("assets/world.bin").bytes);

  assert.equal(new TextDecoder().decode(store.getChunk("assets/hello.bin", 0)), "hello");
  await store.putChunk("assets/cache.bin", 0, contents.get("assets/cache.bin").bytes);

  const persistedPaths = (await persistence.list(store.namespace)).map((entry) => entry.path).sort();
  assert.deepEqual(persistedPaths, ["assets/cache.bin", "assets/hello.bin"]);
});

test("a chunk larger than the persistent budget stays usable in memory but is not retained durably", async () => {
  const persistence = new MemoryChunkPersistence();
  const pressure = [];
  const store = new PersistentVerifiedChunkStore({
    manifest: manifest(),
    persistence,
    maxBytes: 4,
    now: monotonicNow(),
    onStoragePressure: (detail) => pressure.push(detail),
  });
  await store.ready;
  await store.putChunk("assets/hello.bin", 0, hello);

  assert.equal(new TextDecoder().decode(store.getChunk("assets/hello.bin", 0)), "hello");
  assert.deepEqual(await persistence.list(store.namespace), []);
  assert.equal(pressure.length, 1);
});

test("persistent byte budget rejects invalid values", () => {
  assert.throws(
    () => new PersistentVerifiedChunkStore({ manifest: manifest(), persistence: new MemoryChunkPersistence(), maxBytes: -1 }),
    /maxBytes must be/,
  );
});
