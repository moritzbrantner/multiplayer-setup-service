import { expect, test } from "@playwright/test";

async function openPong(browser, project) {
  const viewport = project.use.viewport ?? { width: 1280, height: 800 };
  const options = { viewport, isMobile: project.use.isMobile ?? false, hasTouch: project.use.hasTouch ?? false };
  const hostContext = await browser.newContext(options);
  const guestContext = await browser.newContext(options);
  await hostContext.addInitScript(() => {
    window.pongOutbound = [];
    window.pongBlockRealtime = false;
    window.pongConnections = [];
    const OriginalConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalConnection {
      constructor(...args) {
        super(...args);
        window.pongConnections.push(this);
      }
    };
    const originalSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (payload) {
      try {
        const data = JSON.parse(payload).data;
        if (data?.kind === "pong-snapshot" || data?.kind === "pong-score") {
          window.pongOutbound.push({ kind: data.kind, ...data });
        }
      } catch { /* Only record JSON gameplay envelopes. */ }
      return originalSend.call(this, payload);
    };
    const buffered = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "bufferedAmount");
    if (buffered?.get) {
      Object.defineProperty(RTCDataChannel.prototype, "bufferedAmount", {
        configurable: true,
        get() {
          return this.label === "realtime" && window.pongBlockRealtime
            ? 1_000_000 : buffered.get.call(this);
        },
      });
    }
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const pageErrors = [];
  for (const page of [host, guest]) page.on("pageerror", error => pageErrors.push(error.message));
  const hostRoom = async ({ reload = true } = {}) => {
    const priorRoom = reload ? null : await host.locator("#code").textContent();
    if (reload) await host.goto("/pong.html?api=http%3A%2F%2F127.0.0.1%3A8787");
    await host.getByRole("button", { name: "Host game" }).click();
    await expect(host.locator("#code")).not.toBeEmpty();
    if (priorRoom !== null) await expect.poll(() => host.locator("#code").textContent()).not.toBe(priorRoom);
    return (await host.locator("#code").textContent()).trim();
  };
  const joinRoom = async code => {
    await guest.goto("/pong.html?api=http%3A%2F%2F127.0.0.1%3A8787");
    await guest.getByRole("textbox", { name: "Room code" }).fill(code);
    await guest.getByRole("button", { name: "Join game" }).click();
    await expect(host.locator("#securityStatus")).toContainText("Host owns ball physics");
    await expect(guest.locator("#securityStatus")).toContainText("Guest may send paddle targets");
  };
  return { host, guest, hostRoom, joinRoom, pageErrors, close: async () => {
    await Promise.all([hostContext.close(), guestContext.close()]);
  } };
}

const snapshots = page => page.evaluate(() => window.pongOutbound.filter(item => item.kind === "pong-snapshot"));

async function clickPaddle(page, fraction) {
  const canvas = page.locator("#game");
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: Math.floor(box.width / 2), y: Math.floor(box.height * fraction) } });
}

test("Pong replays delayed timers without flooding WebRTC and honors repeated paddle changes", async ({ browser }, testInfo) => {
  const pong = await openPong(browser, testInfo.project);
  try {
    const room = await pong.hostRoom();
    await pong.joinRoom(room);
    await expect.poll(async () => (await snapshots(pong.host)).length).toBeGreaterThan(0);

    await pong.host.clock.install();
    const before = (await snapshots(pong.host)).length;
    // Fast-forward fires one throttled callback instead of 900 old timer callbacks.
    await pong.host.clock.fastForward(15_000);
    expect((await snapshots(pong.host)).length).toBe(before);
    await pong.host.clock.fastForward(100);
    expect((await snapshots(pong.host)).length - before).toBeLessThanOrEqual(1);

    const initial = (await snapshots(pong.host)).at(-1).rightY;
    await clickPaddle(pong.guest, 0.85);
    await expect.poll(async () => (await snapshots(pong.host)).at(-1)?.rightY).toBeGreaterThan(initial + 10);
    const moved = (await snapshots(pong.host)).at(-1).rightY;
    await clickPaddle(pong.guest, 0.15);
    await expect.poll(async () => (await snapshots(pong.host)).at(-1)?.rightY).toBeLessThan(moved - 10);

    await pong.host.evaluate(() => { window.pongBlockRealtime = true; });
    const blockedAt = (await snapshots(pong.host)).length;
    await pong.host.clock.runFor(250);
    expect((await snapshots(pong.host)).length).toBe(blockedAt);
    await pong.host.evaluate(() => { window.pongBlockRealtime = false; });
    await expect.poll(async () => (await snapshots(pong.host)).length).toBeGreaterThan(blockedAt);
    expect(pong.pageErrors).toEqual([]);
  } finally { await pong.close(); }
});

test("Pong resets clock and inputs when a peer session is replaced", async ({ browser }, testInfo) => {
  const pong = await openPong(browser, testInfo.project);
  try {
    const oldRoom = await pong.hostRoom();
    await pong.joinRoom(oldRoom);
    await clickPaddle(pong.guest, 0.85);
    await expect.poll(async () => (await snapshots(pong.host)).at(-1)?.rightY).toBeGreaterThan(230);
    await pong.host.evaluate(() => { window.pongConnections[0].close(); });
    await expect(pong.host.getByRole("button", { name: "Host game" })).toBeEnabled();
    const newRoom = await pong.hostRoom({ reload: false });
    expect(newRoom).not.toBe(oldRoom);
    await pong.joinRoom(newRoom);
    const count = (await snapshots(pong.host)).length;
    await expect.poll(async () => (await snapshots(pong.host)).length).toBeGreaterThan(count);
    expect(pong.pageErrors).toEqual([]);
  } finally { await pong.close(); }
});
