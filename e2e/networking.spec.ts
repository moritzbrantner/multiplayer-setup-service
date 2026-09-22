import { expect, test } from "@playwright/test";

const path = "assets/greeting.bin";

async function createParticipant(page, { code = null, relay = false } = {}) {
  await page.goto("http://127.0.0.1:4173/index.html");
  return page.evaluate(async ({ code, relay }) => {
    const { ResilientLobbySession } = await import("/resilient-lobby-session.js");
    const { ContentPeerPool } = await import("/content-peer-pool.js");
    const { ContentChunkExchange } = await import("/content-chunk-exchange.js");
    const { VerifiedChunkStore } = await import("/verified-chunk-store.js");
    const manifest = {
      protocol: "multiplayer-content-manifest-v1",
      game: { id: "browser-acceptance", version: "1.0.0" },
      files: [{
        path: "assets/greeting.bin", bytes: 11,
        sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        role: "asset", chunks: { bytes: 5, sha256: [
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          "43cf897720cc5a693b2508c9e95e8711942a96ed98d772fe37123d31603ce20f",
          "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4",
        ] },
      }],
    };
    const session = new ResilientLobbySession({
      apiBase: "http://127.0.0.1:8787", contentSharing: true,
      topology: "host", reconnectBaseDelayMs: 50, reconnectMaxDelayMs: 100,
    });
    const received = [];
    const errors = [];
    session.addEventListener("reliable", (event) => received.push(event.detail.data));
    session.addEventListener("error", (event) => errors.push(String(event.detail.error)));
    const lobby = code ? await session.join(code) : await session.host(2);
    let turn = null;
    if (relay) {
      const response = await fetch(`http://127.0.0.1:8787/lobbies/${session.lobbyId}/turn-credentials`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.participantToken}` },
        body: JSON.stringify({ participantId: session.participantId }),
      });
      if (!response.ok) throw new Error(`TURN credentials failed with ${response.status}`);
      turn = await response.json();
    }
    const pool = new ContentPeerPool({
      session, relayPolicy: "deny",
      ...(turn ? { peerConnectionFactory: (configuration) => new RTCPeerConnection({ ...configuration, iceServers: turn.iceServers, iceTransportPolicy: "relay" }) } : {}),
    });
    const store = new VerifiedChunkStore({ manifest });
    if (!code) await store.putFile("assets/greeting.bin", new TextEncoder().encode("hello world"));
    const exchange = new ContentChunkExchange({ transport: pool, manifest, store, requestTimeoutMs: 10_000 });
    window.acceptance = { session, pool, originalPool: pool, store, exchange, received, errors, turn };
    // Return identifiers only, never capability or TURN credentials in reports.
    return { code: lobby.displayCode, id: session.participantId };
  }, { code, relay });
}

async function connected(left, right, leftId, rightId) {
  await expect.poll(() => left.evaluate(() => window.acceptance.session.participants.size)).toBe(2);
  await expect.poll(() => right.evaluate(() => window.acceptance.session.participants.size)).toBe(2);
  await left.evaluate((peerId) => window.acceptance.pool.connect(peerId), rightId);
  await expect.poll(() => left.evaluate(() => window.acceptance.pool.contentPeerIds())).toEqual([rightId]);
  await expect.poll(() => right.evaluate(() => window.acceptance.pool.contentPeerIds())).toEqual([leftId]);
}

for (const relay of [false, true]) {
  test(relay ? "forced TURN uses issued credentials and enforces bulk opt-in" : "direct connection resumes verified content after signaling replacement", async ({ browser }, testInfo) => {
    const { viewport, isMobile = false, hasTouch = false } = testInfo.project.use;
    const contexts = await Promise.all([
      browser.newContext({ viewport, isMobile, hasTouch }),
      browser.newContext({ viewport, isMobile, hasTouch }),
    ]);
    const [left, right] = await Promise.all(contexts.map((context) => context.newPage()));
    const pageErrors = [];
    for (const page of [left, right]) page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      const host = await createParticipant(left, { relay });
      const guest = await createParticipant(right, { code: host.code, relay });
      await connected(left, right, host.id, guest.id);
      const expectedPath = relay ? "relay" : "direct";
      await expect.poll(() => left.evaluate((id) => window.acceptance.pool.icePath(id), guest.id)).toBe(expectedPath);
      await expect.poll(() => right.evaluate((id) => window.acceptance.pool.icePath(id), host.id)).toBe(expectedPath);

      if (relay) {
        const rejection = await right.evaluate(async (id) => {
          try { await window.acceptance.pool.sendContent(id, "blocked"); return null; }
          catch (error) { return error.message; }
        }, host.id);
        expect(rejection).toContain("TURN relay is disabled");
        for (const page of [left, right]) await page.evaluate(() => { window.acceptance.pool.relayPolicy = "allow"; });
      }
      await right.evaluate(({ id, path }) => window.acceptance.exchange.requestChunks(id, path, [0]), { id: host.id, path });
      expect(await right.evaluate((path) => window.acceptance.store.missingChunks(path), path)).toEqual([1, 2]);

      if (!relay) {
        const oldConnection = await left.evaluate((id) => window.acceptance.pool.peers.get(id).connectionId, guest.id);
        await right.evaluate(() => {
          const state = window.acceptance;
          state.oldSocket = state.session.signaling;
          state.identityBefore = state.session.participantId;
          state.tokenBefore = state.session.participantToken;
          state.oldSocket.close();
        });
        await expect.poll(() => right.evaluate(() => {
          const state = window.acceptance;
          return state.session.signaling !== state.oldSocket && state.session.signaling?.readyState === WebSocket.OPEN && state.pool.signaling === state.session.signaling;
        })).toBe(true);
        await left.evaluate((id) => window.acceptance.pool.disconnect(id), guest.id);
        await connected(left, right, host.id, guest.id);
        expect(await left.evaluate((id) => window.acceptance.pool.peers.get(id).connectionId, guest.id)).not.toBe(oldConnection);
        expect(await right.evaluate(() => {
          const state = window.acceptance;
          return state.pool === state.originalPool && state.identityBefore === state.session.participantId && state.tokenBefore === state.session.participantToken;
        })).toBe(true);
      }

      await right.evaluate(async ({ id, path }) => {
        const state = window.acceptance;
        await state.exchange.requestChunks(id, path, state.store.missingChunks(path));
      }, { id: host.id, path });
      expect(await right.evaluate(async (path) => new TextDecoder().decode(await window.acceptance.store.assembleFile(path)), path)).toBe("hello world");
      await expect.poll(() => left.evaluate(() => window.acceptance.session.readyPeerIds())).toContain(guest.id);
      await left.evaluate((id) => {
        window.acceptance.pool.uploadBudget.setPaused(true);
        window.acceptance.session.sendReliable(id, { kind: "gameplay-while-upload-paused" });
      }, guest.id);
      await expect.poll(() => right.evaluate(() => window.acceptance.received)).toContainEqual({ kind: "gameplay-while-upload-paused" });
      expect(pageErrors).toEqual([]);
      await testInfo.attach("acceptance-scope", { body: JSON.stringify({ path: expectedPath, twoIsolatedContexts: true, browserVersion: browser.version(), resumedVerifiedChunks: true, realMobileNetwork: false, deployedTls: false }), contentType: "application/json" });
    } finally {
      for (const page of [left, right]) await page.evaluate(() => { window.acceptance?.exchange.close(); window.acceptance?.session.close(); }).catch(() => {});
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
