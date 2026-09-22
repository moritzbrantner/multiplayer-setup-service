import {
  manifestFile,
  validateTrustedManifest,
  verifyContent,
  verifyContentChunk,
} from "./content-verification.js";

async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("Verified chunk data must be binary");
}

function requireChunkedFile(manifest, path) {
  const file = manifestFile(manifest, path);
  if (!file.chunks || file.chunks.sha256.length === 0) {
    throw new Error(`Content does not define transferable trusted chunks: ${path}`);
  }
  return file;
}

export class VerifiedChunkStore {
  constructor({ manifest } = {}) {
    validateTrustedManifest(manifest);
    this.manifest = manifest;
    this.files = new Map();
  }

  hasChunk(path, index) {
    return this.files.get(path)?.has(index) ?? false;
  }

  availableChunks(path) {
    requireChunkedFile(this.manifest, path);
    return [...(this.files.get(path)?.keys() ?? [])].sort((left, right) => left - right);
  }

  missingChunks(path) {
    const file = requireChunkedFile(this.manifest, path);
    const stored = this.files.get(path);
    const missing = [];
    for (let index = 0; index < file.chunks.sha256.length; index += 1) {
      if (!stored?.has(index)) missing.push(index);
    }
    return missing;
  }

  async putChunk(path, index, value) {
    const bytes = await toBytes(value);
    const verification = await verifyContentChunk(this.manifest, path, index, bytes);
    let chunks = this.files.get(path);
    if (!chunks) {
      chunks = new Map();
      this.files.set(path, chunks);
    }
    chunks.set(index, bytes.slice());
    return verification;
  }

  async putFile(path, value) {
    const file = requireChunkedFile(this.manifest, path);
    const bytes = await toBytes(value);
    await verifyContent(this.manifest, path, bytes);

    const staged = new Map();
    for (let index = 0; index < file.chunks.sha256.length; index += 1) {
      const start = index * file.chunks.bytes;
      const end = Math.min(start + file.chunks.bytes, bytes.byteLength);
      const chunk = bytes.slice(start, end);
      await verifyContentChunk(this.manifest, path, index, chunk);
      staged.set(index, chunk);
    }
    this.files.set(path, staged);
    return {
      path,
      chunks: staged.size,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  }

  getChunk(path, index) {
    requireChunkedFile(this.manifest, path);
    const chunk = this.files.get(path)?.get(index);
    return chunk ? chunk.slice() : null;
  }

  async assembleFile(path) {
    const file = requireChunkedFile(this.manifest, path);
    const chunks = this.files.get(path);
    if (!chunks || chunks.size !== file.chunks.sha256.length) {
      throw new Error(`Not all trusted chunks are available for ${path}`);
    }

    const bytes = new Uint8Array(file.bytes);
    let offset = 0;
    for (let index = 0; index < file.chunks.sha256.length; index += 1) {
      const chunk = chunks.get(index);
      if (!chunk) throw new Error(`Missing trusted chunk ${index} for ${path}`);
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await verifyContent(this.manifest, path, bytes);
    return bytes;
  }

  clearPath(path) {
    this.files.delete(path);
  }

  clear() {
    this.files.clear();
  }
}
