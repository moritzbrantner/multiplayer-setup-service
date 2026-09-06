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
    this.sent.push(JSON.parse(value));
  }

  receive(value) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: JSON.stringify(value) });
    this.dispatchEvent(event);
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
    this.candidates = [];
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: "offer", sdp: `offer-${FakePeerConnection.instances.indexOf(this)}` };
  }

  async createAnswer() {
    return { type: "answer", sdp: `answer-${FakePeerConnection.instances.indexOf(this)}` };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
  }

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
    this.closed = true;
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

const { LobbySession } = await import("../web/lobby-session.js");

let fetchCalls = [];
let nextResponse = null;

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

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

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function createHostedSession({ topology = "mesh", lobby = lobbyResponse() } = {}) {
  nextResponse = response(lobby, { status: 201 });
  const session = new LobbySession({ apiBase: "http://example.test", topology });
  await session.host(lobby.maxParticipants);
  return { session, socket: FakeWebSocket.instances.at(-1) };
}

function connected(socket, {
  self = "11111111",
  host = "11111111",
  participants = [self],
} = {}) {
  socket.message({
    type: "connected",
    participantId: self,
    hostParticipantId: host,
    participants,
  });
}

function readyAllInitiatorLinks(session) {
  for (const peer of FakePeerConnection.instances) {
    for (const channel of peer.channels) channel.open();
    peer.connect();
  }
  return session.readyPeerIds();
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  fetchCalls = [];
  nextResponse = null;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (!nextResponse) throw new Error("unexpected fetch");
    return nextResponse;
  };
});

afterEach(() => {
  delete globalThis.fetch;
});

test("constructor rejects unsupported topology", () => {
  assert.throws(
    () => new LobbySession({ apiBase: "http://example.test", topology: "ring" }),
    /Topology must be/,
  );
});

test("host validates lobby size before network access", async () => {
  const session = new LobbySession({ apiBase: "http://example.test" });
  await assert.rejects(() => session.host(1), /between 2 and 16/);
  await assert.rejects(() => session.host(17), /between 2 and 16/);
  await assert.rejects(() => session.host(4.5), /between 2 and 16/);
  assert.equal(fetchCalls.length, 0);
});

test("host creates a lobby with the requested capacity and authenticated websocket", async () => {
  const { session, socket } = await createHostedSession();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://example.test/lobbies");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { maxParticipants: 16 });
  assert.equal(session.participantId, "11111111");
  assert.equal(session.hostParticipantId, "11111111");
  assert.match(socket.url, /participantId=11111111/);
  assert.deepEqual(socket.protocols, ["multiplayer-setup-v1", `cap.${"a".repeat(64)}`]);
});

test("join rejects blank lobby codes without network access", async () => {
  const session = new LobbySession({ apiBase: "http://example.test" });
  await assert.rejects(() => session.join("   "), /Enter a lobby code/);
  assert.equal(fetchCalls.length, 0);
});

test("join encodes the lobby code and adopts participant identity", async () => {
  const joined = lobbyResponse({
    participantId: "22222222",
    participantToken: "b".repeat(64),
    hostParticipantId: "11111111",
  });
  nextResponse = response(joined);
  const session = new LobbySession({ apiBase: "http://example.test", topology: "host" });
  await session.join("ABCD 1234");
  assert.equal(fetchCalls[0].url, "http://example.test/lobbies/ABCD%201234/join");
  assert.equal(session.participantId, "22222222");
  assert.equal(session.hostParticipantId, "11111111");
  assert.equal(session.topology, "host");
});

test("mesh roster creates a link to every other participant", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, {
    participants: ["11111111", "22222222", "33333333", "44444444"],
  });
  await flush();
  assert.deepEqual(session.peerIds(), ["22222222", "33333333", "44444444"]);
  assert.equal(FakePeerConnection.instances.length, 3);
});

test("mesh offer initiation is deterministic and targeted", async () => {
  const hosted = lobbyResponse({ participantId: "22222222", hostParticipantId: "22222222" });
  const { socket } = await createHostedSession({ lobby: hosted });
  connected(socket, {
    self: "22222222",
    host: "22222222",
    participants: ["11111111", "22222222", "33333333"],
  });
  await flush();

  const offers = socket.sent.filter((message) => message.type === "signal" && message.payload?.description);
  assert.deepEqual(offers.map((message) => message.to), ["33333333"]);
  assert.equal(offers[0].payload.description.type, "offer");
});

