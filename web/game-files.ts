import { TypedEventTarget } from "./events.ts";
import type { Timer } from "./events.ts";
import type { ResilientLobbySession } from "./resilient-lobby-session.ts";
import type { ContentManifest } from "./content-manifest.ts";
import type { TransferEvents } from "./content-transfer.ts";
export type FileRequest = {peerId: string; requestId: string; path: string};
type FileControl = {type: "request" | "reject"; id: string; path: string; reason?: string};
type IncomingFile = FileRequest & {state: "waiting" | "sending"; timeout: Timer | undefined};
type PendingFile = FileRequest & {timeout: Timer | undefined; timeoutMs: number; resolve: (bytes: Uint8Array<ArrayBuffer>) => void; reject: (error: unknown) => void};
type FileEvents = {request: FileRequest; sent: FileRequest; file: TransferEvents["file"]; progress: TransferEvents["progress"]; error: {peerId: string; requestId?: string | null; path?: string; error: unknown}};
import { ContentTransfer } from "./content-transfer.ts";
import { manifestFile, validateTrustedManifest, verifyContent } from "./content-verification.ts";

export const GAME_FILE_PROTOCOL = "multiplayer-game-file-v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const REQUEST_ID_PATTERN = /^[0-9a-f]{16}$/;
const MAX_REJECTION_REASON_LENGTH = 128;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePeerId(peerId: unknown) {
  if (typeof peerId !== "string" || peerId === "") throw new Error("peerId must be a non-empty string");
  return peerId;
}

function requireRequestId(requestId: unknown) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Invalid game file request id");
  }
  return requestId;
}

function requireTimeout(timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  return timeoutMs;
}

function requireMaxPending(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("maxPendingRequests must be a positive safe integer");
  }
  return value;
}

function requireReason(reason: unknown) {
  if (
    typeof reason !== "string" ||
    reason.trim() === "" ||
    reason.length > MAX_REJECTION_REASON_LENGTH
  ) {
    throw new Error("File rejection reason must be a non-empty short string");
  }
  return reason;
}

function randomRequestId(activeIds: Set<string>) {
  const values = new Uint32Array(2);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    globalThis.crypto.getRandomValues(values);
    const requestId = [...values].map((value) => value.toString(16).padStart(8, "0")).join("");
    if (!activeIds.has(requestId)) return requestId;
  }
  throw new Error("Could not allocate a unique file request id");
}

function requestKey(peerId: string, requestId: string) {
  return `${peerId}:${requestId}`;
}

function controlMessage(type: string, fields: Record<string, unknown>) {
  return { protocol: GAME_FILE_PROTOCOL, type, ...fields };
}

function parseControl(value: unknown): FileControl | null {
  if (!isObject(value) || value.protocol !== GAME_FILE_PROTOCOL) return null;
  if (value.type !== "request" && value.type !== "reject") {
    throw new Error(`Unsupported game file control type: ${String(value.type)}`);
  }
  requireRequestId(value.id);
  requirePeerId(value.path);
  if (value.type === "reject") requireReason(value.reason);
  return { type: value.type, id: requireRequestId(value.id), path: requirePeerId(value.path), ...(value.type === "reject" ? {reason: requireReason(value.reason)} : {}) };
}

export class FileRequestRejectedError extends Error {
  path: string;
  reason: string;
  constructor(path: string, reason: string) {
    super(`File request for ${path} was rejected: ${reason}`);
    this.name = "FileRequestRejectedError";
    this.path = path;
    this.reason = reason;
  }
}

export class GameFiles extends TypedEventTarget<FileEvents> {
  session: ResilientLobbySession;
  manifest: ContentManifest;
  requestTimeoutMs: number;
  incomingRequestTimeoutMs: number;
  maxPendingRequests: number;
  providers: Map<string, (request: FileRequest) => unknown>;
  pending: Map<string, PendingFile>;
  incoming: Map<string, IncomingFile>;
  closed: boolean;
  ownsTransfer: boolean;
  transfer: ContentTransfer;
  onReliable: (event: CustomEvent<{peerId: string; data: unknown}>) => void;
  onParticipantDisconnected: (event: CustomEvent<{participantId: string}>) => void;
  onStarted: (event: CustomEvent<TransferEvents["started"]>) => void;
  onFile: (event: CustomEvent<TransferEvents["file"]>) => void;
  onProgress: (event: CustomEvent<TransferEvents["progress"]>) => void;
  onTransferFailed: (event: CustomEvent<TransferEvents["failed"]>) => void;
  onTransferError: (event: CustomEvent<TransferEvents["error"]>) => void;

