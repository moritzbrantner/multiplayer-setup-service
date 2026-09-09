import { ContentTransfer } from "./content-transfer.js";
import { manifestFile, validateTrustedManifest } from "./content-verification.js";

export const GAME_FILE_PROTOCOL = "multiplayer-game-file-v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const REQUEST_ID_PATTERN = /^[0-9a-f]{16}$/;
const MAX_REJECTION_REASON_LENGTH = 128;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePeerId(peerId) {
  if (typeof peerId !== "string" || peerId === "") throw new Error("peerId must be a non-empty string");
  return peerId;
}

function requireRequestId(requestId) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Invalid game file request id");
  }
  return requestId;
}

function requireTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  return timeoutMs;
}

function requireMaxPending(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("maxPendingRequests must be a positive safe integer");
  }
  return value;
}

function requireReason(reason) {
  if (
    typeof reason !== "string" ||
    reason.trim() === "" ||
    reason.length > MAX_REJECTION_REASON_LENGTH
  ) {
    throw new Error("File rejection reason must be a non-empty short string");
  }
  return reason;
}

function randomRequestId(activeIds) {
  const values = new Uint32Array(2);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    globalThis.crypto.getRandomValues(values);
    const requestId = [...values].map((value) => value.toString(16).padStart(8, "0")).join("");
    if (!activeIds.has(requestId)) return requestId;
  }
  throw new Error("Could not allocate a unique file request id");
}

function requestKey(peerId, requestId) {
  return `${peerId}:${requestId}`;
}

function controlMessage(type, fields) {
  return { protocol: GAME_FILE_PROTOCOL, type, ...fields };
}

function parseControl(value) {
  if (!isObject(value) || value.protocol !== GAME_FILE_PROTOCOL) return null;
  if (value.type !== "request" && value.type !== "reject") {
    throw new Error(`Unsupported game file control type: ${String(value.type)}`);
  }
  requireRequestId(value.id);
  requirePeerId(value.path);
  if (value.type === "reject") requireReason(value.reason);
  return value;
}

export class FileRequestRejectedError extends Error {
  constructor(path, reason) {
    super(`File request for ${path} was rejected: ${reason}`);
    this.name = "FileRequestRejectedError";
    this.path = path;
    this.reason = reason;
  }
}

export class GameFiles extends EventTarget {
  constructor({
    session,
    manifest,
    transfer = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
  } = {}) {
    super();
    if (
      !session ||
      session.contentSharing !== true ||
      typeof session.addEventListener !== "function" ||
      typeof session.removeEventListener !== "function" ||
      typeof session.sendReliable !== "function"
    ) {
      throw new Error("GameFiles requires a LobbySession with contentSharing enabled");
    }
    validateTrustedManifest(manifest);
    requireTimeout(requestTimeoutMs);
    requireMaxPending(maxPendingRequests);

    this.session = session;
    this.manifest = manifest;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxPendingRequests = maxPendingRequests;
    this.providers = new Map();
    this.pending = new Map();
    this.incoming = new Map();
    this.closed = false;
    this.ownsTransfer = transfer == null;
    this.transfer = transfer ?? new ContentTransfer({ session, manifest });

    this.onReliable = (event) => this.#handleReliable(event.detail?.peerId, event.detail?.data);
    this.onStarted = (event) => this.#handleStarted(event.detail);
    this.onFile = (event) => this.#handleFile(event.detail);
    this.onProgress = (event) => this.#handleProgress(event.detail);
    this.onTransferFailed = (event) => this.#handleTransferFailed(event.detail);
    this.onTransferError = (event) => this.#emit("error", event.detail ?? {});

    session.addEventListener("reliable", this.onReliable);
    this.transfer.addEventListener("started", this.onStarted);
    this.transfer.addEventListener("file", this.onFile);
    this.transfer.addEventListener("progress", this.onProgress);
    this.transfer.addEventListener("failed", this.onTransferFailed);
    this.transfer.addEventListener("error", this.onTransferError);
  }

