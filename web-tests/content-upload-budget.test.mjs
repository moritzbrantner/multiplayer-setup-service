import assert from "node:assert/strict";
import { test } from "node:test";
import { ContentUploadBudget, sessionUploadBudget } from "../web/content-upload-budget.js";

test("all pools in a session share one upload budget", () => {
  const first = {};
  assert.equal(sessionUploadBudget(first), sessionUploadBudget(first));
  assert.notEqual(sessionUploadBudget(first), sessionUploadBudget({}));
});

test("aggregate tokens cannot be spent twice by concurrent peers", async () => {
  let time = 0;
  const budget = new ContentUploadBudget({ bytesPerSecond: 1000, burstBytes: 4, now: () => time });
  await budget.consume(4);
  const first = budget.consume(4);
  const second = budget.consume(4);
  assert.equal(budget.pendingSends, 2);
  time = 4;
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(budget.pendingSends, 1);
  time = 8;
  await Promise.all([first, second]);
  assert.equal(budget.pendingSends, 0);
  assert.equal(budget.tokens, 0);
});

test("pausing cancels bounded waiters and prevents new bulk sends", async () => {
  const budget = new ContentUploadBudget({ bytesPerSecond: 1, burstBytes: 4, maxPendingBytes: 4, maxPendingSends: 1 });
  await budget.consume(4);
  const pending = budget.consume(4);
  const rejection = assert.rejects(pending, /cancelled or paused/);
  await assert.rejects(budget.consume(1), /waiting budget/);
  budget.setPaused(true);
  await rejection;
  assert.equal(budget.pendingBytes, 0);
  await assert.rejects(budget.consume(1), /cancelled or paused/);
  budget.setPaused(false);
  await budget.consume(0);
});

test("closing one pool cancels its wait without cancelling other consumers", async () => {
  const budget = new ContentUploadBudget({ bytesPerSecond: 1, burstBytes: 4 });
  await budget.consume(4);
  const controller = new AbortController();
  const pending = budget.consume(4, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled or paused/);
  controller.abort();
  await rejected;
  await budget.consume(0);
  assert.equal(budget.paused, false);
  assert.equal(budget.pendingSends, 0);
});

test("invalid budgets, oversized frames and clocks fail closed", async () => {
  assert.throws(() => new ContentUploadBudget({ bytesPerSecond: 0 }), /positive safe integer/);
  assert.throws(() => new ContentUploadBudget({ now: () => NaN }), /finite number/);
  const budget = new ContentUploadBudget({ burstBytes: 4 });
  await assert.rejects(budget.consume(5), /burst budget/);
});
