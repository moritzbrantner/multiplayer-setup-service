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

const { ContentPeerPool } = await import("../web/content-peer-pool.js");

class FakeSignaling extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
  }

  send() {}
}

class FakeSession extends EventTarget {
  constructor() {
    super();
    this.contentSharing = true;
    this.participantId = "11111111";
    this.participants = new Set(["11111111", "22222222"]);
    this.iceServers = [];
    this.signaling = new FakeSignaling();
  }
}

class BackpressuredChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = "open";
    this.bufferedAmount = 2_000;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  drain(value = 0) {
    const previous = this.bufferedAmount;
    this.bufferedAmount = value;
    if (previous > this.bufferedAmountLowThreshold && value <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }
}

function makeBackpressuredPool() {
  const session = new FakeSession();
  const pool = new ContentPeerPool({
    session,
    peerConnectionFactory: () => {
      throw new Error("peer factory should not be needed by this regression test");
    },
  });
  const channel = new BackpressuredChannel();
  const peer = {
    connectionState: "connected",
    async getStats() {
      return new Map();
    },
    close() {
      this.connectionState = "closed";
    },
  };
  pool.peers.set("22222222", {
    peerId: "22222222",
    connectionId: "0000000000000001",
    initiatedLocally: true,
    peer,
    channel,
    pendingCandidates: [],
    readyEmitted: true,
    nextRelaySendAt: 0,
  });
  return { pool, channel };
}

const sendOptions = { highWaterMark: 1_000, lowWaterMark: 250 };

test("backpressured sends count against the pending-send limit before channel drain", async () => {
  const { pool, channel } = makeBackpressuredPool();
  pool.uploadBudget.maxPendingSends = 1;
  pool.uploadBudget.maxPendingBytes = 16;

  const first = pool.sendContent("22222222", new Uint8Array([1, 2, 3, 4]), sendOptions);
  assert.equal(pool.uploadBudget.pendingSends, 1);
  assert.equal(pool.uploadBudget.pendingBytes, 4);
  await assert.rejects(
    pool.sendContent("22222222", new Uint8Array([5]), sendOptions),
    /waiting budget/,
  );

  const cancelled = assert.rejects(first, /cancelled or paused/);
  pool.uploadBudget.setPaused(true);
  await cancelled;
  assert.equal(pool.uploadBudget.pendingSends, 0);
  assert.equal(pool.uploadBudget.pendingBytes, 0);
  assert.equal(channel.sent.length, 0);
  pool.close();
});

test("backpressured sends count retained payload bytes and recover after pause", async () => {
  const { pool, channel } = makeBackpressuredPool();
  pool.uploadBudget.maxPendingSends = 4;
  pool.uploadBudget.maxPendingBytes = 4;

  const first = pool.sendContent("22222222", new Uint8Array([1, 2, 3, 4]), sendOptions);
  await assert.rejects(
    pool.sendContent("22222222", new Uint8Array([5]), sendOptions),
    /waiting budget/,
  );

  const cancelled = assert.rejects(first, /cancelled or paused/);
  pool.uploadBudget.setPaused(true);
  await cancelled;
  pool.uploadBudget.setPaused(false);
  channel.drain(0);

  await pool.sendContent("22222222", new Uint8Array([9]), sendOptions);
  assert.equal(channel.sent.length, 1);
  assert.deepEqual([...channel.sent[0]], [9]);
  assert.equal(pool.uploadBudget.pendingSends, 0);
  assert.equal(pool.uploadBudget.pendingBytes, 0);
  pool.close();
});
