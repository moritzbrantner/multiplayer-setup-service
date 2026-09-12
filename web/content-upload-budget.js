const DEFAULT_BYTES_PER_SECOND = 1024 * 1024;
const DEFAULT_BURST_BYTES = 1024 * 1024;
const sessionBudgets = new WeakMap();

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function abortError() {
  return new Error("Content upload was cancelled or paused for gameplay");
}

function delay(milliseconds, signals) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(abortError()); };
    for (const signal of signals) signal?.addEventListener("abort", onAbort, { once: true });
    if (signals.some((signal) => signal?.aborted)) return onAbort();
    timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(milliseconds, 2_147_483_647));
  });
}

/** Aggregate token bucket for optional content, never gameplay channels. */
export class ContentUploadBudget {
  constructor({
    bytesPerSecond = DEFAULT_BYTES_PER_SECOND,
    burstBytes = DEFAULT_BURST_BYTES,
    maxPendingBytes = 4 * DEFAULT_BURST_BYTES,
    maxPendingSends = 64,
    now = () => performance.now(),
  } = {}) {
    for (const [name, value] of Object.entries({ bytesPerSecond, burstBytes, maxPendingBytes, maxPendingSends })) {
      positiveInteger(value, name);
    }
    if (typeof now !== "function") throw new Error("now must be a function");
    this.bytesPerSecond = bytesPerSecond;
    this.burstBytes = burstBytes;
    this.maxPendingBytes = maxPendingBytes;
    this.maxPendingSends = maxPendingSends;
    this.now = now;
    this.tokens = burstBytes;
    this.updated = this.#time();
    this.pendingBytes = 0;
    this.pendingSends = 0;
    this.paused = false;
    this.pauseController = new AbortController();
  }

  setPaused(paused) {
    if (typeof paused !== "boolean") throw new Error("paused must be a boolean");
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.pauseController.abort();
    else this.pauseController = new AbortController();
  }

  async consume(bytes, { signal } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.burstBytes) {
      throw new Error("Content frame exceeds the upload burst budget");
    }
    if (this.paused || signal?.aborted) throw abortError();
    if (this.pendingSends >= this.maxPendingSends || bytes > this.maxPendingBytes - this.pendingBytes) {
      throw new Error("Content upload waiting budget is exhausted");
    }
    const pauseSignal = this.pauseController.signal;
    this.pendingSends += 1;
    this.pendingBytes += bytes;
    try {
      while (true) {
        if (this.paused || pauseSignal.aborted || signal?.aborted) throw abortError();
        const now = Math.max(this.updated, this.#time());
        this.tokens = Math.min(this.burstBytes, this.tokens + (now - this.updated) * this.bytesPerSecond / 1000);
        this.updated = now;
        if (this.tokens >= bytes) {
          this.tokens -= bytes;
          return;
        }
        await delay(Math.ceil((bytes - this.tokens) * 1000 / this.bytesPerSecond), [pauseSignal, signal]);
      }
    } finally {
      this.pendingSends -= 1;
      this.pendingBytes -= bytes;
    }
  }

  #time() {
    const value = Number(this.now());
    if (!Number.isFinite(value)) throw new Error("now() must return a finite number");
    return value;
  }
}

export function sessionUploadBudget(session) {
  let budget = sessionBudgets.get(session);
  if (!budget) {
    budget = new ContentUploadBudget();
    sessionBudgets.set(session, budget);
  }
  return budget;
}
