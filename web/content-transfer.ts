import { TypedEventTarget } from "./events.ts";
import type { ContentData } from "./events.ts";
import type { ContentManifest, ManifestFile } from "./content-manifest.ts";
import type { ContentTransport } from "./content-types.ts";
type TransferIdentity = {peerId: string; path: string; transferId: number; requestId: string | null};
export type TransferEvents = {
 sent: TransferIdentity & {bytes: number; chunks: number};
 started: TransferIdentity & {bytes: number; chunks: number};
 progress: TransferIdentity & {receivedChunks: number; totalChunks: number};
 file: TransferIdentity & {bytes: Uint8Array<ArrayBuffer>; verification: Awaited<ReturnType<typeof verifyContent>>};
 failed: TransferIdentity & {error: unknown};
 error: {peerId: string; error: unknown};
};
type IncomingTransfer = {peerId: string; transferId: number; requestId: string | null; file: ManifestFile; chunks: (Uint8Array | undefined)[]; receivedChunks: number};
import {
  manifestFile,
  validateTrustedManifest,
  verifyContent,
  verifyContentChunk,
} from "./content-verification.ts";

export const CONTENT_TRANSFER_PROTOCOL = 1;
export const MAX_P2P_CHUNK_BYTES = 60 * 1024;

const CHUNK_FRAME_MAGIC = 0x4d504331;
const CHUNK_FRAME_HEADER_BYTES = 12;
const MAX_CONTROL_MESSAGE_BYTES = 8 * 1024;
const DEFAULT_MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_ID_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function toBytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("Content transfer payload must be binary data");
}

function validTransferId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function optionalRequestId(value: unknown) {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_REQUEST_ID_LENGTH ||
    !REQUEST_ID_PATTERN.test(value)
  ) {
    throw new Error("Invalid content transfer request id");
  }
  return value;
}

function transferKey(peerId: string, transferId: number) {
  return `${peerId}:${transferId}`;
}

function createChunkFrame(transferId: number, chunkIndex: number, payload: Uint8Array) {
  const frame = new Uint8Array(CHUNK_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, CHUNK_FRAME_MAGIC);
  view.setUint32(4, transferId);
  view.setUint32(8, chunkIndex);
  frame.set(payload, CHUNK_FRAME_HEADER_BYTES);
  return frame.buffer;
}

async function parseChunkFrame(value: unknown) {
  const bytes = await toBytes(value);
  if (bytes.byteLength < CHUNK_FRAME_HEADER_BYTES) {
    throw new Error("Content chunk frame is too short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== CHUNK_FRAME_MAGIC) {
    throw new Error("Content chunk frame has an invalid magic value");
  }
  return {
    transferId: view.getUint32(4),
    chunkIndex: view.getUint32(8),
    payload: bytes.slice(CHUNK_FRAME_HEADER_BYTES),
  };
}

function parseControlMessage(value: unknown) {
  if (typeof value !== "string") return null;
  if (new TextEncoder().encode(value).byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error("Content control message is too large");
  }
  let message;
  try {
    message = JSON.parse(value);
  } catch {
    throw new Error("Content control message is not valid JSON");
  }
  if (!isObject(message) || message.v !== CONTENT_TRANSFER_PROTOCOL) {
    throw new Error("Unsupported content transfer control message");
  }
  return message;
}

function requireTransferableFile(file: ManifestFile, maxTransferBytes: number): asserts file is ManifestFile & {chunks: {bytes: number; sha256: string[]}} {
  if (!file.chunks) throw new Error(`Trusted manifest does not define chunk hashes for ${file.path}`);
  if (file.chunks.bytes > MAX_P2P_CHUNK_BYTES) {
    throw new Error(
      `Trusted chunk size for ${file.path} exceeds the ${MAX_P2P_CHUNK_BYTES}-byte P2P limit`,
    );
  }
  if (file.bytes > maxTransferBytes) {
    throw new Error(`Content ${file.path} exceeds the configured in-memory transfer limit`);
  }
}

function randomTransferId(activeIds: Set<number>) {
  const values = new Uint32Array(1);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    globalThis.crypto.getRandomValues(values);
    const value = values[0]!;
    if (value !== 0 && !activeIds.has(value)) return value;
  }
  throw new Error("Could not allocate a unique content transfer id");
}

