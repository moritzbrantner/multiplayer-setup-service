export function movePaddleToward(currentY, targetY, dt, speed, minY, maxY) {
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

export function validPongScoreMessage(message) {
  return Boolean(
    message?.kind === "pong-score" &&
    Number.isSafeInteger(message.hostScore) &&
    message.hostScore >= 0 &&
    Number.isSafeInteger(message.guestScore) &&
    message.guestScore >= 0
  );
}

export function mayAcceptPongScore(role, message) {
  return role === "guest" && validPongScoreMessage(message);
}
