import { sessionUploadBudget } from "./content-upload-budget.js";

const CONTENT_PEER_PROTOCOL = 1;
const CONTENT_CHANNEL_LABEL = "content-swarm-v1";
const DEFAULT_MAX_PEERS = 4;
const MAX_MAX_PEERS = 8;
const DEFAULT_HIGH_WATER_MARK = 1_048_576;
const DEFAULT_LOW_WATER_MARK = 262_144;
const DEFAULT_RELAY_MAX_BYTES_PER_SECOND = 256 * 1024;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{16}$/;
const RELAY_POLICIES = new Set(["deny", "allow", "limit"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function signalingOpen(socket) {
  return socket?.readyState === (globalThis.WebSocket?.OPEN ?? 1);
}

function createConnectionId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateMaxPeers(maxPeers) {
  if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > MAX_MAX_PEERS) {
    throw new Error(`maxPeers must be between 1 and ${MAX_MAX_PEERS}`);
  }
}

function validateWaterMarks(highWaterMark, lowWaterMark) {
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new Error("Content highWaterMark must be a positive safe integer");
  }
  if (!Number.isSafeInteger(lowWaterMark) || lowWaterMark < 0 || lowWaterMark >= highWaterMark) {
    throw new Error("Content lowWaterMark must be a non-negative safe integer below highWaterMark");
  }
}

function validateRelayPolicy(relayPolicy, relayMaxBytesPerSecond) {
  if (!RELAY_POLICIES.has(relayPolicy)) {
    throw new Error("relayPolicy must be 'deny', 'allow', or 'limit'");
  }
  if (!Number.isSafeInteger(relayMaxBytesPerSecond) || relayMaxBytesPerSecond < 1) {
    throw new Error("relayMaxBytesPerSecond must be a positive safe integer");
  }
}

function contentByteLength(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  throw new Error("Relay-limited content must have a measurable byte length");
}

function statEntries(report) {
  if (!report) return [];
  if (typeof report.values === "function") return [...report.values()];
  const values = [];
  if (typeof report.forEach === "function") report.forEach((value) => values.push(value));
  return values;
}

export async function selectedIcePath(peer) {
  if (!peer || typeof peer.getStats !== "function") return "unknown";
  let report;
  try {
    report = await peer.getStats();
  } catch {
    return "unknown";
  }
  const entries = statEntries(report);
  const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));

  let pair = null;
  const transport = entries.find(
    (entry) => entry?.type === "transport" && typeof entry.selectedCandidatePairId === "string",
  );
  if (transport) pair = byId.get(transport.selectedCandidatePairId) ?? null;
  pair ??= entries.find(
    (entry) =>
      entry?.type === "candidate-pair" &&
      (entry.selected === true || (entry.nominated === true && entry.state === "succeeded")),
  );
  if (!pair) return "unknown";

  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  if (!local || !remote) return "unknown";
  if (local.candidateType === "relay" || remote.candidateType === "relay") return "relay";
  return "direct";
}

function parseServerSignal(event) {
  if (typeof event.data !== "string") return null;
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (message?.type !== "signal" || typeof message.from !== "string") return null;
  const envelope = message.payload?.contentPeer;
  if (!isObject(envelope) || envelope.v !== CONTENT_PEER_PROTOCOL) return null;
  if (!CONNECTION_ID_PATTERN.test(envelope.connectionId ?? "")) return null;
  return { peerId: message.from, envelope };
}

