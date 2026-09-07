import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_MANIFEST_PROTOCOL } from "../web/content-verification.js";
import {
  SIGNED_MANIFEST_PROTOCOL,
  canonicalManifestBytes,
  resolveTrustedManifest,
  verifySignedManifest,
} from "../web/signed-content-manifest.js";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function manifest({ role = "logic", version = "1.0.0" } = {}) {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "signed-test", version },
    files: [
      {
        path: role === "logic" ? "logic/game.wasm" : "assets/world.bin",
        bytes: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        role,
      },
    ],
  };
}

async function signedEnvelope(value, keyId = "release-2026") {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, canonicalManifestBytes(value)),
  );
  return {
    envelope: {
      protocol: SIGNED_MANIFEST_PROTOCOL,
      manifest: value,
      signature: { algorithm: "Ed25519", keyId, value: base64url(signature) },
    },
    trustedKeys: new Map([[keyId, publicKey]]),
  };
}

test("valid Ed25519 envelope verifies against the pinned key", async () => {
  const source = manifest();
  const { envelope, trustedKeys } = await signedEnvelope(source);
  const result = await verifySignedManifest(envelope, { trustedKeys });
  assert.equal(result.manifest, source);
  assert.equal(result.keyId, "release-2026");
});

test("mutating signed manifest content fails closed", async () => {
  const { envelope, trustedKeys } = await signedEnvelope(manifest());
  envelope.manifest.game.version = "1.0.1";
  await assert.rejects(() => verifySignedManifest(envelope, { trustedKeys }), /signature is invalid/);
});

test("unknown signing keys are rejected before content can become trusted", async () => {
  const { envelope } = await signedEnvelope(manifest());
  await assert.rejects(
    () => verifySignedManifest(envelope, { trustedKeys: new Map() }),
    /Unknown trusted manifest signing key/,
  );
});

test("unsigned execution-critical logic is rejected", async () => {
  await assert.rejects(() => resolveTrustedManifest(manifest()), /logic requires a signed/);
});

test("unsigned asset-only v1 manifests remain available during migration", async () => {
  const source = manifest({ role: "asset" });
  assert.equal(await resolveTrustedManifest(source), source);
  await assert.rejects(
    () => resolveTrustedManifest(source, { allowUnsignedAssets: false }),
    /Unsigned trusted content manifests are disabled/,
  );
});
