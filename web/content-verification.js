export const CONTENT_MANIFEST_PROTOCOL = "multiplayer-content-manifest-v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_FILES = 10_000;
const MAX_MANIFEST_CHUNKS = 250_000;
const MAX_CHUNK_BYTES = 1_048_576;
const MAX_PATH_LENGTH = 1_024;
const ALLOWED_ROLES = new Set(["asset", "logic"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSafePath(path) {
  requireNonEmptyString(path, "file.path");
  if (path.length > MAX_PATH_LENGTH) throw new Error("file.path is too long");
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Unsafe manifest path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe manifest path: ${path}`);
  }
  return path;
}

function requireSha256(value, field = "file.sha256") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function requireBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("file.bytes must be a non-negative safe integer");
  }
  return value;
}

function validateChunking(file) {
  if (file.chunks == null) return 0;
  if (!isObject(file.chunks)) throw new Error("file.chunks must be an object");
  if (!Number.isSafeInteger(file.chunks.bytes) || file.chunks.bytes < 1 || file.chunks.bytes > MAX_CHUNK_BYTES) {
    throw new Error(`file.chunks.bytes must be between 1 and ${MAX_CHUNK_BYTES}`);
  }
  if (!Array.isArray(file.chunks.sha256)) {
    throw new Error("file.chunks.sha256 must be an array");
  }
  const expectedChunks = file.bytes === 0 ? 0 : Math.ceil(file.bytes / file.chunks.bytes);
  if (file.chunks.sha256.length !== expectedChunks) {
    throw new Error(`file.chunks.sha256 must contain exactly ${expectedChunks} hashes`);
  }
  for (const [index, hash] of file.chunks.sha256.entries()) {
    requireSha256(hash, `file.chunks.sha256[${index}]`);
  }
  return expectedChunks;
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function trustedManifestUrl(value) {
  const url = new URL(value);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new Error("Trusted content manifests must use HTTPS (HTTP is allowed only on loopback)");
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (allowedOrigins == null) return null;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error("allowedOrigins must be a non-empty array when provided");
  }
  return new Set(allowedOrigins.map((origin) => new URL(origin).origin));
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function contentBytes(value) {
  const bytes = bytesFrom(value);
  if (bytes) return bytes;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("Content must be an ArrayBuffer, typed array, DataView, or Blob");
}

async function sha256Hex(value) {
  const bytes = await contentBytes(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateTrustedManifest(manifest) {
  if (!isObject(manifest)) throw new Error("Content manifest must be an object");
  if (manifest.protocol !== CONTENT_MANIFEST_PROTOCOL) {
    throw new Error(`Unsupported content manifest protocol: ${String(manifest.protocol)}`);
  }
  if (!isObject(manifest.game)) throw new Error("manifest.game must be an object");
  requireNonEmptyString(manifest.game.id, "manifest.game.id");
  requireNonEmptyString(manifest.game.version, "manifest.game.version");
  if (!Array.isArray(manifest.files)) throw new Error("manifest.files must be an array");
  if (manifest.files.length > MAX_MANIFEST_FILES) {
    throw new Error(`manifest.files exceeds the ${MAX_MANIFEST_FILES} file limit`);
  }

  const paths = new Set();
  let totalChunks = 0;
  for (const file of manifest.files) {
    if (!isObject(file)) throw new Error("Each manifest file must be an object");
    const path = requireSafePath(file.path);
    if (paths.has(path)) throw new Error(`Duplicate manifest path: ${path}`);
    paths.add(path);
    requireBytes(file.bytes);
    requireSha256(file.sha256);
    if (!ALLOWED_ROLES.has(file.role)) {
      throw new Error("file.role must be 'asset' or 'logic'");
    }
    totalChunks += validateChunking(file);
    if (totalChunks > MAX_MANIFEST_CHUNKS) {
      throw new Error(`manifest exceeds the ${MAX_MANIFEST_CHUNKS} chunk-hash limit`);
    }
  }

  return manifest;
}

export async function fetchTrustedManifest(
  manifestUrl,
  { fetchImpl = globalThis.fetch, allowedOrigins = null } = {},
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

  const manifest = validateTrustedManifest(await response.json());
  return { manifest, manifestUrl: url.href };
}

export function manifestFile(manifest, path) {
  validateTrustedManifest(manifest);
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`Content is not authorized by the trusted manifest: ${path}`);
  return file;
}

export async function verifyContent(manifest, path, value) {
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

export async function verifyContentChunk(manifest, path, index, value) {
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

function trustedLogicFiles(manifest) {
  return manifest.files
    .filter((file) => file.role === "logic")
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function logicFingerprint(manifest) {
  validateTrustedManifest(manifest);
  const canonical = trustedLogicFiles(manifest)
    .map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`)
    .join("\n");
  const source = `${CONTENT_MANIFEST_PROTOCOL}\n${manifest.game.id}\n${manifest.game.version}\n${canonical}`;
  return sha256Hex(new TextEncoder().encode(source));
}

export async function verifyLogicSet(manifest, contentByPath) {
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
