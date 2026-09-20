import type { ContentManifest } from "./content-manifest.ts";
export type StoredChunk = {key: string; namespace: string; path: string; index: number; bytes: Uint8Array<ArrayBuffer>; touchedAt: number};
export type ChunkPersistence = {
 list: (namespace: string) => Promise<StoredChunk[]>;
 put: (namespace: string, path: string, index: number, bytes: Uint8Array<ArrayBuffer>, touchedAt?: number) => Promise<void>;
 touch?: (namespace: string, path: string, index: number, touchedAt?: number) => Promise<void>;
 delete: (namespace: string, path: string, index: number) => Promise<void>;
 deletePath: (namespace: string, path: string) => Promise<void>;
 clear: (namespace: string) => Promise<void>;
};
type StoragePressure = {namespace: string; maxBytes: number; requestedBytes: number; persistedBytes: number; evictedEntries: number; evictedBytes: number};
import { validateTrustedManifest } from "./content-verification.ts";
import { VerifiedChunkStore } from "./verified-chunk-store.ts";

const DEFAULT_DATABASE = "multiplayer-verified-content-v1";
const STORE_NAME = "chunks";
export const DEFAULT_MAX_PERSISTED_CONTENT_BYTES = 256 * 1024 * 1024;

function namespaceFor(manifest: ContentManifest) {
  validateTrustedManifest(manifest);
  return `${manifest.game.id}\0${manifest.game.version}`;
}

function storageKey(namespace: string, path: string, index: number) {
  return `${namespace}\0${path}\0${index}`;
}

function toStoredBytes(value: Uint8Array<ArrayBuffer>) {
  if (!(value instanceof Uint8Array)) throw new Error("Verified cache only stores Uint8Array chunks");
  return value.slice().buffer;
}

function validateMaxBytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
}

function normalizedTouchedAt(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function openDatabase(name: string) {
  if (!globalThis.indexedDB) throw new Error("IndexedDB is not available in this environment");
  return new Promise<IDBDatabase>((resolve, reject) => {
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

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Verified cache transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Verified cache transaction failed")), {
      once: true,
    });
  });
}

function requestResult<T>(request: IDBRequest<T>, message: string) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error(message)), { once: true });
  });
}

export class MemoryChunkPersistence {
  entries: Map<string, StoredChunk>;
  now: () => number;
  constructor({ now = () => Date.now() } = {}) {
    if (typeof now !== "function") throw new Error("now must be a function");
    this.entries = new Map();
    this.now = now;
  }

  async list(namespace: string): Promise<StoredChunk[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.namespace === namespace)
      .map((entry) => ({ ...entry, bytes: entry.bytes.slice() }));
  }

  async put(namespace: string, path: string, index: number, bytes: Uint8Array<ArrayBuffer>, touchedAt = this.now()) {
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

  async touch(namespace: string, path: string, index: number, touchedAt = this.now()) {
    const entry = this.entries.get(storageKey(namespace, path, index));
    if (entry) entry.touchedAt = normalizedTouchedAt(touchedAt);
  }

  async delete(namespace: string, path: string, index: number) {
    this.entries.delete(storageKey(namespace, path, index));
  }

  async deletePath(namespace: string, path: string) {
    for (const [key, entry] of this.entries) {
      if (entry.namespace === namespace && entry.path === path) this.entries.delete(key);
    }
  }

  async clear(namespace: string) {
    for (const [key, entry] of this.entries) {
      if (entry.namespace === namespace) this.entries.delete(key);
    }
  }
}

export class IndexedDbChunkPersistence {
  databaseName: string;
  databasePromise: Promise<IDBDatabase> | null;
  constructor({ databaseName = DEFAULT_DATABASE } = {}) {
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  async #database() {
    this.databasePromise ??= openDatabase(this.databaseName);
    return this.databasePromise;
  }

  async list(namespace: string): Promise<StoredChunk[]> {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("namespace");
    const result: (Omit<StoredChunk, "bytes"> & {bytes: ArrayBuffer})[] = (await requestResult(index.getAll(namespace), "Could not read verified cache")) ?? [];
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

  async put(namespace: string, path: string, index: number, bytes: Uint8Array<ArrayBuffer>, touchedAt = Date.now()) {
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

  async touch(namespace: string, path: string, index: number, touchedAt = Date.now()) {
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

  async delete(namespace: string, path: string, index: number) {
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(storageKey(namespace, path, index));
    await transactionDone(transaction);
  }

  async deletePath(namespace: string, path: string) {
    const entries = await this.list(namespace);
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const entry of entries) {
      if (entry.path === path) store.delete(storageKey(namespace, entry.path, entry.index));
    }
    await transactionDone(transaction);
  }

  async clear(namespace: string) {
    const entries = await this.list(namespace);
    const database = await this.#database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const entry of entries) store.delete(storageKey(namespace, entry.path, entry.index));
    await transactionDone(transaction);
  }
}

export class PersistentVerifiedChunkStore extends VerifiedChunkStore {
  persistence: ChunkPersistence;
  namespace: string;
  maxBytes: number;
  onStoragePressure: ((detail: StoragePressure) => void) | null;
  now: () => number;
  lastTouchedAt: number;
  ready: Promise<{accepted: number; rejected: number}>;
  constructor({
    manifest,
    persistence = new IndexedDbChunkPersistence(),
    maxBytes = DEFAULT_MAX_PERSISTED_CONTENT_BYTES,
    onStoragePressure = null,
    now = () => Date.now(),
  }: {manifest: ContentManifest; persistence?: ChunkPersistence; maxBytes?: number; onStoragePressure?: ((detail: StoragePressure) => void) | null; now?: () => number}) {
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

  override getChunk(path: string, index: number) {
    const chunk = super.getChunk(path, index);
    if (chunk && typeof this.persistence.touch === "function") {
      const touchedAt = this.#stamp();
      Promise.resolve(this.persistence.touch(this.namespace, path, index, touchedAt)).catch(() => {
        // A failed LRU touch must not invalidate already verified in-memory bytes.
      });
    }
    return chunk;
  }

  override async putChunk(path: string, index: number, value: unknown) {
    await this.ready;
    const verification = await super.putChunk(path, index, value);
    const verified = super.getChunk(path, index);
    if (!verified) throw new Error("Verified chunk disappeared before persistence");
    await this.persistence.put(this.namespace, path, index, verified, this.#stamp());
    await this.#enforceBudget();
    return verification;
  }

  override async putFile(path: string, value: unknown) {
    await this.ready;
    const result = await super.putFile(path, value);
    for (const index of super.availableChunks(path)) {
      const chunk = super.getChunk(path, index);
      if (!chunk) throw new Error("Verified chunk disappeared before persistence");
      await this.persistence.put(this.namespace, path, index, chunk, this.#stamp());
    }
    await this.#enforceBudget();
    return result;
  }

  override async clearPath(path: string) {
    await this.ready;
    super.clearPath(path);
    await this.persistence.deletePath(this.namespace, path);
  }

  override async clear() {
    await this.ready;
    super.clear();
    await this.persistence.clear(this.namespace);
  }
}
