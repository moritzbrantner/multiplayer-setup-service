const SIGNALING_PROTOCOL = "multiplayer-setup-v1";
const DEFAULT_CONTENT_HIGH_WATER_MARK = 1_048_576;
const DEFAULT_CONTENT_LOW_WATER_MARK = 262_144;
const MAX_SEED_CONTENT_IDS = 128;
const CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;

function toWebSocketUrl(apiBase, websocketPath, participantId) {
  const url = new URL(websocketPath, apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("participantId", participantId);
  return url;
}

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function parseChannelMessage(event) {
  if (typeof event.data !== "string") {
    return null;
  }
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function validTopology(topology) {
  return topology === "mesh" || topology === "host";
}

function linkReady(link) {
  return (
    link.peer.connectionState === "connected" &&
    link.reliable?.readyState === "open" &&
    link.realtime?.readyState === "open"
  );
}

function contentReady(link) {
  return link.peer.connectionState === "connected" && link.content?.readyState === "open";
}

function validateContentWaterMarks(highWaterMark, lowWaterMark) {
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new Error("Content highWaterMark must be a positive safe integer");
  }
  if (!Number.isSafeInteger(lowWaterMark) || lowWaterMark < 0 || lowWaterMark >= highWaterMark) {
    throw new Error("Content lowWaterMark must be a non-negative safe integer below highWaterMark");
  }
}

function normalizeSeedContentIds(contentIds) {
  if (!Array.isArray(contentIds)) throw new Error("Seed content IDs must be an array");
  if (contentIds.length > MAX_SEED_CONTENT_IDS) {
    throw new Error(`A participant may advertise at most ${MAX_SEED_CONTENT_IDS} content IDs`);
  }
  const normalized = [...contentIds];
  if (normalized.some((contentId) => typeof contentId !== "string" || !CONTENT_ID_PATTERN.test(contentId))) {
    throw new Error("Seed content IDs must be lowercase SHA-256 hex digests");
  }
  normalized.sort();
  if (normalized.some((contentId, index) => index > 0 && contentId === normalized[index - 1])) {
    throw new Error("Seed content IDs must be unique");
  }
  return normalized;
}

function parseSeedAdvertisement(payload) {
  const advertisement = payload?.contentSeed;
  if (!advertisement || advertisement.v !== 1) return null;
  try {
    return normalizeSeedContentIds(advertisement.contentIds);
  } catch {
    return null;
  }
}

export class LobbySession extends EventTarget {
  constructor({
    apiBase = window.location.origin,
    iceServers = [],
    topology = "mesh",
    contentSharing = false,
  } = {}) {
    super();
    if (!validTopology(topology)) {
      throw new Error("Topology must be 'mesh' or 'host'");
    }
    if (typeof contentSharing !== "boolean") {
      throw new Error("contentSharing must be a boolean");
    }

    this.apiBase = apiBase;
    this.iceServers = iceServers;
    this.topology = topology;
    this.contentSharing = contentSharing;
    this.lobbyId = null;
    this.displayCode = null;
    this.participantId = null;
    this.hostParticipantId = null;
    this.participantToken = null;
    this.maxParticipants = null;
    this.signaling = null;
    this.participants = new Set();
    this.links = new Map();
    this.seedContentIds = [];
    this.closed = false;
  }

  async host(maxParticipants = 16) {
    if (!Number.isInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 16) {
      throw new Error("Lobby size must be between 2 and 16");
    }

    const lobby = await readJson(
      await fetch(new URL("/lobbies", this.apiBase), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxParticipants }),
      }),
    );
    this.#adoptLobby(lobby);
    await this.#connectSignaling(lobby.websocketPath);
    this.#emit("lobby", this.#lobbyDetail());
    return lobby;
  }

  async join(lobbyCode) {
    const normalized = String(lobbyCode ?? "").trim();
    if (!normalized) {
      throw new Error("Enter a lobby code");
    }

    const path = `/lobbies/${encodeURIComponent(normalized)}/join`;
    const lobby = await readJson(
      await fetch(new URL(path, this.apiBase), { method: "POST" }),
    );
    this.#adoptLobby(lobby);
    await this.#connectSignaling(lobby.websocketPath);
    this.#emit("lobby", this.#lobbyDetail());
    return lobby;
  }

  peerIds() {
    return [...this.links.keys()].sort();
  }

  readyPeerIds() {
    return [...this.links.entries()]
      .filter(([, link]) => linkReady(link))
      .map(([peerId]) => peerId)
      .sort();
  }

  contentPeerIds() {
    if (!this.contentSharing) return [];
    return [...this.links.entries()]
      .filter(([, link]) => contentReady(link))
      .map(([peerId]) => peerId)
      .sort();
  }

  advertisedSeedContentIds() {
    return [...this.seedContentIds];
  }

  announceSeedContent(contentIds) {
    if (!this.contentSharing) throw new Error("Content sharing is not enabled for this lobby session");
    const normalized = normalizeSeedContentIds(contentIds);
    this.seedContentIds = normalized;
    for (const peerId of [...this.participants].sort()) {
      if (peerId !== this.participantId) this.#sendSeedAdvertisement(peerId);
    }
    this.#emit("seed-advertisement-local", { contentIds: [...normalized] });
  }

  sendReliable(peerId, data) {
    const link = this.#requiredLink(peerId);
    this.#sendChannel(link.reliable, { v: 1, data });
  }

  sendRealtime(peerId, data) {
    const link = this.#requiredLink(peerId);
    link.realtimeSequence += 1;
    this.#sendChannel(link.realtime, { v: 1, seq: link.realtimeSequence, data });
  }

  async sendContent(
    peerId,
    data,
    {
      highWaterMark = DEFAULT_CONTENT_HIGH_WATER_MARK,
      lowWaterMark = DEFAULT_CONTENT_LOW_WATER_MARK,
    } = {},
  ) {
    if (!this.contentSharing) throw new Error("Content sharing is not enabled for this lobby session");
    validateContentWaterMarks(highWaterMark, lowWaterMark);
    const link = this.#requiredContentLink(peerId);
    await this.#waitForContentCapacity(link.content, highWaterMark, lowWaterMark);
    if (!contentReady(link)) throw new Error(`Content channel for peer ${peerId} is not ready`);
    link.content.send(data);
  }

  broadcastReliable(data, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.readyPeerIds()) {
      if (!excluded.has(peerId)) {
        this.sendReliable(peerId, data);
      }
    }
  }

  broadcastRealtime(data, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.readyPeerIds()) {
      if (!excluded.has(peerId)) {
        this.sendRealtime(peerId, data);
      }
    }
  }

  close() {
    this.closed = true;
    this.signaling?.close();
    for (const link of this.links.values()) {
      link.reliable?.close();
      link.realtime?.close();
      link.content?.close();
      link.peer.close();
    }
    this.links.clear();
    this.participants.clear();
    this.seedContentIds = [];
    this.#emit("statechange", { state: "closed" });
  }

  #adoptLobby(lobby) {
    this.lobbyId = lobby.lobbyId;
    this.displayCode = lobby.displayCode;
    this.participantId = lobby.participantId;
    this.participantToken = lobby.participantToken;
    this.hostParticipantId = lobby.hostParticipantId;
    this.maxParticipants = lobby.maxParticipants;
  }

  async #connectSignaling(websocketPath) {
    const socket = new WebSocket(
      toWebSocketUrl(this.apiBase, websocketPath, this.participantId),
      [SIGNALING_PROTOCOL, `cap.${this.participantToken}`],
    );
    this.signaling = socket;

    socket.addEventListener("message", (event) => {
      this.#handleSignalingMessage(event).catch((error) => this.#fail(error));
    });
    socket.addEventListener("close", () => {
      if (!this.closed) {
        this.#emit("signaling-closed", {});
      }
    });
    socket.addEventListener("error", () => {
      this.#fail(new Error("Lobby signaling WebSocket failed"));
    });

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to lobby signaling"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
  }

  async #handleSignalingMessage(event) {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);

    switch (message.type) {
      case "connected": {
        this.hostParticipantId = message.hostParticipantId;
        this.participants = new Set(message.participants ?? []);
        this.participants.add(this.participantId);
        this.#emit("roster", {
          participants: [...this.participants].sort(),
          hostParticipantId: this.hostParticipantId,
        });
        for (const peerId of this.participants) {
          if (peerId !== this.participantId) this.#ensureLink(peerId);
        }
        this.#emit("statechange", { state: "signaling-connected" });
        break;
      }
      case "participant-connected":
        this.participants.add(message.participantId);
        this.#emit("participant-connected", { participantId: message.participantId });
        this.#emit("roster", {
          participants: [...this.participants].sort(),
          hostParticipantId: this.hostParticipantId,
        });
        this.#ensureLink(message.participantId);
        if (this.contentSharing && this.seedContentIds.length > 0) {
          this.#sendSeedAdvertisement(message.participantId);
        }
        break;
      case "participant-disconnected":
        this.participants.delete(message.participantId);
        this.#dropLink(message.participantId);
        this.#emit("participant-disconnected", { participantId: message.participantId });
        this.#emit("roster", {
          participants: [...this.participants].sort(),
          hostParticipantId: this.hostParticipantId,
        });
        break;
      case "signal":
        await this.#handleSignal(message.from, message.payload);
        break;
      case "error":
        this.#fail(new Error(message.message ?? message.code ?? "Lobby signaling error"));
        break;
      default:
        break;
    }
  }

  #dropLink(peerId) {
    const link = this.links.get(peerId);
    if (!link) return;
    link.reliable?.close();
    link.realtime?.close();
    link.content?.close();
    link.peer.close();
    this.links.delete(peerId);
  }

  #shouldConnect(peerId) {
    if (!peerId || peerId === this.participantId) return false;
    if (this.topology === "mesh") return true;
    return this.participantId === this.hostParticipantId || peerId === this.hostParticipantId;
  }

  #isInitiator(peerId) {
    if (this.topology === "host") return this.participantId === this.hostParticipantId;
    return this.participantId.localeCompare(peerId) < 0;
  }

  #ensureLink(peerId) {
    if (!this.#shouldConnect(peerId)) return null;
    if (this.links.has(peerId)) return this.links.get(peerId);

    const peer = new RTCPeerConnection({ iceServers: this.iceServers });
    const link = {
      peerId,
      peer,
      reliable: null,
      realtime: null,
      content: null,
      pendingCandidates: [],
      realtimeSequence: 0,
      lastRealtimeSequence: -1,
      offerStarted: false,
      readyEmitted: false,
      contentReadyEmitted: false,
    };
    this.links.set(peerId, link);

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.#signal(peerId, { candidate: event.candidate.toJSON() });
    });
    peer.addEventListener("connectionstatechange", () => {
      this.#emit("peer-statechange", { peerId, state: peer.connectionState });
      this.#maybePeerReady(link);
      this.#maybeContentReady(link);
    });

    if (this.#isInitiator(peerId)) {
      this.#bindChannel(link, "reliable", peer.createDataChannel("reliable", { ordered: true }));
      this.#bindChannel(
        link,
        "realtime",
        peer.createDataChannel("realtime", { ordered: false, maxRetransmits: 0 }),
      );
      if (this.contentSharing) {
        this.#bindContentChannel(link, peer.createDataChannel("content", { ordered: true }));
      }
      this.#startOffer(link).catch((error) => this.#fail(error));
    } else {
      peer.addEventListener("datachannel", (event) => {
        if (event.channel.label === "reliable" || event.channel.label === "realtime") {
          this.#bindChannel(link, event.channel.label, event.channel);
        } else if (event.channel.label === "content") {
          if (this.contentSharing) this.#bindContentChannel(link, event.channel);
          else event.channel.close();
        }
      });
    }

    this.#emit("peer-created", { peerId, initiator: this.#isInitiator(peerId) });
    return link;
  }

  async #startOffer(link) {
    if (link.offerStarted || !this.#isInitiator(link.peerId)) return;
    link.offerStarted = true;
    const offer = await link.peer.createOffer();
    await link.peer.setLocalDescription(offer);
    this.#signal(link.peerId, { description: link.peer.localDescription });
  }

  async #handleSignal(from, payload) {
    const seedContentIds = this.contentSharing ? parseSeedAdvertisement(payload) : null;
    if (seedContentIds) {
      if (this.participants.has(from) && from !== this.participantId) {
        this.#emit("content-seed", { peerId: from, contentIds: seedContentIds });
      }
      return;
    }

    if (!this.#shouldConnect(from)) return;
    const link = this.#ensureLink(from);
    if (!link) return;

    if (payload?.description) {
      await link.peer.setRemoteDescription(payload.description);
      await this.#flushCandidates(link);
      if (payload.description.type === "offer") {
        const answer = await link.peer.createAnswer();
        await link.peer.setLocalDescription(answer);
        this.#signal(from, { description: link.peer.localDescription });
      }
    }

    if (payload?.candidate) {
      if (link.peer.remoteDescription) {
        await link.peer.addIceCandidate(payload.candidate);
      } else {
        link.pendingCandidates.push(payload.candidate);
      }
    }
  }

  async #flushCandidates(link) {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) await link.peer.addIceCandidate(candidate);
  }

  #sendSeedAdvertisement(peerId) {
    this.#signal(peerId, {
      contentSeed: {
        v: 1,
        contentIds: [...this.seedContentIds],
      },
    });
  }

  #signal(to, payload) {
    if (this.signaling?.readyState !== WebSocket.OPEN) return;
    this.signaling.send(JSON.stringify({ type: "signal", to, payload }));
  }

  #bindChannel(link, kind, channel) {
    if (kind === "reliable") link.reliable = channel;
    else link.realtime = channel;

    channel.addEventListener("open", () => {
      this.#emit("channel-open", { peerId: link.peerId, kind });
      this.#maybePeerReady(link);
    });
    channel.addEventListener("close", () => {
      this.#emit("channel-close", { peerId: link.peerId, kind });
    });
    channel.addEventListener("message", (event) => {
      const envelope = parseChannelMessage(event);
      if (!envelope || envelope.v !== 1) return;
      if (kind === "realtime") {
        if (!Number.isInteger(envelope.seq) || envelope.seq <= link.lastRealtimeSequence) return;
        link.lastRealtimeSequence = envelope.seq;
      }
      this.#emit(kind, { peerId: link.peerId, data: envelope.data });
    });
  }

  #bindContentChannel(link, channel) {
    if (link.content && link.content !== channel) {
      channel.close();
      return;
    }
    link.content = channel;
    if ("binaryType" in channel) channel.binaryType = "arraybuffer";

    channel.addEventListener("open", () => {
      this.#emit("channel-open", { peerId: link.peerId, kind: "content" });
      this.#maybeContentReady(link);
    });
    channel.addEventListener("close", () => {
      this.#emit("channel-close", { peerId: link.peerId, kind: "content" });
    });
    channel.addEventListener("message", (event) => {
      this.#emit("content", { peerId: link.peerId, data: event.data });
    });
  }

  #maybePeerReady(link) {
    if (link.readyEmitted || !linkReady(link)) return;
    link.readyEmitted = true;
    this.#emit("peer-ready", { peerId: link.peerId });
  }

  #maybeContentReady(link) {
    if (link.contentReadyEmitted || !contentReady(link)) return;
    link.contentReadyEmitted = true;
    this.#emit("content-peer-ready", { peerId: link.peerId });
  }

  #requiredLink(peerId) {
    const link = this.links.get(peerId);
    if (!link || !linkReady(link)) throw new Error(`Peer ${peerId} is not ready`);
    return link;
  }

  #requiredContentLink(peerId) {
    const link = this.links.get(peerId);
    if (!link || !contentReady(link)) throw new Error(`Content channel for peer ${peerId} is not ready`);
    return link;
  }

  async #waitForContentCapacity(channel, highWaterMark, lowWaterMark) {
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

  #sendChannel(channel, value) {
    if (channel?.readyState !== "open") throw new Error("Peer-to-peer channel is not ready");
    channel.send(JSON.stringify(value));
  }

  #lobbyDetail() {
    return {
      lobbyId: this.lobbyId,
      displayCode: this.displayCode,
      participantId: this.participantId,
      hostParticipantId: this.hostParticipantId,
      maxParticipants: this.maxParticipants,
      topology: this.topology,
      contentSharing: this.contentSharing,
    };
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(error) {
    this.#emit("error", { error });
  }
}
