import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { renewLobbySession } from "../web/lobby-renewal.js";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

afterEach(() => {
  delete globalThis.fetch;
});

function session(overrides = {}) {
  const value = new EventTarget();
  Object.assign(value, {
    apiBase: "https://service.example.test",
    lobbyId: "ABCD1234EFGH",
    participantId: "11111111",
    participantToken: "a".repeat(64),
    hostParticipantId: "11111111",
    ...overrides,
  });
  return value;
}

test("host renewal keeps the capability out of the URL and request body", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          lobbyId: "ABCD1234EFGH",
          displayCode: "ABCD-1234-EFGH",
          expiresAt: 2_000,
          maxExpiresAt: 5_000,
        };
      },
    };
  };

  const value = session();
  let eventDetail = null;
  value.addEventListener("lobby-renewed", (event) => {
    eventDetail = event.detail;
  });

  const result = await renewLobbySession(value);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://service.example.test/lobbies/ABCD1234EFGH/renew");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${"a".repeat(64)}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { participantId: "11111111" });
  assert.ok(!calls[0].url.includes(value.participantToken));
  assert.ok(!calls[0].init.body.includes(value.participantToken));
  assert.equal(value.expiresAt, 2_000);
  assert.equal(value.maxExpiresAt, 5_000);
  assert.deepEqual(eventDetail, result);
});

test("guest renewal is rejected locally before making a request", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };

  await assert.rejects(
    () => renewLobbySession(session({ participantId: "22222222" })),
    /Only the lobby host can renew/,
  );
  assert.equal(called, false);
});
