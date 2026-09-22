import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { applyStepToState, topologyEdgeCount } from "../web/arena-model.mjs";

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
    this.sent = 0;
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = "closed";
  }

  send(value) {
    assert.equal(this.readyState, "open");
    assert.equal(typeof value, "string");
    this.sent += 1;
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
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: "offer", sdp: "perf-offer" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "perf-answer" };
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

  close() {
    this.connectionState = "closed";
    this.closed = true;
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
    this.readyState = FakeWebSocket.CLOSED;
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

const PARTICIPANT_IDS = Array.from({ length: 16 }, (_, index) =>
  index.toString(16).toUpperCase().padStart(8, "0"),
);
const HOST_ID = PARTICIPANT_IDS[0];
const BUDGET_MULTIPLIER = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

let nextLobby = null;
globalThis.fetch = async () => {
  assert.ok(nextLobby, "performance test must configure a lobby response");
  return {
    ok: true,
    status: 200,
    async json() {
      return nextLobby;
    },
  };
};

function assertBudget(label, elapsedMs, budgetMs) {
  const effectiveBudget = budgetMs * BUDGET_MULTIPLIER;
  console.log(`${label}: ${elapsedMs.toFixed(2)} ms (budget ${effectiveBudget} ms)`);
  assert.ok(elapsedMs <= effectiveBudget, `${label} exceeded ${effectiveBudget} ms: ${elapsedMs} ms`);
}

function lobbyResponse(participantId) {
  return {
    lobbyId: "ABCD1234EFGH",
    displayCode: "ABCD-1234-EFGH",
    participantId,
    participantToken: participantId.padEnd(64, "a"),
    hostParticipantId: HOST_ID,
    expiresAt: 9_999_999_999_999,
    maxParticipants: 16,
    websocketPath: "/lobbies/ABCD1234EFGH/connect",
  };
}

async function createSessions(topology) {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  const sessions = [];

  for (const participantId of PARTICIPANT_IDS) {
    nextLobby = lobbyResponse(participantId);
    const session = new LobbySession({ apiBase: "http://perf.test", topology });
    if (participantId === HOST_ID) {
      await session.host(16);
    } else {
      await session.join("ABCD-1234-EFGH");
    }
    sessions.push({ session, socket: FakeWebSocket.instances.at(-1) });
  }

  return sessions;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function publishRoster(sessions) {
  for (const { session, socket } of sessions) {
    socket.message({
      type: "connected",
      participantId: session.participantId,
      hostParticipantId: HOST_ID,
      participants: PARTICIPANT_IDS,
    });
  }
}

function closeSessions(sessions) {
  for (const { session } of sessions) session.close();
}

test("250k input commands remain deterministic within a broad CPU budget", () => {
  const participants = new Set(PARTICIPANT_IDS);
  const first = { players: new Map(), lastSequence: new Map(), participants };
  const second = { players: new Map(), lastSequence: new Map(), participants };
  const directions = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];

  const start = performance.now();
  for (let index = 0; index < 250_000; index += 1) {
    const participantId = PARTICIPANT_IDS[index % PARTICIPANT_IDS.length];
    const [dx, dy] = directions[index % directions.length];
    const message = {
      type: "step",
      participantId,
      seq: Math.floor(index / PARTICIPANT_IDS.length) + 1,
      dx,
      dy,
    };
    assert.equal(applyStepToState(first, message), true);
    assert.equal(applyStepToState(second, message), true);
  }
  const elapsed = performance.now() - start;

  assert.deepEqual(first.players, second.players);
  assert.deepEqual(first.lastSequence, second.lastSequence);
  assert.equal(first.players.size, 16);
  assertBudget("250k deterministic input commands applied to two replicas", elapsed, 3_000);
});

test("full 16-player mesh constructs 120 logical edges quickly", async () => {
  const sessions = await createSessions("mesh");
  const start = performance.now();
  publishRoster(sessions);
  await settle();
  const elapsed = performance.now() - start;

  const endpointCount = sessions.reduce((sum, { session }) => sum + session.peerIds().length, 0);
  const offers = sessions.flatMap(({ socket }) => socket.sent).filter(
    (message) => message.payload?.description?.type === "offer",
  );

  assert.equal(topologyEdgeCount("mesh", 16), 120);
  assert.equal(endpointCount, 240, "120 logical edges have two browser endpoints each");
  assert.equal(FakePeerConnection.instances.length, 240);
  assert.equal(offers.length, 120, "exactly one side initiates each logical edge");
  assert.ok(sessions.every(({ session }) => session.peerIds().length === 15));
  assertBudget("16-player mesh graph construction", elapsed, 1_500);
  closeSessions(sessions);
});

test("16-player host-spoke topology constructs only 15 logical edges quickly", async () => {
  const sessions = await createSessions("host");
  const start = performance.now();
  publishRoster(sessions);
  await settle();
  const elapsed = performance.now() - start;

  const endpointCount = sessions.reduce((sum, { session }) => sum + session.peerIds().length, 0);
  const offers = sessions.flatMap(({ socket }) => socket.sent).filter(
    (message) => message.payload?.description?.type === "offer",
  );

  assert.equal(topologyEdgeCount("host", 16), 15);
  assert.equal(endpointCount, 30);
  assert.equal(FakePeerConnection.instances.length, 30);
  assert.equal(offers.length, 15);
  assert.equal(sessions[0].session.peerIds().length, 15);
  assert.ok(sessions.slice(1).every(({ session }) => session.peerIds().length === 1));
  assertBudget("16-player host-spoke graph construction", elapsed, 1_000);
  closeSessions(sessions);
});

test("one 16-player peer can fan out 150k compact reliable commands cheaply", async () => {
  const sessions = await createSessions("mesh");
  const host = sessions[0];
  publishRoster([host]);
  await settle();

  for (const peer of FakePeerConnection.instances) {
    for (const channel of peer.channels) channel.open();
    peer.connect();
  }
  assert.equal(host.session.readyPeerIds().length, 15);

  const payload = { type: "step", participantId: HOST_ID, seq: 1, dx: 1, dy: 0 };
  const wireBytes = Buffer.byteLength(JSON.stringify({ v: 1, data: payload }));
  assert.ok(wireBytes <= 128, `input envelope should stay compact, got ${wireBytes} bytes`);

  const broadcasts = 10_000;
  const start = performance.now();
  for (let index = 0; index < broadcasts; index += 1) {
    payload.seq = index + 1;
    host.session.broadcastReliable(payload);
  }
  const elapsed = performance.now() - start;

  const totalMessages = FakePeerConnection.instances
    .flatMap((peer) => peer.channels)
    .filter((channel) => channel.label === "reliable")
    .reduce((sum, channel) => sum + channel.sent, 0);
  assert.equal(totalMessages, broadcasts * 15);
  assertBudget("150k reliable channel sends", elapsed, 5_000);
  closeSessions(sessions);
});
