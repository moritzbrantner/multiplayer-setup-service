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
  }

  close() {
    this.readyState = "closed";
  }

  send() {}
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
const { ContentSeederDiscovery } = await import("../web/content-seeder-discovery.js");
const { CONTENT_MANIFEST_PROTOCOL } = await import("../web/content-verification.js");

const CONTENT_A = "a".repeat(64);
const CONTENT_B = "b".repeat(64);
const UNKNOWN = "c".repeat(64);

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

async function createSession({ contentSharing = true, topology = "mesh", lobby = lobbyResponse() } = {}) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    async json() {
      return lobby;
    },
  });
  const session = new LobbySession({
    apiBase: "http://example.test",
    topology,
    contentSharing,
  });
  await session.host(lobby.maxParticipants);
  return { session, socket: FakeWebSocket.instances.at(-1) };
}

function connected(socket, { self = "11111111", host = "11111111", participants = [self] } = {}) {
  socket.message({
    type: "connected",
    participantId: self,
    hostParticipantId: host,
    participants,
  });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function trustedManifest() {
  return {
    protocol: CONTENT_MANIFEST_PROTOCOL,
    game: { id: "seed-game", version: "1.0.0" },
    files: [
      {
        path: "assets/a.bin",
        bytes: 1,
        sha256: CONTENT_A,
        role: "asset",
        chunks: { bytes: 1, sha256: [CONTENT_A] },
      },
      {
        path: "assets/b.bin",
        bytes: 1,
        sha256: CONTENT_B,
        role: "asset",
        chunks: { bytes: 1, sha256: [CONTENT_B] },
      },
      {
        path: "logic/not-p2p.wasm",
        bytes: 1,
        sha256: UNKNOWN,
        role: "logic",
      },
    ],
  };
}

class FakeContentSession extends EventTarget {
  constructor() {
    super();
    this.contentSharing = true;
    this.announcements = [];
  }

  announceSeedContent(contentIds) {
    this.announcements.push([...contentIds]);
  }

  seed(peerId, contentIds) {
    this.dispatchEvent(new CustomEvent("content-seed", { detail: { peerId, contentIds } }));
  }

  disconnect(peerId) {
    this.dispatchEvent(
      new CustomEvent("participant-disconnected", { detail: { participantId: peerId } }),
    );
  }
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
});

test("game and player seeding opt-ins remain separate", async () => {
  const disabled = await createSession({ contentSharing: false });
  connected(disabled.socket, { participants: ["11111111", "22222222"] });
  await flush();
  assert.throws(() => disabled.session.announceSeedContent([CONTENT_A]), /not enabled/);

  const enabled = await createSession({ contentSharing: true });
  connected(enabled.socket, { participants: ["11111111", "22222222"] });
  await flush();
  assert.deepEqual(enabled.session.advertisedSeedContentIds(), []);
  enabled.session.announceSeedContent([CONTENT_A]);
  assert.deepEqual(enabled.session.advertisedSeedContentIds(), [CONTENT_A]);
});

test("seeder advertisements use existing targeted opaque signaling", async () => {
  const { session, socket } = await createSession();
  connected(socket, { participants: ["11111111", "22222222", "33333333"] });
  await flush();
  socket.sent.length = 0;

  session.announceSeedContent([CONTENT_B, CONTENT_A]);
  const advertisements = socket.sent.filter((message) => message.payload?.contentSeed);
  assert.deepEqual(advertisements.map((message) => message.to), ["22222222", "33333333"]);
  assert.deepEqual(advertisements[0].payload.contentSeed, {
    v: 1,
    contentIds: [CONTENT_A, CONTENT_B],
  });

  session.announceSeedContent([]);
  const stopped = socket.sent.at(-1);
  assert.deepEqual(stopped.payload.contentSeed.contentIds, []);
});

test("existing seeders automatically advertise to a participant that joins later", async () => {
  const { session, socket } = await createSession();
  connected(socket, { participants: ["11111111"] });
  await flush();
  session.announceSeedContent([CONTENT_A]);
  socket.sent.length = 0;

  socket.message({ type: "participant-connected", participantId: "22222222" });
  await flush();
  const advertisement = socket.sent.find(
    (message) => message.to === "22222222" && message.payload?.contentSeed,
  );
  assert.ok(advertisement);
  assert.deepEqual(advertisement.payload.contentSeed.contentIds, [CONTENT_A]);
});

test("content discovery works between peers that are not gameplay neighbors", async () => {
  const lobby = lobbyResponse({
    participantId: "22222222",
    participantToken: "b".repeat(64),
    hostParticipantId: "11111111",
  });
  const { session, socket } = await createSession({ topology: "host", lobby });
  connected(socket, {
    self: "22222222",
    host: "11111111",
    participants: ["11111111", "22222222", "33333333"],
  });
  await flush();
  assert.deepEqual(session.peerIds(), ["11111111"]);

  const received = [];
  session.addEventListener("content-seed", (event) => received.push(event.detail));
  socket.message({
    type: "signal",
    from: "33333333",
    payload: { contentSeed: { v: 1, contentIds: [CONTENT_A] } },
  });
  await flush();
  assert.deepEqual(received, [{ peerId: "33333333", contentIds: [CONTENT_A] }]);
  assert.deepEqual(session.peerIds(), ["11111111"]);
});

test("malformed seeder advertisements are ignored", async () => {
  const { session, socket } = await createSession();
  connected(socket, { participants: ["11111111", "22222222"] });
  await flush();
  let received = 0;
  session.addEventListener("content-seed", () => {
    received += 1;
  });

  socket.message({
    type: "signal",
    from: "22222222",
    payload: { contentSeed: { v: 1, contentIds: ["NOT-A-HASH"] } },
  });
  await flush();
  assert.equal(received, 0);
});

test("trusted registry advertises only transferable manifest content", () => {
  const session = new FakeContentSession();
  const discovery = new ContentSeederDiscovery({ session, manifest: trustedManifest() });

  assert.deepEqual(discovery.setSeederEnabled(true), [CONTENT_A, CONTENT_B]);
  assert.deepEqual(session.announcements, [[CONTENT_A, CONTENT_B]]);
  assert.throws(
    () => discovery.setSeederEnabled(true, { paths: ["logic/not-p2p.wasm"] }),
    /not transferable/,
  );
  assert.deepEqual(discovery.setSeederEnabled(false), []);
  assert.deepEqual(session.announcements.at(-1), []);
  discovery.close();
});

test("trusted registry ignores unknown peer content ids and clears disconnected seeders", () => {
  const session = new FakeContentSession();
  const discovery = new ContentSeederDiscovery({ session, manifest: trustedManifest() });

  session.seed("22222222", [CONTENT_A, UNKNOWN]);
  session.seed("33333333", [CONTENT_A, CONTENT_B]);
  assert.deepEqual(discovery.seedersForPath("assets/a.bin"), ["22222222", "33333333"]);
  assert.deepEqual(discovery.seedersForPath("assets/b.bin"), ["33333333"]);
  assert.deepEqual(discovery.seedersForContentId(UNKNOWN), []);

  session.disconnect("33333333");
  assert.deepEqual(discovery.seedersForPath("assets/a.bin"), ["22222222"]);
  assert.deepEqual(discovery.seedersForPath("assets/b.bin"), []);
  discovery.close();
});
