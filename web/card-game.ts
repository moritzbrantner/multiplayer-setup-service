import type { Card, CardGameState, CardView, CardIntent } from "./card-game-model.ts";
import { isRecord, errorMessage } from "./events.ts";
import { requiredElement } from "./dom.ts";
import { GameCommands } from "./game-commands.ts";
import { LobbyExperience, readInviteJoin } from "./lobby-experience.ts";
import { DemoLobbySession as LobbySession } from "./demo-session.ts";
import {
  applyCardIntent,
  canPlayCard,
  cardViewFor,
  createCardGame,
} from "./card-game-model.ts";

function validCard(value: unknown): value is Card {
  return isRecord(value) && typeof value.id === "string" && typeof value.color === "string" && typeof value.value === "string";
}
function validCardView(value: unknown): value is CardView {
  return isRecord(value) && value.type === "card-view" && validCard(value.topCard)
    && typeof value.currentPlayerId === "string" && (value.winnerId === null || typeof value.winnerId === "string")
    && typeof value.turnNumber === "number" && typeof value.deckCount === "number" && typeof value.lastEvent === "string"
    && Array.isArray(value.hand) && value.hand.every(validCard)
    && Array.isArray(value.players) && value.players.every((player: unknown) => isRecord(player) && typeof player.id === "string" && typeof player.handCount === "number");
}
const CARD_INTENT_COMMAND = "card.intent";
const params = new URLSearchParams(window.location.search);
const apiBase = params.get("api") || "http://127.0.0.1:8787";
const inviteJoin = readInviteJoin({ search: window.location.search, codeParam: "lobby" });
const hostButton = requiredElement("#host", HTMLButtonElement);
const joinButton = requiredElement("#join", HTMLButtonElement);
const codeInput = requiredElement("#code", HTMLInputElement);
const startButton = requiredElement("#start", HTMLButtonElement);
const status = requiredElement("#status", HTMLElement);
const lobbyState = requiredElement("#lobby-state", HTMLElement);
const game = requiredElement("#game", HTMLElement);
const topCard = requiredElement("#top-card", HTMLElement);
const turn = requiredElement("#turn", HTMLElement);
const players = requiredElement("#players", HTMLElement);
const hand = requiredElement("#hand", HTMLElement);
const drawButton = requiredElement("#draw", HTMLButtonElement);
const gameEvent = requiredElement("#game-event", HTMLElement);
const forgeButton = requiredElement("#forge-card", HTMLButtonElement);
const replayButton = requiredElement("#replay-intent", HTMLButtonElement);
const securityResult = requiredElement("#security-result", HTMLElement);

if (inviteJoin.code) codeInput.value = inviteJoin.code;

let session: LobbySession | null = null;
let commands: GameCommands | null = null;
let lobbyExperience: LobbyExperience | null = null;
let authoritativeState: CardGameState | null = null;
let currentView: CardView | null = null;
let localSequence = 0;
let lastIntent: CardIntent | null = null;

function shortId(id: string | null) {
  return id ? id.slice(0, 8) : "—";
}

function cardLabel(card: Card) {
  return `${card.color} ${card.value}`;
}

function seed32() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0]!;
}

function setSecurityResult(message: string, state = "neutral") {
  securityResult.textContent = message;
  securityResult.dataset.state = state;
}

function rejectionCopy(reason: string) {
  const messages: Record<string, string> = {
    "unknown-participant": "Rejected: sender is not in this lobby.",
    "malformed-intent": "Rejected: malformed card intent.",
    "stale-sequence": "Rejected: duplicate or replayed sequence number.",
    "game-not-started": "Rejected: the host has not started the game.",
    "game-finished": "Rejected: the game has already finished.",
    "not-your-turn": "Rejected: it is not that player's turn.",
    "deck-empty": "Rejected: the draw pile is empty.",
    "card-not-in-hand": "Rejected: the sender does not own that card.",
    "illegal-card": "Rejected: that card does not match the top color or value.",
  };
  return messages[reason] ?? `Rejected: ${reason}.`;
}

function participantOrder() {
  if (!session) return [];
  const others = [...session.participants]
    .filter((id) => id !== session?.hostParticipantId)
    .sort();
  return session.hostParticipantId ? [session.hostParticipantId, ...others] : others;
}

