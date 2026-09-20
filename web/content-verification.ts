import type { ContentManifest } from "./content-manifest.ts";
import type { ManifestTrustOptions } from "./signed-content-manifest.ts";
export type ManifestFetchOptions = ManifestTrustOptions & {fetchImpl?: typeof fetch; allowedOrigins?: string[] | null};
import { CONTENT_MANIFEST_PROTOCOL, validateTrustedManifest } from "./content-manifest.ts";
import { resolveTrustedManifest } from "./signed-content-manifest.ts";
export { CONTENT_MANIFEST_PROTOCOL, validateTrustedManifest } from "./content-manifest.ts";

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function trustedManifestUrl(value: string) {
  const url = new URL(value);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new Error("Trusted content manifests must use HTTPS (HTTP is allowed only on loopback)");
}

function normalizeAllowedOrigins(allowedOrigins: string[] | null) {
  if (allowedOrigins == null) return null;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error("allowedOrigins must be a non-empty array when provided");
  }
  return new Set(allowedOrigins.map((origin) => new URL(origin).origin));
}

function bytesFrom(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return null;
}

async function contentBytes(value: unknown) {
  const bytes = bytesFrom(value);
  if (bytes) return bytes;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("Content must be an ArrayBuffer, typed array, DataView, or Blob");
}

async function sha256Hex(value: unknown) {
  const bytes = await contentBytes(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchTrustedManifest(
  manifestUrl: string,
  { fetchImpl = globalThis.fetch, allowedOrigins = null, trustedKeys = null, revokedKeyIds = null, allowUnsignedAssets = true }: ManifestFetchOptions = {},
) {
  const url = trustedManifestUrl(manifestUrl);
  const origins = normalizeAllowedOrigins(allowedOrigins);
  if (origins && !origins.has(url.origin)) {
    throw new Error(`Manifest origin is not trusted: ${url.origin}`);
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Trusted manifest request failed with ${response.status}`);
  }

  const manifest = await resolveTrustedManifest(await response.json(), { trustedKeys, revokedKeyIds, allowUnsignedAssets });
  return { manifest, manifestUrl: url.href };
}

export function manifestFile(manifest: ContentManifest, path: string) {
  validateTrustedManifest(manifest);
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`Content is not authorized by the trusted manifest: ${path}`);
  return file;
}

export async function verifyContent(manifest: ContentManifest, path: string, value: unknown) {
  const file = manifestFile(manifest, path);
  const bytes = await contentBytes(value);
  if (bytes.byteLength !== file.bytes) {
    throw new Error(`Content size mismatch for ${path}: expected ${file.bytes}, got ${bytes.byteLength}`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== file.sha256) {
    throw new Error(`Content hash mismatch for ${path}`);
  }
  return {
    path,
    role: file.role,
    bytes: file.bytes,
    sha256: actualSha256,
  };
}

export async function verifyContentChunk(manifest: ContentManifest, path: string, index: number, value: unknown) {
  const file = manifestFile(manifest, path);
  if (!file.chunks) throw new Error(`Content does not define trusted chunk hashes: ${path}`);
  if (!Number.isInteger(index) || index < 0 || index >= file.chunks.sha256.length) {
    throw new Error(`Invalid chunk index for ${path}: ${index}`);
  }

  const bytes = await contentBytes(value);
  const offset = index * file.chunks.bytes;
  const expectedBytes = Math.min(file.chunks.bytes, file.bytes - offset);
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`Chunk size mismatch for ${path}#${index}: expected ${expectedBytes}, got ${bytes.byteLength}`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== file.chunks.sha256[index]) {
    throw new Error(`Chunk hash mismatch for ${path}#${index}`);
  }
  return {
    path,
    index,
    bytes: expectedBytes,
    sha256: actualSha256,
  };
}

function trustedLogicFiles(manifest: ContentManifest) {
  return manifest.files
    .filter((file) => file.role === "logic")
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function logicFingerprint(manifest: ContentManifest) {
  validateTrustedManifest(manifest);
  const canonical = trustedLogicFiles(manifest)
    .map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`)
    .join("\n");
  const source = `${CONTENT_MANIFEST_PROTOCOL}\n${manifest.game.id}\n${manifest.game.version}\n${canonical}`;
  return sha256Hex(new TextEncoder().encode(source));
}

export async function verifyLogicSet(manifest: ContentManifest, contentByPath: Map<string, unknown>) {
  validateTrustedManifest(manifest);
  if (!(contentByPath instanceof Map)) {
    throw new Error("contentByPath must be a Map keyed by trusted manifest path");
  }

  const verified = [];
  for (const file of trustedLogicFiles(manifest)) {
    if (!contentByPath.has(file.path)) {
      throw new Error(`Missing trusted game logic: ${file.path}`);
    }
    verified.push(await verifyContent(manifest, file.path, contentByPath.get(file.path)));
  }

  return {
    gameId: manifest.game.id,
    gameVersion: manifest.game.version,
    fingerprint: await logicFingerprint(manifest),
    files: verified,
  };
}
