import type { Position } from "./arena-model.ts";
import { isRecord, errorMessage } from "./events.ts";
import { requiredElement } from "./dom.ts";
import { LobbyExperience, readInviteJoin } from "./lobby-experience.ts";
import { DemoLobbySession as LobbySession } from "./demo-session.ts";
import {
  applySnapshotEntry,
  applyStepToState,
  hashId,
  initialPlayer,
  isTopologyReady,
  topologyEdgeCount,
  validStep,
} from "./arena-model.ts";

const params = new URLSearchParams(window.location.search);
const apiBase = params.get("api") || "http://127.0.0.1:8787";
const inviteJoin = readInviteJoin({ search: window.location.search, codeParam: "lobby" });
const topologySelect = requiredElement("#topology", HTMLSelectElement);
const maxParticipantsSelect = requiredElement("#max-participants", HTMLSelectElement);
const hostButton = requiredElement("#host", HTMLButtonElement);
const joinButton = requiredElement("#join", HTMLButtonElement);
const codeInput = requiredElement("#code", HTMLInputElement);
const status = requiredElement("#status", HTMLElement);
const game = requiredElement("#game", HTMLElement);
const arena = requiredElement("#arena", HTMLElement);
const selfId = requiredElement("#self-id", HTMLElement);
const participantCount = requiredElement("#participant-count", HTMLElement);
const peerCount = requiredElement("#peer-count", HTMLElement);
const edgeCount = requiredElement("#edge-count", HTMLElement);

const queryTopology = params.get("topology");
if (inviteJoin.code) codeInput.value = inviteJoin.code;
if (queryTopology === "mesh" || queryTopology === "host") topologySelect.value = queryTopology;

let session: LobbySession | null = null;
let lobbyExperience: LobbyExperience | null = null;
let localSequence = 0;
const players = new Map<string, Position>();
const lastSequence = new Map<string, number>();
const heldKeys = new Set<string>();

function ensurePlayer(id: string) {
  if (!players.has(id)) {
    players.set(id, initialPlayer(id));
    lastSequence.set(id, 0);
  }
  return players.get(id)!;
}

function render() {
  const participantIds = [...session?.participants ?? []].sort();
  const existing = new Map(
    [...arena.querySelectorAll<HTMLElement>(".arena-player")].map((node) => [node.dataset.id, node]),
  );

  for (const id of participantIds) {
    const player = ensurePlayer(id);
    let node = existing.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "arena-player";
      node.dataset.id = id;
      node.dataset.self = String(id === session?.participantId);
      node.style.background = `hsl(${hashId(id) % 360} 72% 52%)`;
      const label = document.createElement("span");
      label.textContent = id;
      node.append(label);
      arena.append(node);
    }
    node.style.left = `${player.x / 10}%`;
    node.style.top = `${player.y / 10}%`;
    existing.delete(id);
  }

  for (const node of existing.values()) node.remove();

  const count = participantIds.length || 1;
  participantCount.textContent = String(count);
  peerCount.textContent = String(session?.readyPeerIds().length ?? 0);
  edgeCount.textContent = String(topologyEdgeCount(topologySelect.value, count));
}

function applyStep(message: unknown) {
  if (!session) return false;
  const applied = applyStepToState({
    players,
    lastSequence,
    participants: session.participants,
  }, message);
  if (applied) render();
  return applied;
}

function topologyReady() {
  if (!session?.participantId || !session.hostParticipantId) return false;
  return isTopologyReady({
    topology: session.topology,
    participantId: session.participantId,
    hostParticipantId: session.hostParticipantId,
    participantCount: session.participants.size,
    readyPeerIds: session.readyPeerIds(),
  });
}

function sendLocalStep(dx: number, dy: number) {
  if (!session?.participantId || !session.hostParticipantId || game.classList.contains("hidden")) return;
  if (!topologyReady()) {
    status.textContent = "Waiting for the required peer links before sending input…";
    return;
  }

  localSequence += 1;
  const message = {
    type: "step",
    participantId: session.participantId,
    seq: localSequence,
    dx,
    dy,
  };
  applyStep(message);

  if (session.topology === "mesh" || session.participantId === session.hostParticipantId) {
    session.broadcastReliable(message);
  } else if (session.readyPeerIds().includes(session.hostParticipantId)) {
    session.sendReliable(session.hostParticipantId, message);
  }
}

