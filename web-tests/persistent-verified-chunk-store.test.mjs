import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import {
  MemoryChunkPersistence,
  PersistentVerifiedChunkStore,
} from "../web/persistent-verified-chunk-store.js";

const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const hello = new TextEncoder().encode("hello");

function manifest(version = "1") {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "cache-test", version },
    files: [
      {
        path: "assets/hello.bin",
        bytes: hello.byteLength,
        sha256: HELLO_SHA256,
        role: "asset",
        chunks: { bytes: hello.byteLength, sha256: [HELLO_SHA256] },
      },
    ],
  };
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
