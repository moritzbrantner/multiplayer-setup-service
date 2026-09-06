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

class FakeWebSocket extends EventTarget {
  static OPEN = 1;

  constructor(bus, participantId) {
    super();
    this.bus = bus;
    this.participantId = participantId;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
  }

  send(value) {
    const message = JSON.parse(value);
    this.sent.push(message);
    this.bus.deliver(this.participantId, message);
  }
}

globalThis.WebSocket = FakeWebSocket;

class SignalingBus {
  constructor() {
    this.sockets = new Map();
  }

  socket(participantId) {
    const socket = new FakeWebSocket(this, participantId);
    this.sockets.set(participantId, socket);
    return socket;
  }

  deliver(from, message) {
    const target = this.sockets.get(message.to);
    if (!target) return;
    queueMicrotask(() => {
      const event = new Event("message");
      Object.defineProperty(event, "data", {
        value: JSON.stringify({ type: "signal", from, payload: message.payload }),
      });
      target.dispatchEvent(event);
    });
  }
}

class FakeDataChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = "connecting";
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
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

  constructor(configuration) {
    super();
    this.configuration = configuration;
    this.connectionState = "new";
    this.remoteDescription = null;
    this.localDescription = null;
    this.channels = [];
    this.candidates = [];
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
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

class FakeSession extends EventTarget {
  constructor({ bus, participantId, participants, contentSharing = true, topology = "host" }) {
    super();
    this.participantId = participantId;
    this.participants = new Set(participants);
    this.contentSharing = contentSharing;
    this.topology = topology;
    this.iceServers = [{ urls: "stun:example.test" }];
    this.signaling = bus.socket(participantId);
  }

  disconnectParticipant(participantId) {
    this.participants.delete(participantId);
    this.dispatchEvent(
      new CustomEvent("participant-disconnected", { detail: { participantId } }),
    );
  }
}

const { ContentPeerPool } = await import("../web/content-peer-pool.js");

function makeSessions(ids, { contentSharing = true } = {}) {
  const bus = new SignalingBus();
  const sessions = new Map(
    ids.map((participantId) => [
      participantId,
      new FakeSession({ bus, participantId, participants: ids, contentSharing }),
    ]),
  );
  return { bus, sessions };
}

function makePool(session, options = {}) {
  return new ContentPeerPool({
    session,
    peerConnectionFactory: (configuration) => new FakePeerConnection(configuration),
    ...options,
  });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakePeerConnection.instances = [];
});

test("content peer pool remains unavailable unless the game opted in", () => {
  const { sessions } = makeSessions(["11111111", "22222222"], { contentSharing: false });
  assert.throws(
    () => makePool(sessions.get("11111111")),
    /contentSharing enabled/,
  );
});

test("content-only peers negotiate through targeted lobby signaling", async () => {
  const { sessions } = makeSessions(["11111111", "22222222"]);
  const left = makePool(sessions.get("11111111"));
  const right = makePool(sessions.get("22222222"));

  const connectionId = await left.connect("22222222");
  await flush();

  assert.match(connectionId, /^[0-9a-f]{16}$/);
  assert.deepEqual(left.peerIds(), ["22222222"]);
  assert.deepEqual(right.peerIds(), ["11111111"]);
  assert.equal(left.peers.get("22222222").peer.remoteDescription.type, "answer");
  assert.equal(right.peers.get("11111111").peer.remoteDescription.type, "offer");

  const offerMessage = sessions
    .get("11111111")
    .signaling.sent.find((message) => message.payload?.contentPeer?.description?.type === "offer");
  assert.equal(offerMessage.to, "22222222");
  assert.equal(offerMessage.payload.contentPeer.v, 1);

  left.close();
  right.close();
});

test("content topology is independent from host-spoke gameplay neighbors", async () => {
  const ids = ["11111111", "22222222", "33333333"];
  const { sessions } = makeSessions(ids);
  const guestA = sessions.get("22222222");
  const guestB = sessions.get("33333333");
  guestA.gameplayPeerIds = () => ["11111111"];
  guestB.gameplayPeerIds = () => ["11111111"];

  const left = makePool(guestA);
  const right = makePool(guestB);
  await left.connect("33333333");
  await flush();

  assert.deepEqual(guestA.gameplayPeerIds(), ["11111111"]);
  assert.deepEqual(left.peerIds(), ["33333333"]);
  assert.deepEqual(right.peerIds(), ["22222222"]);

  left.close();
  right.close();
});

test("default peer cap bounds both outgoing and incoming content relationships", async () => {
  const ids = ["11111111", "22222222", "33333333"];
  const { sessions } = makeSessions(ids);
  const first = makePool(sessions.get("11111111"), { maxPeers: 1 });
  const hub = makePool(sessions.get("22222222"), { maxPeers: 1 });
  const second = makePool(sessions.get("33333333"), { maxPeers: 1 });

  await first.connect("22222222");
  await flush();
  assert.deepEqual(hub.peerIds(), ["11111111"]);

  await second.connect("22222222");
  await flush();
  assert.deepEqual(hub.peerIds(), ["11111111"]);
  assert.deepEqual(second.peerIds(), []);
  assert.equal(second.hasCapacity(), true);

  await assert.rejects(() => first.connect("33333333"), /pool is full/);

  first.close();
  hub.close();
  second.close();
});

test("ready content-only channels support backpressured ContentTransfer-compatible sends", async () => {
  const { sessions } = makeSessions(["11111111", "22222222"]);
  const left = makePool(sessions.get("11111111"));
  const right = makePool(sessions.get("22222222"));
  await left.connect("22222222");
  await flush();

  const leftLink = left.peers.get("22222222");
  const rightLink = right.peers.get("11111111");
  const rightChannel = new FakeDataChannel("content-swarm-v1");
  rightLink.peer.emitDataChannel(rightChannel);
  leftLink.peer.connect();
  rightLink.peer.connect();
  leftLink.channel.open();
  rightChannel.open();

  assert.deepEqual(left.contentPeerIds(), ["22222222"]);
  assert.deepEqual(right.contentPeerIds(), ["11111111"]);
  assert.equal(leftLink.channel.binaryType, "arraybuffer");
  assert.equal(rightChannel.binaryType, "arraybuffer");

  leftLink.channel.bufferedAmount = 2_000;
  const pending = left.sendContent("22222222", new Uint8Array([1, 2, 3]), {
    highWaterMark: 1_000,
    lowWaterMark: 250,
  });
  await Promise.resolve();
  assert.equal(leftLink.channel.sent.length, 0);
  leftLink.channel.setBufferedAmount(250);
  await pending;
  assert.equal(leftLink.channel.sent.length, 1);

  left.close();
  right.close();
});

test("participant departure tears down its content-only relationship", async () => {
  const { sessions } = makeSessions(["11111111", "22222222"]);
  const leftSession = sessions.get("11111111");
  const left = makePool(leftSession);
  const right = makePool(sessions.get("22222222"));
  await left.connect("22222222");
  await flush();
  assert.deepEqual(left.peerIds(), ["22222222"]);

  leftSession.disconnectParticipant("22222222");
  assert.deepEqual(left.peerIds(), []);

  left.close();
  right.close();
});
