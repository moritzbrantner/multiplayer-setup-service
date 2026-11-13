export type NativeInvitation = { lobbyId: string; matchId: string; url: string };

export class NativeInvitationError extends Error {}

export function parseNativeInvitation(url: URL): NativeInvitation {
  const params = url.searchParams;
  const lobbyId = params.get("lobbyId") ?? "";
  const matchId = params.get("matchId") ?? "";
  if (
    url.origin !== "https://moenarch.com" || url.pathname !== "/native.html" ||
    url.username || url.password ||
    url.hash ||
    [...params.keys()].some((key) => key !== "lobbyId" && key !== "matchId") ||
    params.getAll("lobbyId").length !== 1 ||
    params.getAll("matchId").length !== 1 ||
    !/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(lobbyId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(matchId)
  ) {
    throw new NativeInvitationError("Invalid invitation. Ask the host for a new invitation link.");
  }
  const canonical = new URL("https://moenarch.com/native.html");
  canonical.searchParams.set("lobbyId", lobbyId);
  canonical.searchParams.set("matchId", matchId);
  return { lobbyId, matchId, url: canonical.href };
}

export async function checkNativeInvitation(
  invitation: NativeInvitation,
  apiOrigin: string,
  request: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<string> {
  const response = await request(
    new URL(`/lobbies/${invitation.lobbyId}`, apiOrigin),
    {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (response.status === 404) {
    throw new NativeInvitationError("This lobby is missing or expired. Ask the host for a new invitation.");
  }
  if (!response.ok) {
    throw new NativeInvitationError("The lobby service is unavailable. Try checking again shortly.");
  }
  const data: unknown = await response.json();
  if (
    typeof data !== "object" || data === null ||
    !("lobbyId" in data) || data.lobbyId !== invitation.lobbyId ||
    !("participantCount" in data) || typeof data.participantCount !== "number" ||
    !Number.isInteger(data.participantCount) || data.participantCount < 1 ||
    !("maxParticipants" in data) || typeof data.maxParticipants !== "number" ||
    !Number.isInteger(data.maxParticipants) || data.maxParticipants < 2 ||
    data.maxParticipants > 16 || data.participantCount > data.maxParticipants ||
    !("expiresAt" in data) || typeof data.expiresAt !== "number" ||
    !Number.isSafeInteger(data.expiresAt) || data.expiresAt < 0
  ) {
    throw new NativeInvitationError("The lobby service returned invalid metadata. Try checking again.");
  }
  if (data.expiresAt <= now) {
    throw new NativeInvitationError("This lobby has expired. Ask the host for a new invitation.");
  }
  if (data.participantCount === data.maxParticipants) {
    throw new NativeInvitationError("This lobby is full. Ask the host for an available place, then check again.");
  }
  return `Lobby found (${data.participantCount}/${data.maxParticipants} participants). Host availability and access will be checked by the native client.`;
}
