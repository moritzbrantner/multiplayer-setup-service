import { validateTrustedManifest } from "./content-verification.js";
import { VerifiedChunkStore } from "./verified-chunk-store.js";

const DEFAULT_DATABASE = "multiplayer-verified-content-v1";
const STORE_NAME = "chunks";
export const DEFAULT_MAX_PERSISTED_CONTENT_BYTES = 256 * 1024 * 1024;

function namespaceFor(manifest) {
  validateTrustedManifest(manifest);
  return `${manifest.game.id}\0${manifest.game.version}`;
}

function storageKey(namespace, path, index) {
  return `${namespace}\0${path}\0${index}`;
}

function toStoredBytes(value) {
  if (!(value instanceof Uint8Array)) throw new Error("Verified cache only stores Uint8Array chunks");
  return value.slice().buffer;
}

function validateMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
}

function normalizedTouchedAt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function openDatabase(name) {
  if (!globalThis.indexedDB) throw new Error("IndexedDB is not available in this environment");
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(name, 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("namespace", "namespace", { unique: false });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Could not open verified chunk cache")), {
      once: true,
    });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Verified cache transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Verified cache transaction failed")), {
      once: true,
    });
  });
}

function requestResult(request, message) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error(message)), { once: true });
  });
}

export class MemoryChunkPersistence {
  constructor({ now = () => Date.now() } = {}) {
    if (typeof now !== "function") throw new Error("now must be a function");
    this.entries = new Map();
    this.now = now;
  }

  async list(namespace) {
    return [...this.entries.values()]
      .filter((entry) => entry.namespace === namespace)
      .map((entry) => ({ ...entry, bytes: entry.bytes.slice() }));
  }

  async put(namespace, path, index, bytes, touchedAt = this.now()) {
    const key = storageKey(namespace, path, index);
    this.entries.set(key, {
      key,
      namespace,
      path,
      index,
      bytes: bytes.slice(),
      touchedAt: normalizedTouchedAt(touchedAt),
    });
  }

  async touch(namespace, path, index, touchedAt = this.now()) {
    const entry = this.entries.get(storageKey(namespace, path, index));
    if (entry) entry.touchedAt = normalizedTouchedAt(touchedAt);
  }

  async delete(namespace, path, index) {
    this.entries.delete(storageKey(namespace, path, index));
  }

  async deletePath(namespace, path) {
    for (const [key, entry] of this.entries) {
      if (entry.namespace === namespace && entry.path === path) this.entries.delete(key);
    }
  }

  async clear(namespace) {
    for (const [key, entry] of this.entries) {
      if (entry.namespace === namespace) this.entries.delete(key);
    }
  }
}

export class IndexedDbChunkPersistence {
  constructor({ databaseName = DEFAULT_DATABASE } = {}) {
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  async #database() {
    this.databasePromise ??= openDatabase(this.databaseName);
    return this.databasePromise;
  }

  async list(namespace) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("namespace");
    const result = (await requestResult(index.getAll(namespace), "Could not read verified cache")) ?? [];
    await transactionDone(transaction);
    return result.map((entry) => ({
      key: entry.key,
      namespace: entry.namespace,
      path: entry.path,
      index: entry.index,
      bytes: new Uint8Array(entry.bytes),
      touchedAt: normalizedTouchedAt(entry.touchedAt),
    }));
  }

  async put(namespace, path, index, bytes, touchedAt = Date.now()) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: storageKey(namespace, path, index),
      namespace,
      path,
      index,
      bytes: toStoredBytes(bytes),
      touchedAt: normalizedTouchedAt(touchedAt),
    });
    await transactionDone(transaction);
  }

  async touch(namespace, path, index, touchedAt = Date.now()) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const key = storageKey(namespace, path, index);
    const entry = await requestResult(store.get(key), "Could not touch verified cache entry");
    if (entry) {
      entry.touchedAt = normalizedTouchedAt(touchedAt);
      store.put(entry);
    }
    await transactionDone(transaction);
  }

  async delete(namespace, path, index) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(storageKey(namespace, path, index));
    await transactionDone(transaction);
  }

  async deletePath(namespace, path) {
    const entries = await this.list(namespace);
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const entry of entries) {
      if (entry.path === path) store.delete(storageKey(namespace, entry.path, entry.index));
    }
    await transactionDone(transaction);
  }

  async clear(namespace) {
    const entries = await this.list(namespace);
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const entry of entries) store.delete(storageKey(namespace, entry.path, entry.index));
    await transactionDone(transaction);
  }
}

