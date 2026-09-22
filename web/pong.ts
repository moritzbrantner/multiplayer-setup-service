import { LobbyExperience, readInviteJoin } from "./lobby-experience.js";
import { movePaddleToward, mayAcceptPongScore } from "./pong-model.mjs";
import { PeerSession } from "./session.js";

const WIDTH = 800;
const HEIGHT = 450;
const PADDLE_W = 14;
const PADDLE_H = 92;
const BALL_R = 9;
const PADDLE_SPEED = 330;
const SNAPSHOT_INTERVAL = 1 / 30;

const params = new URLSearchParams(location.search);
const apiBase = params.get("api") ?? "http://127.0.0.1:8787";
const inviteJoin = readInviteJoin({ search: location.search, codeParam: "room" });
const hostButton = document.querySelector("#host");
const joinButton = document.querySelector("#join");
const roomInput = document.querySelector("#room");
const status = document.querySelector("#status");
const codeRow = document.querySelector("#codeRow");
const code = document.querySelector("#code");
const hostScore = document.querySelector("#hostScore");
const guestScore = document.querySelector("#guestScore");
const controlHint = document.querySelector("#controlHint");
const resetButton = document.querySelector("#reset");
const forgeScoreButton = document.querySelector("#forgeScore");
const securityStatus = document.querySelector("#securityStatus");
const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");

if (inviteJoin.code) roomInput.value = inviteJoin.code;

let session = null;
let lobbyExperience = null;
let ready = false;
let previousTime = performance.now();
let snapshotBudget = 0;
let localDirection = 0;
let targetGuestY = HEIGHT / 2;
let guestView = null;

const world = {
  leftY: HEIGHT / 2,
  rightY: HEIGHT / 2,
  ballX: WIDTH / 2,
  ballY: HEIGHT / 2,
  ballVx: 260,
  ballVy: 120,
  hostScore: 0,
  guestScore: 0,
};

function clampPaddle(y) {
  return Math.max(PADDLE_H / 2, Math.min(HEIGHT - PADDLE_H / 2, y));
}

function resetBall(direction = Math.random() < 0.5 ? -1 : 1) {
  world.ballX = WIDTH / 2;
  world.ballY = HEIGHT / 2;
  world.ballVx = direction * 260;
  world.ballVy = (Math.random() * 180) - 90;
}

function snapshot() {
  return {
    kind: "pong-snapshot",
    leftY: world.leftY,
    rightY: world.rightY,
    ballX: world.ballX,
    ballY: world.ballY,
    hostScore: world.hostScore,
    guestScore: world.guestScore,
  };
}

function updateScoreUi(host, guest) {
  hostScore.textContent = String(host);
  guestScore.textContent = String(guest);
}

function score(side) {
  if (side === "host") world.hostScore += 1;
  else world.guestScore += 1;
  updateScoreUi(world.hostScore, world.guestScore);
  session.sendReliable({
    kind: "pong-score",
    hostScore: world.hostScore,
    guestScore: world.guestScore,
  });
  resetBall(side === "host" ? 1 : -1);
}

function updateHost(dt) {
  world.leftY = clampPaddle(world.leftY + localDirection * PADDLE_SPEED * dt);
  world.rightY = movePaddleToward(
    world.rightY,
    targetGuestY,
    dt,
    PADDLE_SPEED,
    PADDLE_H / 2,
    HEIGHT - PADDLE_H / 2,
  );

  world.ballX += world.ballVx * dt;
  world.ballY += world.ballVy * dt;

  if (world.ballY < BALL_R) {
    world.ballY = BALL_R;
    world.ballVy = Math.abs(world.ballVy);
  } else if (world.ballY > HEIGHT - BALL_R) {
    world.ballY = HEIGHT - BALL_R;
    world.ballVy = -Math.abs(world.ballVy);
  }

  const leftX = 34;
  const rightX = WIDTH - 34;
  if (
    world.ballVx < 0 &&
    world.ballX - BALL_R <= leftX + PADDLE_W / 2 &&
    world.ballX > leftX - 24 &&
    Math.abs(world.ballY - world.leftY) <= PADDLE_H / 2 + BALL_R
  ) {
    world.ballX = leftX + PADDLE_W / 2 + BALL_R;
    world.ballVx = Math.abs(world.ballVx) * 1.035;
    world.ballVy += (world.ballY - world.leftY) * 4;
  }

  if (
    world.ballVx > 0 &&
    world.ballX + BALL_R >= rightX - PADDLE_W / 2 &&
    world.ballX < rightX + 24 &&
    Math.abs(world.ballY - world.rightY) <= PADDLE_H / 2 + BALL_R
  ) {
    world.ballX = rightX - PADDLE_W / 2 - BALL_R;
    world.ballVx = -Math.abs(world.ballVx) * 1.035;
    world.ballVy += (world.ballY - world.rightY) * 4;
  }

  if (world.ballX < -30) score("guest");
  else if (world.ballX > WIDTH + 30) score("host");

  snapshotBudget += dt;
  if (snapshotBudget >= SNAPSHOT_INTERVAL) {
    snapshotBudget %= SNAPSHOT_INTERVAL;
    session.sendRealtime(snapshot());
  }
}

function interpolateGuest() {
  if (!guestView) return;
  world.leftY += (guestView.leftY - world.leftY) * 0.28;
  world.rightY += (guestView.rightY - world.rightY) * 0.28;
  world.ballX += (guestView.ballX - world.ballX) * 0.38;
  world.ballY += (guestView.ballY - world.ballY) * 0.38;
  world.hostScore = guestView.hostScore;
  world.guestScore = guestView.guestScore;
  updateScoreUi(world.hostScore, world.guestScore);
}