export class ContentTransfer extends TypedEventTarget<TransferEvents> {
  session: ContentTransport;
  manifest: ContentManifest;
  maxTransferBytes: number;
  incoming: Map<string, IncomingTransfer>;
  outgoingIds: Set<number>;
  peerChains: Map<string, Promise<void>>;
  closed: boolean;
  onContent: (event: CustomEvent<{peerId: string; data: ContentData}>) => void;
  constructor({ session, manifest, maxTransferBytes = DEFAULT_MAX_TRANSFER_BYTES }: {session: ContentTransport; manifest: ContentManifest; maxTransferBytes?: number}) {
    super();
    if (!session || session.contentSharing !== true) {
      throw new Error("ContentTransfer requires a LobbySession with contentSharing enabled");
    }
    validateTrustedManifest(manifest);
    if (!Number.isSafeInteger(maxTransferBytes) || maxTransferBytes < 1) {
      throw new Error("maxTransferBytes must be a positive safe integer");
    }

    this.session = session;
    this.manifest = manifest;
    this.maxTransferBytes = maxTransferBytes;
    this.incoming = new Map();
    this.outgoingIds = new Set();
    this.peerChains = new Map();
    this.closed = false;
    this.onContent = (event) => this.#enqueue(event.detail?.peerId, event.detail?.data);
    session.addEventListener("content", this.onContent);
  }