export class ContentPeerPool extends EventTarget {
  constructor({
    session,
    uploadBudget = null,
    maxPeers = DEFAULT_MAX_PEERS,
    relayPolicy = "deny",
    relayMaxBytesPerSecond = DEFAULT_RELAY_MAX_BYTES_PER_SECOND,
    peerConnectionFactory = (configuration) => new RTCPeerConnection(configuration),
    now = () => Date.now(),
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {}) {
    super();
    if (!session || session.contentSharing !== true) {
      throw new Error("ContentPeerPool requires a LobbySession with contentSharing enabled");
    }
    if (!session.signaling || typeof session.signaling.addEventListener !== "function") {
      throw new Error("ContentPeerPool requires an active lobby signaling socket");
    }
    if (typeof session.participantId !== "string" || session.participantId === "") {
      throw new Error("ContentPeerPool requires a joined lobby session");
    }
    validateMaxPeers(maxPeers);
    validateRelayPolicy(relayPolicy, relayMaxBytesPerSecond);
    if (typeof peerConnectionFactory !== "function") {
      throw new Error("peerConnectionFactory must be a function");
    }
    if (typeof now !== "function" || typeof sleep !== "function") {
      throw new Error("now and sleep must be functions");
    }

    this.session = session;
    this.signaling = null;
    this.signalingGeneration = 0;
    this.uploadBudget = uploadBudget ?? sessionUploadBudget(session);
    if (typeof this.uploadBudget.consume !== "function") {
      throw new Error("uploadBudget must provide consume()");
    }
    this.uploadAdmissionBudget =
      typeof this.uploadBudget.reserve === "function" ? this.uploadBudget : sessionUploadBudget(session);
    this.sendAbort = new AbortController();
    this.contentSharing = true;
    this.maxPeers = maxPeers;
    this.relayPolicy = relayPolicy;
    this.relayMaxBytesPerSecond = relayMaxBytesPerSecond;
    this.peerConnectionFactory = peerConnectionFactory;
    this.now = now;
    this.sleep = sleep;
    this.peers = new Map();
    this.closed = false;
    this.signalChains = new Map();

    this.onSignalingMessage = null;
    this.onSignalingChanged = () => this.#bindSignaling();
    this.onSessionState = (event) => {
      if (event.detail?.state === "closed") this.close();
    };
    this.onParticipantDisconnected = (event) => {
      const peerId = event.detail?.participantId;
      if (typeof peerId === "string") this.#dropPeer(peerId, false);
    };
    this.#bindSignaling();
    session.addEventListener("signaling-changed", this.onSignalingChanged);
    session.addEventListener("statechange", this.onSessionState);
    session.addEventListener("participant-disconnected", this.onParticipantDisconnected);
  }

  peerIds() {
    return [...this.peers.keys()].sort();
  }

  contentPeerIds() {
    return [...this.peers.entries()]
      .filter(([, link]) => this.#linkReady(link))
      .map(([peerId]) => peerId)
      .sort();
  }

  hasCapacity() {
    return this.peers.size < this.maxPeers;
  }

  async icePath(peerId) {
    const link = this.peers.get(peerId);
    if (!link) throw new Error(`Content peer ${peerId} is not connected`);
    return selectedIcePath(link.peer);
  }

  async connect(peerId) {
    if (this.closed) throw new Error("ContentPeerPool is closed");
    this.#bindSignaling();
    if (!signalingOpen(this.signaling)) throw new Error("Lobby signaling socket is not open");
    this.#requireParticipant(peerId);
    const existing = this.peers.get(peerId);
    if (existing) return existing.connectionId;
    if (!this.hasCapacity()) throw new Error("Content peer pool is full");

    const link = this.#createLink(peerId, createConnectionId(), true);
    this.#bindChannel(link, link.peer.createDataChannel(CONTENT_CHANNEL_LABEL, { ordered: true }));
    const generation = this.signalingGeneration;
    try {
      const offer = await link.peer.createOffer();
      this.#assertCurrent(link, generation);
      await link.peer.setLocalDescription(offer);
      this.#assertCurrent(link, generation);
      this.#send(peerId, link.connectionId, { description: link.peer.localDescription });
      return link.connectionId;
    } catch (error) {
      if (this.peers.get(peerId) === link) this.#dropPeer(peerId, false);
      throw error;
    }
  }

  async sendContent(
    peerId,
    data,
    {
      highWaterMark = DEFAULT_HIGH_WATER_MARK,
      lowWaterMark = DEFAULT_LOW_WATER_MARK,
    } = {},
  ) {
    if (this.closed) throw new Error("ContentPeerPool is closed");
    validateWaterMarks(highWaterMark, lowWaterMark);
    const link = this.peers.get(peerId);
    if (!link || !this.#linkReady(link)) {
      throw new Error(`Content peer ${peerId} is not ready`);
    }

    const size = contentByteLength(data);
    const admissionBudget = this.uploadAdmissionBudget;
    const reservation = admissionBudget.reserve(size, { signal: this.sendAbort.signal });
    if (!reservation || typeof reservation.release !== "function") {
      throw new Error("uploadBudget reserve() must return a releasable reservation");
    }
    const waitSignals = [
      ...(Array.isArray(reservation.signals) ? reservation.signals : []),
      this.sendAbort.signal,
      this.uploadBudget.pauseController?.signal,
    ];

    try {
      const icePath = await selectedIcePath(link.peer);
      if (icePath === "relay") {
        if (this.relayPolicy === "deny") {
          this.#emitRelayPolicy(peerId, "denied", 0);
          throw new Error(`Bulk content over TURN relay is disabled for peer ${peerId}`);
        }
        if (this.relayPolicy === "limit") {
          const now = Number(this.now());
          if (!Number.isFinite(now)) throw new Error("now() must return a finite number");
          const sendAt = Math.max(now, link.nextRelaySendAt);
          const delayMs = Math.max(0, sendAt - now);
          const reservationMs = Math.ceil((size * 1000) / this.relayMaxBytesPerSecond);
          link.nextRelaySendAt = sendAt + reservationMs;
          this.#emitRelayPolicy(peerId, "limited", delayMs, size);
          if (delayMs > 0) await this.sleep(delayMs);
        } else {
          this.#emitRelayPolicy(peerId, "allowed", 0);
        }
      }

      await this.#waitForCapacity(link.channel, highWaterMark, lowWaterMark, waitSignals);
      // Pacing is shared by every content pool in this session, including direct peers.
      if (admissionBudget === this.uploadBudget) {
        if (typeof reservation.consume !== "function") {
          throw new Error("uploadBudget reserve() must return a consumable reservation");
        }
        await reservation.consume();
      } else {
        await this.uploadBudget.consume(size, { signal: this.sendAbort.signal });
      }
      if (this.closed || this.peers.get(peerId) !== link || !this.#linkReady(link)) {
        throw new Error(`Content peer ${peerId} is not ready`);
      }
      // A route can change while backpressure or an upload budget delays a send.
      const finalPath = await selectedIcePath(link.peer);
      if (finalPath === "relay" && this.relayPolicy === "deny") {
        this.#emitRelayPolicy(peerId, "denied", 0);
        throw new Error(`Bulk content over TURN relay is disabled for peer ${peerId}`);
      }
      if (finalPath === "relay" && icePath !== "relay" && this.relayPolicy === "limit") {
        throw new Error("Content route changed to TURN; retry under the relay rate policy");
      }
      if (this.closed || this.uploadBudget.paused || this.peers.get(peerId) !== link || !this.#linkReady(link)) {
        throw new Error(`Content peer ${peerId} is not ready for upload`);
      }
      link.channel.send(data);
    } finally {
      reservation.release();
    }
  }

  disconnect(peerId) {
    this.#dropPeer(peerId, true);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.sendAbort.abort();
    this.signalingGeneration += 1;
    this.signaling?.removeEventListener("message", this.onSignalingMessage);
    this.session.removeEventListener("signaling-changed", this.onSignalingChanged);
    this.session.removeEventListener("statechange", this.onSessionState);
    this.session.removeEventListener("participant-disconnected", this.onParticipantDisconnected);
    for (const peerId of [...this.peers.keys()]) this.#dropPeer(peerId, false);
    this.signalChains.clear();
  }

  #bindSignaling() {
    if (this.closed || this.signaling === this.session.signaling) return;
    this.signaling?.removeEventListener("message", this.onSignalingMessage);
    this.signaling = this.session.signaling;
    this.signalingGeneration += 1;
    const socket = this.signaling;
    const generation = this.signalingGeneration;
    this.onSignalingMessage = (event) => {
      if (this.signaling === socket && generation === this.signalingGeneration) this.#enqueueSignal(event);
    };
    socket?.addEventListener("message", this.onSignalingMessage);
    this.signalChains.clear();
    for (const [peerId, link] of this.peers) {
      if (!this.#linkReady(link)) this.#dropPeer(peerId, false);
    }
  }

  #assertCurrent(link, generation) {
    if (this.closed || generation !== this.signalingGeneration || this.peers.get(link.peerId) !== link) {
      throw new Error("Content negotiation was superseded by signaling recovery");
    }
  }

  #emitRelayPolicy(peerId, action, delayMs, bytes = null) {
    this.dispatchEvent(
      new CustomEvent("relay-policy", {
        detail: {
          peerId,
          action,
          delayMs,
          ...(bytes === null ? {} : { bytes }),
          maxBytesPerSecond: this.relayMaxBytesPerSecond,
        },
      }),
    );
  }