test("host-spoke guest connects only to the host", async () => {
  const joined = lobbyResponse({
    participantId: "22222222",
    participantToken: "b".repeat(64),
    hostParticipantId: "11111111",
  });
  nextResponse = response(joined);
  const session = new LobbySession({ apiBase: "http://example.test", topology: "host" });
  await session.join("ABCD-1234-EFGH");
  const socket = FakeWebSocket.instances.at(-1);
  connected(socket, {
    self: "22222222",
    host: "11111111",
    participants: ["11111111", "22222222", "33333333", "44444444"],
  });
  await flush();
  assert.deepEqual(session.peerIds(), ["11111111"]);
  assert.equal(FakePeerConnection.instances.length, 1);
});

test("host-spoke host connects to and initiates every guest", async () => {
  const { session, socket } = await createHostedSession({ topology: "host" });
  connected(socket, {
    participants: ["11111111", "22222222", "33333333", "44444444"],
  });
  await flush();
  assert.deepEqual(session.peerIds(), ["22222222", "33333333", "44444444"]);
  const offers = socket.sent.filter((message) => message.payload?.description?.type === "offer");
  assert.deepEqual(offers.map((message) => message.to).sort(), ["22222222", "33333333", "44444444"]);
});

test("participant disconnect drops exactly that peer link", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, { participants: ["11111111", "22222222", "33333333"] });
  await flush();
  assert.deepEqual(session.peerIds(), ["22222222", "33333333"]);
  socket.message({ type: "participant-disconnected", participantId: "22222222" });
  await flush();
  assert.deepEqual(session.peerIds(), ["33333333"]);
  assert.equal(FakePeerConnection.instances[0].closed, true);
});

test("reliable send is fail-closed until the peer is fully ready", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, { participants: ["11111111", "22222222"] });
  await flush();
  assert.throws(() => session.sendReliable("22222222", { type: "x" }), /not ready/);
  readyAllInitiatorLinks(session);
  session.sendReliable("22222222", { type: "x" });
  const peer = FakePeerConnection.instances[0];
  const reliable = peer.channels.find((channel) => channel.label === "reliable");
  assert.deepEqual(reliable.sent, [{ v: 1, data: { type: "x" } }]);
});

test("realtime sends monotonically increasing per-peer sequences", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, { participants: ["11111111", "22222222"] });
  await flush();
  readyAllInitiatorLinks(session);
  session.sendRealtime("22222222", { x: 1 });
  session.sendRealtime("22222222", { x: 2 });
  const realtime = FakePeerConnection.instances[0].channels.find(
    (channel) => channel.label === "realtime",
  );
  assert.deepEqual(realtime.sent.map((message) => message.seq), [1, 2]);
});

test("stale realtime messages are discarded per peer", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, { participants: ["11111111", "22222222"] });
  await flush();
  readyAllInitiatorLinks(session);
  const received = [];
  session.addEventListener("realtime", (event) => received.push(event.detail));
  const realtime = FakePeerConnection.instances[0].channels.find(
    (channel) => channel.label === "realtime",
  );
  realtime.receive({ v: 1, seq: 4, data: { x: 4 } });
  realtime.receive({ v: 1, seq: 3, data: { x: 3 } });
  realtime.receive({ v: 1, seq: 4, data: { x: 4 } });
  assert.deepEqual(received, [{ peerId: "22222222", data: { x: 4 } }]);
});

test("broadcastReliable honors exclusions", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, { participants: ["11111111", "22222222", "33333333"] });
  await flush();
  readyAllInitiatorLinks(session);
  session.broadcastReliable({ type: "tick" }, { exclude: ["22222222"] });

  const sentByPeer = new Map();
  for (const [index, peerId] of session.peerIds().entries()) {
    const reliable = FakePeerConnection.instances[index].channels.find(
      (channel) => channel.label === "reliable",
    );
    sentByPeer.set(peerId, reliable.sent.length);
  }
  assert.equal(sentByPeer.get("22222222"), 0);
  assert.equal(sentByPeer.get("33333333"), 1);
});

test("close tears down signaling, links, and roster state", async () => {
  const { session, socket } = await createHostedSession();
  connected(socket, { participants: ["11111111", "22222222"] });
  await flush();
  session.close();
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.deepEqual(session.peerIds(), []);
  assert.equal(session.participants.size, 0);
  assert.equal(FakePeerConnection.instances[0].closed, true);
});
