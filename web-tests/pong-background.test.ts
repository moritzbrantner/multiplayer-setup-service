import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pong = readFileSync(new URL("../web/pong.ts", import.meta.url), "utf8");

test("host simulation is scheduled independently of animation frames", () => {
  assert.match(pong, /setInterval\(simulationTick,/);
  const frame = pong.split("function frame() {")[1]?.split("\n}")[0];
  assert.ok(frame);
  assert.doesNotMatch(frame, /updateHost|simulationTick/);
  assert.match(pong, /requestAnimationFrame\(frame\)/);
});

test("background wakeups preserve elapsed simulation debt with fixed steps", () => {
  const tick = pong.split("function simulationTick() {")[1]?.split("\n}")[0];
  assert.ok(tick);
  assert.match(tick, /simulationDebt \+= elapsed/);
  assert.match(tick, /while \(simulationDebt >= SIMULATION_STEP/);
  assert.match(tick, /updateHost\(SIMULATION_STEP\)/);
  assert.match(tick, /simulationDebt -= SIMULATION_STEP/);
});