function receiveReliable(peerId: string, message: unknown) {
  if (!session || !isRecord(message)) return;
  if (message?.type === "snapshot") {
    if (peerId !== session.hostParticipantId || !Array.isArray(message.players)) return;
    let changed = false;
    for (const snapshot of message.players) {
      changed =
        applySnapshotEntry(
          {
            players,
            lastSequence,
            participants: session.participants,
          },
          snapshot,
        ) || changed;
    }
    if (changed) render();
    return;
  }

  if (!validStep(message)) return;

  if (session.topology === "mesh") {
    if (message.participantId !== peerId) return;
    applyStep(message);
    return;
  }

  const isHost = session.participantId === session.hostParticipantId;
  if (isHost) {
    if (message.participantId !== peerId || !applyStep(message)) return;
    session.broadcastReliable(message, { exclude: [peerId] });
  } else if (peerId === session.hostParticipantId) {
    applyStep(message);
  }
}

function sendSnapshot(peerId: string) {
  if (!session) return;
  if (session.participantId !== session.hostParticipantId) return;
  const snapshot = {
    type: "snapshot",
    players: [...session.participants].sort().map((id) => {
      const player = ensurePlayer(id);
      return { id, x: player.x, y: player.y, seq: lastSequence.get(id) ?? 0 };
    }),
  };
  session.sendReliable(peerId, snapshot);
}

function directionFromHeldKeys() {
  let dx = 0;
  let dy = 0;
  if (heldKeys.has("a") || heldKeys.has("arrowleft")) dx -= 1;
  if (heldKeys.has("d") || heldKeys.has("arrowright")) dx += 1;
  if (heldKeys.has("w") || heldKeys.has("arrowup")) dy -= 1;
  if (heldKeys.has("s") || heldKeys.has("arrowdown")) dy += 1;
  if (dx !== 0 && dy !== 0) dy = 0;
  return { dx, dy };
}

function setConnectedUi() {
  if (!session) return;
  game.classList.remove("hidden");
  selfId.textContent = session.participantId;
  topologySelect.disabled = true;
  maxParticipantsSelect.disabled = true;
  hostButton.disabled = true;
  joinButton.disabled = true;
  codeInput.disabled = true;
  render();
}

function wireSession(current: LobbySession) {
  current.addEventListener("lobby", () => {
    status.textContent = `Lobby ${current.displayCode}; connecting peers…`;
    codeInput.value = current.displayCode ?? "";
    setConnectedUi();
  });
  current.addEventListener("roster", (event) => {
    for (const id of event.detail.participants) ensurePlayer(id);
    render();
  });
  current.addEventListener("participant-connected", () => render());
  current.addEventListener("peer-ready", (event) => {
    status.textContent = `Peer-to-peer links ready: ${current.readyPeerIds().length}`;
    if (current.participantId === current.hostParticipantId) sendSnapshot(event.detail.peerId);
    render();
  });
  current.addEventListener("peer-statechange", () => render());
  current.addEventListener("reliable", (event) => {
    receiveReliable(event.detail.peerId, event.detail.data);
  });
  current.addEventListener("error", (event) => {
    status.textContent = errorMessage(event.detail.error);
  });
}

function createSession() {
  lobbyExperience?.close();
  lobbyExperience = null;
  session?.close();
  session = new LobbySession({ apiBase, topology: topologySelect.value === "host" ? "host" : "mesh" });
  lobbyExperience = new LobbyExperience({
    session,
    root: document,
    codeParam: "lobby",
    inviteTitle: "Join my multiplayer arena",
    inviteExtras: () => ({ topology: topologySelect.value }),
  });
  wireSession(session);
  return session;
}

hostButton.addEventListener("click", async () => {
  status.textContent = "Creating lobby…";
  try {
    const current = createSession();
    await current.host(Number(maxParticipantsSelect.value));
  } catch (error) {
    status.textContent = errorMessage(error);
  }
});

joinButton.addEventListener("click", async () => {
  status.textContent = "Joining lobby…";
  try {
    const current = createSession();
    await current.join(codeInput.value);
  } catch (error) {
    status.textContent = errorMessage(error);
  }
});

for (const [selector, dx, dy] of [
  ["#up", 0, -1],
  ["#left", -1, 0],
  ["#down", 0, 1],
  ["#right", 1, 0],
] as const) {
  requiredElement(selector, HTMLButtonElement).addEventListener("click", () => sendLocalStep(dx, dy));
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"].includes(key)) {
    event.preventDefault();
    heldKeys.add(key);
  }
});
window.addEventListener("keyup", (event) => heldKeys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => heldKeys.clear());

setInterval(() => {
  if (!session?.participantId || !session.hostParticipantId || game.classList.contains("hidden")) return;
  const { dx, dy } = directionFromHeldKeys();
  if (dx !== 0 || dy !== 0) sendLocalStep(dx, dy);
}, 50);

window.addEventListener("beforeunload", () => {
  lobbyExperience?.close();
  session?.close();
});
if (inviteJoin.autoJoin) queueMicrotask(() => joinButton.click());
