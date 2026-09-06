import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTENT_MANIFEST_PROTOCOL,
  fetchTrustedManifest,
  logicFingerprint,
  manifestFile,
  validateTrustedManifest,
  verifyContent,
  verifyLogicSet,
} from "../web/content-verification.js";

const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const WORLD_SHA256 = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7";

function bytes(value) {
  return new TextEncoder().encode(value);
}

function manifest(overrides = {}) {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "example-game", version: "1.2.3" },
    files: [
      { path: "assets/hello.txt", bytes: 5, sha256: HELLO_SHA256, role: "asset" },
      { path: "logic/main.wasm", bytes: 5, sha256: WORLD_SHA256, role: "logic" },
    ],
    ...overrides,
  };
}

test("trusted manifests may describe assets and execution-critical game logic", () => {
  const value = manifest();
  assert.equal(validateTrustedManifest(value), value);
  assert.equal(manifestFile(value, "logic/main.wasm").role, "logic");
});

test("manifest validation rejects traversal, duplicate paths, and invalid hashes", () => {
  assert.throws(
    () => validateTrustedManifest(manifest({ files: [
      { path: "../logic.wasm", bytes: 1, sha256: "0".repeat(64), role: "logic" },
    ] })),
    /Unsafe manifest path/,
  );
  assert.throws(
    () => validateTrustedManifest(manifest({ files: [
      { path: "same.bin", bytes: 1, sha256: "0".repeat(64), role: "asset" },
      { path: "same.bin", bytes: 1, sha256: "1".repeat(64), role: "asset" },
    ] })),
    /Duplicate manifest path/,
  );
  assert.throws(
    () => validateTrustedManifest(manifest({ files: [
      { path: "logic.wasm", bytes: 1, sha256: "NOT-A-HASH", role: "logic" },
    ] })),
    /SHA-256/,
  );
});

test("trusted manifest fetch is HTTPS-only except for local development", async () => {
  await assert.rejects(
    () => fetchTrustedManifest("http://example.test/game.manifest.json", { fetchImpl: async () => null }),
    /must use HTTPS/,
  );

  let requested = null;
  const result = await fetchTrustedManifest("http://localhost:8080/game.manifest.json", {
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return { ok: true, status: 200, async json() { return manifest(); } };
    },
  });
  assert.equal(result.manifest.game.id, "example-game");
  assert.equal(requested.url, "http://localhost:8080/game.manifest.json");
  assert.equal(requested.options.cache, "no-store");
  assert.equal(requested.options.credentials, "omit");
  assert.equal(requested.options.redirect, "error");
});

test("games can restrict manifests to explicitly configured trusted origins", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return manifest(); } });
  await assert.rejects(
    () => fetchTrustedManifest("https://cdn.example/game.manifest.json", {
      fetchImpl,
      allowedOrigins: ["https://game.example"],
    }),
    /not trusted/,
  );
  const result = await fetchTrustedManifest("https://game.example/game.manifest.json", {
    fetchImpl,
    allowedOrigins: ["https://game.example"],
  });
  assert.equal(result.manifestUrl, "https://game.example/game.manifest.json");
});

test("peer bytes are accepted only when size and SHA-256 match the trusted manifest", async () => {
  const value = manifest();
  const verified = await verifyContent(value, "assets/hello.txt", bytes("hello"));
  assert.deepEqual(verified, {
    path: "assets/hello.txt",
    role: "asset",
    bytes: 5,
    sha256: HELLO_SHA256,
  });
  await assert.rejects(
    () => verifyContent(value, "assets/hello.txt", bytes("HELLO")),
    /hash mismatch/,
  );
  await assert.rejects(
    () => verifyContent(value, "assets/hello.txt", bytes("hello!")),
    /size mismatch/,
  );
  await assert.rejects(
    () => verifyContent(value, "peer-added-script.js", bytes("hello")),
    /not authorized/,
  );
});

test("logic verification requires every logic file authorized by the trusted manifest", async () => {
  const value = manifest();
  await assert.rejects(() => verifyLogicSet(value, new Map()), /Missing trusted game logic/);

  const result = await verifyLogicSet(value, new Map([
    ["logic/main.wasm", bytes("world")],
    ["peer-added-script.js", bytes("hello")],
  ]));
  assert.equal(result.gameId, "example-game");
  assert.equal(result.gameVersion, "1.2.3");
  assert.deepEqual(result.files.map((file) => file.path), ["logic/main.wasm"]);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test("logic fingerprint is deterministic regardless of manifest file order", async () => {
  const value = manifest();
  const reversed = manifest({ files: [...value.files].reverse() });
  assert.equal(await logicFingerprint(value), await logicFingerprint(reversed));
});