function draw() {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = "#666";
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.moveTo(WIDTH / 2, 0);
  ctx.lineTo(WIDTH / 2, HEIGHT);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(34 - PADDLE_W / 2, world.leftY - PADDLE_H / 2, PADDLE_W, PADDLE_H);
  ctx.fillRect(WIDTH - 34 - PADDLE_W / 2, world.rightY - PADDLE_H / 2, PADDLE_W, PADDLE_H);
  ctx.beginPath();
  ctx.arc(world.ballX, world.ballY, BALL_R, 0, Math.PI * 2);
  ctx.fill();
}

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - previousTime) / 1000));
  previousTime = now;
  if (ready && session?.role === "host") updateHost(dt);
  if (ready && session?.role === "guest") interpolateGuest();
  draw();
  requestAnimationFrame(frame);
}

function sendGuestPaddle(y) {
  if (!ready || session?.role !== "guest") return;
  targetGuestY = clampPaddle(y);
  world.rightY = targetGuestY;
  session.sendRealtime({ kind: "pong-paddle", y: targetGuestY });
}

function setLocalPaddleFromPointer(event) {
  if (!ready || !session) return;
  const rect = canvas.getBoundingClientRect();
  const y = ((event.clientY - rect.top) / rect.height) * HEIGHT;
  if (session.role === "host") world.leftY = clampPaddle(y);
  else sendGuestPaddle(y);
}

function attachSession(next) {
  session = next;
  lobbyExperience?.close();
  lobbyExperience = new LobbyExperience({
    session: next,
    root: document,
    codeParam: "room",
    inviteTitle: "Join my Pong game",
  });
  session.addEventListener("room", (event) => {
    code.textContent = event.detail.displayCode;
    codeRow.classList.remove("hidden");
  });
  session.addEventListener("statechange", (event) => {
    status.textContent = `Connection: ${event.detail.state}`;
  });
  session.addEventListener("p2p-ready", () => {
    ready = true;
    status.textContent = "Peer-to-peer ready; signaling released.";
    controlHint.textContent = session.role === "host"
      ? "You are the left paddle. Use W/S or drag/tap on the field."
      : "You are the right paddle. Use ↑/↓ or drag/tap on the field.";
    resetButton.disabled = session.role !== "host";
    forgeScoreButton.disabled = session.role !== "guest";
    securityStatus.textContent = session.role === "host"
      ? "Host owns ball physics and scoring; guest score publications will be rejected."
      : "Guest may send paddle targets, but not scores or ball state.";
  });
  session.addEventListener("realtime", (event) => {
    const message = event.detail;
    if (session.role === "host" && message?.kind === "pong-paddle" && Number.isFinite(message.y)) {
      targetGuestY = clampPaddle(message.y);
    } else if (session.role === "guest" && message?.kind === "pong-snapshot") {
      guestView = message;
    }
  });
  session.addEventListener("reliable", (event) => {
    const message = event.detail;
    if (message?.kind === "pong-score") {
      if (session.role === "host") {
        securityStatus.textContent = "Blocked forged guest score: only the host may publish score state.";
        session.sendReliable({ kind: "pong-security-result", accepted: false, reason: "score-authority" });
      } else if (mayAcceptPongScore(session.role, message)) {
        world.hostScore = message.hostScore;
        world.guestScore = message.guestScore;
        updateScoreUi(world.hostScore, world.guestScore);
      }
    } else if (message?.kind === "pong-reset" && session.role === "guest") {
      world.hostScore = 0;
      world.guestScore = 0;
      updateScoreUi(0, 0);
    } else if (message?.kind === "pong-security-result" && session.role === "guest") {
      securityStatus.textContent = message.accepted
        ? "Unexpected: host accepted the probe."
        : "Host rejected the forged score as expected.";
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
  ready = false;
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

function resetScores() {
  if (session?.role !== "host" || !ready) return;
  world.hostScore = 0;
  world.guestScore = 0;
  updateScoreUi(0, 0);
  resetBall();
  session.sendReliable({ kind: "pong-reset" });
}

function attemptForgedScore() {
  if (session?.role !== "guest" || !ready) return;
  securityStatus.textContent = "Sending a deliberately forged 99–0 score from the guest…";
  session.sendReliable({ kind: "pong-score", hostScore: 99, guestScore: 0, probe: "forged-guest-score" });
}

canvas.addEventListener("pointerdown", setLocalPaddleFromPointer);
canvas.addEventListener("pointermove", (event) => {
  if (event.buttons !== 0 || event.pointerType === "touch") setLocalPaddleFromPointer(event);
});
window.addEventListener("keydown", (event) => {
  if (!ready || !session) return;
  if (session.role === "host" && (event.key === "w" || event.key === "W")) localDirection = -1;
  if (session.role === "host" && (event.key === "s" || event.key === "S")) localDirection = 1;
  if (session.role === "guest" && event.key === "ArrowUp") sendGuestPaddle(world.rightY - 18);
  if (session.role === "guest" && event.key === "ArrowDown") sendGuestPaddle(world.rightY + 18);
});
window.addEventListener("keyup", (event) => {
  if (session?.role === "host" && ["w", "W", "s", "S"].includes(event.key)) localDirection = 0;
});
hostButton.addEventListener("click", () => connect("host"));
joinButton.addEventListener("click", () => connect("join"));
resetButton.addEventListener("click", resetScores);
forgeScoreButton.addEventListener("click", attemptForgedScore);
window.addEventListener("beforeunload", () => {
  lobbyExperience?.close();
  session?.close();
});
requestAnimationFrame(frame);
if (inviteJoin.autoJoin) queueMicrotask(() => connect("join"));
