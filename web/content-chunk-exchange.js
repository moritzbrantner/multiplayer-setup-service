import { manifestFile, validateTrustedManifest } from "./content-verification.js";

export const CONTENT_CHUNK_EXCHANGE_PROTOCOL = 1;
export const MAX_CHUNKS_PER_REQUEST = 64;
export const MAX_EXCHANGE_CHUNK_BYTES = 60 * 1024;

const CHUNK_FRAME_MAGIC = 0x4d504332;
const CHUNK_FRAME_HEADER_BYTES = 12;
const MAX_CONTROL_BYTES = 8 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRequestId(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function requestKey(peerId, requestId) {
  return `${peerId}:${requestId}`;
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("Chunk exchange payload must be binary data");
}

function requireExchangeableFile(manifest, path) {
  const file = manifestFile(manifest, path);
  if (!file.chunks || file.chunks.sha256.length === 0) {
    throw new Error(`Content does not define transferable trusted chunks: ${path}`);
  }
  if (file.chunks.bytes > MAX_EXCHANGE_CHUNK_BYTES) {
    throw new Error(
      `Trusted chunk size for ${path} exceeds the ${MAX_EXCHANGE_CHUNK_BYTES}-byte exchange limit`,
    );
  }
  return file;
}

function normalizeIndexes(file, indexes) {
  if (!Array.isArray(indexes) || indexes.length === 0 || indexes.length > MAX_CHUNKS_PER_REQUEST) {
    throw new Error(`Chunk request must contain between 1 and ${MAX_CHUNKS_PER_REQUEST} indexes`);
  }
  const normalized = [...indexes];
  if (
    normalized.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= file.chunks.sha256.length,
    )
  ) {
    throw new Error("Chunk request contains an invalid index");
  }
  normalized.sort((left, right) => left - right);
  if (normalized.some((index, offset) => offset > 0 && index === normalized[offset - 1])) {
    throw new Error("Chunk request indexes must be unique");
  }
  return normalized;
}

function parseControl(value) {
  if (typeof value !== "string") return null;
  if (new TextEncoder().encode(value).byteLength > MAX_CONTROL_BYTES) {
    throw new Error("Chunk exchange control message is too large");
  }
  let message;
  try {
    message = JSON.parse(value);
  } catch {
    throw new Error("Chunk exchange control message is not valid JSON");
  }
  if (!isObject(message) || message.v !== CONTENT_CHUNK_EXCHANGE_PROTOCOL) {
    throw new Error("Unsupported chunk exchange control message");
  }
  return message;
}

function createChunkFrame(requestId, index, payload) {
  const frame = new Uint8Array(CHUNK_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, CHUNK_FRAME_MAGIC);
  view.setUint32(4, requestId);
  view.setUint32(8, index);
  frame.set(payload, CHUNK_FRAME_HEADER_BYTES);
  return frame.buffer;
}

async function parseChunkFrame(value) {
  const bytes = await toBytes(value);
  if (bytes.byteLength < CHUNK_FRAME_HEADER_BYTES) {
    throw new Error("Chunk exchange frame is too short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== CHUNK_FRAME_MAGIC) {
    throw new Error("Chunk exchange frame has an invalid magic value");
  }
  return {
    requestId: view.getUint32(4),
    index: view.getUint32(8),
    payload: bytes.slice(CHUNK_FRAME_HEADER_BYTES),
  };
}

function randomRequestId(pendingRequests) {
  const values = new Uint32Array(1);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    globalThis.crypto.getRandomValues(values);
    const value = values[0];
    if (value === 0) continue;
    if (![...pendingRequests.values()].some((pending) => pending.requestId === value)) return value;
  }
  throw new Error("Could not allocate a unique chunk request id");
}

export class ContentChunkExchange extends EventTarget {
  constructor({
    transport,
    manifest,
    store,
    cache = null,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    super();
    if (!transport || transport.contentSharing !== true) {
      throw new Error("ContentChunkExchange requires a content-enabled transport");
    }
    if (!store || typeof store.putChunk !== "function" || typeof store.getChunk !== "function") {
      throw new Error("ContentChunkExchange requires a verified chunk store");
    }
    if (cache !== null && typeof cache.putChunk !== "function") {
      throw new Error("ContentChunkExchange cache requires putChunk()");
    }
    validateTrustedManifest(manifest);
    if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 128) {
      throw new Error("maxPendingRequests must be between 1 and 128");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000) {
      throw new Error("requestTimeoutMs must be between 1 and 300000 milliseconds");
    }

    this.transport = transport;
    this.manifest = manifest;
    this.store = store;
    this.cache = cache;
    this.maxPendingRequests = maxPendingRequests;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pendingRequests = new Map();
    this.peerChains = new Map();
    this.closed = false;

    this.onContent = (event) => this.#enqueue(event.detail?.peerId, event.detail?.data);
    this.onPeerClosed = (event) => this.#rejectPeer(event.detail?.peerId, "Content peer closed");
    transport.addEventListener("content", this.onContent);
    transport.addEventListener("content-peer-closed", this.onPeerClosed);
  }

