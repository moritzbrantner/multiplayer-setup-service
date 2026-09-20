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

const { ResilientLobbySession } = await import("../web/resilient-lobby-session.ts");

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


test("remote signaling disconnect and reconnect roster preserve healthy gameplay", async () => {
  const session = new ResilientLobbySession({ apiBase: "http://example.test" });
  await session.host();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111", "22222222"] });
  await flush();
  const peer = FakePeerConnection.instances.at(-1);
  peer.connectionState = "connected";
  for (const channel of peer.channels) channel.readyState = "open";
  socket.message({ type: "participant-disconnected", participantId: "22222222" });
  socket.message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111"] });
  await flush();
  assert.equal(peer.connectionState, "connected");
  assert.deepEqual(session.readyPeerIds(), ["22222222"]);
  assert.ok(session.participants.has("22222222"));
  session.close();
});

test("TURN credential refresh reaches an existing peer on the next ICE recovery", async () => {
  const oldTurn = { urls: "turn:example.test", username: "old", credential: "fixture-old" };
  const newTurn = { ...oldTurn, username: "refreshed", credential: "fixture-new" };
  const session = new ResilientLobbySession({ apiBase: "http://example.test", turnIceServers: [oldTurn] });
  await session.host();
  FakeWebSocket.instances.at(-1).message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111", "22222222"] });
  await flush();
  const peer = FakePeerConnection.instances.at(-1);
  peer.fail();
  await flush();
  peer.connectionState = "connected";
  peer.dispatchEvent(new Event("connectionstatechange"));
  session.setTurnIceServers([newTurn]);
  peer.fail();
  await flush();
  assert.deepEqual(peer.configuration.iceServers, [newTurn]);
  session.close();
});

test("demo sessions fetch private short-lived TURN configuration without enabling relay initially", async (t) => {
  const { DemoLobbySession } = await import("../web/demo-session.ts");
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/turn-credentials")) return response({
      iceServers: [{ urls: "turn:example.test", username: "ephemeral", credential: "test-only" }],
      expiresAt: Date.now() + 120_000,
    });
    return response(lobbyResponse());
  };
  const session = new DemoLobbySession({ apiBase: "http://example.test" });
  t.after(() => session.close());
  await session.host(2);
  assert.match(session.iceServers[0].urls, /^stun:/);
  assert.equal(session.turnIceServers.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${session.participantToken}`);
  assert.ok(!calls[1].url.includes(session.participantToken));
  FakeWebSocket.instances.at(-1).message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111", "22222222"] });
  await flush();
  assert.deepEqual(FakePeerConnection.instances.at(-1).configuration.iceServers, session.iceServers);
  session.close();
  assert.deepEqual(session.turnIceServers, []);
});

test("demo remains usable when the service has no TURN configuration", async (t) => {
  const { DemoLobbySession } = await import("../web/demo-session.ts");
  globalThis.fetch = async (url) => String(url).endsWith("/turn-credentials")
    ? { ok: false, status: 503, async json() { return { error: { code: "turn-not-configured", message: "TURN is not configured" } }; } }
    : response(lobbyResponse());
  const session = new DemoLobbySession({ apiBase: "http://example.test" });
  t.after(() => session.close());
  const errors = [];
  session.addEventListener("error", (event) => errors.push(event.detail));
  await session.host(2);
  assert.equal(session.established, true);
  assert.deepEqual(session.turnIceServers, []);
  assert.deepEqual(errors, []);
});

test("ICE attempts that never report failure still reach bounded TURN recovery", async (t) => {
  const session = new ResilientLobbySession({
    apiBase: "http://example.test", iceConnectionTimeoutMs: 10, peerRecoveryAttempts: 1,
    turnIceServers: [{ urls: "turn:example.test", username: "fixture", credential: "test-only" }],
  });
  t.after(() => session.close());
  await session.host();
  FakeWebSocket.instances.at(-1).message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111", "22222222"] });
  await flush(40);
  const peer = FakePeerConnection.instances.at(-1);
  assert.equal(peer.restartIceCount, 1);
  assert.equal(peer.configuration.iceServers[0].urls, "turn:example.test");
});

test("an offline participant is removed when its preserved gameplay transport actually fails", async (t) => {
  const session = new ResilientLobbySession({ apiBase: "http://example.test" });
  t.after(() => session.close());
  await session.host();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111", "22222222"] });
  await flush();
  const peer = FakePeerConnection.instances.at(-1);
  peer.connectionState = "connected";
  for (const channel of peer.channels) channel.readyState = "open";
  socket.message({ type: "participant-disconnected", participantId: "22222222" });
  await flush();
  assert.ok(session.participants.has("22222222"));
  const departed = [];
  session.addEventListener("participant-disconnected", (event) => departed.push(event.detail.participantId));
  peer.fail();
  await flush();
  assert.equal(session.participants.has("22222222"), false);
  assert.deepEqual(session.peerIds(), []);
  assert.deepEqual(departed, ["22222222"]);
});

test("a remote restart request does not overlap an ICE recovery already awaiting connectivity", async (t) => {
  const session = new ResilientLobbySession({ apiBase: "http://example.test" });
  t.after(() => session.close());
  await session.host();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: "connected", hostParticipantId: "11111111", participants: ["11111111", "22222222"] });
  await flush();
  const peer = FakePeerConnection.instances.at(-1);
  peer.fail();
  await flush();
  socket.message({ type: "signal", from: "22222222", payload: { transport: { v: 1, type: "ice-restart-request" } } });
  await flush();
  assert.equal(peer.restartIceCount, 1);
  assert.equal(peer.offerOptions.length, 2);
});
