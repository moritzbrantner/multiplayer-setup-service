import { TypedEventTarget, isRecord } from "./events.ts";
import type { ContentData, Timer } from "./events.ts";
import type { Lobby, LobbyOptions, PeerLink, SessionEvents, Topology } from "./lobby-types.ts";
const SIGNALING_PROTOCOL = "multiplayer-setup-v1";
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 4_000;
const DEFAULT_PEER_RECOVERY_ATTEMPTS = 2;
const DEFAULT_CONTENT_HIGH_WATER_MARK = 1_048_576;
const DEFAULT_CONTENT_LOW_WATER_MARK = 262_144;
const MAX_SEED_CONTENT_IDS = 128;
const CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;

function toWebSocketUrl(apiBase: string, websocketPath: string, participantId: string) {
  const url = new URL(websocketPath, apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("participantId", participantId);
  return url;
}

async function readJson(response: Response | Promise<Response>): Promise<Lobby> {
  response = await response;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function parseChannelMessage(event: MessageEvent): Record<string, unknown> | null {
  if (typeof event.data !== "string") return null;
  try {
    const value: unknown = JSON.parse(event.data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validTopology(topology: unknown) {
  return topology === "mesh" || topology === "host";
}

function linkReady(link: PeerLink | undefined) {
  return (
    link?.peer.connectionState === "connected" &&
    link.reliable?.readyState === "open" &&
    link.realtime?.readyState === "open"
  );
}

function contentReady(link: PeerLink) {
  return link?.peer.connectionState === "connected" && link.content?.readyState === "open";
}

function validatePositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
}

function validateReconnectOptions(maxAttempts: number, baseDelayMs: number, maxDelayMs: number) {
  validatePositiveInteger(maxAttempts, "reconnectMaxAttempts");
  validatePositiveInteger(baseDelayMs, "reconnectBaseDelayMs");
  validatePositiveInteger(maxDelayMs, "reconnectMaxDelayMs");
  if (maxDelayMs < baseDelayMs) throw new Error("reconnectMaxDelayMs must be >= reconnectBaseDelayMs");
}

function validateContentWaterMarks(highWaterMark: number, lowWaterMark: number) {
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new Error("Content highWaterMark must be a positive safe integer");
  }
  if (!Number.isSafeInteger(lowWaterMark) || lowWaterMark < 0 || lowWaterMark >= highWaterMark) {
    throw new Error("Content lowWaterMark must be a non-negative safe integer below highWaterMark");
  }
}

function normalizeSeedContentIds(contentIds: string[]) {
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

function parseSeedAdvertisement(payload: Record<string, unknown>) {
  const advertisement = payload?.contentSeed;
  if (!isRecord(advertisement) || advertisement.v !== 1 || !Array.isArray(advertisement.contentIds)) return null;
  try {
    return normalizeSeedContentIds(advertisement.contentIds);
  } catch {
    return null;
  }
}

function reconnectDelay(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
}

export class ResilientLobbySession extends TypedEventTarget<SessionEvents> {
  apiBase: string;
  iceServers: RTCIceServer[];
  turnIceServers: RTCIceServer[];
  topology: Topology;
  contentSharing: boolean;
  reconnectMaxAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  peerRecoveryAttempts: number;
  iceConnectionTimeoutMs: number;
  lobbyId: string | null = null;
  displayCode: string | null = null;
  participantId: string | null = null;
  hostParticipantId: string | null = null;
  participantToken: string | null = null;
  maxParticipants: number | null = null;
  websocketPath: string | null = null;
  expiresAt = 0;
  maxExpiresAt = 0;
  private _signaling: WebSocket | null = null;
  participants: Set<string>;
  signalingParticipants: Set<string>;
  links: Map<string, PeerLink>;
  seedContentIds: string[];
  closed: boolean;
  reconnectAttempt: number;
  reconnectTimer: Timer | null;
  reconnectInFlight: boolean;
  setupGeneration: number;
  setupInFlight: boolean;
  established: boolean;
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
    iceConnectionTimeoutMs = 10_000,
  }: LobbyOptions = {}) {
    super();
    if (!validTopology(topology)) throw new Error("Topology must be 'mesh' or 'host'");
    if (typeof contentSharing !== "boolean") throw new Error("contentSharing must be a boolean");
    validateReconnectOptions(reconnectMaxAttempts, reconnectBaseDelayMs, reconnectMaxDelayMs);
    validatePositiveInteger(peerRecoveryAttempts, "peerRecoveryAttempts");
    validatePositiveInteger(iceConnectionTimeoutMs, "iceConnectionTimeoutMs");
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
    this.iceConnectionTimeoutMs = iceConnectionTimeoutMs;
    this.lobbyId = null;
    this.displayCode = null;
    this.participantId = null;
    this.hostParticipantId = null;
    this.participantToken = null;
    this.maxParticipants = null;
    this.websocketPath = null;
    this.signaling = null;
    this.participants = new Set();
    this.signalingParticipants = new Set();
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

  set signaling(socket: WebSocket | null) {
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

  async join(lobbyCode: string) {
    const normalized = String(lobbyCode ?? "").trim();
    if (!normalized) throw new Error("Enter a lobby code");
    const path = `/lobbies/${encodeURIComponent(normalized)}/join`;
    return this.#runInitialSetup(() => readJson(fetch(new URL(path, this.apiBase), { method: "POST" })));
  }

  async #runInitialSetup(loadLobby: () => Promise<Lobby>) {
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
      this.#emit("lobby", this.#lobbyDetail(lobby));
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

  #assertInitialSetupActive(generation: number) {
    if (this.closed || !this.setupInFlight || this.setupGeneration !== generation) {
      throw new Error("Lobby session setup was cancelled");
    }
  }

  #abortInitialSetup(generation: number) {
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
    this.signalingParticipants.clear();
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

  setTurnIceServers(turnIceServers: RTCIceServer[]) {
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

  announceSeedContent(contentIds: string[]) {
    if (!this.contentSharing) throw new Error("Content sharing is not enabled for this lobby session");
    const normalized = normalizeSeedContentIds(contentIds);
    this.seedContentIds = normalized;
    for (const peerId of [...this.participants].sort()) {
      if (peerId !== this.participantId) this.#sendSeedAdvertisement(peerId);
    }
    this.#emit("seed-advertisement-local", { contentIds: [...normalized] });
  }

  sendReliable(peerId: string, data: unknown) {
    const link = this.#requiredLink(peerId);
    this.#sendChannel(link.reliable, { v: 1, data });
  }

  sendRealtime(peerId: string, data: unknown) {
    const link = this.#requiredLink(peerId);
    link.realtimeSequence += 1;
    this.#sendChannel(link.realtime, { v: 1, seq: link.realtimeSequence, data });
  }

  async sendContent(
    peerId: string,
    data: ContentData,
    { highWaterMark = DEFAULT_CONTENT_HIGH_WATER_MARK, lowWaterMark = DEFAULT_CONTENT_LOW_WATER_MARK } = {},
  ) {
    if (!this.contentSharing) throw new Error("Content sharing is not enabled for this lobby session");
    validateContentWaterMarks(highWaterMark, lowWaterMark);
    const link = this.#requiredContentLink(peerId);
    await this.#waitForContentCapacity(link.content, highWaterMark, lowWaterMark);
    if (!contentReady(link)) throw new Error(`Content channel for peer ${peerId} is not ready`);
    if (!link.content) throw new Error("Content channel is missing");
    if (typeof data === "string") link.content.send(data);
    else if (data instanceof Blob) link.content.send(data);
    else if (data instanceof ArrayBuffer) link.content.send(data);
    else link.content.send(data);
  }

  broadcastReliable(data: unknown, { exclude = [] }: {exclude?: string[]} = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.readyPeerIds()) {
      if (!excluded.has(peerId)) this.sendReliable(peerId, data);
    }
  }

  broadcastRealtime(data: unknown, { exclude = [] }: {exclude?: string[]} = {}) {
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
    this.signalingParticipants.clear();
    this.seedContentIds = [];
    if (cancelingInitialSetup) this.#clearLobbyIdentity();
    this.#emit("statechange", { state: "closed" });
  }

  #adoptLobby(lobby: Lobby) {
    this.lobbyId = lobby.lobbyId;
    this.displayCode = lobby.displayCode;
    this.participantId = lobby.participantId;
    this.participantToken = lobby.participantToken;
    this.hostParticipantId = lobby.hostParticipantId;
    this.maxParticipants = lobby.maxParticipants;
    this.websocketPath = lobby.websocketPath;
    this.expiresAt = lobby.expiresAt;
    this.maxExpiresAt = lobby.maxExpiresAt;
  }

  async #connectSignaling(websocketPath: string) {
    if (!this.participantId || !this.participantToken) throw new Error("Lobby identity is unavailable");
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

    await new Promise<void>((resolve, reject) => {
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
        if (this.closed || !this.websocketPath) return;
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

  async #handleSignalingMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    const message: unknown = JSON.parse(event.data);
    if (!isRecord(message) || !this.participantId || !this.hostParticipantId) return;

    switch (message.type) {
      case "connected": {
        if (typeof message.hostParticipantId !== "string" || !Array.isArray(message.participants)
          || !message.participants.every((id: unknown) => typeof id === "string")) return;
        this.reconnectAttempt = 0;
        this.hostParticipantId = message.hostParticipantId;
        this.signalingParticipants = new Set(message.participants ?? []);
        const nextParticipants = new Set(this.signalingParticipants);
        for (const [peerId, link] of this.links) {
          if (linkReady(link)) nextParticipants.add(peerId);
        }
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
          if (link && !linkReady(link) && link.peer.connectionState !== "new") this.#recoverPeer(link).catch((error) => this.#fail(error));
        }
        this.#emit("statechange", { state: "signaling-connected" });
        break;
      }
      case "participant-connected":
        if (typeof message.participantId !== "string") return;
        this.signalingParticipants.add(message.participantId);
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
        if (typeof message.participantId !== "string") return;
        this.signalingParticipants.delete(message.participantId);
        this.#emit("participant-signaling-disconnected", { participantId: message.participantId });
        if (this.links.has(message.participantId) && linkReady(this.links.get(message.participantId))) break;
        this.participants.delete(message.participantId);
        this.#dropLink(message.participantId);
        this.#emit("participant-disconnected", { participantId: message.participantId });
        this.#emit("roster", {
          participants: [...this.participants].sort(),
          hostParticipantId: this.hostParticipantId,
        });
        break;
      case "signal":
        if (typeof message.from === "string" && isRecord(message.payload)) await this.#handleSignal(message.from, message.payload);
        break;
      case "error":
        this.#fail(new Error(typeof message.message === "string" ? message.message : "Lobby signaling error"));
        break;
      default:
        break;
    }
  }

  #closeLink(link: PeerLink) {
    if (link.recoveryTimer) clearTimeout(link.recoveryTimer);
    link.recoveryTimer = null;
    link.reliable?.close();
    link.realtime?.close();
    link.content?.close();
    link.peer.close();
  }

  #dropLink(peerId: string) {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    this.#closeLink(link);
  }

  #removeOfflinePeer(link: PeerLink) {
    if (this.closed || this.links.get(link.peerId) !== link || linkReady(link)
      || this.signaling?.readyState !== WebSocket.OPEN || this.signalingParticipants.has(link.peerId)) return false;
    this.participants.delete(link.peerId);
    this.#dropLink(link.peerId);
    this.#emit("participant-disconnected", { participantId: link.peerId });
    if (this.hostParticipantId) this.#emit("roster", { participants: [...this.participants].sort(), hostParticipantId: this.hostParticipantId });
    return true;
  }

  #shouldConnect(peerId: string) {
    if (!peerId || peerId === this.participantId) return false;
    if (this.topology === "mesh") return true;
    return this.participantId === this.hostParticipantId || peerId === this.hostParticipantId;
  }

  #isInitiator(peerId: string) {
    if (this.topology === "host") return this.participantId === this.hostParticipantId;
    return this.participantId !== null && this.participantId.localeCompare(peerId) < 0;
  }

  #peerConfiguration(useTurn = false) {
    return { iceServers: useTurn ? [...this.iceServers, ...this.turnIceServers] : [...this.iceServers] };
  }

  #ensureLink(peerId: string) {
    if (!this.#shouldConnect(peerId)) return null;
    if (this.links.has(peerId)) return this.links.get(peerId);

    const peer = new RTCPeerConnection(this.#peerConfiguration(false));
    const link: PeerLink = {
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
      recoveryTimer: null,
      recoveryAttempts: 0,
      recoveryInFlight: false,
      turnEnabled: false,
    };
    this.links.set(peerId, link);
    this.#schedulePeerRecovery(link);

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.#signal(peerId, { candidate: event.candidate.toJSON() });
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.closed || this.links.get(peerId) !== link) return;
      this.#emit("peer-statechange", { peerId, state: peer.connectionState });
      this.#maybePeerReady(link);
      this.#maybeContentReady(link);
      if (peer.connectionState === "connected") {
        link.recoveryAttempts = 0;
        if (link.recoveryTimer) clearTimeout(link.recoveryTimer);
        link.recoveryTimer = null;
      }
      if (peer.connectionState === "disconnected") this.#schedulePeerRecovery(link);
      if ((peer.connectionState === "failed" || peer.connectionState === "closed") && this.#removeOfflinePeer(link)) return;
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

  async #startOffer(link: PeerLink, { iceRestart = false } = {}) {
    if (!iceRestart && (link.offerStarted || !this.#isInitiator(link.peerId))) return;
    if (!this.#isInitiator(link.peerId)) return;
    if (!iceRestart) link.offerStarted = true;
    const offer = await link.peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await link.peer.setLocalDescription(offer);
    this.#signal(link.peerId, { description: link.peer.localDescription });
  }

  #schedulePeerRecovery(link: PeerLink) {
    if (this.closed || link.recoveryTimer || this.links.get(link.peerId) !== link) return;
    link.recoveryTimer = setTimeout(() => {
      link.recoveryTimer = null;
      if (!linkReady(link)) this.#recoverPeer(link).catch((error) => this.#fail(error));
    }, this.iceConnectionTimeoutMs);
  }

  async #recoverPeer(link: PeerLink, { requested = false } = {}) {
    if (link.recoveryInFlight || this.closed || this.links.get(link.peerId) !== link) return;
    if (this.signaling?.readyState !== WebSocket.OPEN) return;
    if (requested && link.recoveryAttempts > 0 && link.recoveryTimer) return;
    if (link.recoveryAttempts >= this.peerRecoveryAttempts) {
      this.#emit("peer-recovery-exhausted", { peerId: link.peerId, attempts: link.recoveryAttempts });
      return;
    }

    if (link.recoveryTimer) clearTimeout(link.recoveryTimer);
    link.recoveryTimer = null;
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

      if (this.turnIceServers.length > 0) {
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
      this.#schedulePeerRecovery(link);
    }
  }

  async #handleSignal(from: string, payload: Record<string, unknown>) {
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

    if (isRecord(payload.transport) && payload.transport.v === 1 && payload.transport.type === "ice-restart-request") {
      await this.#recoverPeer(link, { requested: true });
      return;
    }

    if (isRecord(payload.description)) {
      const description = payload.description;
      if ((description.type !== "offer" && description.type !== "answer") || typeof description.sdp !== "string") return;
      if (description.type === "offer" && link.peer.remoteDescription && this.turnIceServers.length > 0) {
        link.peer.setConfiguration(this.#peerConfiguration(true));
        link.turnEnabled = true;
      }
      await link.peer.setRemoteDescription({ type: description.type, sdp: description.sdp });
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

  async #flushCandidates(link: PeerLink) {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) await link.peer.addIceCandidate(candidate);
  }

  #sendSeedAdvertisement(peerId: string) {
    this.#signal(peerId, { contentSeed: { v: 1, contentIds: [...this.seedContentIds] } });
  }

  #signal(to: string, payload: unknown) {
    if (this.signaling?.readyState !== WebSocket.OPEN) return;
    this.signaling.send(JSON.stringify({ type: "signal", to, payload }));
  }

  #bindChannel(link: PeerLink, kind: "reliable" | "realtime", channel: RTCDataChannel) {
    if (kind === "reliable") link.reliable = channel;
    else link.realtime = channel;
    channel.addEventListener("open", () => {
      this.#emit("channel-open", { peerId: link.peerId, kind });
      this.#maybePeerReady(link);
    });
    channel.addEventListener("close", () => {
      this.#emit("channel-close", { peerId: link.peerId, kind });
      this.#removeOfflinePeer(link);
    });
    channel.addEventListener("message", (event) => {
      const envelope = parseChannelMessage(event);
      if (!envelope || envelope.v !== 1) return;
      if (kind === "realtime") {
        if (typeof envelope.seq !== "number" || !Number.isInteger(envelope.seq) || envelope.seq <= link.lastRealtimeSequence) return;
        link.lastRealtimeSequence = envelope.seq;
      }
      this.#emit(kind, { peerId: link.peerId, data: envelope.data });
    });
  }

  #bindContentChannel(link: PeerLink, channel: RTCDataChannel) {
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

  #maybePeerReady(link: PeerLink) {
    if (link.readyEmitted || !linkReady(link)) return;
    link.readyEmitted = true;
    this.#emit("peer-ready", { peerId: link.peerId });
  }

  #maybeContentReady(link: PeerLink) {
    if (link.contentReadyEmitted || !contentReady(link)) return;
    link.contentReadyEmitted = true;
    this.#emit("content-peer-ready", { peerId: link.peerId });
  }

  #requiredLink(peerId: string) {
    const link = this.links.get(peerId);
    if (!link || !linkReady(link)) throw new Error(`Peer ${peerId} is not ready`);
    return link;
  }

  #requiredContentLink(peerId: string) {
    const link = this.links.get(peerId);
    if (!link || !contentReady(link)) throw new Error(`Content channel for peer ${peerId} is not ready`);
    return link;
  }

  async #waitForContentCapacity(channel: RTCDataChannel | null, highWaterMark: number, lowWaterMark: number) {
    if (!channel) throw new Error("Content channel is missing");
    if (channel.bufferedAmount < highWaterMark) return;
    channel.bufferedAmountLowThreshold = lowWaterMark;
    await new Promise<void>((resolve, reject) => {
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

  #sendChannel(channel: RTCDataChannel | null, value: unknown) {
    if (channel?.readyState !== "open") throw new Error("Peer-to-peer channel is not ready");
    channel.send(JSON.stringify(value));
  }

  #lobbyDetail(lobby: Lobby) {
    return {
      lobbyId: lobby.lobbyId,
      displayCode: lobby.displayCode,
      participantId: lobby.participantId,
      hostParticipantId: lobby.hostParticipantId,
      maxParticipants: lobby.maxParticipants,
      topology: this.topology,
      contentSharing: this.contentSharing,
    };
  }

  #emit<K extends keyof SessionEvents>(type: K, detail: SessionEvents[K]) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(error: unknown) {
    this.#emit("error", { error });
  }
}
