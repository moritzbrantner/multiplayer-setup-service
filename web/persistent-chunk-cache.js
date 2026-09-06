import {
  manifestFile,
  validateTrustedManifest,
  verifyContent,
  verifyContentChunk,
} from "./content-verification.js";

const DEFAULT_DB_NAME = "multiplayer-content-cache-v1";
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024 * 1024;
const STORE_NAME = "chunks";
const DB_VERSION = 1;

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Persistent chunk data must be binary");
}

function copyBuffer(value) {
  const bytes = toBytes(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function requireChunkedFile(manifest, path) {
  const file = manifestFile(manifest, path);
  if (!file.chunks || file.chunks.sha256.length === 0) {
    throw new Error(`Content does not define transferable trusted chunks: ${path}`);
  }
  return file;
}

function cacheScope(manifest) {
  return JSON.stringify([manifest.game.id]);
}

function fileNamespace(manifest, file) {
  return JSON.stringify([manifest.game.id, manifest.game.version, file.path, file.sha256]);
}

function chunkKey(namespace, index) {
  return JSON.stringify([namespace, index]);
}

function expectedChunkBytes(file, index) {
  const offset = index * file.chunks.bytes;
  return Math.min(file.chunks.bytes, file.bytes - offset);
}

function validateBackend(backend) {
  for (const method of ["get", "put", "delete", "listFile", "listScope", "clearScope"]) {
    if (typeof backend?.[method] !== "function") {
      throw new Error(`Persistent chunk cache backend requires ${method}()`);
    }
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), {
      once: true,
    });
  });
}

export class IndexedDbChunkCacheBackend {
  constructor({ indexedDB = globalThis.indexedDB, dbName = DEFAULT_DB_NAME } = {}) {
    if (!indexedDB || typeof indexedDB.open !== "function") {
      throw new Error("IndexedDB is not available in this browser");
    }
    if (typeof dbName !== "string" || dbName.trim() === "") {
      throw new Error("dbName must be a non-empty string");
    }
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.databasePromise = null;
  }

  async get(key) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const result = await requestResult(transaction.objectStore(STORE_NAME).get(key));
    await transactionDone(transaction);
    return result ?? null;
  }

  async put(record) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  }

  async delete(key) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    await transactionDone(transaction);
  }

  async listFile(namespace) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const result = await requestResult(
      transaction.objectStore(STORE_NAME).index("fileNamespace").getAll(namespace),
    );
    await transactionDone(transaction);
    return result ?? [];
  }

  async listScope(scope) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const result = await requestResult(
      transaction.objectStore(STORE_NAME).index("scope").getAll(scope),
    );
    await transactionDone(transaction);
    return result ?? [];
  }

  async clearScope(scope) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const keys = await requestResult(store.index("scope").getAllKeys(scope));
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
  }

  async #database() {
    if (!this.databasePromise) this.databasePromise = this.#open();
    return this.databasePromise;
  }

  #open() {
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, DB_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (!store.indexNames.contains("scope")) store.createIndex("scope", "scope", { unique: false });
        if (!store.indexNames.contains("fileNamespace")) {
          store.createIndex("fileNamespace", "fileNamespace", { unique: false });
        }
        if (!store.indexNames.contains("lastAccess")) {
          store.createIndex("lastAccess", "lastAccess", { unique: false });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Could not open IndexedDB cache")), {
        once: true,
      });
      request.addEventListener("blocked", () => reject(new Error("IndexedDB cache upgrade is blocked")), {
        once: true,
      });
    });
  }
}

export class PersistentVerifiedChunkCache {
  constructor({
    manifest,
    backend = null,
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(),
  } = {}) {
    validateTrustedManifest(manifest);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CACHE_BYTES) {
      throw new Error(`maxBytes must be between 1 and ${MAX_CACHE_BYTES}`);
    }
    if (typeof now !== "function") throw new Error("now must be a function");

