async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

export async function renewLobbySession(session) {
  if (!session || typeof session !== "object") {
    throw new Error("A lobby session is required");
  }

  const apiBase = requiredString(session.apiBase, "apiBase");
  const lobbyId = requiredString(session.lobbyId, "lobbyId");
  const participantId = requiredString(session.participantId, "participantId");
  const participantToken = requiredString(session.participantToken, "participantToken");
  const hostParticipantId = requiredString(session.hostParticipantId, "hostParticipantId");

  if (participantId !== hostParticipantId) {
    throw new Error("Only the lobby host can renew the lobby");
  }

  const renewal = await readJson(
    await fetch(new URL(`/lobbies/${encodeURIComponent(lobbyId)}/renew`, apiBase), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${participantToken}`,
      },
      body: JSON.stringify({ participantId }),
    }),
  );

  session.expiresAt = renewal.expiresAt;
  session.maxExpiresAt = renewal.maxExpiresAt;
  session.dispatchEvent?.(new CustomEvent("lobby-renewed", { detail: renewal }));
  return renewal;
}
