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

class FakePeerConnection extends EventTarget {
  close() {}
}

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  static failNext = false;

  constructor(url, protocols) {
    super();
    this.url = String(url);
    this.protocols = protocols;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.failNext) {
        FakeWebSocket.failNext = false;
        this.dispatchEvent(new Event("error"));
        this.close();
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send() {}

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.WebSocket = FakeWebSocket;

const { ResilientLobbySession } = await import("../web/resilient-lobby-session.js");

function response(body) {
  return { ok: true, status: 201, async json() { return body; } };
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

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.failNext = false;
  globalThis.fetch = async () => response(lobbyResponse());
});

afterEach(() => {
  delete globalThis.fetch;
});

for (const operation of ["host", "join"]) {
  test(`close during initial ${operation} HTTP request cancels setup before lobby adoption`, async () => {
    const pending = deferred();
    globalThis.fetch = async () => pending.promise;
    const session = new ResilientLobbySession({ apiBase: "http://example.test" });
    let lobbyEvents = 0;
    session.addEventListener("lobby", () => {
      lobbyEvents += 1;
    });

    const setup = operation === "host" ? session.host() : session.join("ABCD-1234-EFGH");
    await Promise.resolve();
    session.close();
    pending.resolve(response(lobbyResponse()));

    await assert.rejects(setup, /setup was cancelled/);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(lobbyEvents, 0);
    assert.equal(session.lobbyId, null);
    assert.equal(session.participantId, null);
  });
}

test("initial signaling failure rejects without leaving a reconnecting hidden session", async () => {
  FakeWebSocket.failNext = true;
  const session = new ResilientLobbySession({
    apiBase: "http://example.test",
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
    reconnectMaxAttempts: 2,
  });

  await assert.rejects(() => session.host(), /Could not connect to lobby signaling/);
  await flush(5);

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(session.reconnectTimer, null);
  assert.equal(session.signaling, null);
  assert.equal(session.setupInFlight, false);
  assert.equal(session.established, false);
  assert.equal(session.lobbyId, null);
  assert.equal(session.participantId, null);
});
