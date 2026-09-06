const SIGNALING_PROTOCOL = "multiplayer-setup-v1";

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

export class LobbySession extends EventTarget {
  constructor({ apiBase = window.location.origin, iceServers = [], topology = "mesh" } = {}) {
    super();
    if (!validTopology(topology)) {
      throw new Error("Topology must be 'mesh' or 'host'");
    }

    this.apiBase = apiBase;
    this.iceServers = iceServers;
    this.topology = topology;
    this.lobbyId = null;
    this.displayCode = null;
    this.participantId = null;
    this.hostParticipantId = null;
    this.participantToken = null;
    this.maxParticipants = null;
    this.signaling = null;
    this.participants = new Set();
    this.links = new Map();
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

  sendReliable(peerId, data) {
    const link = this.#requiredLink(peerId);
    this.#sendChannel(link.reliable, { v: 1, data });
  }

  sendRealtime(peerId, data) {
    const link = this.#requiredLink(peerId);
    link.realtimeSequence += 1;
    this.#sendChannel(link.realtime, { v: 1, seq: link.realtimeSequence, data });
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
      link.peer.close();
    }
    this.links.clear();
    this.participants.clear();
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
      pendingCandidates: [],
      realtimeSequence: 0,
      lastRealtimeSequence: -1,
      offerStarted: false,
      readyEmitted: false,
    };
    this.links.set(peerId, link);

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.#signal(peerId, { candidate: event.candidate.toJSON() });
    });
    peer.addEventListener("connectionstatechange", () => {
      this.#emit("peer-statechange", { peerId, state: peer.connectionState });
      this.#maybePeerReady(link);
    });

    if (this.#isInitiator(peerId)) {
      this.#bindChannel(link, "reliable", peer.createDataChannel("reliable", { ordered: true }));
      this.#bindChannel(
        link,
        "realtime",
        peer.createDataChannel("realtime", { ordered: false, maxRetransmits: 0 }),
      );
      this.#startOffer(link).catch((error) => this.#fail(error));
    } else {
      peer.addEventListener("datachannel", (event) => {
        if (event.channel.label === "reliable" || event.channel.label === "realtime") {
          this.#bindChannel(link, event.channel.label, event.channel);
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

  #maybePeerReady(link) {
    if (link.readyEmitted || !linkReady(link)) return;
    link.readyEmitted = true;
    this.#emit("peer-ready", { peerId: link.peerId });
  }

  #requiredLink(peerId) {
    const link = this.links.get(peerId);
    if (!link || !linkReady(link)) throw new Error(`Peer ${peerId} is not ready`);
    return link;
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
    };
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(error) {
    this.#emit("error", { error });
  }
}
