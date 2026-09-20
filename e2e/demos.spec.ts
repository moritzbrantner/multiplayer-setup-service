import { expect, test } from "@playwright/test";
import type { DemoLobbySession } from "../web/demo-session.ts";

declare global {
  interface Window {
    demoAcceptance: {session: DemoLobbySession; received: unknown[]; recoveries: number; initialDirect: boolean; errors: string[]};
  }
}

for (const game of ["tic-tac-toe", "pong", "arena", "card-game"]) {
  test(`${game} hosts, joins, and exchanges lobby chat`, async ({ browser }, testInfo) => {
    const { viewport, isMobile = false, hasTouch = false } = testInfo.project.use;
    const options = { ...(viewport ? {viewport} : {}), isMobile, hasTouch };
    const hostContext = await browser.newContext(options);
    const guestContext = await browser.newContext(options);
    try {
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();
      const errors: string[] = [];
      for (const page of [host, guest]) page.on("pageerror", (error) => errors.push(error.message));
      await host.goto(`/${game}.html?api=http://127.0.0.1:8787`);
      await host.locator("#host").click();
      await expect(host.locator("[data-lobby-share]")).toBeEnabled();
      const invite = await host.locator("[data-lobby-invite]").getAttribute("href");
      expect(invite).toBeTruthy();
      await guest.goto(invite!);
      await expect(host.locator("[data-lobby-chat-input]")).toBeEnabled();
      await expect(guest.locator("[data-lobby-chat-input]")).toBeEnabled();
      await host.locator("[data-lobby-chat-input]").fill("Connected from the host");
      await host.locator("[data-lobby-chat-send]").click();
      await expect(guest.locator("[data-lobby-chat-log]")).toContainText("Connected from the host");
      if (game === "tic-tac-toe") {
        await host.locator(".cell").first().click();
        await expect(guest.locator(".cell").first()).toHaveText("X");
      }
      if (game === "card-game") {
        await host.locator("#start").click();
        await expect(guest.locator("#hand .playing-card")).toHaveCount(7);
      }
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
}

test("demo transport automatically recovers stalled direct ICE using issued TURN credentials", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    // Prevent direct candidates while retaining the real browser's ICE and TURN stack.
    for (const context of [hostContext, guestContext]) await context.addInitScript(() => {
      const Peer = globalThis.RTCPeerConnection;
      globalThis.RTCPeerConnection = class extends Peer {
        constructor(configuration?: RTCConfiguration) { super({ ...configuration, iceTransportPolicy: "relay" }); }
        override setConfiguration(configuration?: RTCConfiguration) { super.setConfiguration({ ...configuration, iceTransportPolicy: "relay" }); }
      };
    });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const create = async (page: import("@playwright/test").Page, code: string | null) => {
      await page.goto("/index.html");
      return page.evaluate(async (code) => {
        const { DemoLobbySession } = await import("/demo-session.js");
        const session = new DemoLobbySession({ apiBase: "http://127.0.0.1:8787", topology: "host", iceServers: [], iceConnectionTimeoutMs: 1_000 });
        const state: Window["demoAcceptance"] = { session, received: [], recoveries: 0, initialDirect: false, errors: [] };
        window.demoAcceptance = state;
        session.addEventListener("peer-created", (event) => {
          state.initialDirect = session.links.get(event.detail.peerId)!.peer.getConfiguration().iceServers?.length === 0;
        });
        session.addEventListener("error", (event) => state.errors.push(event.detail.error instanceof Error ? event.detail.error.name : "UnknownError"));
        session.addEventListener("peer-recovery", () => state.recoveries++);
        session.addEventListener("reliable", (event) => state.received.push(event.detail.data));
        const lobby = code ? await session.join(code) : await session.host(2);
        return { code: lobby.displayCode, id: lobby.participantId };
      }, code);
    };
    const left = await create(host, null);
    const right = await create(guest, left.code);
    await expect.poll(() => host.evaluate(() => {
      const state = window.demoAcceptance;
      return {ready: state.session.readyPeerIds(), errors: state.errors, recoveries: state.recoveries,
        peers: [...state.session.links.values()].map((link) => ({connection: link.peer.connectionState, ice: link.peer.iceConnectionState, signaling: link.peer.signalingState}))};
    })).toMatchObject({ready: [right.id], errors: []});
    await expect.poll(() => guest.evaluate(() => window.demoAcceptance.session.readyPeerIds())).toEqual([left.id]);
    expect(await host.evaluate(() => window.demoAcceptance.initialDirect && window.demoAcceptance.recoveries > 0)).toBe(true);
    const relayed = await host.evaluate(async (id) => {
      const stats = await window.demoAcceptance.session.links.get(id)!.peer.getStats();
      const transport = [...stats.values()].find((stat) => stat.type === "transport" && stat.selectedCandidatePairId);
      const pair = transport && stats.get(transport.selectedCandidatePairId);
      const candidate = pair && stats.get(pair.localCandidateId);
      return candidate?.candidateType === "relay";
    }, right.id);
    expect(relayed).toBe(true);
    await host.evaluate((id) => window.demoAcceptance.session.sendReliable(id, {kind: "recovered-gameplay"}), right.id);
    await expect.poll(() => guest.evaluate(() => window.demoAcceptance.received)).toContainEqual({kind: "recovered-gameplay"});
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
