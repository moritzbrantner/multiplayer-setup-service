import { LobbySession } from "./lobby-session.js";

const params = new URLSearchParams(window.location.search);
const apiBase = params.get("api") || "http://127.0.0.1:8787";
const topologySelect = document.querySelector("#topology");
const maxParticipantsSelect = document.querySelector("#max-participants");
const hostButton = document.querySelector("#host");
const joinButton = document.querySelector("#join");
const codeInput = document.querySelector("#code");
const status = document.querySelector("#status");
const invite = document.querySelector("#invite");
const game = document.querySelector("#game");
const arena = document.querySelector("#arena");
const selfId = document.querySelector("#self-id");
const participantCount = document.querySelector("#participant-count");
const peerCount = document.querySelector("#peer-count");
const edgeCount = document.querySelector("#edge-count");

const queryLobby = params.get("lobby");
const queryTopology = params.get("topology");
if (queryLobby) codeInput.value = queryLobby;
if (queryTopology === "mesh" || queryTopology === "host") topologySelect.value = queryTopology;

let session = null;
let localSequence = 0;
const players = new Map();
const lastSequence = new Map();
const heldKeys = new Set();

function hashId(id) {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initialPlayer(id) {
  const hash = hashId(id);
  return { x: 80 + (hash % 841), y: 80 + ((hash >>> 10) % 841) };
}

function ensurePlayer(id) {
  if (!players.has(id)) {
    players.set(id, initialPlayer(id));
    lastSequence.set(id, 0);
  }
  return players.get(id);
}

function render() {
  const participantIds = [...session?.participants ?? []].sort();
  const existing = new Map(
    [...arena.querySelectorAll(".arena-player")].map((node) => [node.dataset.id, node]),
  );

  for (const id of participantIds) {
    const player = ensurePlayer(id);
    let node = existing.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "arena-player";
      node.dataset.id = id;
      node.dataset.self = String(id === session.participantId);
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
  const edges = topologySelect.value === "mesh" ? (count * (count - 1)) / 2 : Math.max(0, count - 1);
  edgeCount.textContent = String(edges);
}

function validStep(message) {
  return (
    message?.type === "step" &&
    typeof message.participantId === "string" &&
    Number.isInteger(message.seq) &&
    message.seq > 0 &&
    Number.isInteger(message.dx) &&
    Number.isInteger(message.dy) &&
    Math.abs(message.dx) <= 1 &&
    Math.abs(message.dy) <= 1 &&
    Math.abs(message.dx) + Math.abs(message.dy) > 0
  );
}

function applyStep(message) {
  if (!validStep(message) || !session?.participants.has(message.participantId)) return false;

  const previous = lastSequence.get(message.participantId) ?? 0;
  if (message.seq <= previous) return false;

  const player = ensurePlayer(message.participantId);
  player.x = Math.max(20, Math.min(980, player.x + message.dx * 12));
  player.y = Math.max(20, Math.min(980, player.y + message.dy * 12));
  lastSequence.set(message.participantId, message.seq);
  render();
  return true;
}

function topologyReady() {
  if (!session) return false;
  const ready = new Set(session.readyPeerIds());
  if (session.topology === "mesh") {
    return ready.size === Math.max(0, session.participants.size - 1);
  }
  if (session.participantId === session.hostParticipantId) {
    return ready.size === Math.max(0, session.participants.size - 1);
  }
  return ready.has(session.hostParticipantId);
}

function sendLocalStep(dx, dy) {
  if (!session || game.classList.contains("hidden")) return;
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

function receiveReliable(peerId, message) {
  if (message?.type === "snapshot") {
    if (peerId !== session.hostParticipantId || !Array.isArray(message.players)) return;
    for (const snapshot of message.players) {
      if (
        typeof snapshot?.id === "string" &&
        Number.isInteger(snapshot.x) &&
        Number.isInteger(snapshot.y) &&
        Number.isInteger(snapshot.seq)
      ) {
        players.set(snapshot.id, {
          x: Math.max(20, Math.min(980, snapshot.x)),
          y: Math.max(20, Math.min(980, snapshot.y)),
        });
        lastSequence.set(snapshot.id, Math.max(0, snapshot.seq));
      }
    }
    render();
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

function sendSnapshot(peerId) {
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
  game.classList.remove("hidden");
  selfId.textContent = session.participantId;
  topologySelect.disabled = true;
  maxParticipantsSelect.disabled = true;
  hostButton.disabled = true;
  joinButton.disabled = true;
  codeInput.disabled = true;
  render();
}

function wireSession(current) {
  current.addEventListener("lobby", () => {
    status.textContent = `Lobby ${current.displayCode}; connecting peers…`;
    codeInput.value = current.displayCode;
    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.set("lobby", current.displayCode);
    inviteUrl.searchParams.set("topology", current.topology);
    inviteUrl.searchParams.set("api", current.apiBase);
    invite.textContent = `Invite: ${inviteUrl}`;
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
    status.textContent = event.detail.error.message;
  });
}

function createSession() {
  session?.close();
  session = new LobbySession({ apiBase, topology: topologySelect.value });
  wireSession(session);
  return session;
}

hostButton.addEventListener("click", async () => {
  status.textContent = "Creating lobby…";
  try {
    const current = createSession();
    await current.host(Number(maxParticipantsSelect.value));
  } catch (error) {
    status.textContent = error.message;
  }
});

joinButton.addEventListener("click", async () => {
  status.textContent = "Joining lobby…";
  try {
    const current = createSession();
    await current.join(codeInput.value);
  } catch (error) {
    status.textContent = error.message;
  }
});

for (const [selector, dx, dy] of [
  ["#up", 0, -1],
  ["#left", -1, 0],
  ["#down", 0, 1],
  ["#right", 1, 0],
]) {
  document.querySelector(selector).addEventListener("click", () => sendLocalStep(dx, dy));
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
  if (!session || game.classList.contains("hidden")) return;
  const { dx, dy } = directionFromHeldKeys();
  if (dx !== 0 || dy !== 0) sendLocalStep(dx, dy);
}, 50);

window.addEventListener("beforeunload", () => session?.close());