  constructor({
    session,
    manifest,
    transfer = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    incomingRequestTimeoutMs = requestTimeoutMs,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
  }: {session: ResilientLobbySession; manifest: ContentManifest; transfer?: ContentTransfer | null; requestTimeoutMs?: number; incomingRequestTimeoutMs?: number; maxPendingRequests?: number}) {
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
    requireTimeout(incomingRequestTimeoutMs);
    requireMaxPending(maxPendingRequests);

    this.session = session;
    this.manifest = manifest;
    this.requestTimeoutMs = requestTimeoutMs;
    this.incomingRequestTimeoutMs = incomingRequestTimeoutMs;
    this.maxPendingRequests = maxPendingRequests;
    this.providers = new Map();
    this.pending = new Map();
    this.incoming = new Map();
    this.closed = false;
    this.ownsTransfer = transfer == null;
    this.transfer = transfer ?? new ContentTransfer({ session, manifest });

    this.onReliable = (event) => this.#handleReliable(event.detail?.peerId, event.detail?.data);
    this.onParticipantDisconnected = (event) => this.#handleParticipantDisconnected(event.detail?.participantId);
    this.onStarted = (event) => this.#handleStarted(event.detail);
    this.onFile = (event) => {
      this.#handleFile(event.detail).catch((error) => {
        this.#emit("error", {
          peerId: event.detail?.peerId,
          requestId: event.detail?.requestId,
          error,
        });
      });
    };
    this.onProgress = (event) => this.#handleProgress(event.detail);
    this.onTransferFailed = (event) => this.#handleTransferFailed(event.detail);
    this.onTransferError = (event) => this.#emit("error", event.detail ?? {});

    session.addEventListener("reliable", this.onReliable);
    session.addEventListener("participant-disconnected", this.onParticipantDisconnected);
    this.transfer.addEventListener("started", this.onStarted);
    this.transfer.addEventListener("file", this.onFile);
    this.transfer.addEventListener("progress", this.onProgress);
    this.transfer.addEventListener("failed", this.onTransferFailed);
    this.transfer.addEventListener("error", this.onTransferError);
  }

  provide(path: string, provider: (request: FileRequest) => unknown) {
    this.#assertOpen();
    manifestFile(this.manifest, path);
    if (typeof provider !== "function") throw new Error("File provider must be a function");
    this.providers.set(path, provider);
    return () => {
      if (this.providers.get(path) === provider) this.providers.delete(path);
    };
  }

  requestFile(peerId: string, path: string, { timeoutMs = this.requestTimeoutMs } = {}) {
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
    return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const pending: PendingFile = {
        requestId,
        peerId: remotePeerId,
        path,
        timeout: undefined,
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

  async sendFile(request: FileRequest, value: unknown) {
    this.#assertOpen();
    const active = this.#requireIncomingRequest(request);
    if (active.state !== "waiting") throw new Error("File request is already being handled");
    clearTimeout(active.timeout);
    active.timeout = undefined;
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

  rejectRequest(request: FileRequest, reason = "unavailable") {
    this.#assertOpen();
    const active = this.#requireIncomingRequest(request);
    if (active.state !== "waiting") throw new Error("File request is already being handled");
    const rejectionReason = requireReason(reason);
    clearTimeout(active.timeout);
    active.timeout = undefined;
    this.incoming.delete(requestKey(active.peerId, active.requestId));
    this.#sendReject(active.peerId, active.requestId, active.path, rejectionReason);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.removeEventListener("reliable", this.onReliable);
    this.session.removeEventListener("participant-disconnected", this.onParticipantDisconnected);
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
    for (const request of this.incoming.values()) clearTimeout(request.timeout);
    this.incoming.clear();
    this.providers.clear();
  }

  #handleReliable(peerId: string, value: unknown) {
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

  #receiveRequest(peerId: string, message: FileControl) {
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

    const request: IncomingFile = {
      peerId,
      requestId: message.id,
      path: message.path,
      state: "waiting",
      timeout: undefined,
    };
    this.incoming.set(key, request);
    this.#armIncomingTimeout(request);

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
        const current = this.incoming.get(key);
        if (current !== request || current.state !== "waiting") return;
        if (value == null) {
          this.rejectRequest(request, "unavailable");
          return;
        }
        return this.sendFile(request, value);
      })
      .catch((error) => {
        const current = this.incoming.get(key);
        if (current !== request) return;
        if (current.state === "waiting") {
          try {
            this.rejectRequest(current, "provider-failed");
          } catch {
            // The error event below is authoritative for diagnostics.
          }
        }
        this.#emit("error", { peerId, requestId: message.id, path: message.path, error });
      });
  }

  #receiveRejection(peerId: string, message: FileControl) {
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
    pending.reject(new FileRequestRejectedError(pending.path, message.reason ?? "unavailable"));
  }

  #handleParticipantDisconnected(peerId: string) {
    if (typeof peerId !== "string" || peerId === "") return;

    for (const pending of [...this.pending.values()]) {
      if (pending.peerId !== peerId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(pending.requestId);
      pending.reject(new Error(`Peer ${peerId} disconnected during file request`));
    }
    for (const [key, request] of [...this.incoming.entries()]) {
      if (request.peerId !== peerId) continue;
      clearTimeout(request.timeout);
      this.incoming.delete(key);
    }
  }

  #handleStarted(detail: TransferEvents["started"]) {
    const pending = this.#matchingPending(detail);
    if (!pending) return;
    this.#armPendingTimeout(pending);
  }

  async #handleFile(detail: TransferEvents["file"]) {
    const requestId = detail?.requestId;
    if (!requestId || !this.pending.has(requestId)) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.peerId !== detail.peerId || pending.path !== detail.path) {
      this.#emit("error", {
        peerId: detail?.peerId,
        requestId,
        error: new Error("Received file does not match the pending request"),
      });
      return;
    }

    clearTimeout(pending.timeout);
    pending.timeout = undefined;
    try {
      await verifyContent(this.manifest, pending.path, detail.bytes);
    } catch (error) {
      if (this.pending.get(requestId) === pending) {
        this.pending.delete(requestId);
        pending.reject(error);
      }
      return;
    }
    if (this.pending.get(requestId) !== pending) return;

    this.pending.delete(requestId);
    this.#emit("file", { ...detail, requestId });
    pending.resolve(detail.bytes);
  }

  #handleProgress(detail: TransferEvents["progress"]) {
    const pending = this.#matchingPending(detail);
    if (!pending) return;
    this.#armPendingTimeout(pending);
    this.#emit("progress", { ...detail, requestId: pending.requestId });
  }

  #handleTransferFailed(detail: TransferEvents["failed"]) {
    const pending = this.#matchingPending(detail);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(pending.requestId);
    pending.reject(detail?.error instanceof Error ? detail.error : new Error(`File transfer failed for ${pending.path}`));
  }

  #matchingPending(detail: {requestId: string | null; peerId: string; path: string}) {
    const requestId = detail?.requestId;
    if (!requestId || !this.pending.has(requestId)) return null;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.peerId !== detail.peerId || pending.path !== detail.path) return null;
    return pending;
  }

  #armPendingTimeout(pending: PendingFile) {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      if (this.pending.get(pending.requestId) !== pending) return;
      this.pending.delete(pending.requestId);
      pending.reject(new Error(`File request timed out for ${pending.path}`));
    }, pending.timeoutMs);
  }

  #armIncomingTimeout(request: IncomingFile) {
    clearTimeout(request.timeout);
    request.timeout = setTimeout(() => {
      const key = requestKey(request.peerId, request.requestId);
      if (this.incoming.get(key) !== request || request.state !== "waiting") return;
      this.incoming.delete(key);
      try {
        this.#sendReject(request.peerId, request.requestId, request.path, "request-timeout");
      } catch (error) {
        this.#emit("error", {
          peerId: request.peerId,
          requestId: request.requestId,
          path: request.path,
          error,
        });
      }
    }, this.incomingRequestTimeoutMs);
  }

  #requireIncomingRequest(request: FileRequest) {
    if (!isObject(request)) throw new Error("File request must be an object emitted by GameFiles");
    const peerId = requirePeerId(request.peerId);
    const requestId = requireRequestId(request.requestId);
    const path = requirePeerId(request.path);
    const active = this.incoming.get(requestKey(peerId, requestId));
    if (!active || active.path !== path) throw new Error("File request is no longer active");
    return active;
  }

  #sendReject(peerId: string, requestId: string, path: string, reason: string) {
    this.session.sendReliable(
      peerId,
      controlMessage("reject", { id: requestId, path, reason: requireReason(reason) }),
    );
  }

  #assertOpen() {
    if (this.closed) throw new Error("GameFiles is closed");
  }

  #emit<K extends keyof FileEvents>(type: K, detail: FileEvents[K]) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
