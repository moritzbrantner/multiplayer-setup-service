import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNativeInvitation, parseNativeInvitation } from "../web/native-invite.js";

const base = "https://moenarch.com/native.html";
const query = "?lobbyId=0123456789AB&matchId=zone-1";
const invitation = parseNativeInvitation(new URL(base + query));
const metadata = {
  lobbyId: invitation.lobbyId,
  participantCount: 1,
  maxParticipants: 16,
  expiresAt: 2000,
};

test("native handoff contains exactly the public identifiers", () => {
  assert.deepEqual(invitation, {
    lobbyId: "0123456789AB", matchId: "zone-1", url: base + query,
  });
  for (const url of [
    base, base + query + "&cap=secret", base + query + "#ticket",
    base + query + "&matchId=other", base + query.replace("zone-1", "bad%20match"),
    base + query.replace("zone-1", "a".repeat(65)),
    base + query.replace("0123456789AB", "invalid"),
    "https://other.test/native.html" + query,
    "https://moenarch.com/other.html" + query,
    "https://user@moenarch.com/native.html" + query,
  ]) {
    assert.throws(() => parseNativeInvitation(new URL(url)), /Invalid invitation/);
  }
});

test("viewing the invitation only reads public metadata without consuming a seat", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const status = await checkNativeInvitation(invitation, "https://moenarch.com", async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(metadata);
  }, 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://moenarch.com/lobbies/0123456789AB");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(calls[0].init?.body, undefined);
  assert.equal(calls[0].init?.headers, undefined);
  assert.match(status, /Lobby found \(1\/16 participants\)/);
  assert.match(status, /Host availability and access will be checked/);
});

test("metadata distinguishes missing, expired, full and unavailable invitations", async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 404 }), /missing or expired/],
    [new Response(null, { status: 503 }), /service is unavailable/],
    [Response.json({ ...metadata, expiresAt: 1 }), /has expired/],
    [Response.json({ ...metadata, participantCount: 16 }), /is full/],
    [Response.json({ ...metadata, lobbyId: "different" }), /invalid metadata/],
    [Response.json({ ...metadata, expiresAt: "2000" }), /invalid metadata/],
  ] as const) {
    await assert.rejects(
      checkNativeInvitation(invitation, "https://moenarch.com", async () => response, 1000),
      expected,
    );
  }
});
