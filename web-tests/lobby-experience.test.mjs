import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInviteUrl,
  LobbyExperience,
  normalizeChatText,
  readInviteJoin,
  summarizeLatency,
} from "../web/lobby-experience.js";

const emptyRoot = {
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

class TwoPlayerSession extends EventTarget {
  constructor(role = "host") {
    super();
    this.role = role;
    this.apiBase = "https://signal.example.test";
    this.reliable = { readyState: "open" };
    this.realtime = { readyState: "open" };
    this.reliableMessages = [];
    this.realtimeMessages = [];
  }

  sendReliable(message) { this.reliableMessages.push(message); }
  sendRealtime(message) { this.realtimeMessages.push(message); }
}

class MultipartySession extends EventTarget {
  constructor({ participantId, hostParticipantId = "host", topology = "host", readyPeers = [] }) {
    super();
    this.participantId = participantId;
    this.hostParticipantId = hostParticipantId;
    this.topology = topology;
    this.apiBase = "https://signal.example.test";
    this.participants = new Set([hostParticipantId, participantId, ...readyPeers]);
    this.readyPeers = [...readyPeers];
    this.reliableMessages = [];
    this.realtimeMessages = [];
  }

  readyPeerIds() { return [...this.readyPeers]; }
  sendReliable(peerId, message) { this.reliableMessages.push({ peerId, message }); }
  sendRealtime(peerId, message) { this.realtimeMessages.push({ peerId, message }); }
}

test("share links preserve the page query and opt into auto-join", () => {
  const invite = new URL(buildInviteUrl({
    locationHref: "https://example.test/pong.html?theme=dark",
    code: "ABCD-EFGH-JKMN",
    codeParam: "room",
    apiBase: "https://signal.example.test",
    extras: { topology: "host" },
  }));
  assert.equal(invite.searchParams.get("room"), "ABCD-EFGH-JKMN");
  assert.equal(invite.searchParams.get("api"), "https://signal.example.test");
  assert.equal(invite.searchParams.get("topology"), "host");
  assert.equal(invite.searchParams.get("join"), "1");
  assert.equal(invite.searchParams.get("theme"), "dark");
});

test("invite parsing only auto-joins explicit join links", () => {
  assert.deepEqual(
    readInviteJoin({ search: "?lobby=9HA2-9724-8G4E&join=1", codeParam: "lobby" }),
    { code: "9HA2-9724-8G4E", autoJoin: true },
  );
  assert.deepEqual(
    readInviteJoin({ search: "?room=ABCD-EFGH-JKMN", codeParam: "room" }),
    { code: "ABCD-EFGH-JKMN", autoJoin: false },
  );
});

test("chat text stays bounded", () => {
  assert.equal(normalizeChatText("  hello lobby  "), "hello lobby");
  assert.equal(normalizeChatText("   "), null);
  assert.equal(normalizeChatText("x".repeat(501)), null);
});

test("two-player chat uses the reliable data channel", () => {
  const session = new TwoPlayerSession("host");
  const experience = new LobbyExperience({
    session,
    root: emptyRoot,
    locationHref: "https://example.test/pong.html",
  });
  assert.equal(experience.sendChat(" hello "), true);
  assert.equal(session.reliableMessages.length, 1);
  assert.equal(session.reliableMessages[0].kind, "multiplayer-lobby-chat-v1");
  assert.equal(session.reliableMessages[0].senderId, "host");
  assert.equal(session.reliableMessages[0].text, "hello");
  experience.close();
});

test("host-spoke guest chat targets only the host", () => {
  const session = new MultipartySession({ participantId: "guest-a", readyPeers: ["host"] });
  const experience = new LobbyExperience({
    session,
    root: emptyRoot,
    locationHref: "https://example.test/card-game.html",
  });
  assert.equal(experience.sendChat("ready"), true);
  assert.equal(session.reliableMessages.length, 1);
  assert.equal(session.reliableMessages[0].peerId, "host");
  assert.equal(session.reliableMessages[0].message.senderId, "guest-a");
  experience.close();
});

test("latency summaries use recent median RTT samples", () => {
  assert.deepEqual(summarizeLatency(new Map()), { text: "Ping —", quality: "unknown" });
  assert.deepEqual(
    summarizeLatency(new Map([["guest", [22, 18, 20, 24, 21]]])),
    { text: "Ping 21 ms", quality: "good" },
  );
  assert.deepEqual(
    summarizeLatency(new Map([
      ["a", [40, 42, 44]],
      ["b", [101, 103, 105]],
    ])),
    { text: "Peer ping 42–103 ms", quality: "fair" },
  );
});
