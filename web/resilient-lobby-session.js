const SIGNALING_PROTOCOL = "multiplayer-setup-v1";
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 4_000;
const DEFAULT_PEER_RECOVERY_ATTEMPTS = 2;
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
  response = await response;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function parseChannelMessage(event) {
  if (typeof event.data !== "string") return null;
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

function validatePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
}

function validateReconnectOptions(maxAttempts, baseDelayMs, maxDelayMs) {
  validatePositiveInteger(maxAttempts, "reconnectMaxAttempts");
  validatePositiveInteger(baseDelayMs, "reconnectBaseDelayMs");
  validatePositiveInteger(maxDelayMs, "reconnectMaxDelayMs");
  if (maxDelayMs < baseDelayMs) throw new Error("reconnectMaxDelayMs must be >= reconnectBaseDelayMs");
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

function reconnectDelay(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
}

export class ResilientLobbySession extends EventTarget {
  constructor({
    apiBase = window.location.origin,
    iceServers = [],
    turnIceServers = [],
    topology = "mesh",
    contentSharing = false,
    reconnectMaxAttempts = DEFAULT_RECONNECT_MAX_ATTEMPTS,
    reconnectBaseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
    peerRecoveryAttempts = DEFAULT_PEER_RECOVERY_ATTEMPTS,
  } = {}) {
    super();
    if (!validTopology(topology)) throw new Error("Topology must be 'mesh' or 'host'");
    if (typeof contentSharing !== "boolean") throw new Error("contentSharing must be a boolean");
    validateReconnectOptions(reconnectMaxAttempts, reconnectBaseDelayMs, reconnectMaxDelayMs);
    validatePositiveInteger(peerRecoveryAttempts, "peerRecoveryAttempts");
    if (!Array.isArray(iceServers) || !Array.isArray(turnIceServers)) {
      throw new Error("iceServers and turnIceServers must be arrays");
    }

    this.apiBase = apiBase;
    this.iceServers = [...iceServers];
    this.turnIceServers = [...turnIceServers];
    this.topology = topology;
    this.contentSharing = contentSharing;
    this.reconnectMaxAttempts = reconnectMaxAttempts;
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.peerRecoveryAttempts = peerRecoveryAttempts;
    this.lobbyId = null;
    this.displayCode = null;
    this.participantId = null;
    this.hostParticipantId = null;
    this.participantToken = null;
    this.maxParticipants = null;
    this.websocketPath = null;
    this.signaling = null;
    this.participants = new Set();
    this.links = new Map();
    this.seedContentIds = [];
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.reconnectInFlight = false;
    this.setupGeneration = 0;
    this.setupInFlight = false;
    this.established = false;
  }

  get signaling() {
    return this._signaling ?? null;
  }

  set signaling(socket) {
    const previousSocket = this._signaling ?? null;
    if (previousSocket === socket) return;
    this._signaling = socket;
    this.dispatchEvent(new CustomEvent("signaling-changed", {
      detail: { socket, previousSocket },
    }));
  }

  async host(maxParticipants = 16) {
    if (!Number.isInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 16) {
      throw new Error("Lobby size must be between 2 and 16");
    }
    return this.#runInitialSetup(() =>
      readJson(
        fetch(new URL("/lobbies", this.apiBase), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxParticipants }),
        }),
      ),
    );
  }

  async join(lobbyCode) {
    const normalized = String(lobbyCode ?? "").trim();
    if (!normalized) throw new Error("Enter a lobby code");
    const path = `/lobbies/${encodeURIComponent(normalized)}/join`;
    return this.#runInitialSetup(() => readJson(fetch(new URL(path, this.apiBase), { method: "POST" })));
  }

  async #runInitialSetup(loadLobby) {
    const generation = this.#beginInitialSetup();
    try {
      const lobby = await loadLobby();
      this.#assertInitialSetupActive(generation);
      this.#adoptLobby(lobby);
      await this.#connectSignaling(lobby.websocketPath);
      this.#assertInitialSetupActive(generation);
      if (this.signaling?.readyState !== WebSocket.OPEN) {
        throw new Error("Lobby signaling closed during initial setup");
      }
      this.setupInFlight = false;
      this.established = true;
      this.#emit("lobby", this.#lobbyDetail());
      return lobby;
    } catch (error) {
      this.#abortInitialSetup(generation);
      throw error;
    }
  }

  #beginInitialSetup() {
    if (this.closed) throw new Error("Lobby session is closed");
    if (this.setupInFlight || this.established) throw new Error("Lobby session setup has already started");
    this.setupGeneration += 1;
    this.setupInFlight = true;
    return this.setupGeneration;
  }

  #assertInitialSetupActive(generation) {
    if (this.closed || !this.setupInFlight || this.setupGeneration !== generation) {
      throw new Error("Lobby session setup was cancelled");
    }
  }

  #abortInitialSetup(generation) {
    if (this.setupGeneration !== generation) return;
    this.setupInFlight = false;
    this.established = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.signaling;
    this.signaling = null;
    socket?.close();
    for (const link of this.links.values()) this.#closeLink(link);
    this.links.clear();
    this.participants.clear();
    this.#clearLobbyIdentity();
  }

  #clearLobbyIdentity() {
    this.lobbyId = null;
    this.displayCode = null;
    this.participantId = null;
    this.hostParticipantId = null;
    this.participantToken = null;
    this.maxParticipants = null;
    this.websocketPath = null;
  }

  setTurnIceServers(turnIceServers) {
    if (!Array.isArray(turnIceServers)) throw new Error("turnIceServers must be an array");
    this.turnIceServers = [...turnIceServers];
    this.#emit("turn-configuration", { available: this.turnIceServers.length > 0 });
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
    { highWaterMark = DEFAULT_CONTENT_HIGH_WATER_MARK, lowWaterMark = DEFAULT_CONTENT_LOW_WATER_MARK } = {},
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
      if (!excluded.has(peerId)) this.sendReliable(peerId, data);
    }
  }

  broadcastRealtime(data, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.readyPeerIds()) {
      if (!excluded.has(peerId)) this.sendRealtime(peerId, data);
    }
  }

  close() {
    const cancelingInitialSetup = this.setupInFlight && !this.established;
    this.setupGeneration += 1;
    this.setupInFlight = false;
    this.established = false;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.signaling;
    this.signaling = null;
    socket?.close();
    for (const link of this.links.values()) this.#closeLink(link);
    this.links.clear();
    this.participants.clear();
    this.seedContentIds = [];
    if (cancelingInitialSetup) this.#clearLobbyIdentity();
    this.#emit("statechange", { state: "closed" });
  }

  #adoptLobby(lobby) {
    this.lobbyId = lobby.lobbyId;
    this.displayCode = lobby.displayCode;
    this.participantId = lobby.participantId;
    this.participantToken = lobby.participantToken;
    this.hostParticipantId = lobby.hostParticipantId;
    this.maxParticipants = lobby.maxParticipants;
    this.websocketPath = lobby.websocketPath;
  }

  async #connectSignaling(websocketPath) {
    const socket = new WebSocket(
      toWebSocketUrl(this.apiBase, websocketPath, this.participantId),
      [SIGNALING_PROTOCOL, `cap.${this.participantToken}`],
    );
    this.signaling = socket;

    socket.addEventListener("message", (event) => {
      if (this.signaling !== socket || this.closed) return;
      this.#handleSignalingMessage(event).catch((error) => this.#fail(error));
    });
    socket.addEventListener("close", () => {
      if (this.signaling !== socket || this.closed || !this.established) return;
      this.#emit("signaling-closed", { attempt: this.reconnectAttempt });
      this.#scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.signaling !== socket || this.closed) return;
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
      const onClose = () => {
        cleanup();
        reject(new Error("Lobby signaling closed before opening"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  #scheduleReconnect() {
    if (this.closed || !this.established || this.reconnectTimer || this.reconnectInFlight || !this.websocketPath) return;
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this.#emit("statechange", { state: "reconnect-exhausted", attempts: this.reconnectAttempt });
      return;
    }

    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    const delayMs = reconnectDelay(attempt, this.reconnectBaseDelayMs, this.reconnectMaxDelayMs);
    this.#emit("statechange", { state: "reconnect-wait", attempt, delayMs });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectInFlight = true;
      let connected = false;
      try {
        await this.#connectSignaling(this.websocketPath);
        connected = true;
        this.#emit("statechange", { state: "reconnect-socket-open", attempt });
      } catch (error) {
        this.#fail(error);
      } finally {
        this.reconnectInFlight = false;
      }
      if (!connected) this.#scheduleReconnect();
    }, delayMs);
  }

  async #handleSignalingMessage(event) {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);

    switch (message.type) {
      case "connected": {
        this.reconnectAttempt = 0;
        this.hostParticipantId = message.hostParticipantId;
        const nextParticipants = new Set(message.participants ?? []);
        nextParticipants.add(this.participantId);
        for (const peerId of this.links.keys()) {
          if (!nextParticipants.has(peerId)) this.#dropLink(peerId);
        }
        this.participants = nextParticipants;
        this.#emit("roster", {
          participants: [...this.participants].sort(),
          hostParticipantId: this.hostParticipantId,
        });
        for (const peerId of this.participants) {
          if (peerId === this.participantId) continue;
          const link = this.#ensureLink(peerId);
          if (link?.peer.connectionState === "failed") this.#recoverPeer(link).catch((error) => this.#fail(error));
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
        if (this.contentSharing && this.seedContentIds.length > 0) this.#sendSeedAdvertisement(message.participantId);
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

  #closeLink(link) {
    link.reliable?.close();
    link.realtime?.close();
    link.content?.close();
    link.peer.close();
  }

  #dropLink(peerId) {
    const link = this.links.get(peerId);
    if (!link) return;
    this.#closeLink(link);
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

  #peerConfiguration(useTurn = false) {
    return { iceServers: useTurn ? [...this.iceServers, ...this.turnIceServers] : [...this.iceServers] };
  }

  #ensureLink(peerId) {
    if (!this.#shouldConnect(peerId)) return null;
    if (this.links.has(peerId)) return this.links.get(peerId);

    const peer = new RTCPeerConnection(this.#peerConfiguration(false));
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
      recoveryAttempts: 0,
      recoveryInFlight: false,
      turnEnabled: false,
    };
    this.links.set(peerId, link);

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.#signal(peerId, { candidate: event.candidate.toJSON() });
    });
    peer.addEventListener("connectionstatechange", () => {
      this.#emit("peer-statechange", { peerId, state: peer.connectionState });
      this.#maybePeerReady(link);
      this.#maybeContentReady(link);
      if (peer.connectionState === "connected") link.recoveryAttempts = 0;
      if (peer.connectionState === "failed") {
        this.#recoverPeer(link).catch((error) => this.#fail(error));
      }
    });

    if (this.#isInitiator(peerId)) {
      this.#bindChannel(link, "reliable", peer.createDataChannel("reliable", { ordered: true }));
      this.#bindChannel(
        link,
        "realtime",
        peer.createDataChannel("realtime", { ordered: false, maxRetransmits: 0 }),
      );
      if (this.contentSharing) this.#bindContentChannel(link, peer.createDataChannel("content", { ordered: true }));
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

  async #startOffer(link, { iceRestart = false } = {}) {
    if (!iceRestart && (link.offerStarted || !this.#isInitiator(link.peerId))) return;
    if (!this.#isInitiator(link.peerId)) return;
    if (!iceRestart) link.offerStarted = true;
    const offer = await link.peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await link.peer.setLocalDescription(offer);
    this.#signal(link.peerId, { description: link.peer.localDescription });
  }

  async #recoverPeer(link, { requested = false } = {}) {
    if (link.recoveryInFlight || this.closed) return;
    if (this.signaling?.readyState !== WebSocket.OPEN) return;
    if (link.recoveryAttempts >= this.peerRecoveryAttempts) {
      this.#emit("peer-recovery-exhausted", { peerId: link.peerId, attempts: link.recoveryAttempts });
      return;
    }

    link.recoveryInFlight = true;
    link.recoveryAttempts += 1;
    try {
      if (!this.#isInitiator(link.peerId)) {
        this.#signal(link.peerId, {
          transport: { v: 1, type: "ice-restart-request", preferTurn: this.turnIceServers.length > 0 },
        });
        this.#emit("peer-recovery", {
          peerId: link.peerId,
          attempt: link.recoveryAttempts,
          action: "request",
          requested,
        });
        return;
      }

      if (this.turnIceServers.length > 0 && !link.turnEnabled) {
        if (typeof link.peer.setConfiguration !== "function") {
          throw new Error("Browser cannot update ICE configuration for TURN fallback");
        }
        link.peer.setConfiguration(this.#peerConfiguration(true));
        link.turnEnabled = true;
      }
      if (typeof link.peer.restartIce === "function") link.peer.restartIce();
      await this.#startOffer(link, { iceRestart: true });
      this.#emit("peer-recovery", {
        peerId: link.peerId,
        attempt: link.recoveryAttempts,
        action: "restart",
        usingTurn: link.turnEnabled,
        requested,
      });
    } finally {
      link.recoveryInFlight = false;
    }
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

    if (payload?.transport?.v === 1 && payload.transport.type === "ice-restart-request") {
      await this.#recoverPeer(link, { requested: true });
      return;
    }

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
      if (link.peer.remoteDescription) await link.peer.addIceCandidate(payload.candidate);
      else link.pendingCandidates.push(payload.candidate);
    }
  }

  async #flushCandidates(link) {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) await link.peer.addIceCandidate(candidate);
  }

  #sendSeedAdvertisement(peerId) {
    this.#signal(peerId, { contentSeed: { v: 1, contentIds: [...this.seedContentIds] } });
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
    channel.addEventListener("close", () => this.#emit("channel-close", { peerId: link.peerId, kind }));
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
    channel.addEventListener("close", () => this.#emit("channel-close", { peerId: link.peerId, kind: "content" }));
    channel.addEventListener("message", (event) => this.#emit("content", { peerId: link.peerId, data: event.data }));
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
