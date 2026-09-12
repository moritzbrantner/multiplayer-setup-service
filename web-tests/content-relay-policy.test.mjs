import assert from "node:assert/strict";
import { test } from "node:test";

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

  constructor() {
    super();
    this.readyState = FakeWebSocket.OPEN;
  }

  send() {}
}

globalThis.WebSocket = FakeWebSocket;

const { ContentPeerPool, selectedIcePath } = await import("../web/content-peer-pool.js");

class FakeSession extends EventTarget {
  constructor() {
    super();
    this.contentSharing = true;
    this.participantId = "11111111";
    this.participants = new Set(["11111111", "22222222"]);
    this.iceServers = [];
    this.signaling = new FakeWebSocket();
  }
}

class FakeChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = "open";
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function statsFor(candidateType) {
  return new Map([
    ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
    ],
    ["local", { id: "local", type: "local-candidate", candidateType }],
    ["remote", { id: "remote", type: "remote-candidate", candidateType: "host" }],
  ]);
}

function readyPool({ relayPolicy = "deny", relayMaxBytesPerSecond = 256 * 1024, now, sleep } = {}) {
  const pool = new ContentPeerPool({
    session: new FakeSession(),
    relayPolicy,
    relayMaxBytesPerSecond,
    ...(now ? { now } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const peer = {
    connectionState: "connected",
    async getStats() {
      return statsFor("relay");
    },
    close() {
      this.connectionState = "closed";
    },
  };
  const channel = new FakeChannel();
  pool.peers.set("22222222", {
    peerId: "22222222",
    connectionId: "0123456789abcdef",
    peer,
    channel,
    pendingCandidates: [],
    readyEmitted: true,
    nextRelaySendAt: 0,
  });
  return { pool, peer, channel };
}

test("selected ICE path distinguishes relay, direct, and unavailable stats", async () => {
  assert.equal(
    await selectedIcePath({ async getStats() { return statsFor("relay"); } }),
    "relay",
  );
  assert.equal(
    await selectedIcePath({ async getStats() { return statsFor("host"); } }),
    "direct",
  );
  assert.equal(await selectedIcePath({}), "unknown");
  assert.equal(
    await selectedIcePath({ async getStats() { throw new Error("stats unavailable"); } }),
    "unknown",
  );
});

test("bulk content over a detected TURN relay is denied by default", async () => {
  const { pool, channel } = readyPool();
  const policyEvents = [];
  pool.addEventListener("relay-policy", (event) => policyEvents.push(event.detail));

  await assert.rejects(
    () => pool.sendContent("22222222", new Uint8Array([1, 2, 3])),
    /TURN relay is disabled/,
  );
  assert.equal(channel.sent.length, 0);
  assert.equal(policyEvents.length, 1);
  assert.equal(policyEvents[0].action, "denied");
  pool.close();
});

test("a game can explicitly allow relayed bulk content", async () => {
  const { pool, channel } = readyPool({ relayPolicy: "allow" });
  await pool.sendContent("22222222", new Uint8Array([1, 2, 3]));
  assert.equal(channel.sent.length, 1);
  pool.close();
});

test("relay limit reserves deterministic bandwidth slots for sequential sends", async () => {
  const delays = [];
  const { pool, channel } = readyPool({
    relayPolicy: "limit",
    relayMaxBytesPerSecond: 4,
    now: () => 0,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  await pool.sendContent("22222222", new Uint8Array(4));
  await pool.sendContent("22222222", new Uint8Array(4));

  assert.equal(channel.sent.length, 2);
  assert.deepEqual(delays, [1000]);
  pool.close();
});

test("relay policy options fail closed on invalid configuration", () => {
  assert.throws(
    () => new ContentPeerPool({ session: new FakeSession(), relayPolicy: "sometimes" }),
    /relayPolicy must be/,
  );
  assert.throws(
    () => new ContentPeerPool({ session: new FakeSession(), relayPolicy: "limit", relayMaxBytesPerSecond: 0 }),
    /relayMaxBytesPerSecond must be/,
  );
});