export class PersistentVerifiedChunkStore extends VerifiedChunkStore {
  constructor({
    manifest,
    persistence = new IndexedDbChunkPersistence(),
    maxBytes = DEFAULT_MAX_PERSISTED_CONTENT_BYTES,
    onStoragePressure = null,
    now = () => Date.now(),
  } = {}) {
    super({ manifest });
    validateMaxBytes(maxBytes);
    if (onStoragePressure !== null && typeof onStoragePressure !== "function") {
      throw new Error("onStoragePressure must be a function when provided");
    }
    if (typeof now !== "function") throw new Error("now must be a function");
    this.persistence = persistence;
    this.namespace = namespaceFor(manifest);
    this.maxBytes = maxBytes;
    this.onStoragePressure = onStoragePressure;
    this.now = now;
    this.lastTouchedAt = 0;
    this.ready = this.#hydrate();
  }

  #stamp() {
    const current = Number(this.now());
    if (!Number.isSafeInteger(current) || current < 0) throw new Error("now() must return a non-negative safe integer");
    this.lastTouchedAt = Math.max(current, this.lastTouchedAt + 1);
    return this.lastTouchedAt;
  }

  async #hydrate() {
    const entries = await this.persistence.list(this.namespace);
    let accepted = 0;
    let rejected = 0;
    for (const entry of entries) {
      this.lastTouchedAt = Math.max(this.lastTouchedAt, normalizedTouchedAt(entry.touchedAt));
      try {
        await super.putChunk(entry.path, entry.index, entry.bytes);
        accepted += 1;
      } catch {
        rejected += 1;
        await this.persistence.delete(this.namespace, entry.path, entry.index);
      }
    }
    await this.#enforceBudget();
    return { accepted, rejected };
  }

  async #enforceBudget() {
    const entries = await this.persistence.list(this.namespace);
    let persistedBytes = entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    if (persistedBytes <= this.maxBytes) return null;

    const originalBytes = persistedBytes;
    const ordered = [...entries].sort((left, right) => {
      const timeDifference = normalizedTouchedAt(left.touchedAt) - normalizedTouchedAt(right.touchedAt);
      if (timeDifference !== 0) return timeDifference;
      const pathDifference = left.path.localeCompare(right.path);
      return pathDifference !== 0 ? pathDifference : left.index - right.index;
    });

    let evictedEntries = 0;
    let evictedBytes = 0;
    for (const entry of ordered) {
      if (persistedBytes <= this.maxBytes) break;
      await this.persistence.delete(this.namespace, entry.path, entry.index);
      persistedBytes -= entry.bytes.byteLength;
      evictedEntries += 1;
      evictedBytes += entry.bytes.byteLength;
    }

    const detail = {
      namespace: this.namespace,
      maxBytes: this.maxBytes,
      requestedBytes: originalBytes,
      persistedBytes,
      evictedEntries,
      evictedBytes,
    };
    try {
      this.onStoragePressure?.(detail);
    } catch {
      // Storage correctness must not depend on observer behavior.
    }
    return detail;
  }

  async storageUsage() {
    await this.ready;
    const entries = await this.persistence.list(this.namespace);
    return {
      namespace: this.namespace,
      maxBytes: this.maxBytes,
      entries: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
    };
  }

  getChunk(path, index) {
    const chunk = super.getChunk(path, index);
    if (chunk && typeof this.persistence.touch === "function") {
      const touchedAt = this.#stamp();
      Promise.resolve(this.persistence.touch(this.namespace, path, index, touchedAt)).catch(() => {
        // A failed LRU touch must not invalidate already verified in-memory bytes.
      });
    }
    return chunk;
  }

  async putChunk(path, index, value) {
    await this.ready;
    const verification = await super.putChunk(path, index, value);
    const verified = super.getChunk(path, index);
    await this.persistence.put(this.namespace, path, index, verified, this.#stamp());
    await this.#enforceBudget();
    return verification;
  }

  async putFile(path, value) {
    await this.ready;
    const result = await super.putFile(path, value);
    for (const index of super.availableChunks(path)) {
      await this.persistence.put(this.namespace, path, index, super.getChunk(path, index), this.#stamp());
    }
    await this.#enforceBudget();
    return result;
  }

  async clearPath(path) {
    await this.ready;
    super.clearPath(path);
    await this.persistence.deletePath(this.namespace, path);
  }

  async clear() {
    await this.ready;
    super.clear();
    await this.persistence.clear(this.namespace);
  }
}
