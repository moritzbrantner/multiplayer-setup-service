import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCardIntent,
  canPlayCard,
  cardViewFor,
  createCardDeck,
  createCardGame,
  shuffleCardDeck,
  validCardIntent,
} from "../web/card-game-model.mjs";

test("card deck has stable unique identities", () => {
  const deck = createCardDeck();
  assert.equal(deck.length, 76);
  assert.equal(new Set(deck.map((card) => card.id)).size, deck.length);
});

test("seeded shuffle is deterministic", () => {
  const deck = createCardDeck();
  assert.deepEqual(shuffleCardDeck(deck, 42), shuffleCardDeck(deck, 42));
  assert.notDeepEqual(shuffleCardDeck(deck, 42), shuffleCardDeck(deck, 43));
});

test("play legality matches color or value", () => {
  const top = { color: "red", value: "4" };
  assert.equal(canPlayCard({ color: "red", value: "8" }, top), true);
  assert.equal(canPlayCard({ color: "blue", value: "4" }, top), true);
  assert.equal(canPlayCard({ color: "blue", value: "8" }, top), false);
});

test("intent shape rejects malformed messages", () => {
  assert.equal(validCardIntent({ type: "card-intent", action: "draw", seq: 1 }), true);
  assert.equal(validCardIntent({ type: "card-intent", action: "play", cardId: "red-1-0", seq: 2 }), true);
  assert.equal(validCardIntent({ type: "card-intent", action: "play", cardId: "", seq: 2 }), false);
  assert.equal(validCardIntent({ type: "card-intent", action: "draw", seq: 0 }), false);
  assert.equal(validCardIntent({ type: "card-view", action: "draw", seq: 1 }), false);
});

test("views expose only the viewer hand and public hand counts", () => {
  const state = createCardGame(["A", "B", "C", "D"], 7);
  const view = cardViewFor(state, "B");
  assert.deepEqual(view.hand, state.hands.B);
  assert.equal(view.players.length, 4);
  assert.equal(view.players.find((player) => player.id === "A").handCount, 7);
  assert.equal("hands" in view, false);
  assert.equal(JSON.stringify(view).includes(state.hands.A[0].id), false);
});

test("host validation rejects forged cards without changing the hand", () => {
  const state = createCardGame(["A", "B"], 9);
  const before = state.hands.A.map((card) => card.id);
  const result = applyCardIntent(state, "A", {
    type: "card-intent",
    action: "play",
    cardId: "forged-card",
    seq: 1,
  });
  assert.deepEqual(result, { accepted: false, reason: "card-not-in-hand" });
  assert.deepEqual(state.hands.A.map((card) => card.id), before);
});

test("host validation rejects out-of-turn actions", () => {
  const state = createCardGame(["A", "B"], 11);
  const result = applyCardIntent(state, "B", { type: "card-intent", action: "draw", seq: 1 });
  assert.deepEqual(result, { accepted: false, reason: "not-your-turn" });
  assert.equal(state.currentPlayerId, "A");
});

test("replayed intents are idempotently rejected", () => {
  const state = createCardGame(["A", "B"], 12);
  const first = applyCardIntent(state, "A", { type: "card-intent", action: "draw", seq: 1 });
  assert.equal(first.accepted, true);
  const replay = applyCardIntent(state, "A", { type: "card-intent", action: "draw", seq: 1 });
  assert.deepEqual(replay, { accepted: false, reason: "stale-sequence" });
});

test("illegal color/value plays are rejected", () => {
  const state = createCardGame(["A", "B"], 17);
  const illegal = state.hands.A.find((card) => !canPlayCard(card, state.topCard));
  assert.ok(illegal, "test seed should produce an illegal card");
  const result = applyCardIntent(state, "A", {
    type: "card-intent",
    action: "play",
    cardId: illegal.id,
    seq: 1,
  });
  assert.deepEqual(result, { accepted: false, reason: "illegal-card" });
});

test("accepted draw advances turn and preserves hidden information", () => {
  const state = createCardGame(["A", "B", "C", "D"], 21);
  const before = state.hands.A.length;
  const result = applyCardIntent(state, "A", { type: "card-intent", action: "draw", seq: 1 });
  assert.deepEqual(result, { accepted: true, action: "draw" });
  assert.equal(state.hands.A.length, before + 1);
  assert.equal(state.currentPlayerId, "B");
  assert.equal(cardViewFor(state, "C").players.find((player) => player.id === "A").handCount, before + 1);
});
