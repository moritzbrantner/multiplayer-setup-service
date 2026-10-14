import { expect, test } from "@playwright/test";

// This tests the real launcher + setup service boundary. The controlled Pages
// popup deliberately implements only its public postMessage protocol. Actual
// Rust Scrabble/WebTransport gameplay remains scrabble#80 acceptance.
const pages = "https://moritzbrantner.github.io/scrabble/";
const match = "b_000000006ac18f30_0123456789abcdef0123456789abcdef";
const setupApi = "http://127.0.0.1:8787";
const launcher = "/scrabble.html?setupApi=" + encodeURIComponent(setupApi);

test.use({ trace: "off" }); // Host capabilities must not enter retained traces.

test("host binds one public match, rejects forged messages, guests share the player route", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const credentials = [];
  const registrations = [];
  // Keep secrets in memory only and assert booleans, never print their values.
  host.on("response", async (response) => {
    if (
      response.request().method() === "POST" &&
      response.url() === setupApi + "/lobbies"
    ) {
      credentials.push((await response.json()).participantToken);
    }
  });
  host.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/game-reference"))
      registrations.push(request.postDataJSON());
  });
  for (const context of [hostContext, guestContext]) {
    await context.route("https://moritzbrantner.github.io/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Controlled Scrabble Pages protocol peer</title><p>Scrabble boundary fixture</p>",
      }),
    );
    await context.route("https://untrusted.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Untrusted origin</title>",
      }),
    );
  }
  try {
    await host.goto("http://127.0.0.1:4173" + launcher);
    await host
      .getByRole("button", { name: "Create Scrabble lobby", exact: true })
      .click();
    const invite = host.getByRole("link", { name: "Invite link", exact: true });
    await expect(invite).toHaveAttribute("href", /session=/);
    const inviteUrl = new URL(await invite.getAttribute("href"), host.url());
    const session = inviteUrl.searchParams.get("session");
    expect(session).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    expect([...inviteUrl.searchParams.keys()].sort()).toEqual([
      "session",
      "setupApi",
    ]);
    const popupEvent = host.waitForEvent("popup");
    await host
      .getByRole("button", { name: "Open Scrabble board", exact: true })
      .click();
    const board = await popupEvent;
    await board.waitForLoadState();
    const boardUrl = new URL(board.url());
    expect(boardUrl.origin + boardUrl.pathname).toBe(pages.slice(0, -1) + "/");
    expect(Object.fromEntries(boardUrl.searchParams)).toEqual({
      launch: "moenarch",
      session,
      view: "board",
    });
    const message = { type: "scrabble-match-created", session, match };
    const report = async (page, data) =>
      page.evaluate(
        (data) => window.opener.postMessage(data, "http://127.0.0.1:4173"),
        data,
      );
    // The popup source is genuine, but the session does not match this lobby.
    await report(board, { ...message, session: "ZZZZZZZZZZZZ" });
    await report(board, { ...message, match: "https://untrusted.example/" });
    // A correct origin and session cannot authorize a different popup.
    const unrelatedEvent = host.waitForEvent("popup");
    await host.evaluate((url) => window.open(url), pages + "?unrelated=1");
    const unrelated = await unrelatedEvent;
    await unrelated.waitForLoadState();
    await report(unrelated, message);
    // Even the designated popup loses authority after changing origin.
    await board.goto("https://untrusted.example/");
    await report(board, message);
    // Message dispatch is asynchronous: a later posted barrier proves all the
    // earlier messages were delivered before inspecting network side effects.
    await host.evaluate(
      () =>
        new Promise((resolve) => {
          const barrier = (event) => {
            if (event.data === "acceptance-barrier") {
              window.removeEventListener("message", barrier);
              resolve(null);
            }
          };
          window.addEventListener("message", barrier);
          window.postMessage("acceptance-barrier", window.location.origin);
        }),
    );
    expect(registrations.length).toBe(0);
    expect(
      (
        await host.request.get(`${setupApi}/lobbies/${session}/game-reference`)
      ).status(),
    ).toBe(409);
    await board.goto(boardUrl.href);
    await report(board, message);
    await expect
      .poll(async () =>
        (
          await host.request.get(
            `${setupApi}/lobbies/${session}/game-reference`,
          )
        ).status(),
      )
      .toBe(200);
    // Duplicate successful delivery is safe and never creates another board.
    await report(board, message);
    await host
      .getByRole("button", { name: "Open Scrabble board", exact: true })
      .click();
    expect(hostContext.pages().length).toBe(3); // launcher, original board, unrelated popup
    const publicReference = await (
      await host.request.get(`${setupApi}/lobbies/${session}/game-reference`)
    ).json();
    expect(publicReference).toEqual({
      application: "scrabble",
      matchId: match,
    });
    await guest.goto(inviteUrl.href);
    const playerEvent = guest.waitForEvent("popup");
    await guest
      .getByRole("button", { name: "Open Scrabble player", exact: true })
      .click();
    const player = await playerEvent;
    await player.waitForLoadState();
    const playerUrl = new URL(player.url());
    expect(playerUrl.origin + playerUrl.pathname).toBe(pages);
    expect(Object.fromEntries(playerUrl.searchParams)).toEqual({
      launch: "moenarch",
      session,
      match,
      view: "player",
    });
    // Losing the in-memory host capability on reload must resolve the existing
    // reference, never create a new game or regain host write authority.
    await host.goto(inviteUrl.href);
    await expect(
      host.getByRole("button", { name: "Open Scrabble player", exact: true }),
    ).toBeEnabled();
    await expect(
      host.getByRole("button", { name: "Open Scrabble board", exact: true }),
    ).toHaveCount(0);
    expect(credentials.length).toBe(1);
    for (const page of [host, board, guest, player]) {
      const state = await page.evaluate(() => ({
        url: location.href,
        local: JSON.stringify(localStorage),
        session: JSON.stringify(sessionStorage),
      }));
      expect(
        credentials.every(
          (secret) =>
            !Object.values(state).some((value) => value.includes(secret)),
        ),
      ).toBe(true);
    }
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
