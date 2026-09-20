import { isRecord } from "./events.ts";
export type TurnSession = {apiBase: string; lobbyId: string | null; participantId: string | null; participantToken: string | null; setTurnIceServers: (servers: RTCIceServer[]) => void};
export type TurnCredentials = {iceServers: RTCIceServer[]; expiresAt: number};
export class TurnCredentialError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}
function requireSession(session: TurnSession): asserts session is TurnSession & {lobbyId: string; participantId: string; participantToken: string} {
  if (!session || typeof session !== "object") throw new Error("A lobby session is required");
  for (const field of ["lobbyId", "participantId", "participantToken"] as const) {
    if (typeof session[field] !== "string" || session[field] === "") {
      throw new Error(`Lobby session is missing ${field}`);
    }
  }
  if (typeof session.setTurnIceServers !== "function") {
    throw new Error("Lobby session does not support TURN ICE configuration");
  }
}

function normalizeUrls(value: unknown): string[] {
  const urls = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!urls || urls.length === 0) throw new Error("TURN ICE server must define URLs");
  for (const url of urls) {
    if (typeof url !== "string" || (!url.startsWith("turn:") && !url.startsWith("turns:"))) {
      throw new Error("TURN ICE server URLs must use turn: or turns:");
    }
  }
  return urls.map((url: unknown) => {
    if (typeof url !== "string") throw new Error("Invalid TURN URL");
    return url;
  });
}

function validateIceServer(value: unknown): RTCIceServer {
  if (!isRecord(value)) {
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

async function readJson(response: Response): Promise<TurnCredentials> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `TURN credential request failed with ${response.status}`;
    throw new TurnCredentialError(message, body?.error?.code ?? "turn-request-failed");
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
  session: TurnSession,
  { fetchImpl = globalThis.fetch, signal }: {fetchImpl?: typeof fetch; signal?: AbortSignal} = {},
) {
  requireSession(session);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const apiBase = session.apiBase ?? globalThis.location?.origin;
  if (!apiBase) throw new Error("Lobby session is missing apiBase");
  const path = `/lobbies/${encodeURIComponent(session.lobbyId)}/turn-credentials`;
  return readJson(
    await fetchImpl(new URL(path, apiBase), {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
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

export async function refreshTurnIceServers(session: TurnSession, options: {fetchImpl?: typeof fetch; signal?: AbortSignal} = {}) {
  const credentials = await fetchTurnCredentials(session, options);
  session.setTurnIceServers(credentials.iceServers);
  return credentials;
}