  async sendFile(peerId: string, path: string, value: unknown, { requestId = null }: {requestId?: string | null} = {}) {
    if (this.closed) throw new Error("ContentTransfer is closed");
    const normalizedRequestId = optionalRequestId(requestId);
    const file = manifestFile(this.manifest, path);
    requireTransferableFile(file, this.maxTransferBytes);
    const bytes = await toBytes(value);
    await verifyContent(this.manifest, path, bytes);

    const transferId = randomTransferId(this.outgoingIds);
    this.outgoingIds.add(transferId);
    try {
      await this.session.sendContent(
        peerId,
        JSON.stringify({
          v: CONTENT_TRANSFER_PROTOCOL,
          type: "start",
          id: transferId,
          path,
          bytes: file.bytes,
          sha256: file.sha256,
          chunkBytes: file.chunks.bytes,
          chunks: file.chunks.sha256.length,
          ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
        }),
      );

      for (let index = 0; index < file.chunks.sha256.length; index += 1) {
        const start = index * file.chunks.bytes;
        const end = Math.min(start + file.chunks.bytes, bytes.byteLength);
        await this.session.sendContent(
          peerId,
          createChunkFrame(transferId, index, bytes.slice(start, end)),
        );
      }

      await this.session.sendContent(
        peerId,
        JSON.stringify({ v: CONTENT_TRANSFER_PROTOCOL, type: "complete", id: transferId }),
      );
      this.#emit("sent", {
        peerId,
        path,
        transferId,
        requestId: normalizedRequestId,
        bytes: file.bytes,
        chunks: file.chunks.sha256.length,
      });
      return transferId;
    } finally {
      this.outgoingIds.delete(transferId);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.removeEventListener("content", this.onContent);
    this.incoming.clear();
    this.peerChains.clear();
    this.outgoingIds.clear();
  }

  #enqueue(peerId: string, data: unknown) {
    if (this.closed || typeof peerId !== "string" || peerId === "") return;
    const previous = this.peerChains.get(peerId) ?? Promise.resolve();
    const next = previous
      .then(() => this.#handleMessage(peerId, data))
      .catch((error) => this.#emit("error", { peerId, error }));
    this.peerChains.set(peerId, next);
  }

  async #handleMessage(peerId: string, data: unknown) {
    const control = parseControlMessage(data);
    if (control) {
      if (control.type === "start") this.#startIncoming(peerId, control);
      else if (control.type === "complete") await this.#completeIncoming(peerId, control);
      else throw new Error(`Unsupported content control type: ${String(control.type)}`);
      return;
    }
    await this.#acceptChunk(peerId, data);
  }

  #startIncoming(peerId: string, message: Record<string, unknown>) {
    if (!validTransferId(message.id)) throw new Error("Invalid content transfer id");
    if (typeof message.path !== "string") throw new Error("Content transfer path is required");
    const requestId = optionalRequestId(message.requestId);

    try {
      const file = manifestFile(this.manifest, message.path);
      requireTransferableFile(file, this.maxTransferBytes);

      if (
        message.bytes !== file.bytes ||
        message.sha256 !== file.sha256 ||
        message.chunkBytes !== file.chunks.bytes ||
        message.chunks !== file.chunks.sha256.length
      ) {
        throw new Error(`Peer transfer metadata does not match the trusted manifest for ${message.path}`);
      }
      for (const transfer of this.incoming.values()) {
        if (transfer.peerId === peerId) {
          throw new Error(`Peer ${peerId} already has an active content transfer`);
        }
      }

      const key = transferKey(peerId, message.id);
      if (this.incoming.has(key)) throw new Error("Duplicate content transfer id");
      this.incoming.set(key, {
        peerId,
        transferId: message.id,
        requestId,
        file,
        chunks: new Array(file.chunks.sha256.length),
        receivedChunks: 0,
      });
      this.#emit("started", {
        peerId,
        path: file.path,
        transferId: message.id,
        requestId,
        bytes: file.bytes,
        chunks: file.chunks.sha256.length,
      });
    } catch (error) {
      this.#emitTransferFailure({
        peerId,
        path: message.path,
        transferId: message.id,
        requestId,
        error,
      });
      throw error;
    }
  }

  async #acceptChunk(peerId: string, data: unknown) {
    const frame = await parseChunkFrame(data);
    const key = transferKey(peerId, frame.transferId);
    const transfer = this.incoming.get(key);
    if (!transfer) throw new Error("Content chunk does not belong to an active transfer");
    if (transfer.chunks[frame.chunkIndex]) {
      this.incoming.delete(key);
      const error = new Error(`Duplicate content chunk ${frame.chunkIndex}`);
      this.#emitTransferFailure({ ...transfer, error });
      throw error;
    }

    try {
      await verifyContentChunk(
        this.manifest,
        transfer.file.path,
        frame.chunkIndex,
        frame.payload,
      );
    } catch (error) {
      this.incoming.delete(key);
      this.#emitTransferFailure({ ...transfer, error });
      throw error;
    }

    transfer.chunks[frame.chunkIndex] = frame.payload;
    transfer.receivedChunks += 1;
    this.#emit("progress", {
      peerId,
      path: transfer.file.path,
      transferId: transfer.transferId,
      requestId: transfer.requestId,
      receivedChunks: transfer.receivedChunks,
      totalChunks: transfer.chunks.length,
    });
  }

  async #completeIncoming(peerId: string, message: Record<string, unknown>) {
    if (!validTransferId(message.id)) throw new Error("Invalid content transfer id");
    const key = transferKey(peerId, message.id);
    const transfer = this.incoming.get(key);
    if (!transfer) throw new Error("Content completion does not belong to an active transfer");
    this.incoming.delete(key);

    try {
      if (transfer.receivedChunks !== transfer.chunks.length || transfer.chunks.some((chunk) => !chunk)) {
        throw new Error(`Content transfer completed before all chunks arrived for ${transfer.file.path}`);
      }

      const bytes = new Uint8Array(transfer.file.bytes);
      let offset = 0;
      for (const chunk of transfer.chunks) {
        if (!chunk) throw new Error("Missing verified chunk");
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const verification = await verifyContent(this.manifest, transfer.file.path, bytes);
      this.#emit("file", {
        peerId,
        path: transfer.file.path,
        transferId: transfer.transferId,
        requestId: transfer.requestId,
        bytes,
        verification,
      });
    } catch (error) {
      this.#emitTransferFailure({ ...transfer, error });
      throw error;
    }
  }

  #emitTransferFailure({ peerId, file, path, transferId, requestId, error }: {peerId: string; file?: ManifestFile; path?: string; transferId: number; requestId: string | null; error: unknown}) {
    this.#emit("failed", {
      peerId,
      path: file?.path ?? path ?? "",
      transferId,
      requestId,
      error,
    });
  }

  #emit<K extends keyof TransferEvents>(type: K, detail: TransferEvents[K]) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
