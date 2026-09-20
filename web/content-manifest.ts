export type ManifestFile = {path: string; bytes: number; sha256: string; role: "asset" | "logic"; chunks?: {bytes: number; sha256: string[]}};
export type ContentManifest = {protocol: "multiplayer-content-manifest-v1"; game: {id: string; version: string}; files: ManifestFile[]};
export const CONTENT_MANIFEST_PROTOCOL = "multiplayer-content-manifest-v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_FILES = 10_000;
const MAX_MANIFEST_CHUNKS = 250_000;
const MAX_CHUNK_BYTES = 1_048_576;
const MAX_PATH_LENGTH = 1_024;
const ALLOWED_ROLES = new Set(["asset", "logic"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSafePath(input: unknown): string {
  const path = requireNonEmptyString(input, "file.path");
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

function requireSha256(value: unknown, field = "file.sha256") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function requireBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("file.bytes must be a non-negative safe integer");
  }
  return value;
}

function validateChunking(file: Record<string, unknown>) {
  if (file.chunks == null) return 0;
  if (!isObject(file.chunks)) throw new Error("file.chunks must be an object");
  if (typeof file.chunks.bytes !== "number" || !Number.isSafeInteger(file.chunks.bytes) || file.chunks.bytes < 1 || file.chunks.bytes > MAX_CHUNK_BYTES) {
    throw new Error(`file.chunks.bytes must be between 1 and ${MAX_CHUNK_BYTES}`);
  }
  if (!Array.isArray(file.chunks.sha256)) {
    throw new Error("file.chunks.sha256 must be an array");
  }
  const expectedChunks = file.bytes === 0 ? 0 : Math.ceil(requireBytes(file.bytes) / file.chunks.bytes);
  if (file.chunks.sha256.length !== expectedChunks) {
    throw new Error(`file.chunks.sha256 must contain exactly ${expectedChunks} hashes`);
  }
  for (const [index, hash] of file.chunks.sha256.entries()) {
    requireSha256(hash, `file.chunks.sha256[${index}]`);
  }
  return expectedChunks;
}

export function validateTrustedManifest(manifest: unknown): ContentManifest {
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
    if (typeof file.role !== "string" || !ALLOWED_ROLES.has(file.role)) {
      throw new Error("file.role must be 'asset' or 'logic'");
    }
    totalChunks += validateChunking(file);
    if (totalChunks > MAX_MANIFEST_CHUNKS) {
      throw new Error(`manifest exceeds the ${MAX_MANIFEST_CHUNKS} chunk-hash limit`);
    }
  }

  // Every field of the public manifest contract has been validated above.
  return manifest as ContentManifest;
}

