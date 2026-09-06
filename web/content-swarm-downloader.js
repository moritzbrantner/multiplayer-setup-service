import { manifestFile, validateTrustedManifest } from "./content-verification.js";
import { MAX_CHUNKS_PER_REQUEST } from "./content-chunk-exchange.js";

const DEFAULT_MAX_SOURCES = 3;
const MAX_SWARM_SOURCES = 4;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_PEER_READY_TIMEOUT_MS = 10_000;

function requireChunkedFile(manifest, path) {
  const file = manifestFile(manifest, path);
  if (!file.chunks || file.chunks.sha256.length === 0) {
    throw new Error(`Content does not define transferable trusted chunks: ${path}`);
  }
  return file;
}

function validatePositiveInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum}`);
  }
}

function chunks(values, size) {
  const batches = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export class ContentSwarmDownloader extends EventTarget {
  constructor({
    manifest,
    discovery,
    peerPool,
    exchange,
    store,
    maxSources = DEFAULT_MAX_SOURCES,
    batchSize = DEFAULT_BATCH_SIZE,
    peerReadyTimeoutMs = DEFAULT_PEER_READY_TIMEOUT_MS,
  } = {}) {
    validateTrustedManifest(manifest);
    if (!discovery || typeof discovery.seedersForPath !== "function") {
      throw new Error("ContentSwarmDownloader requires seeder discovery");
    }
    if (
      !peerPool ||
      typeof peerPool.connect !== "function" ||
      typeof peerPool.contentPeerIds !== "function" ||
      typeof peerPool.peerIds !== "function" ||
      typeof peerPool.hasCapacity !== "function"
    ) {
      throw new Error("ContentSwarmDownloader requires a content peer pool");
    }
    if (!exchange || typeof exchange.requestChunks !== "function") {
      throw new Error("ContentSwarmDownloader requires a chunk exchange");
    }
    if (
      !store ||
      typeof store.missingChunks !== "function" ||
      typeof store.assembleFile !== "function"
    ) {
      throw new Error("ContentSwarmDownloader requires a verified chunk store");
    }
    validatePositiveInteger(maxSources, "maxSources", MAX_SWARM_SOURCES);
    validatePositiveInteger(batchSize, "batchSize", MAX_CHUNKS_PER_REQUEST);
    if (
      !Number.isSafeInteger(peerReadyTimeoutMs) ||
      peerReadyTimeoutMs < 1 ||
      peerReadyTimeoutMs > 120_000
    ) {
      throw new Error("peerReadyTimeoutMs must be between 1 and 120000 milliseconds");
    }

    this.manifest = manifest;
    this.discovery = discovery;
    this.peerPool = peerPool;
    this.exchange = exchange;
    this.store = store;
    this.maxSources = maxSources;
    this.batchSize = batchSize;
    this.peerReadyTimeoutMs = peerReadyTimeoutMs;
    this.downloads = new Map();
    this.closed = false;
  }

  download(path) {
    if (this.closed) return Promise.reject(new Error("ContentSwarmDownloader is closed"));
    requireChunkedFile(this.manifest, path);

    const existing = this.downloads.get(path);
    if (existing) return existing;

    const operation = this.#download(path).finally(() => {
      if (this.downloads.get(path) === operation) this.downloads.delete(path);
    });
    this.downloads.set(path, operation);
    return operation;
  }

  close() {
    this.closed = true;
  }

  async #download(path) {
    const file = requireChunkedFile(this.manifest, path);
    let missing = this.store.missingChunks(path);
    if (missing.length === 0) return this.#complete(path, file, []);

    const advertised = sortedUnique(this.discovery.seedersForPath(path));
    if (advertised.length === 0) {
      throw new Error(`No seeders advertise trusted content for ${path}`);
    }

    const sources = await this.#prepareSources(advertised);
    if (sources.length === 0) {
      throw new Error(`No advertised seeder became ready for ${path}`);
    }

    const unavailableByPeer = new Map(sources.map((peerId) => [peerId, new Set()]));
    const failedSources = new Set();
    const sourcesUsed = new Set();
    let cursor = 0;

    this.#emitProgress(path, file, sources);

    while (missing.length > 0) {
      const assignments = new Map(sources.map((peerId) => [peerId, []]));
      const unassignable = [];

      for (const index of missing) {
        const eligible = sources.filter(
          (peerId) =>
            !failedSources.has(peerId) && !unavailableByPeer.get(peerId)?.has(index),
        );
        if (eligible.length === 0) {
          unassignable.push(index);
          continue;
        }
        const peerId = eligible[cursor % eligible.length];
        cursor += 1;
        assignments.get(peerId).push(index);
      }

      const work = [];
      for (const peerId of sources) {
        for (const batch of chunks(assignments.get(peerId), this.batchSize)) {
          if (batch.length === 0) continue;
          sourcesUsed.add(peerId);
          work.push({
            peerId,
            batch,
            promise: this.exchange.requestChunks(peerId, path, batch),
          });
        }
      }

      if (work.length === 0) {
        throw new Error(
          `No available seeder can provide the remaining trusted chunks for ${path}: ${unassignable.join(",")}`,
        );
      }

      const before = missing.length;
      const settled = await Promise.allSettled(work.map((entry) => entry.promise));
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        const entry = work[index];
        if (outcome.status === "rejected") {
          failedSources.add(entry.peerId);
          this.dispatchEvent(
            new CustomEvent("source-error", {
              detail: { peerId: entry.peerId, path, error: outcome.reason },
            }),
          );
          continue;
        }

        const result = outcome.value;
        for (const missingIndex of result.missing ?? []) {
          unavailableByPeer.get(entry.peerId)?.add(missingIndex);
        }
      }

      missing = this.store.missingChunks(path);
      this.#emitProgress(path, file, sources.filter((peerId) => !failedSources.has(peerId)));

      if (missing.length === 0) break;
      if (missing.length >= before) {
        const canRetry = missing.some((index) =>
          sources.some(
            (peerId) =>
              !failedSources.has(peerId) && !unavailableByPeer.get(peerId)?.has(index),
          ),
        );
        if (!canRetry) {
          throw new Error(`Seeders could not provide all trusted chunks for ${path}`);
        }
      }
    }

    return this.#complete(path, file, [...sourcesUsed].sort());
  }

  async #prepareSources(advertised) {
    const ready = new Set(this.peerPool.contentPeerIds());
    const selected = [];

    for (const peerId of advertised) {
      if (selected.length >= this.maxSources) break;
      if (ready.has(peerId)) {
        selected.push(peerId);
        continue;
      }

      const exists = this.peerPool.peerIds().includes(peerId);
      if (!exists && !this.peerPool.hasCapacity()) continue;

      try {
        if (!exists) await this.peerPool.connect(peerId);
        await this.#waitForPeer(peerId);
        selected.push(peerId);
      } catch (error) {
        this.dispatchEvent(
          new CustomEvent("source-error", {
            detail: { peerId, path: null, error },
          }),
        );
      }
    }

    return selected;
  }

  #waitForPeer(peerId) {
    if (this.peerPool.contentPeerIds().includes(peerId)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Content peer ${peerId} did not become ready`));
      }, this.peerReadyTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.peerPool.removeEventListener("content-peer-ready", onReady);
        this.peerPool.removeEventListener("content-peer-closed", onClosed);
        this.peerPool.removeEventListener("error", onError);
      };
      const onReady = (event) => {
        if (event.detail?.peerId !== peerId) return;
        cleanup();
        resolve();
      };
      const onClosed = (event) => {
        if (event.detail?.peerId !== peerId) return;
        cleanup();
        reject(new Error(`Content peer ${peerId} closed before becoming ready`));
      };
      const onError = (event) => {
        if (event.detail?.peerId !== peerId) return;
        cleanup();
        reject(event.detail?.error ?? new Error(`Content peer ${peerId} failed`));
      };

      this.peerPool.addEventListener("content-peer-ready", onReady);
      this.peerPool.addEventListener("content-peer-closed", onClosed);
      this.peerPool.addEventListener("error", onError);

      if (this.peerPool.contentPeerIds().includes(peerId)) {
        cleanup();
        resolve();
      }
    });
  }

  async #complete(path, file, sourcesUsed) {
    const bytes = await this.store.assembleFile(path);
    const result = {
      path,
      bytes,
      sha256: file.sha256,
      sources: sourcesUsed,
      chunks: file.chunks.sha256.length,
    };
    this.dispatchEvent(new CustomEvent("complete", { detail: result }));
    return result;
  }

  #emitProgress(path, file, sources) {
    const missing = this.store.missingChunks(path);
    this.dispatchEvent(
      new CustomEvent("progress", {
        detail: {
          path,
          verifiedChunks: file.chunks.sha256.length - missing.length,
          totalChunks: file.chunks.sha256.length,
          sources: [...sources].sort(),
        },
      }),
    );
  }
}
