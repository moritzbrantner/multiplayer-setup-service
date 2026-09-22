const SIGNALING_PROTOCOL = "multiplayer-setup-v1";

function toWebSocketUrl(apiBase, websocketPath, role) {
  const url = new URL(websocketPath, apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", role);
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

export class PeerSession extends EventTarget {
  constructor({ apiBase = window.location.origin, iceServers = [] } = {}) {
    super();
    this.apiBase = apiBase;
    this.iceServers = iceServers;
    this.role = null;
    this.roomId = null;
    this.displayCode = null;
    this.peer = null;
    this.signaling = null;
    this.reliable = null;
    this.realtime = null;
    this.closed = false;
    this.pendingCandidates = [];
    this.realtimeSequence = 0;
    this.lastRealtimeSequence = -1;
    this.offerStarted = false;
  }

  async host() {
    const room = await readJson(
      await fetch(new URL("/rooms", this.apiBase), { method: "POST" }),
    );
    this.role = "host";
    this.roomId = room.roomId;
    this.displayCode = room.displayCode;
    this.#preparePeer();
    await this.#connectSignaling(room.websocketPath, room.hostToken);
    this.#emit("room", { roomId: this.roomId, displayCode: this.displayCode, role: this.role });
    return room;
  }

  async join(roomCode) {
    const normalized = String(roomCode ?? "").trim();
    if (!normalized) {
      throw new Error("Enter a room code");
    }
    const path = `/rooms/${encodeURIComponent(normalized)}/join`;
    const room = await readJson(
      await fetch(new URL(path, this.apiBase), { method: "POST" }),
    );
    this.role = "guest";
    this.roomId = room.roomId;
    this.displayCode = room.displayCode;
    this.#preparePeer();
    await this.#connectSignaling(room.websocketPath, room.guestToken);
    this.#emit("room", { roomId: this.roomId, displayCode: this.displayCode, role: this.role });
    return room;
  }

  sendReliable(data) {
    this.#sendChannel(this.reliable, { v: 1, data });
  }

  sendRealtime(data) {
    this.realtimeSequence += 1;
    this.#sendChannel(this.realtime, {
      v: 1,
      seq: this.realtimeSequence,
      data,
    });
  }

  close() {
    this.closed = true;
    this.signaling?.close();
    this.reliable?.close();
    this.realtime?.close();
    this.peer?.close();
    this.#emitState("closed");
  }

  #preparePeer() {
    this.peer = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.#signal({ candidate: event.candidate.toJSON() });
      }
    });
    this.peer.addEventListener("connectionstatechange", () => {
      this.#emitState(this.peer.connectionState);
      this.#maybeReleaseSignaling();
    });
    this.peer.addEventListener("icegatheringstatechange", () => this.#maybeReleaseSignaling());

    if (this.role === "host") {
      this.#bindChannel(
        "reliable",
        this.peer.createDataChannel("reliable", { ordered: true }),
      );
      this.#bindChannel(
        "realtime",
        this.peer.createDataChannel("realtime", {
          ordered: false,
          maxRetransmits: 0,
        }),
      );
    } else {
      this.peer.addEventListener("datachannel", (event) => {
        if (event.channel.label === "reliable" || event.channel.label === "realtime") {
          this.#bindChannel(event.channel.label, event.channel);
        }
      });
    }
  }

  async #connectSignaling(websocketPath, token) {
    const socket = new WebSocket(
      toWebSocketUrl(this.apiBase, websocketPath, this.role),
      [SIGNALING_PROTOCOL, `cap.${token}`],
    );
    this.signaling = socket;

    socket.addEventListener("message", (event) => {
      this.#handleSignalingMessage(event).catch((error) => this.#fail(error));
    });
    socket.addEventListener("close", () => {
      if (!this.closed && this.peer?.connectionState !== "connected") {
        this.#emit("signaling-closed", {});
      }
    });
    socket.addEventListener("error", () => {
      this.#fail(new Error("Signaling WebSocket failed"));
    });

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to signaling"));
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
    if (typeof event.data !== "string") {
      return;
    }
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "connected":
        this.#emitState("signaling-connected");
        break;
      case "peer-connected":
        this.#emit("peer-connected", { peerRole: message.peerRole });
        if (this.role === "host" && !this.offerStarted) {
          this.offerStarted = true;
          await this.#startOffer();
        }
        break;
      case "peer-disconnected":
        this.#emit("peer-disconnected", { peerRole: message.peerRole });
        break;
      case "signal":
        await this.#handleSignal(message.payload);
        break;
      case "error":
        this.#fail(new Error(message.message ?? message.code ?? "Signaling error"));
        break;
      default:
        break;
    }
  }

  async #startOffer() {
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    this.#signal({ description: this.peer.localDescription });
  }

  async #handleSignal(payload) {
    if (payload?.description) {
      await this.peer.setRemoteDescription(payload.description);
      await this.#flushCandidates();
      if (payload.description.type === "offer") {
        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        this.#signal({ description: this.peer.localDescription });
      }
    }

    if (payload?.candidate) {
      if (this.peer.remoteDescription) {
        await this.peer.addIceCandidate(payload.candidate);
      } else {
        this.pendingCandidates.push(payload.candidate);
      }
    }
  }

  async #flushCandidates() {
    const pending = this.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await this.peer.addIceCandidate(candidate);
    }
  }

  #signal(payload) {
    if (this.signaling?.readyState === WebSocket.OPEN) {
      this.signaling.send(JSON.stringify({ type: "signal", payload }));
    }
  }

  #bindChannel(kind, channel) {
    if (kind === "reliable") {
      this.reliable = channel;
    } else {
      this.realtime = channel;
    }

    channel.addEventListener("open", () => {
      this.#emit("channel-open", { kind });
      this.#maybeReleaseSignaling();
    });
    channel.addEventListener("close", () => this.#emit("channel-close", { kind }));
    channel.addEventListener("message", (event) => {
      const envelope = parseChannelMessage(event);
      if (!envelope || envelope.v !== 1) {
        return;
      }
      if (kind === "realtime") {
        if (!Number.isInteger(envelope.seq) || envelope.seq <= this.lastRealtimeSequence) {
          return;
        }
        this.lastRealtimeSequence = envelope.seq;
      }
      this.#emit(kind, envelope.data);
    });
  }

  #maybeReleaseSignaling() {
    if (
      this.peer?.connectionState === "connected" &&
      this.peer.iceGatheringState === "complete" &&
      this.reliable?.readyState === "open" &&
      this.realtime?.readyState === "open" &&
      this.signaling?.readyState === WebSocket.OPEN
    ) {
      this.signaling.close(1000, "peer-to-peer-ready");
      this.#emit("p2p-ready", {});
    }
  }

  #sendChannel(channel, value) {
    if (channel?.readyState !== "open") {
      throw new Error("Peer-to-peer channel is not ready");
    }
    channel.send(JSON.stringify(value));
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #emitState(state) {
    this.#emit("statechange", { state });
  }

  #fail(error) {
    this.#emit("error", { error });
  }
}
