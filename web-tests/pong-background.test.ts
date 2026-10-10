import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PongHostClock } from "../web/pong-clock.js";

const pong = readFileSync(new URL("../web/pong.ts", import.meta.url), "utf8");

test("simulation is independent of rendering and network sends are outside physics steps", () => {
  assert.match(pong, /setInterval\(simulationTick,/);
  const frame = pong.split("function frame() {")[1]?.split("\n}")[0];
  const update = pong.split("function updateHost(dt) {")[1]?.split("\n}")[0];
  assert.ok(frame && update);
  assert.doesNotMatch(frame, /updateHost|simulationTick/);
  assert.doesNotMatch(update, /sendRealtime|sendReliable/);
});

test("a delayed timer replays fixed steps in bounded batches", () => {
  const clock = new PongHostClock({ stepMs: 10, maxStepsPerTick: 3 });
  clock.reset(0);
  const observed = [];
  assert.deepEqual(clock.advance(100, (dt, at) => observed.push([dt, at])), { steps: 3, caughtUp: false });
  assert.deepEqual(observed, [[0.01, 10], [0.01, 20], [0.01, 30]]);
  for (let i = 0; i < 3; i += 1) clock.advance(100, (dt, at) => observed.push([dt, at]));
  assert.equal(observed.length, 10);
  assert.equal(observed.at(-1)[1], 100);
  assert.equal(clock.advance(100, () => { throw new Error("Unexpected step"); }).steps, 0);
});

test("multiple input transitions apply at host receipt times, never during earlier replay", () => {
  const clock = new PongHostClock({ stepMs: 10, maxStepsPerTick: 4 });
  clock.reset(0);
  let target = 225;
  const observed = [];
  clock.advance(100, (_, at) => observed.push([at, target])); // 10..40
  clock.queueInput(100, () => { target = 380; });
  clock.queueInput(110, () => { target = 80; });
  clock.queueInput(130, () => { target = 300; });
  for (let i = 0; i < 4; i += 1) clock.advance(140, (_, at) => observed.push([at, target]));
  assert.deepEqual(observed.filter(([at]) => at <= 90).map(([, value]) => value), Array(9).fill(225));
  assert.deepEqual(observed.filter(([at]) => [100, 110, 120, 130, 140].includes(at)), [
    [100, 225], [110, 380], [120, 80], [130, 80], [140, 300],
  ]);
});

test("a new peer session discards stale transitions and simulation time debt", () => {
  const clock = new PongHostClock({ stepMs: 10, maxStepsPerTick: 3 });
  clock.reset(0);
  let oldChange = 0;
  clock.queueInput(1000, () => { oldChange += 1; });
  clock.advance(1000, () => {});
  clock.reset(1000);
  const steps = [];
  clock.advance(1010, (_, at) => steps.push(at));
  assert.deepEqual(steps, [1010]);
  assert.equal(oldChange, 0);
});
