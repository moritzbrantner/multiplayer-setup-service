import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

import { applyCardIntent, createCardGame } from "../web/card-game-model.mjs";
import { GAME_COMMAND_PROTOCOL, GameCommands } from "../web/game-commands.js";

const client = await readFile(new URL("../web/card-game.js", import.meta.url), "utf8");

class LinkedSession extends EventTarget {
  constructor(participantId, hostParticipantId) {
    super();
    this.participantId = participantId;
    this.hostParticipantId = hostParticipantId;
    this.peers = new Map();
    this.sent = [];
  }

  connect(peer) {
    this.peers.set(peer.participantId, peer);
  }

  sendReliable(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} is not ready`);
    const copy = structuredClone(data);
    this.sent.push({ peerId, data: copy });
    peer.dispatchEvent(
      new CustomEvent("reliable", {
        detail: { peerId: this.participantId, data: copy },
      }),
    );
  }

  broadcastReliable(data, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.peers.keys()) {
      if (!excluded.has(peerId)) this.sendReliable(peerId, data);
    }
  }
}

function linkedPair(leftId, rightId, hostParticipantId = "HOST0001") {
  const left = new LinkedSession(leftId, hostParticipantId);
  const right = new LinkedSession(rightId, hostParticipantId);
  left.connect(right);
  right.connect(left);
  return { left, right };
}

test("card-game showcase uses GameCommands only for state-changing card intents", () => {
  assert.match(client, /import \{ GameCommands \} from "\.\/game-commands\.js"/);
  assert.match(client, /commands\.sendToHost\(CARD_INTENT_COMMAND, intent\)/);
  assert.match(client, /currentCommands\.handle\(CARD_INTENT_COMMAND/);
  assert.doesNotMatch(client, /data\?\.type === "card-intent"/);

  assert.match(client, /session\.sendReliable\(peerId, view\)/);
  assert.match(client, /type: "card-rejection"/);
});

test("card intent commands preserve peer identity for host-side game validation", () => {
  const { left: host, right: attacker } = linkedPair("HOST0001", "ATTACK01");
  const hostCommands = new GameCommands({ session: host });
  const attackerCommands = new GameCommands({ session: attacker });
  const state = createCardGame(["HOST0001", "GUEST001"], 12345);
  let validation = null;

  hostCommands.handle("card.intent", (intent, { peerId }) => {
    validation = applyCardIntent(state, peerId, intent);
  });

  attackerCommands.sendToHost("card.intent", {
    type: "card-intent",
    action: "draw",
    seq: 1,
  });

  assert.deepEqual(attacker.sent[0].data, {
    protocol: GAME_COMMAND_PROTOCOL,
    command: "card.intent",
    payload: {
      type: "card-intent",
      action: "draw",
      seq: 1,
    },
  });
  assert.deepEqual(validation, { accepted: false, reason: "unknown-participant" });

  hostCommands.close();
  attackerCommands.close();
});
