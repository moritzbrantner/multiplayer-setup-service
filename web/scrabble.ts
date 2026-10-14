const pages = new URL("https://moritzbrantner.github.io/scrabble/");
const params = new URLSearchParams(location.search);
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
  location.hostname,
);
const api = new URL(
  loopback ? params.get("setupApi") || location.origin : location.origin,
);
const canonicalLobby = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const canonicalMatch = /^b_[0-9a-f]{16}_[0-9a-f]{32}$/;

function button(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("Missing launcher control");
  }
  return element;
}
const create = button("create");
const board = button("board");
const player = button("player");
const refresh = button("refresh");
const status = document.getElementById("status");
const invite = document.getElementById("invite");
if (!(invite instanceof HTMLAnchorElement) || !status) {
  throw new Error("Missing launcher view");
}
const statusView = status;
const inviteLink = invite;
let session = params.get("session");
let host: { participantId: string; participantToken: string } | undefined;
let match: string | undefined;
let boardWindow: Window | null = null;
let binding = false;

function say(message: string) {
  statusView.textContent = message;
}
function inviteUrl() {
  const url = new URL(location.pathname, location.origin);
  if (session) {
    url.searchParams.set("session", session);
  }
  if (loopback && params.has("setupApi")) {
    url.searchParams.set("setupApi", api.origin);
  }
  return url;
}
function showSession() {
  inviteLink.href = inviteUrl().href;
  inviteLink.hidden = false;
  history.replaceState(null, "", inviteUrl());
  create.hidden = true;
  board.hidden = !host;
  refresh.hidden = false;
}
function gameUrl(view: "board" | "player", lobby: string) {
  const url = new URL(pages);
  url.searchParams.set("launch", "moenarch");
  url.searchParams.set("session", lobby);
  if (view === "player" && match) {
    url.searchParams.set("match", match);
  }
  url.searchParams.set("view", view);
  return url;
}
async function resolve() {
  if (!session) {
    return;
  }
  refresh.disabled = true;
  try {
    const response = await fetch(
      new URL(`/lobbies/${session}/game-reference`, api),
      { cache: "no-store" },
    );
    const data: unknown = await response.json();
    if (response.status === 409) {
      say(
        "Waiting for the board to create the game. Check again when it is ready.",
      );
      return;
    }
    if (!response.ok) {
      throw new Error(
        "Lobby is unavailable or expired. Use an existing Scrabble match invitation to continue playing.",
      );
    }
    if (
      typeof data !== "object" ||
      data === null ||
      !("application" in data) ||
      data.application !== "scrabble" ||
      !("matchId" in data) ||
      typeof data.matchId !== "string" ||
      !canonicalMatch.test(data.matchId)
    ) {
      throw new Error("Invalid game reference.");
    }
    match = data.matchId;
    player.hidden = false;
    say("Game ready. Open your player screen.");
  } catch (error) {
    say(
      error instanceof Error
        ? error.message
        : "Cannot load the game. Try again.",
    );
  } finally {
    refresh.disabled = false;
  }
}
create.addEventListener("click", async () => {
  create.disabled = true;
  try {
    const response = await fetch(new URL("/lobbies", api), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxParticipants: 16 }),
    });
    if (!response.ok) {
      throw new Error("Cannot create a lobby. Try again.");
    }
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("lobbyId" in data) ||
      typeof data.lobbyId !== "string" ||
      !canonicalLobby.test(data.lobbyId) ||
      !("participantId" in data) ||
      !("participantToken" in data) ||
      typeof data.participantId !== "string" ||
      typeof data.participantToken !== "string"
    ) {
      throw new Error("Invalid lobby response.");
    }
    session = data.lobbyId;
    host = {
      participantId: data.participantId,
      participantToken: data.participantToken,
    };
    showSession();
    say("Share the invite link, then open the Scrabble board.");
  } catch (error) {
    say(error instanceof Error ? error.message : "Cannot create a lobby.");
  } finally {
    create.disabled = false;
  }
});
board.addEventListener("click", () => {
  if (!host || !session) {
    return;
  }
  if (boardWindow && !boardWindow.closed) {
    boardWindow.focus();
    return;
  }
  if (match) {
    say(
      "The game already exists. Open a player screen or return to its board invitation.",
    );
    return;
  }
  // A closed board may have created a game without delivering its result. Do
  // not replace it silently: creation nonce ownership remains with that board.
  if (boardWindow) {
    say(
      "The board was closed. Reopen its original Scrabble address to recover the game.",
    );
    return;
  }
  boardWindow = window.open(gameUrl("board", session), "_blank");
  if (!boardWindow) {
    say("Allow popups, then open the board again.");
  }
});
player.addEventListener("click", () => {
  if (match && session) {
    window.open(gameUrl("player", session), "_blank", "noopener");
  }
});
refresh.addEventListener("click", resolve);
window.addEventListener("message", async (event: MessageEvent<unknown>) => {
  if (
    !host ||
    !session ||
    binding ||
    event.origin !== pages.origin ||
    event.source !== boardWindow
  ) {
    return;
  }
  const data = event.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("type" in data) ||
    data.type !== "scrabble-match-created" ||
    !("session" in data) ||
    data.session !== session ||
    !("match" in data) ||
    typeof data.match !== "string" ||
    !canonicalMatch.test(data.match)
  ) {
    return;
  }
  binding = true;
  try {
    const response = await fetch(
      new URL(`/lobbies/${session}/game-reference`, api),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${host.participantToken}`,
        },
        body: JSON.stringify({
          participantId: host.participantId,
          application: "scrabble",
          matchId: data.match,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        "Cannot register this game. Return to the board and retry the invitation.",
      );
    }
    await resolve();
  } catch (error) {
    say(error instanceof Error ? error.message : "Cannot register the game.");
  } finally {
    binding = false;
  }
});
if (session) {
  create.hidden = true;
  if (canonicalLobby.test(session)) {
    showSession();
    void resolve();
  } else {
    say("Invalid lobby invitation.");
  }
}