  async requestChunks(peerId, path, indexes) {
    if (this.closed) throw new Error("ContentChunkExchange is closed");
    if (typeof peerId !== "string" || peerId === "") throw new Error("peerId is required");
    const file = requireExchangeableFile(this.manifest, path);
    const requested = normalizeIndexes(file, indexes);
    if (this.pendingRequests.size >= this.maxPendingRequests) {
      throw new Error("Too many pending chunk requests");
    }

    const requestId = randomRequestId(this.pendingRequests);
    const key = requestKey(peerId, requestId);
    let settle;
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timeout = setTimeout(() => {
      const pending = this.pendingRequests.get(key);
      if (!pending) return;
      this.pendingRequests.delete(key);
      pending.reject(new Error(`Chunk request timed out for ${path}`));
    }, this.requestTimeoutMs);

    this.pendingRequests.set(key, {
      peerId,
      requestId,
      path,
      requested,
      received: new Set(),
      timeout,
      resolve: settle.resolve,
      reject: settle.reject,
    });

    try {
      await this.transport.sendContent(
        peerId,
        JSON.stringify({
          v: CONTENT_CHUNK_EXCHANGE_PROTOCOL,
          type: "chunk-request",
          requestId,
          path,
          indexes: requested,
        }),
      );
    } catch (error) {
      this.#rejectRequest(key, error);
    }

    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.transport.removeEventListener("content", this.onContent);
    this.transport.removeEventListener("content-peer-closed", this.onPeerClosed);
    for (const key of [...this.pendingRequests.keys()]) {
      this.#rejectRequest(key, new Error("ContentChunkExchange closed"));
    }
    this.peerChains.clear();
  }

  #enqueue(peerId, data) {
    if (this.closed || typeof peerId !== "string" || peerId === "") return;
    const previous = this.peerChains.get(peerId) ?? Promise.resolve();
    const next = previous
      .then(() => this.#handleMessage(peerId, data))
      .catch((error) => {
        this.dispatchEvent(new CustomEvent("error", { detail: { peerId, error } }));
      });
    this.peerChains.set(peerId, next);
  }

  async #handleMessage(peerId, data) {
    const control = parseControl(data);
    if (control) {
      if (control.type === "chunk-request") await this.#serveRequest(peerId, control);
      else if (control.type === "chunk-complete") this.#completeRequest(peerId, control);
      else if (control.type === "chunk-error") this.#handleRemoteError(peerId, control);
      else throw new Error(`Unsupported chunk exchange message: ${String(control.type)}`);
      return;
    }
    await this.#acceptChunk(peerId, data);
  }

  async #serveRequest(peerId, message) {
    if (!validRequestId(message.requestId) || typeof message.path !== "string") {
      throw new Error("Invalid incoming chunk request");
    }

    let file;
    let indexes;
    try {
      file = requireExchangeableFile(this.manifest, message.path);
      indexes = normalizeIndexes(file, message.indexes);
    } catch {
      await this.#sendError(peerId, message.requestId, "invalid-request");
      return;
    }

    for (const index of indexes) {
      const chunk = this.store.getChunk(message.path, index);
      if (!chunk) continue;
      await this.transport.sendContent(peerId, createChunkFrame(message.requestId, index, chunk));
    }
    await this.transport.sendContent(
      peerId,
      JSON.stringify({
        v: CONTENT_CHUNK_EXCHANGE_PROTOCOL,
        type: "chunk-complete",
        requestId: message.requestId,
      }),
    );
  }

  async #acceptChunk(peerId, data) {
    const frame = await parseChunkFrame(data);
    const key = requestKey(peerId, frame.requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending) throw new Error("Chunk response does not belong to a pending request");
    if (!pending.requested.includes(frame.index)) {
      this.#rejectRequest(key, new Error(`Peer returned an unrequested chunk ${frame.index}`));
      return;
    }
    if (pending.received.has(frame.index)) {
      this.#rejectRequest(key, new Error(`Peer returned duplicate chunk ${frame.index}`));
      return;
    }

    try {
      await this.store.putChunk(pending.path, frame.index, frame.payload);
    } catch (error) {
      this.#rejectRequest(key, error);
      return;
    }

    if (this.cache) {
      try {
        await this.cache.putChunk(pending.path, frame.index, frame.payload);
      } catch (error) {
        this.dispatchEvent(
          new CustomEvent("cache-error", {
            detail: { peerId, path: pending.path, index: frame.index, error },
          }),
        );
      }
    }

    pending.received.add(frame.index);
    this.dispatchEvent(
      new CustomEvent("chunk", {
        detail: {
          peerId,
          path: pending.path,
          requestId: pending.requestId,
          index: frame.index,
        },
      }),
    );
  }

  #completeRequest(peerId, message) {
    if (!validRequestId(message.requestId)) throw new Error("Invalid chunk completion id");
    const key = requestKey(peerId, message.requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending) return;
    this.pendingRequests.delete(key);
    clearTimeout(pending.timeout);

    const received = pending.requested.filter((index) => pending.received.has(index));
    const missing = pending.requested.filter((index) => !pending.received.has(index));
    pending.resolve({
      peerId,
      path: pending.path,
      requestId: pending.requestId,
      received,
      missing,
    });
  }

  #handleRemoteError(peerId, message) {
    if (!validRequestId(message.requestId)) throw new Error("Invalid chunk error id");
    const key = requestKey(peerId, message.requestId);
    if (!this.pendingRequests.has(key)) return;
    this.#rejectRequest(key, new Error(`Peer rejected chunk request: ${String(message.code ?? "error")}`));
  }

  async #sendError(peerId, requestId, code) {
    if (!validRequestId(requestId)) return;
    await this.transport.sendContent(
      peerId,
      JSON.stringify({
        v: CONTENT_CHUNK_EXCHANGE_PROTOCOL,
        type: "chunk-error",
        requestId,
        code,
      }),
    );
  }

  #rejectRequest(key, error) {
    const pending = this.pendingRequests.get(key);
    if (!pending) return;
    this.pendingRequests.delete(key);
    clearTimeout(pending.timeout);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  #rejectPeer(peerId, message) {
    if (typeof peerId !== "string") return;
    for (const [key, pending] of this.pendingRequests) {
      if (pending.peerId === peerId) this.#rejectRequest(key, new Error(message));
    }
  }
}
