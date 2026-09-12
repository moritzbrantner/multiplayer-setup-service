import { validateTrustedManifest } from "./content-verification.js";

export const SIGNED_MANIFEST_PROTOCOL = "multiplayer-content-manifest-signature-v1";
const SIGNATURE_ALGORITHM = "Ed25519";
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (!isObject(value)) throw new Error("Signed manifest contains a non-JSON value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function base64UrlBytes(value, field) {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be base64url text`);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${field} must be unpadded base64url text`);
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + padding;
  const binary = globalThis.atob
    ? globalThis.atob(base64)
    : Buffer.from(base64, "base64").toString("binary");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizeKeyIdSet(value, field) {
  if (value == null) return new Set();
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : null;
  if (!values) throw new Error(`${field} must be an array or Set of key IDs`);
  const result = new Set();
  for (const keyId of values) {
    if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
      throw new Error(`${field} contains an invalid key ID`);
    }
    result.add(keyId);
  }
  return result;
}

function trustedKeyBytes(trustedKeys, keyId) {
  const value = trustedKeys instanceof Map ? trustedKeys.get(keyId) : trustedKeys?.[keyId];
  if (value == null) throw new Error(`Unknown trusted manifest signing key: ${keyId}`);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return base64UrlBytes(value, `trustedKeys.${keyId}`);
  throw new Error(`Trusted manifest key ${keyId} must be raw Ed25519 bytes or base64url text`);
}

function validateEnvelope(envelope) {
  if (!isObject(envelope)) throw new Error("Signed manifest envelope must be an object");
  if (envelope.protocol !== SIGNED_MANIFEST_PROTOCOL) {
    throw new Error(`Unsupported signed manifest protocol: ${String(envelope.protocol)}`);
  }
  validateTrustedManifest(envelope.manifest);
  if (!isObject(envelope.signature)) throw new Error("Signed manifest signature must be an object");
  if (envelope.signature.algorithm !== SIGNATURE_ALGORITHM) {
    throw new Error(`Unsupported manifest signature algorithm: ${String(envelope.signature.algorithm)}`);
  }
  if (typeof envelope.signature.keyId !== "string" || !KEY_ID_PATTERN.test(envelope.signature.keyId)) {
    throw new Error("Manifest signature keyId is invalid");
  }
  return envelope;
}

export function canonicalManifestBytes(manifest) {
  validateTrustedManifest(manifest);
  return new TextEncoder().encode(canonicalize(manifest));
}

export async function verifySignedManifest(
  envelope,
  { trustedKeys, revokedKeyIds = null } = {},
) {
  validateEnvelope(envelope);
  if (!trustedKeys) throw new Error("trustedKeys is required for signed manifest verification");

  const revoked = normalizeKeyIdSet(revokedKeyIds, "revokedKeyIds");
  const keyId = envelope.signature.keyId;
  if (revoked.has(keyId)) {
    throw new Error(`Trusted manifest signing key is revoked: ${keyId}`);
  }

  const publicKeyBytes = trustedKeyBytes(trustedKeys, keyId);
  if (publicKeyBytes.byteLength !== 32) throw new Error("Ed25519 public keys must be exactly 32 bytes");
  const signatureBytes = base64UrlBytes(envelope.signature.value, "manifest signature");
  if (signatureBytes.byteLength !== 64) throw new Error("Ed25519 signatures must be exactly 64 bytes");

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: SIGNATURE_ALGORITHM },
    false,
    ["verify"],
  );
  const verified = await globalThis.crypto.subtle.verify(
    { name: SIGNATURE_ALGORITHM },
    key,
    signatureBytes,
    canonicalManifestBytes(envelope.manifest),
  );
  if (!verified) throw new Error("Trusted content manifest signature is invalid");

  return {
    manifest: envelope.manifest,
    keyId,
    algorithm: SIGNATURE_ALGORITHM,
  };
}

export async function resolveTrustedManifest(
  value,
  { trustedKeys = null, revokedKeyIds = null, allowUnsignedAssets = true } = {},
) {
  if (isObject(value) && value.protocol === SIGNED_MANIFEST_PROTOCOL) {
    return (await verifySignedManifest(value, { trustedKeys, revokedKeyIds })).manifest;
  }

  const manifest = validateTrustedManifest(value);
  const containsLogic = manifest.files.some((file) => file.role === "logic");
  if (containsLogic) {
    throw new Error("Execution-critical logic requires a signed trusted manifest");
  }
  if (!allowUnsignedAssets) throw new Error("Unsigned trusted content manifests are disabled");
  return manifest;
}