  #requireParticipant(peerId) {
    if (typeof peerId !== "string" || peerId === "" || peerId === this.session.participantId) {
      throw new Error("Content peer must be another lobby participant");
    }
    if (!(this.session.participants instanceof Set) || !this.session.participants.has(peerId)) {
      throw new Error(`Participant ${peerId} is not in the current lobby roster`);
    }
  }

  #createLink(peerId, connectionId, initiatedLocally) {
    const peer = this.peerConnectionFactory({ iceServers: this.session.iceServers ?? [] });
    const link = {
      peerId,
      connectionId,
      initiatedLocally,
      peer,
      channel: null,
      pendingCandidates: [],
      readyEmitted: false,
      nextRelaySendAt: 0,
    };
    this.peers.set(peerId, link);

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate && this.peers.get(peerId) === link && signalingOpen(this.session.signaling)) {
        this.#send(peerId, connectionId, { candidate: event.candidate.toJSON() });
      }
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.peers.get(peerId) !== link) return;
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        this.#dropPeer(peerId, false);
        return;
      }
      this.#maybeReady(link);
    });
    peer.addEventListener("datachannel", (event) => {
      if (this.peers.get(peerId) !== link || event.channel.label !== CONTENT_CHANNEL_LABEL || link.channel) {
        event.channel.close();
        return;
      }
      this.#bindChannel(link, event.channel);
    });

    this.dispatchEvent(
      new CustomEvent("peer-created", {
        detail: { peerId, connectionId, initiatedLocally },
      }),
    );
    return link;
  }

  #bindChannel(link, channel) {
    link.channel = channel;
    if ("binaryType" in channel) channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => this.#maybeReady(link));
    channel.addEventListener("message", (event) => {
      if (this.closed || this.peers.get(link.peerId) !== link) return;
      this.dispatchEvent(
        new CustomEvent("content", {
          detail: { peerId: link.peerId, data: event.data },
        }),
      );
    });
    channel.addEventListener("close", () => {
      if (this.peers.get(link.peerId) === link) this.#dropPeer(link.peerId, false);
    });
  }

  #linkReady(link) {
    return link.peer.connectionState === "connected" && link.channel?.readyState === "open";
  }

  #maybeReady(link) {
    if (link.readyEmitted || !this.#linkReady(link)) return;
    link.readyEmitted = true;
    this.dispatchEvent(
      new CustomEvent("content-peer-ready", {
        detail: { peerId: link.peerId, connectionId: link.connectionId },
      }),
    );
  }

  #enqueueSignal(event) {
    if (this.closed) return;
    const parsed = parseServerSignal(event);
    if (!parsed) return;
    if (!(this.session.participants instanceof Set) || !this.session.participants.has(parsed.peerId)) {
      return;
    }
    if (parsed.peerId === this.session.participantId) return;

    const generation = this.signalingGeneration;
    const previous = this.signalChains.get(parsed.peerId) ?? Promise.resolve();
    const next = previous
      .then(() => {
        if (!this.closed && generation === this.signalingGeneration) {
          return this.#handleSignal(parsed.peerId, parsed.envelope, generation);
        }
      })
      .catch((error) => {
        if (!this.closed && generation === this.signalingGeneration) {
          this.dispatchEvent(new CustomEvent("error", { detail: { peerId: parsed.peerId, error } }));
        }
      })
      .finally(() => {
        if (this.signalChains.get(parsed.peerId) === next) this.signalChains.delete(parsed.peerId);
      });
    this.signalChains.set(parsed.peerId, next);
  }

  async #handleSignal(peerId, envelope, generation) {
    if (typeof envelope.reject === "string" || envelope.close === true) {
      const link = this.peers.get(peerId);
      if (link?.connectionId === envelope.connectionId) this.#dropPeer(peerId, false);
      return;
    }

    let link = this.peers.get(peerId);
    if (envelope.description?.type === "offer") {
      if (link && link.connectionId !== envelope.connectionId) {
        if (link.connectionId.localeCompare(envelope.connectionId) <= 0) {
          this.#send(peerId, envelope.connectionId, { reject: "collision" });
          return;
        }
        this.#dropPeer(peerId, false);
        link = null;
      }
      if (!link) {
        if (!this.hasCapacity()) {
          this.#send(peerId, envelope.connectionId, { reject: "capacity" });
          return;
        }
        link = this.#createLink(peerId, envelope.connectionId, false);
      }
    }

    if (!link || link.connectionId !== envelope.connectionId) return;

    if (envelope.description) {
      await link.peer.setRemoteDescription(envelope.description);
      this.#assertCurrent(link, generation);
      await this.#flushCandidates(link);
      this.#assertCurrent(link, generation);
      if (envelope.description.type === "offer") {
        const answer = await link.peer.createAnswer();
        this.#assertCurrent(link, generation);
        await link.peer.setLocalDescription(answer);
        this.#assertCurrent(link, generation);
        this.#send(peerId, link.connectionId, { description: link.peer.localDescription });
      }
    }

    if (envelope.candidate) {
      if (link.peer.remoteDescription) await link.peer.addIceCandidate(envelope.candidate);
      else link.pendingCandidates.push(envelope.candidate);
    }
  }

  async #flushCandidates(link) {
    const candidates = link.pendingCandidates.splice(0);
    for (const candidate of candidates) await link.peer.addIceCandidate(candidate);
  }

  #send(peerId, connectionId, data) {
    this.#bindSignaling();
    if (!signalingOpen(this.signaling)) throw new Error("Lobby signaling socket is not open");
    this.signaling.send(
      JSON.stringify({
        type: "signal",
        to: peerId,
        payload: {
          contentPeer: {
            v: CONTENT_PEER_PROTOCOL,
            connectionId,
            ...data,
          },
        },
      }),
    );
  }

  #dropPeer(peerId, notify) {
    const link = this.peers.get(peerId);
    if (!link) return;
    this.peers.delete(peerId);
    if (notify && signalingOpen(this.signaling)) {
      try {
        this.#send(peerId, link.connectionId, { close: true });
      } catch {
        // Local teardown must not depend on the control plane remaining available.
      }
    }
    link.channel?.close();
    link.peer.close();
    this.dispatchEvent(
      new CustomEvent("content-peer-closed", {
        detail: { peerId, connectionId: link.connectionId },
      }),
    );
  }

  async #waitForCapacity(channel, highWaterMark, lowWaterMark, signals = [this.sendAbort.signal]) {
    const abortSignals = [...new Set(signals.filter(Boolean))];
    const aborted = () => abortSignals.some((signal) => signal.aborted);
    if (aborted()) throw new Error("Content upload was cancelled or paused for gameplay");
    if (channel.bufferedAmount < highWaterMark) return;
    channel.bufferedAmountLowThreshold = lowWaterMark;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        for (const signal of abortSignals) signal.removeEventListener("abort", onAbort);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Content channel closed while waiting for send capacity"));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Content upload was cancelled or paused for gameplay"));
      };
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose, { once: true });
      for (const signal of abortSignals) signal.addEventListener("abort", onAbort, { once: true });
      if (aborted()) {
        onAbort();
        return;
      }
      if (channel.readyState !== "open") {
        onClose();
        return;
      }
      if (channel.bufferedAmount <= lowWaterMark) {
        cleanup();
        resolve();
      }
    });
  }
}