function lobbyReadyForStart() {
  if (!session || session.participantId !== session.hostParticipantId) return false;
  const count = session.participants.size;
  return count >= 2 && count <= 4 && session.readyPeerIds().length === count - 1;
}

function renderLobbyState() {
  if (!session) {
    lobbyState.textContent = "No lobby yet.";
    startButton.disabled = true;
    return;
  }
  const count = session.participants.size;
  lobbyState.textContent = `${count}/4 players in lobby · ${session.readyPeerIds().length} ready peer link${session.readyPeerIds().length === 1 ? "" : "s"}.`;
  startButton.disabled = !lobbyReadyForStart() || Boolean(authoritativeState);
}

function renderView(view: CardView) {
  if (!session) return;
  currentView = view;
  game.classList.remove("hidden");
  topCard.textContent = cardLabel(view.topCard);
  topCard.dataset.color = view.topCard.color;
  turn.textContent = view.winnerId
    ? `${shortId(view.winnerId)} won`
    : view.currentPlayerId === session.participantId
      ? "Your turn"
      : `${shortId(view.currentPlayerId)}'s turn`;
  gameEvent.textContent = view.lastEvent;

  players.replaceChildren();
  for (const player of view.players) {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = player.id === session.participantId ? "You" : shortId(player.id);
    const count = document.createElement("span");
    count.textContent = `${player.handCount} card${player.handCount === 1 ? "" : "s"}`;
    item.append(name, count);
    if (player.id === view.currentPlayerId && !view.winnerId) item.dataset.turn = "true";
    players.append(item);
  }

  hand.replaceChildren();
  const canAct = !view.winnerId && view.currentPlayerId === session.participantId;
  for (const card of view.hand) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "playing-card";
    button.dataset.color = card.color;
    button.textContent = card.value;
    const legal = canPlayCard(card, view.topCard);
    button.disabled = !canAct || !legal;
    button.title = legal ? `Play ${cardLabel(card)}` : `${cardLabel(card)} does not match`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => sendIntent("play", card.id));
    hand.append(button);
  }

  drawButton.disabled = !canAct;
  forgeButton.disabled = !session || !currentView;
  replayButton.disabled = !lastIntent || !session || !currentView;
}

function deliverView(peerId: string) {
  if (!session || !authoritativeState) return;
  const view = cardViewFor(authoritativeState, peerId);
  if (peerId === session.participantId) renderView(view);
  else if (session.readyPeerIds().includes(peerId)) session.sendReliable(peerId, view);
}

function publishViews() {
  if (!authoritativeState) return;
  for (const participantId of authoritativeState.participants) deliverView(participantId);
}

function sendRejection(peerId: string, reason: string) {
  if (!session) return;
  const copy = rejectionCopy(reason);
  if (peerId === session.participantId) setSecurityResult(copy, "rejected");
  else if (session.readyPeerIds().includes(peerId)) {
    session.sendReliable(peerId, { type: "card-rejection", reason });
  }
  status.textContent = `Host validation ${copy.toLowerCase()}`;
}

function handleHostIntent(peerId: string, intent: unknown) {
  if (!authoritativeState) {
    sendRejection(peerId, "game-not-started");
    return;
  }
  const result = applyCardIntent(authoritativeState, peerId, intent);
  if (!result.accepted) {
    sendRejection(peerId, result.reason);
    return;
  }
  setSecurityResult("Accepted: the host validated the intent against authoritative game state.", "accepted");
  publishViews();
}

function transmitIntent(intent: CardIntent, { remember = true } = {}) {
  if (!session?.participantId || !session.hostParticipantId || !commands || !currentView) return;
  if (remember) lastIntent = structuredClone(intent);
  replayButton.disabled = !lastIntent;
  if (session.participantId === session.hostParticipantId) {
    handleHostIntent(session.participantId, intent);
  } else if (session.readyPeerIds().includes(session.hostParticipantId)) {
    commands.sendToHost(CARD_INTENT_COMMAND, intent);
  } else {
    status.textContent = "Host peer link is not ready.";
  }
}

function sendIntent(action: "play" | "draw", cardId?: string) {
  if (action === "play" && !cardId) return;
  localSequence += 1;
  transmitIntent(action === "play" && cardId
    ? { type: "card-intent", action, cardId, seq: localSequence }
    : { type: "card-intent", action: "draw", seq: localSequence });
}

