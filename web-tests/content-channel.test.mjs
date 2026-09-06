import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

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
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = "blob";
    this.sent = [];
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  send(value) {
    if (this.readyState !== "open") throw new Error("channel is not open");
    this.sent.push(value);
  }

  setBufferedAmount(value) {
    const previous = this.bufferedAmount;
    this.bufferedAmount = value;
    if (previous > this.bufferedAmountLowThreshold && value <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }
}

class FakePeerConnection extends EventTarget {
  static instances = [];

  constructor() {
    super();
    this.connectionState = "new";
    this.remoteDescription = null;
    this.localDescription = null;
    this.channels = [];
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: "offer", sdp: "offer" };
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

  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  emitDataChannel(channel) {
    const event = new Event("datachannel");
    Object.defineProperty(event, "channel", { value: channel });
    this.dispatchEvent(event);
  }

  close() {
    this.connectionState = "closed";
  }
}

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];

  constructor() {
    super();
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
    this.readyState = 3;
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

const { LobbySession } = await import("../web/lobby-session.js");

function lobbyResponse(overrides = {}) {
  return {
    lobbyId: "ABCD1234EFGH",
    displayCode: "ABCD-1234-EFGH",
    participantId: "11111111",
    participantToken: "a".repeat(64),
    hostParticipantId: "11111111",
    expiresAt: 9999999999999,
    maxParticipants: 16,
    websocketPath: "/lobbies/ABCD1234EFGH/connect",
    ...overrides,
  };
}

async function createSession({ contentSharing = false, lobby = lobbyResponse() } = {}) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    async json() {
      return lobby;
    },
  });
  const session = new LobbySession({
    apiBase: "http://example.test",
    contentSharing,
  });
  await session.host(lobby.maxParticipants);
  return { session, socket: FakeWebSocket.instances.at(-1) };
}

function connectRoster(socket, { self = "11111111", host = "11111111", peers = ["22222222"] } = {}) {
  socket.message({
    type: "connected",
    participantId: self,
    hostParticipantId: host,
    participants: [self, ...peers],
  });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
});

test("content channel is absent by default", async () => {
  const { session, socket } = await createSession();
  connectRoster(socket);
  await flush();
  const peer = FakePeerConnection.instances[0];
  assert.deepEqual(peer.channels.map((channel) => channel.label), ["reliable", "realtime"]);
  assert.deepEqual(session.contentPeerIds(), []);
  await assert.rejects(() => session.sendContent("22222222", "x"), /not enabled/);
});

test("content channel is created only when explicitly enabled", async () => {
  const { session, socket } = await createSession({ contentSharing: true });
  connectRoster(socket);
  await flush();
  const peer = FakePeerConnection.instances[0];
  assert.deepEqual(peer.channels.map((channel) => channel.label), ["reliable", "realtime", "content"]);
  for (const channel of peer.channels) channel.open();
  peer.connect();
  assert.deepEqual(session.contentPeerIds(), ["22222222"]);
  const content = peer.channels.find((channel) => channel.label === "content");
  assert.equal(content.binaryType, "arraybuffer");
  await session.sendContent("22222222", "control");
  assert.deepEqual(content.sent, ["control"]);
});

test("a session that did not opt in closes an incoming content channel", async () => {
  const lobby = lobbyResponse({
    participantId: "22222222",
    participantToken: "b".repeat(64),
    hostParticipantId: "22222222",
  });
  const { socket } = await createSession({ lobby });
  connectRoster(socket, { self: "22222222", host: "22222222", peers: ["11111111"] });
  await flush();
  const peer = FakePeerConnection.instances[0];
  const unsolicited = new FakeDataChannel("content");
  peer.emitDataChannel(unsolicited);
  assert.equal(unsolicited.readyState, "closed");
});

test("content sends apply bufferedAmount backpressure without blocking gameplay channels", async () => {
  const { session, socket } = await createSession({ contentSharing: true });
  connectRoster(socket);
  await flush();
  const peer = FakePeerConnection.instances[0];
  for (const channel of peer.channels) channel.open();
  peer.connect();
  const content = peer.channels.find((channel) => channel.label === "content");
  const reliable = peer.channels.find((channel) => channel.label === "reliable");

  content.bufferedAmount = 2_000;
  const pending = session.sendContent("22222222", "bulk", {
    highWaterMark: 1_000,
    lowWaterMark: 250,
  });
  await Promise.resolve();
  assert.equal(content.sent.length, 0);

  session.sendReliable("22222222", { type: "gameplay" });
  assert.equal(reliable.sent.length, 1);

  content.setBufferedAmount(250);
  await pending;
  assert.deepEqual(content.sent, ["bulk"]);
});
