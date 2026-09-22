import assert from "node:assert/strict";
import test from "node:test";
import {
  applySnapshotEntry,
  applyStepToState,
  hashId,
  initialPlayer,
  isTopologyReady,
  topologyEdgeCount,
  validStep,
} from "../web/arena-model.mjs";

test("hashId and initialPlayer are deterministic", () => {
  const id = "1234ABCD";
  assert.equal(hashId(id), hashId(id));
  assert.deepEqual(initialPlayer(id), initialPlayer(id));
});

test("initial positions stay inside the arena", () => {
  for (const id of ["00000000", "1234ABCD", "ZZZZZZZZ", "ABCDEFGH"]) {
    const player = initialPlayer(id);
    assert.ok(player.x >= 80 && player.x <= 920);
    assert.ok(player.y >= 80 && player.y <= 920);
  }
});

test("validStep accepts exactly one cardinal movement", () => {
  assert.equal(validStep({ type: "step", participantId: "A", seq: 1, dx: 1, dy: 0 }), true);
  assert.equal(validStep({ type: "step", participantId: "A", seq: 1, dx: 0, dy: -1 }), true);
  assert.equal(validStep({ type: "step", participantId: "A", seq: 1, dx: 1, dy: 1 }), false);
  assert.equal(validStep({ type: "step", participantId: "A", seq: 1, dx: 0, dy: 0 }), false);
  assert.equal(validStep({ type: "step", participantId: "A", seq: 1, dx: 2, dy: 0 }), false);
});

test("validStep rejects malformed identity and sequence fields", () => {
  for (const message of [
    null,
    {},
    { type: "move", participantId: "A", seq: 1, dx: 1, dy: 0 },
    { type: "step", participantId: "", seq: 1, dx: 1, dy: 0 },
    { type: "step", participantId: "A", seq: 0, dx: 1, dy: 0 },
    { type: "step", participantId: "A", seq: 1.5, dx: 1, dy: 0 },
  ]) {
    assert.equal(validStep(message), false);
  }
});

test("applyStepToState creates deterministic local state", () => {
  const participants = new Set(["A"]);
  const players = new Map();
  const lastSequence = new Map();
  const start = initialPlayer("A");
  assert.equal(
    applyStepToState({ players, lastSequence, participants }, { type: "step", participantId: "A", seq: 1, dx: 1, dy: 0 }),
    true,
  );
  assert.deepEqual(players.get("A"), { x: start.x + 12, y: start.y });
  assert.equal(lastSequence.get("A"), 1);
});

test("duplicate and out-of-order inputs are idempotently ignored", () => {
  const participants = new Set(["A"]);
  const players = new Map([["A", { x: 100, y: 100 }]]);
  const lastSequence = new Map([["A", 4]]);
  const duplicate = { type: "step", participantId: "A", seq: 4, dx: 1, dy: 0 };
  const stale = { type: "step", participantId: "A", seq: 3, dx: 1, dy: 0 };
  assert.equal(applyStepToState({ players, lastSequence, participants }, duplicate), false);
  assert.equal(applyStepToState({ players, lastSequence, participants }, stale), false);
  assert.deepEqual(players.get("A"), { x: 100, y: 100 });
  assert.equal(lastSequence.get("A"), 4);
});

test("sequence gaps are accepted without inventing missing inputs", () => {
  const participants = new Set(["A"]);
  const players = new Map([["A", { x: 100, y: 100 }]]);
  const lastSequence = new Map([["A", 1]]);
  assert.equal(
    applyStepToState(
      { players, lastSequence, participants },
      { type: "step", participantId: "A", seq: 4, dx: 0, dy: 1 },
    ),
    true,
  );
  assert.deepEqual(players.get("A"), { x: 100, y: 112 });
  assert.equal(lastSequence.get("A"), 4);
});

test("inputs for non-members are rejected", () => {
  const players = new Map();
  const lastSequence = new Map();
  assert.equal(
    applyStepToState(
      { players, lastSequence, participants: new Set(["A"]) },
      { type: "step", participantId: "B", seq: 1, dx: 1, dy: 0 },
    ),
    false,
  );
  assert.equal(players.size, 0);
});

