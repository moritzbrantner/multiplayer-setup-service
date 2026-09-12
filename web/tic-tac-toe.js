import { LobbyExperience, readInviteJoin } from "./lobby-experience.js";
import { PeerSession } from "./session.js";

const params = new URLSearchParams(location.search);
const apiBase = params.get("api") ?? "http://127.0.0.1:8787";
const inviteJoin = readInviteJoin({ search: location.search, codeParam: "room" });
const hostButton = document.querySelector("#host");
const joinButton = document.querySelector("#join");
const roomInput = document.querySelector("#room");
const status = document.querySelector("#status");
const codeRow = document.querySelector("#codeRow");
const code = document.querySelector("#code");
const boardNode = document.querySelector("#board");
const gameStatus = document.querySelector("#gameStatus");
const resetButton = document.querySelector("#reset");

if (inviteJoin.code) roomInput.value = inviteJoin.code;

let session = null;
let lobbyExperience = null;
let board = Array(9).fill(null);
let ply = 0;
let winner = null;
let connected = false;

const cells = Array.from({ length: 9 }, (_, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cell";
  button.setAttribute("aria-label", `Cell ${index + 1}`);
  button.addEventListener("click", () => makeLocalMove(index));
  boardNode.append(button);
  return button;
});

function boardKey(value = board) {
  return value.map((cell) => cell ?? "-").join("");
}

function markFor(role) {
  return role === "host" ? "X" : "O";
}

function turnRole() {
  return ply % 2 === 0 ? "host" : "guest";
}

function computeWinner() {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return board.every(Boolean) ? "draw" : null;
}

function render() {
  cells.forEach((cell, index) => {
    cell.textContent = board[index] ?? "";
    cell.disabled = !connected || Boolean(winner) || board[index] !== null || turnRole() !== session?.role;
  });

  if (!connected) {
    gameStatus.textContent = "Connect two peers to start.";
  } else if (winner === "draw") {
    gameStatus.textContent = "Draw.";
  } else if (winner) {
    gameStatus.textContent = `${winner} wins.`;
  } else if (turnRole() === session.role) {
    gameStatus.textContent = `Your turn (${markFor(session.role)}).`;
  } else {
    gameStatus.textContent = `Peer's turn (${markFor(turnRole())}).`;
  }
  resetButton.disabled = !connected || session?.role !== "host";
}

function applyMove({ index, role, expectedPly, before }) {
  if (!Number.isInteger(index) || index < 0 || index >= 9) return false;
  if (role !== turnRole() || expectedPly !== ply || before !== boardKey() || board[index] !== null || winner) return false;
  board[index] = markFor(role);
  ply += 1;
  winner = computeWinner();
  render();
  return true;
}

function makeLocalMove(index) {
  if (!session || turnRole() !== session.role) return;
  const move = { kind: "ttt-move", index, role: session.role, expectedPly: ply, before: boardKey() };
  if (applyMove(move)) session.sendReliable(move);
}

function resetGame(broadcast) {
  board = Array(9).fill(null);
  ply = 0;
  winner = null;
  render();
  if (broadcast) session.sendReliable({ kind: "ttt-reset" });
}

function attachSession(next) {
  session = next;
  lobbyExperience?.close();
  lobbyExperience = new LobbyExperience({
    session: next,
    root: document,
    codeParam: "room",
    inviteTitle: "Join my Tic-Tac-Toe game",
  });
  session.addEventListener("room", (event) => {
    code.textContent = event.detail.displayCode;
    codeRow.classList.remove("hidden");
  });
  session.addEventListener("statechange", (event) => {
    status.textContent = `Connection: ${event.detail.state}`;
  });
  session.addEventListener("p2p-ready", () => {
    connected = true;
    status.textContent = "Peer-to-peer ready; signaling released.";
    render();
  });
  session.addEventListener("reliable", (event) => {
    const message = event.detail;
    if (message?.kind === "ttt-move" && !applyMove(message)) {
      status.textContent = "Rejected an invalid or desynchronized peer move.";
    } else if (message?.kind === "ttt-reset" && session.role === "guest") {
      resetGame(false);
    }
  });
  session.addEventListener("error", (event) => {
    status.textContent = event.detail.error.message;
  });
}

async function connect(mode) {
  hostButton.disabled = true;
  joinButton.disabled = true;
  roomInput.disabled = true;
  connected = false;
  const next = new PeerSession({ apiBase });
  attachSession(next);
  try {
    if (mode === "host") await next.host();
    else await next.join(roomInput.value);
    status.textContent = "Waiting for peer-to-peer connection…";
  } catch (error) {
    status.textContent = error.message;
    lobbyExperience?.close();
    lobbyExperience = null;
    next.close();
    session = null;
    hostButton.disabled = false;
    joinButton.disabled = false;
    roomInput.disabled = false;
  }
}

hostButton.addEventListener("click", () => connect("host"));
joinButton.addEventListener("click", () => connect("join"));
resetButton.addEventListener("click", () => resetGame(true));
window.addEventListener("beforeunload", () => {
  lobbyExperience?.close();
  session?.close();
});
render();
if (inviteJoin.autoJoin) queueMicrotask(() => connect("join"));
