// The host clock is local authority: remote payloads never choose timestamps.
export class PongHostClock {
  constructor({ stepMs = 1000 / 120, maxStepsPerTick = 1200 } = {}) {
    this.stepMs = stepMs;
    this.maxStepsPerTick = maxStepsPerTick;
    this.simulatedThrough = 0;
    this.transitions = [];
  }

  reset(nowMs) {
    this.simulatedThrough = nowMs;
    this.transitions.length = 0;
  }

  queueInput(receivedAtMs, apply) {
    const prior = this.transitions.at(-1)?.atMs ?? -Infinity;
    // A delayed callback cannot edit steps that the host already simulated.
    this.transitions.push({ atMs: Math.max(receivedAtMs, this.simulatedThrough, prior), apply });
  }

  advance(nowMs, step) {
    let steps = 0;
    let applied = 0;
    while (this.simulatedThrough + this.stepMs <= nowMs && steps < this.maxStepsPerTick) {
      const nextStepAt = this.simulatedThrough + this.stepMs;
      while (applied < this.transitions.length && this.transitions[applied].atMs <= nextStepAt) {
        this.transitions[applied].apply();
        applied += 1;
      }
      step(this.stepMs / 1000, nextStepAt);
      this.simulatedThrough = nextStepAt;
      steps += 1;
    }
    if (applied) this.transitions.splice(0, applied);
    return { steps, caughtUp: nowMs - this.simulatedThrough < this.stepMs };
  }
}