  provide(path, provider) {
    this.#assertOpen();
    manifestFile(this.manifest, path);
    if (typeof provider !== "function") throw new Error("File provider must be a function");
    this.providers.set(path, provider);
    return () => {
      if (this.providers.get(path) === provider) this.providers.delete(path);
    };
  }

  requestFile(peerId, path, { timeoutMs = this.requestTimeoutMs } = {}) {
    this.#assertOpen();
    const remotePeerId = requirePeerId(peerId);
    manifestFile(this.manifest, path);
    requireTimeout(timeoutMs);
    if (this.pending.size >= this.maxPendingRequests) {
      throw new Error("Too many pending file requests");
    }
    if ([...this.pending.values()].some((pending) => pending.peerId === remotePeerId)) {
      throw new Error(`Peer ${remotePeerId} already has a pending file request`);
    }
    if (
      typeof this.session.contentPeerIds === "function" &&
      !this.session.contentPeerIds().includes(remotePeerId)
    ) {
      throw new Error(`Content channel for peer ${remotePeerId} is not ready`);
    }

    const requestId = randomRequestId(new Set(this.pending.keys()));
    return new Promise((resolve, reject) => {
      const pending = {
        requestId,
        peerId: remotePeerId,
        path,
        timeout: null,
        timeoutMs,
        resolve,
        reject,
      };
      this.pending.set(requestId, pending);
      this.#armPendingTimeout(pending);

      try {
        this.session.sendReliable(
          remotePeerId,
          controlMessage("request", { id: requestId, path }),
        );
      } catch (error) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async sendFile(request, value) {
    this.#assertOpen();
    const active = this.#requireIncomingRequest(request);
    if (active.state !== "waiting") throw new Error("File request is already being handled");
    active.state = "sending";

    try {
      await this.transfer.sendFile(active.peerId, active.path, value, {
        requestId: active.requestId,
      });
      this.incoming.delete(requestKey(active.peerId, active.requestId));
      this.#emit("sent", {
        peerId: active.peerId,
        requestId: active.requestId,
        path: active.path,
      });
    } catch (error) {
      this.incoming.delete(requestKey(active.peerId, active.requestId));
      try {
        this.#sendReject(active.peerId, active.requestId, active.path, "send-failed");
      } catch {
        // Preserve the original transfer failure.
      }
      throw error;
    }
  }

  rejectRequest(request, reason = "unavailable") {
    this.#assertOpen();
    const active = this.#requireIncomingRequest(request);
    if (active.state !== "waiting") throw new Error("File request is already being handled");
    const rejectionReason = requireReason(reason);
    this.incoming.delete(requestKey(active.peerId, active.requestId));
    this.#sendReject(active.peerId, active.requestId, active.path, rejectionReason);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.removeEventListener("reliable", this.onReliable);
    this.transfer.removeEventListener("started", this.onStarted);
    this.transfer.removeEventListener("file", this.onFile);
    this.transfer.removeEventListener("progress", this.onProgress);
    this.transfer.removeEventListener("failed", this.onTransferFailed);
    this.transfer.removeEventListener("error", this.onTransferError);
    if (this.ownsTransfer) this.transfer.close();

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("GameFiles is closed"));
    }
    this.pending.clear();
    this.incoming.clear();
    this.providers.clear();
  }

  #handleReliable(peerId, value) {
    if (this.closed || typeof peerId !== "string" || peerId === "") return;

    let message;
    try {
      message = parseControl(value);
    } catch (error) {
      this.#emit("error", { peerId, error });
      return;
    }
    if (!message) return;

    try {
      if (message.type === "request") {
        this.#receiveRequest(peerId, message);
        return;
      }
      this.#receiveRejection(peerId, message);
    } catch (error) {
      this.#emit("error", { peerId, error });
    }
  }

  #receiveRequest(peerId, message) {
    try {
      manifestFile(this.manifest, message.path);
    } catch {
      this.#sendReject(peerId, message.id, message.path, "not-authorized");
      return;
    }

    if (
      typeof this.session.contentPeerIds === "function" &&
      !this.session.contentPeerIds().includes(peerId)
    ) {
      this.#sendReject(peerId, message.id, message.path, "content-not-ready");
      return;
    }

    const key = requestKey(peerId, message.id);
    if (this.incoming.has(key)) {
      this.#sendReject(peerId, message.id, message.path, "duplicate-request");
      return;
    }
    if (
      this.incoming.size >= this.maxPendingRequests ||
      [...this.incoming.values()].some((request) => request.peerId === peerId)
    ) {
      this.#sendReject(peerId, message.id, message.path, "busy");
      return;
    }

    const request = {
      peerId,
      requestId: message.id,
      path: message.path,
      state: "waiting",
    };
    this.incoming.set(key, request);

    const provider = this.providers.get(request.path);
    if (!provider) {
      this.#emit("request", {
        peerId: request.peerId,
        requestId: request.requestId,
        path: request.path,
      });
      return;
    }

    Promise.resolve()
      .then(() => provider({ peerId: request.peerId, requestId: request.requestId, path: request.path }))
      .then((value) => {
        if (value == null) {
          this.rejectRequest(request, "unavailable");
          return;
        }
        return this.sendFile(request, value);
      })
      .catch((error) => {
        const current = this.incoming.get(key);
        if (current?.state === "waiting") {
          try {
            this.rejectRequest(current, "provider-failed");
          } catch {
            // The error event below is authoritative for diagnostics.
          }
        }
        this.#emit("error", { peerId, requestId: message.id, path: message.path, error });
      });
  }

  #receiveRejection(peerId, message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (pending.peerId !== peerId || pending.path !== message.path) {
      this.#emit("error", {
        peerId,
        error: new Error("File rejection does not match the pending request"),
      });
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    pending.reject(new FileRequestRejectedError(pending.path, message.reason));
  }

  #handleStarted(detail) {
    const pending = this.#matchingPending(detail);
    if (!pending) return;
    this.#armPendingTimeout(pending);
  }

  #handleFile(detail) {
    const requestId = detail?.requestId;
    if (!requestId || !this.pending.has(requestId)) return;
    const pending = this.pending.get(requestId);
    if (pending.peerId !== detail.peerId || pending.path !== detail.path) {
      this.#emit("error", {
        peerId: detail?.peerId,
        requestId,
        error: new Error("Received file does not match the pending request"),
      });
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    this.#emit("file", { ...detail, requestId });
    pending.resolve(detail.bytes);
  }

  #handleProgress(detail) {
    const pending = this.#matchingPending(detail);
    if (!pending) return;
    this.#armPendingTimeout(pending);
    this.#emit("progress", { ...detail, requestId: pending.requestId });
  }

  #handleTransferFailed(detail) {
    const pending = this.#matchingPending(detail);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(pending.requestId);
    pending.reject(detail?.error instanceof Error ? detail.error : new Error(`File transfer failed for ${pending.path}`));
  }

  #matchingPending(detail) {
    const requestId = detail?.requestId;
    if (!requestId || !this.pending.has(requestId)) return null;
    const pending = this.pending.get(requestId);
    if (pending.peerId !== detail.peerId || pending.path !== detail.path) return null;
    return pending;
  }

  #armPendingTimeout(pending) {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      if (this.pending.get(pending.requestId) !== pending) return;
      this.pending.delete(pending.requestId);
      pending.reject(new Error(`File request timed out for ${pending.path}`));
    }, pending.timeoutMs);
  }

  #requireIncomingRequest(request) {
    if (!isObject(request)) throw new Error("File request must be an object emitted by GameFiles");
    const peerId = requirePeerId(request.peerId);
    const requestId = requireRequestId(request.requestId);
    const path = requirePeerId(request.path);
    const active = this.incoming.get(requestKey(peerId, requestId));
    if (!active || active.path !== path) throw new Error("File request is no longer active");
    return active;
  }

  #sendReject(peerId, requestId, path, reason) {
    this.session.sendReliable(
      peerId,
      controlMessage("reject", { id: requestId, path, reason: requireReason(reason) }),
    );
  }

  #assertOpen() {
    if (this.closed) throw new Error("GameFiles is closed");
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