    this.manifest = manifest;
    this.backend = backend ?? new IndexedDbChunkCacheBackend();
    validateBackend(this.backend);
    this.maxBytes = maxBytes;
    this.now = now;
    this.scope = cacheScope(manifest);
    this.usageBytes = null;
  }

  async putChunk(path, index, value) {
    const file = requireChunkedFile(this.manifest, path);
    const bytes = toBytes(value);
    await verifyContentChunk(this.manifest, path, index, bytes);
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`Verified chunk exceeds configured cache capacity for ${path}#${index}`);
    }

    const namespace = fileNamespace(this.manifest, file);
    const key = chunkKey(namespace, index);
    const previous = await this.backend.get(key);
    const record = {
      key,
      scope: this.scope,
      fileNamespace: namespace,
      gameId: this.manifest.game.id,
      gameVersion: this.manifest.game.version,
      path,
      fileSha256: file.sha256,
      index,
      chunkSha256: file.chunks.sha256[index],
      size: bytes.byteLength,
      lastAccess: this.now(),
      bytes: copyBuffer(bytes),
    };
    await this.backend.put(record);

    const usage = await this.#usage();
    this.usageBytes = usage - (previous?.size ?? 0) + record.size;
    await this.prune();
    return {
      path,
      index,
      bytes: record.size,
      sha256: record.chunkSha256,
    };
  }

  async putFile(path, value) {
    const file = requireChunkedFile(this.manifest, path);
    const bytes = toBytes(value);
    await verifyContent(this.manifest, path, bytes);
    for (let index = 0; index < file.chunks.sha256.length; index += 1) {
      const start = index * file.chunks.bytes;
      const end = Math.min(start + file.chunks.bytes, bytes.byteLength);
      await this.putChunk(path, index, bytes.slice(start, end));
    }
    return {
      path,
      chunks: file.chunks.sha256.length,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  }

  async persistStorePath(path, store) {
    requireChunkedFile(this.manifest, path);
    if (!store || typeof store.availableChunks !== "function" || typeof store.getChunk !== "function") {
      throw new Error("persistStorePath requires a verified chunk store");
    }
    const indexes = store.availableChunks(path);
    for (const index of indexes) {
      const chunk = store.getChunk(path, index);
      if (chunk) await this.putChunk(path, index, chunk);
    }
    return indexes.length;
  }

  async restorePath(path, store) {
    const file = requireChunkedFile(this.manifest, path);
    if (!store || typeof store.putChunk !== "function") {
      throw new Error("restorePath requires a verified chunk store");
    }

    const namespace = fileNamespace(this.manifest, file);
    const records = await this.backend.listFile(namespace);
    const restored = [];
    const discarded = [];

    for (const record of records.sort((left, right) => left.index - right.index)) {
      try {
        if (
          record.scope !== this.scope ||
          record.fileNamespace !== namespace ||
          record.gameId !== this.manifest.game.id ||
          record.gameVersion !== this.manifest.game.version ||
          record.path !== path ||
          record.fileSha256 !== file.sha256 ||
          !Number.isInteger(record.index) ||
          record.index < 0 ||
          record.index >= file.chunks.sha256.length ||
          record.chunkSha256 !== file.chunks.sha256[record.index] ||
          record.size !== expectedChunkBytes(file, record.index)
        ) {
          throw new Error("Persistent chunk metadata no longer matches the trusted manifest");
        }

        const bytes = toBytes(record.bytes);
        if (bytes.byteLength !== record.size) throw new Error("Persistent chunk size is corrupt");
        await store.putChunk(path, record.index, bytes);
        record.lastAccess = this.now();
        record.bytes = copyBuffer(bytes);
        await this.backend.put(record);
        restored.push(record.index);
      } catch {
        await this.backend.delete(record.key);
        discarded.push(record.index);
        if (this.usageBytes !== null) this.usageBytes = Math.max(0, this.usageBytes - (record.size ?? 0));
      }
    }

    return {
      path,
      restored: [...new Set(restored)].sort((left, right) => left - right),
      discarded: [...new Set(discarded)].sort((left, right) => left - right),
    };
  }

  async removePath(path) {
    const file = requireChunkedFile(this.manifest, path);
    const namespace = fileNamespace(this.manifest, file);
    const records = await this.backend.listFile(namespace);
    for (const record of records) await this.backend.delete(record.key);
    if (this.usageBytes !== null) {
      this.usageBytes = Math.max(
        0,
        this.usageBytes - records.reduce((total, record) => total + (record.size ?? 0), 0),
      );
    }
    return records.length;
  }

  async clearGame() {
    await this.backend.clearScope(this.scope);
    this.usageBytes = 0;
  }

  async stats() {
    const records = await this.backend.listScope(this.scope);
    return {
      chunks: records.length,
      bytes: records.reduce((total, record) => total + (record.size ?? 0), 0),
      maxBytes: this.maxBytes,
    };
  }

  async prune() {
    let usage = await this.#usage();
    if (usage <= this.maxBytes) return { evictedChunks: 0, bytes: usage };

    const records = await this.backend.listScope(this.scope);
    records.sort((left, right) => {
      const access = (left.lastAccess ?? 0) - (right.lastAccess ?? 0);
      return access !== 0 ? access : String(left.key).localeCompare(String(right.key));
    });

    let evictedChunks = 0;
    for (const record of records) {
      if (usage <= this.maxBytes) break;
      await this.backend.delete(record.key);
      usage = Math.max(0, usage - (record.size ?? 0));
      evictedChunks += 1;
    }
    this.usageBytes = usage;
    return { evictedChunks, bytes: usage };
  }

  async requestPersistence(storageManager = globalThis.navigator?.storage) {
    if (!storageManager || typeof storageManager.persist !== "function") return false;
    return Boolean(await storageManager.persist());
  }

  async #usage() {
    if (this.usageBytes !== null) return this.usageBytes;
    const records = await this.backend.listScope(this.scope);
    this.usageBytes = records.reduce((total, record) => total + (record.size ?? 0), 0);
    return this.usageBytes;
  }
}
