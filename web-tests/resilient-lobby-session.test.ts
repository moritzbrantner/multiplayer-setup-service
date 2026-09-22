import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

class FakeDataChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = "connecting";
    this.bufferedAmount = 0;
  }
  close() {
    this.readyState = "closed";
  }
  send() {}
}

class FakePeerConnection extends EventTarget {
  static instances = [];

  constructor(configuration) {
    super();
    this.configuration = configuration;
    this.connectionState = "new";
    this.remoteDescription = null;
    this.localDescription = null;
    this.channels = [];
    this.offerOptions = [];
    this.restartIceCount = 0;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(options) {
    this.offerOptions.push(options ?? null);
    return { type: "offer", sdp: `offer-${this.offerOptions.length}` };
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate() {}

  setConfiguration(configuration) {
    this.configuration = configuration;
  }

  restartIce() {
    this.restartIceCount += 1;
  }

  fail() {
    this.connectionState = "failed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  close() {
    this.connectionState = "closed";
  }
}

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    super();
    this.url = String(url);
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  message(value) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: JSON.stringify(value) });
    this.dispatchEvent(event);
  }
}

globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.WebSocket = FakeWebSocket;

const { ResilientLobbySession } = await import("../web/resilient-lobby-session.js");

function response(body) {
  return { ok: true, status: 201, async json() { return body; } };
}

function lobbyResponse() {
  return {
    lobbyId: "ABCD1234EFGH",
    displayCode: "ABCD-1234-EFGH",
    participantId: "11111111",
    participantToken: "a".repeat(64),
    hostParticipantId: "11111111",
    expiresAt: 9999999999999,
    maxParticipants: 16,
    websocketPath: "/lobbies/ABCD1234EFGH/connect",
  };
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  globalThis.fetch = async () => response(lobbyResponse());
});

afterEach(() => {
  delete globalThis.fetch;
});

test("signaling reconnect reuses the participant identity and capability", async () => {
  const session = new ResilientLobbySession({
    apiBase: "http://example.test",
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 2,
    reconnectMaxAttempts: 3,
  });
  await session.host();
  const first = FakeWebSocket.instances[0];
  first.message({
    type: "connected",
    participantId: "11111111",
    hostParticipantId: "11111111",
    participants: ["11111111"],
  });
  first.close();
  await flush(5);

  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances[1];
  assert.equal(session.signaling, second);
  assert.match(second.url, /participantId=11111111/);
  assert.deepEqual(second.protocols, ["multiplayer-setup-v1", `cap.${"a".repeat(64)}`]);

  second.message({
    type: "connected",
    participantId: "11111111",
    hostParticipantId: "11111111",
    participants: ["11111111"],
  });
  await flush();
  assert.equal(session.reconnectAttempt, 0);
  session.close();
});

test("failed direct peer escalates to TURN and sends an ICE-restart offer", async () => {
  const direct = { urls: "stun:stun.example.test" };
  const turn = { urls: "turn:turn.example.test", username: "ephemeral", credential: "short-lived" };
  const session = new ResilientLobbySession({
    apiBase: "http://example.test",
    iceServers: [direct],
    turnIceServers: [turn],
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
  });
  await session.host();
  const socket = FakeWebSocket.instances[0];
  socket.message({
    type: "connected",
    participantId: "11111111",
    hostParticipantId: "11111111",
    participants: ["11111111", "22222222"],
  });
  await flush();

  const peer = FakePeerConnection.instances[0];
  assert.deepEqual(peer.configuration.iceServers, [direct]);
  peer.fail();
  await flush();

  assert.deepEqual(peer.configuration.iceServers, [direct, turn]);
  assert.equal(peer.restartIceCount, 1);
  assert.deepEqual(peer.offerOptions.at(-1), { iceRestart: true });
  const recoveryOffer = socket.sent.find(
    (message) => message.to === "22222222" && message.payload?.description?.sdp === "offer-2",
  );
  assert.ok(recoveryOffer);
  session.close();
});
