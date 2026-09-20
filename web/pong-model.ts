import { isRecord } from "./events.ts";
export function movePaddleToward(currentY: number, targetY: number, dt: number, speed: number, minY: number, maxY: number) {
  if (![currentY, targetY, dt, speed, minY, maxY].every(Number.isFinite)) {
    throw new Error("Paddle motion inputs must be finite numbers");
  }
  if (dt < 0 || speed < 0 || minY > maxY) throw new Error("Invalid paddle motion bounds");
  const clampedTarget = Math.max(minY, Math.min(maxY, targetY));
  const delta = clampedTarget - currentY;
  const maxStep = speed * dt;
  const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
  return Math.max(minY, Math.min(maxY, currentY + step));
}

export function validPongScoreMessage(message: unknown): message is {kind: "pong-score"; hostScore: number; guestScore: number} {
  return (
    isRecord(message) && message.kind === "pong-score" &&
    typeof message.hostScore === "number" && Number.isSafeInteger(message.hostScore) &&
    message.hostScore >= 0 &&
    typeof message.guestScore === "number" && Number.isSafeInteger(message.guestScore) &&
    message.guestScore >= 0
  );
}

export function mayAcceptPongScore(role: string | null, message: unknown): message is {kind: "pong-score"; hostScore: number; guestScore: number} {
  return role === "guest" && validPongScoreMessage(message);
}