function wireSession(current: LobbySession, currentCommands: GameCommands) {
  currentCommands.handle(CARD_INTENT_COMMAND, (intent, { peerId }) => {
    if (current !== session || currentCommands !== commands) return;
    if (current.participantId !== current.hostParticipantId) return;
    handleHostIntent(peerId, intent);
  });
  currentCommands.addEventListener("error", (event) => {
    if (current !== session || currentCommands !== commands) return;
    status.textContent = errorMessage(event.detail.error);
  });

  current.addEventListener("lobby", () => {
    codeInput.value = current.displayCode ?? "";
    status.textContent = `Lobby ${current.displayCode} created/joined. Waiting for players…`;
    hostButton.disabled = true;
    joinButton.disabled = true;
    codeInput.disabled = true;
    renderLobbyState();
  });
  current.addEventListener("roster", () => {
    if (authoritativeState) status.textContent = "Roster changed after game start; restart the lobby for a clean card game.";
    renderLobbyState();
  });
  current.addEventListener("participant-connected", renderLobbyState);
  current.addEventListener("participant-disconnected", () => {
    renderLobbyState();
    if (authoritativeState) status.textContent = "A player disconnected. This showcase keeps the game paused until a new lobby is started.";
  });
  current.addEventListener("peer-ready", () => {
    status.textContent = `Peer link ready. ${current.participants.size}/4 players currently joined.`;
    renderLobbyState();
  });
  current.addEventListener("peer-statechange", renderLobbyState);
  current.addEventListener("reliable", (event) => {
    if (current.participantId === current.hostParticipantId) return;
    const { peerId, data } = event.detail;
    if (peerId !== current.hostParticipantId) return;
    if (validCardView(data)) {
      renderView(data);
      status.textContent = data.winnerId ? `Game finished: ${shortId(data.winnerId)} won.` : "Authoritative host view received.";
    } else if (isRecord(data) && data.type === "card-rejection" && typeof data.reason === "string") {
      setSecurityResult(rejectionCopy(data.reason), "rejected");
    }
  });
  current.addEventListener("error", (event) => {
    status.textContent = errorMessage(event.detail.error);
  });
}

function createSession() {
  lobbyExperience?.close();
  lobbyExperience = null;
  commands?.close();
  commands = null;
  session?.close();
  authoritativeState = null;
  currentView = null;
  localSequence = 0;
  lastIntent = null;
  session = new LobbySession({ apiBase, topology: "host" });
  lobbyExperience = new LobbyExperience({
    session,
    root: document,
    codeParam: "lobby",
    inviteTitle: "Join my color-match card game",
  });
  commands = new GameCommands({ session });
  wireSession(session, commands);
  return session;
}

hostButton.addEventListener("click", async () => {
  status.textContent = "Creating four-player lobby…";
  try {
    await createSession().host(4);
  } catch (error) {
    status.textContent = errorMessage(error);
  }
});

joinButton.addEventListener("click", async () => {
  status.textContent = "Joining lobby…";
  try {
    await createSession().join(codeInput.value);
  } catch (error) {
    status.textContent = errorMessage(error);
  }
});

startButton.addEventListener("click", () => {
  if (!lobbyReadyForStart()) return;
  const ids = participantOrder();
  authoritativeState = createCardGame(ids, seed32());
  status.textContent = `Game started with ${ids.length} players. The host owns hidden deck/hand state.`;
  publishViews();
  renderLobbyState();
});

drawButton.addEventListener("click", () => sendIntent("draw"));
forgeButton.addEventListener("click", () => {
  localSequence += 1;
  setSecurityResult("Sending a deliberately forged card ID to the host…", "neutral");
  transmitIntent({
    type: "card-intent",
    action: "play",
    cardId: "forged-card-not-in-hand",
    seq: localSequence,
  });
});
replayButton.addEventListener("click", () => {
  if (!lastIntent) return;
  setSecurityResult(`Replaying sequence ${lastIntent.seq} without changing it…`, "neutral");
  transmitIntent(structuredClone(lastIntent), { remember: false });
});

window.addEventListener("beforeunload", () => {
  lobbyExperience?.close();
  commands?.close();
  session?.close();
});
renderLobbyState();
if (inviteJoin.autoJoin) queueMicrotask(() => joinButton.click());