test("movement is clamped to deterministic arena bounds", () => {
  const participants = new Set(["A"]);
  const players = new Map([["A", { x: 978, y: 22 }]]);
  const lastSequence = new Map();
  assert.equal(
    applyStepToState(
      { players, lastSequence, participants },
      { type: "step", participantId: "A", seq: 1, dx: 1, dy: 0 },
    ),
    true,
  );
  assert.equal(
    applyStepToState(
      { players, lastSequence, participants },
      { type: "step", participantId: "A", seq: 2, dx: 0, dy: -1 },
    ),
    true,
  );
  assert.deepEqual(players.get("A"), { x: 980, y: 20 });
});

test("snapshot bootstrap clamps coordinates and records sequence", () => {
  const players = new Map();
  const lastSequence = new Map();
  const participants = new Set(["A"]);
  assert.equal(
    applySnapshotEntry(
      { players, lastSequence, participants },
      { id: "A", x: -100, y: 5000, seq: 7 },
    ),
    true,
  );
  assert.deepEqual(players.get("A"), { x: 20, y: 980 });
  assert.equal(lastSequence.get("A"), 7);
});

test("stale snapshots cannot roll deterministic state backwards", () => {
  const players = new Map([["A", { x: 500, y: 500 }]]);
  const lastSequence = new Map([["A", 8]]);
  const participants = new Set(["A"]);
  assert.equal(
    applySnapshotEntry(
      { players, lastSequence, participants },
      { id: "A", x: 100, y: 100, seq: 7 },
    ),
    false,
  );
  assert.deepEqual(players.get("A"), { x: 500, y: 500 });
  assert.equal(lastSequence.get("A"), 8);
});

test("snapshots cannot introduce participants outside the roster", () => {
  const players = new Map();
  const lastSequence = new Map();
  assert.equal(
    applySnapshotEntry(
      { players, lastSequence, participants: new Set(["A"]) },
      { id: "B", x: 100, y: 100, seq: 0 },
    ),
    false,
  );
  assert.equal(players.size, 0);
});

test("topology edge counts cover 2, 4, 8, and 16 players", () => {
  assert.deepEqual(
    [2, 4, 8, 16].map((count) => topologyEdgeCount("mesh", count)),
    [1, 6, 28, 120],
  );
  assert.deepEqual(
    [2, 4, 8, 16].map((count) => topologyEdgeCount("host", count)),
    [1, 3, 7, 15],
  );
});

test("topologyEdgeCount rejects invalid topology and participant counts", () => {
  assert.throws(() => topologyEdgeCount("ring", 4));
  assert.throws(() => topologyEdgeCount("mesh", -1));
  assert.throws(() => topologyEdgeCount("mesh", 1.5));
});

test("mesh readiness requires every other participant", () => {
  assert.equal(
    isTopologyReady({
      topology: "mesh",
      participantId: "A",
      hostParticipantId: "A",
      participantCount: 4,
      readyPeerIds: ["B", "C"],
    }),
    false,
  );
  assert.equal(
    isTopologyReady({
      topology: "mesh",
      participantId: "A",
      hostParticipantId: "A",
      participantCount: 4,
      readyPeerIds: ["B", "C", "D"],
    }),
    true,
  );
});

test("host-spoke readiness differs for host and guests", () => {
  assert.equal(
    isTopologyReady({
      topology: "host",
      participantId: "HOST",
      hostParticipantId: "HOST",
      participantCount: 4,
      readyPeerIds: ["A", "B", "C"],
    }),
    true,
  );
  assert.equal(
    isTopologyReady({
      topology: "host",
      participantId: "A",
      hostParticipantId: "HOST",
      participantCount: 4,
      readyPeerIds: ["HOST"],
    }),
    true,
  );
  assert.equal(
    isTopologyReady({
      topology: "host",
      participantId: "A",
      hostParticipantId: "HOST",
      participantCount: 4,
      readyPeerIds: ["B"],
    }),
    false,
  );
});
