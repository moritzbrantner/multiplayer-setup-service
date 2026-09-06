const CONTENT_PEER_PROTOCOL = 1;
const CONTENT_CHANNEL_LABEL = "content-swarm-v1";
const DEFAULT_MAX_PEERS = 4;
const MAX_MAX_PEERS = 8;
const DEFAULT_HIGH_WATER_MARK = 1_048_576;
const DEFAULT_LOW_WATER_MARK = 262_144;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{16}$/;

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
    maxPeers = DEFAULT_MAX_PEERS,
    peerConnectionFactory = (configuration) => new RTCPeerConnection(configuration),
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
    if (typeof peerConnectionFactory !== "function") {
      throw new Error("peerConnectionFactory must be a function");
    }

    this.session = session;
    this.signaling = session.signaling;
    this.contentSharing = true;
    this.maxPeers = maxPeers;
    this.peerConnectionFactory = peerConnectionFactory;
    this.peers = new Map();
    this.closed = false;
    this.signalChains = new Map();

    this.onSignalingMessage = (event) => this.#enqueueSignal(event);
    this.onParticipantDisconnected = (event) => {
      const peerId = event.detail?.participantId;
      if (typeof peerId === "string") this.#dropPeer(peerId, false);
    };
    this.signaling.addEventListener("message", this.onSignalingMessage);
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

  async connect(peerId) {
    if (this.closed) throw new Error("ContentPeerPool is closed");
    this.#requireParticipant(peerId);
    const existing = this.peers.get(peerId);
    if (existing) return existing.connectionId;
    if (!this.hasCapacity()) throw new Error("Content peer pool is full");

    const link = this.#createLink(peerId, createConnectionId(), true);
    this.#bindChannel(link, link.peer.createDataChannel(CONTENT_CHANNEL_LABEL, { ordered: true }));
    const offer = await link.peer.createOffer();
    await link.peer.setLocalDescription(offer);
    this.#send(peerId, link.connectionId, { description: link.peer.localDescription });
    return link.connectionId;
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
    await this.#waitForCapacity(link.channel, highWaterMark, lowWaterMark);
    if (!this.#linkReady(link)) throw new Error(`Content peer ${peerId} is not ready`);
    link.channel.send(data);
  }

  disconnect(peerId) {
    this.#dropPeer(peerId, true);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.signaling.removeEventListener("message", this.onSignalingMessage);
    this.session.removeEventListener("participant-disconnected", this.onParticipantDisconnected);
    for (const peerId of [...this.peers.keys()]) this.#dropPeer(peerId, false);
    this.signalChains.clear();
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
    };
    this.peers.set(peerId, link);

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.#send(peerId, connectionId, { candidate: event.candidate.toJSON() });
      }
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        this.#dropPeer(peerId, false);
        return;
      }
      this.#maybeReady(link);
    });
    peer.addEventListener("datachannel", (event) => {
      if (event.channel.label !== CONTENT_CHANNEL_LABEL || link.channel) {
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
      this.dispatchEvent(
        new CustomEvent("content", {
          detail: { peerId: link.peerId, data: event.data },
        }),
      );
    });
    channel.addEventListener("close", () => {
      this.#dropPeer(link.peerId, false);
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

    const previous = this.signalChains.get(parsed.peerId) ?? Promise.resolve();
    const next = previous
      .then(() => this.#handleSignal(parsed.peerId, parsed.envelope))
      .catch((error) => {
        this.dispatchEvent(new CustomEvent("error", { detail: { peerId: parsed.peerId, error } }));
      });
    this.signalChains.set(parsed.peerId, next);
  }

  async #handleSignal(peerId, envelope) {
    if (envelope.reject === "capacity" || envelope.close === true) {
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
      await this.#flushCandidates(link);
      if (envelope.description.type === "offer") {
        const answer = await link.peer.createAnswer();
        await link.peer.setLocalDescription(answer);
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

  async #waitForCapacity(channel, highWaterMark, lowWaterMark) {
    if (channel.bufferedAmount < highWaterMark) return;
    channel.bufferedAmountLowThreshold = lowWaterMark;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Content channel closed while waiting for send capacity"));
      };
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose, { once: true });
      if (channel.bufferedAmount <= lowWaterMark) {
        cleanup();
        resolve();
      }
    });
  }
}
