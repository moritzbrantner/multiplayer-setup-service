import assert from "node:assert/strict";
import test from "node:test";
import { mayAcceptPongScore, movePaddleToward, validPongScoreMessage } from "../web/pong-model.mjs";

test("guest paddle movement is speed-limited on the authoritative host", () => {
  assert.equal(movePaddleToward(100, 400, 0.1, 330, 46, 404), 133);
  assert.equal(movePaddleToward(390, 9999, 0.1, 330, 46, 404), 404);
});

test("score messages require finite non-negative safe integers", () => {
  assert.equal(validPongScoreMessage({ kind: "pong-score", hostScore: 2, guestScore: 3 }), true);
  assert.equal(validPongScoreMessage({ kind: "pong-score", hostScore: -1, guestScore: 3 }), false);
  assert.equal(validPongScoreMessage({ kind: "pong-score", hostScore: 2.5, guestScore: 3 }), false);
});

test("only the guest accepts host score publications", () => {
  const score = { kind: "pong-score", hostScore: 9, guestScore: 4 };
  assert.equal(mayAcceptPongScore("guest", score), true);
  assert.equal(mayAcceptPongScore("host", score), false);
});
