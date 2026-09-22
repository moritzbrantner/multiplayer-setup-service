const COLORS = ["red", "yellow", "green", "blue"];
const VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function assertParticipants(participantIds) {
  if (!Array.isArray(participantIds) || participantIds.length < 2 || participantIds.length > 4) {
    throw new Error("Card game requires between 2 and 4 participants");
  }
  if (participantIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Participant IDs must be non-empty strings");
  }
  if (new Set(participantIds).size !== participantIds.length) {
    throw new Error("Participant IDs must be unique");
  }
}

function nextRandom(seedState) {
  let value = seedState.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  seedState.value = value >>> 0;
  return seedState.value / 0x1_0000_0000;
}

export function createCardDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (const value of VALUES) {
      const copies = value === "0" ? 1 : 2;
      for (let copy = 0; copy < copies; copy += 1) {
        deck.push({ id: `${color}-${value}-${copy}`, color, value });
      }
    }
  }
  return deck;
}

export function shuffleCardDeck(deck, seed) {
  if (!Array.isArray(deck)) throw new Error("Deck must be an array");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("Seed must be an unsigned 32-bit integer");
  }
  const shuffled = deck.map((card) => ({ ...card }));
  const state = { value: seed || 0x9e37_79b9 };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom(state) * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function canPlayCard(card, topCard) {
  return Boolean(
    card &&
    topCard &&
    typeof card.color === "string" &&
    typeof card.value === "string" &&
    (card.color === topCard.color || card.value === topCard.value)
  );
}

export function createCardGame(participantIds, seed) {
  assertParticipants(participantIds);
  const participants = [...participantIds];
  const deck = shuffleCardDeck(createCardDeck(), seed);
  const hands = Object.fromEntries(participants.map((id) => [id, []]));

  for (let round = 0; round < 7; round += 1) {
    for (const participantId of participants) {
      hands[participantId].push(deck.pop());
    }
  }

  const topCard = deck.pop();
  return {
    participants,
    hands,
    deck,
    topCard,
    currentPlayerId: participants[0],
    winnerId: null,
    lastSequences: Object.fromEntries(participants.map((id) => [id, 0])),
    turnNumber: 1,
    lastEvent: `Game started. ${participants[0]} goes first.`,
  };
}

export function validCardIntent(intent) {
  if (!intent || intent.type !== "card-intent") return false;
  if (!Number.isSafeInteger(intent.seq) || intent.seq < 1) return false;
  if (intent.action === "draw") return intent.cardId === undefined;
  return intent.action === "play" && typeof intent.cardId === "string" && intent.cardId.length > 0;
}

function rejection(reason) {
  return { accepted: false, reason };
}

function advanceTurn(state) {
  const currentIndex = state.participants.indexOf(state.currentPlayerId);
  state.currentPlayerId = state.participants[(currentIndex + 1) % state.participants.length];
  state.turnNumber += 1;
}

export function applyCardIntent(state, peerId, intent) {
  if (!state || !state.participants?.includes(peerId)) return rejection("unknown-participant");
  if (!validCardIntent(intent)) return rejection("malformed-intent");

  const previousSequence = state.lastSequences[peerId] ?? 0;
  if (intent.seq <= previousSequence) return rejection("stale-sequence");
  state.lastSequences[peerId] = intent.seq;

  if (state.winnerId) return rejection("game-finished");
  if (state.currentPlayerId !== peerId) return rejection("not-your-turn");

  const hand = state.hands[peerId];
  if (intent.action === "draw") {
    if (state.deck.length === 0) return rejection("deck-empty");
    hand.push(state.deck.pop());
    state.lastEvent = `${peerId} drew a card.`;
    advanceTurn(state);
    return { accepted: true, action: "draw" };
  }

  const cardIndex = hand.findIndex((card) => card.id === intent.cardId);
  if (cardIndex < 0) return rejection("card-not-in-hand");
  const card = hand[cardIndex];
  if (!canPlayCard(card, state.topCard)) return rejection("illegal-card");

  hand.splice(cardIndex, 1);
  state.topCard = card;
  state.lastEvent = `${peerId} played ${card.color} ${card.value}.`;
  if (hand.length === 0) {
    state.winnerId = peerId;
    state.lastEvent = `${peerId} won.`;
  } else {
    advanceTurn(state);
  }
  return { accepted: true, action: "play", card: { ...card } };
}

export function cardViewFor(state, viewerId) {
  if (!state?.participants?.includes(viewerId)) throw new Error("Viewer must be a participant");
  return {
    type: "card-view",
    topCard: { ...state.topCard },
    currentPlayerId: state.currentPlayerId,
    winnerId: state.winnerId,
    turnNumber: state.turnNumber,
    deckCount: state.deck.length,
    hand: state.hands[viewerId].map((card) => ({ ...card })),
    players: state.participants.map((id) => ({ id, handCount: state.hands[id].length })),
    lastEvent: state.lastEvent,
  };
}
