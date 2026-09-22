function requireSession(session) {
  if (!session || typeof session !== "object") throw new Error("A lobby session is required");
  for (const field of ["lobbyId", "participantId", "participantToken"]) {
    if (typeof session[field] !== "string" || session[field] === "") {
      throw new Error(`Lobby session is missing ${field}`);
    }
  }
  if (typeof session.setTurnIceServers !== "function") {
    throw new Error("Lobby session does not support TURN ICE configuration");
  }
}

function normalizeUrls(value) {
  const urls = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!urls || urls.length === 0) throw new Error("TURN ICE server must define URLs");
  for (const url of urls) {
    if (typeof url !== "string" || (!url.startsWith("turn:") && !url.startsWith("turns:"))) {
      throw new Error("TURN ICE server URLs must use turn: or turns:");
    }
  }
  return [...urls];
}

function validateIceServer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TURN ICE server must be an object");
  }
  const urls = normalizeUrls(value.urls);
  if (typeof value.username !== "string" || value.username === "") {
    throw new Error("TURN ICE server username is required");
  }
  if (typeof value.credential !== "string" || value.credential === "") {
    throw new Error("TURN ICE server credential is required");
  }
  return { urls, username: value.username, credential: value.credential };
}

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `TURN credential request failed with ${response.status}`;
    throw new Error(message);
  }
  if (!body || !Array.isArray(body.iceServers) || body.iceServers.length === 0) {
    throw new Error("TURN credential response does not contain ICE servers");
  }
  if (!Number.isSafeInteger(body.expiresAt) || body.expiresAt <= 0) {
    throw new Error("TURN credential response has an invalid expiry");
  }
  return {
    iceServers: body.iceServers.map(validateIceServer),
    expiresAt: body.expiresAt,
  };
}

export async function fetchTurnCredentials(
  session,
  { fetchImpl = globalThis.fetch } = {},
) {
  requireSession(session);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const apiBase = session.apiBase ?? globalThis.location?.origin;
  if (!apiBase) throw new Error("Lobby session is missing apiBase");
  const path = `/lobbies/${encodeURIComponent(session.lobbyId)}/turn-credentials`;
  return readJson(
    await fetchImpl(new URL(path, apiBase), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.participantToken}`,
      },
      body: JSON.stringify({ participantId: session.participantId }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    }),
  );
}

export async function refreshTurnIceServers(session, options = {}) {
  const credentials = await fetchTurnCredentials(session, options);
  session.setTurnIceServers(credentials.iceServers);
  return credentials;
}
