import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchTurnCredentials,
  refreshTurnIceServers,
} from "../web/turn-credentials.js";

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function session() {
  return {
    apiBase: "https://multiplayer.example.test",
    lobbyId: "ABCD1234EFGH",
    participantId: "11111111",
    participantToken: "a".repeat(64),
    turnIceServers: [],
    setTurnIceServers(value) {
      this.turnIceServers = value;
    },
  };
}

function credentialBody() {
  return {
    iceServers: [
      {
        urls: [
          "turn:turn.example.test:3478?transport=udp",
          "turns:turn.example.test:5349?transport=tcp",
        ],
        username: "1789170000:11111111",
        credential: "temporary-secret",
      },
    ],
    expiresAt: 1_789_170_000_000,
  };
}

test("TURN credentials use participant capability auth without putting secrets in URL or body", async () => {
  const current = session();
  let captured = null;
  const result = await fetchTurnCredentials(current, {
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response(credentialBody());
    },
  });

  assert.equal(
    captured.url,
    "https://multiplayer.example.test/lobbies/ABCD1234EFGH/turn-credentials",
  );
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.authorization, `Bearer ${"a".repeat(64)}`);
  assert.deepEqual(JSON.parse(captured.options.body), { participantId: "11111111" });
  assert.equal(captured.url.includes(current.participantToken), false);
  assert.equal(captured.options.body.includes(current.participantToken), false);
  assert.equal(captured.options.cache, "no-store");
  assert.equal(captured.options.credentials, "omit");
  assert.equal(captured.options.redirect, "error");
  assert.deepEqual(result, credentialBody());
});

test("refresh helper installs only validated TURN ICE servers on the session", async () => {
  const current = session();
  const result = await refreshTurnIceServers(current, {
    fetchImpl: async () => response(credentialBody()),
  });
  assert.deepEqual(current.turnIceServers, result.iceServers);
  assert.equal(current.turnIceServers[0].username, "1789170000:11111111");
});

test("malformed or non-TURN credential responses fail closed", async () => {
  const current = session();
  await assert.rejects(
    () => fetchTurnCredentials(current, { fetchImpl: async () => response({ iceServers: [], expiresAt: 1 }) }),
    /does not contain ICE servers/,
  );
  await assert.rejects(
    () =>
      fetchTurnCredentials(current, {
        fetchImpl: async () =>
          response({
            iceServers: [{ urls: ["stun:example.test"], username: "u", credential: "c" }],
            expiresAt: 1,
          }),
      }),
    /must use turn:/,
  );
  await assert.rejects(
    () =>
      fetchTurnCredentials(current, {
        fetchImpl: async () => response({ ...credentialBody(), expiresAt: "later" }),
      }),
    /invalid expiry/,
  );
});

test("service errors are surfaced without accepting fallback credentials", async () => {
  await assert.rejects(
    () =>
      fetchTurnCredentials(session(), {
        fetchImpl: async () =>
          response(
            { error: { code: "turn-not-configured", message: "TURN credentials are not configured" } },
            { ok: false, status: 503 },
          ),
      }),
    /not configured/,
  );
});
