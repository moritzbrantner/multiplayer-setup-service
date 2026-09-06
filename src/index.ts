import {
  formatRoomCode,
  generateCapabilityToken,
  generateRoomId,
  hashCapabilityToken,
  isValidRoomId,
  normalizeRoomId,
} from "./protocol";
import { SignalingRoom } from "./room";

const DEFAULT_ROOM_TTL_SECONDS = 600;
const MIN_ROOM_TTL_SECONDS = 60;
const MAX_ROOM_TTL_SECONDS = 3600;
const MAX_ROOM_CREATION_ATTEMPTS = 5;
const DEFAULT_ALLOWED_ORIGINS =
  "https://moritzbrantner.github.io,http://localhost:*,http://127.0.0.1:*";

export { SignalingRoom } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const originCheck = ensureOriginAllowed(request, env);
    if (originCheck) {
      return originCheck;
    }

    if (request.method === "OPTIONS") {
      return withCors(request, env, new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(
        request,
        env,
        Response.json({
          status: "ok",
          service: "multiplayer-setup-service",
          protocolVersion: 1,
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/rooms") {
      return withCors(request, env, await createRoom(env));
    }

    const roomRoute = matchRoomRoute(url.pathname);
    if (!roomRoute) {
      return withCors(
        request,
        env,
        errorResponse("not-found", "Endpoint not found", 404),
      );
    }

    const roomId = normalizeRoomId(roomRoute.roomId);
    if (!isValidRoomId(roomId)) {
      return withCors(
        request,
        env,
        errorResponse("invalid-room-id", "Invalid room code", 400),
      );
    }

    if (request.method === "POST" && roomRoute.action === "join") {
      return withCors(request, env, await joinRoom(env, roomId));
    }

    if (request.method === "GET" && roomRoute.action === "status") {
      return withCors(request, env, await getRoomStatus(env, roomId));
    }

    if (request.method === "GET" && roomRoute.action === "connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return withCors(
          request,
          env,
          errorResponse(
            "websocket-required",
            "Expected a WebSocket upgrade request",
            426,
          ),
        );
      }

      return roomStub(env, roomId).fetch(request);
    }

    return withCors(
      request,
      env,
      errorResponse("method-not-allowed", "Method not allowed", 405),
    );
  },
} satisfies ExportedHandler<Env>;

async function createRoom(env: Env): Promise<Response> {
  const ttlSeconds = roomTtlSeconds(env);

  for (let attempt = 0; attempt < MAX_ROOM_CREATION_ATTEMPTS; attempt += 1) {
    const roomId = generateRoomId();
    const hostToken = generateCapabilityToken();
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlSeconds * 1000;
    const hostTokenHash = await hashCapabilityToken(hostToken);

    const response = await roomStub(env, roomId).fetch(
      internalRequest("/initialize", {
        method: "POST",
        body: JSON.stringify({ createdAt, expiresAt, hostTokenHash }),
      }),
    );

    if (response.status === 409) {
      continue;
    }

    if (!response.ok) {
      return errorResponse(
        "room-initialization-failed",
        "Could not initialize room",
        502,
      );
    }

    return Response.json(
      {
        roomId,
        displayCode: formatRoomCode(roomId),
        role: "host",
        hostToken,
        expiresAt,
        websocketPath: `/rooms/${roomId}/connect`,
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return errorResponse(
    "room-id-exhausted",
    "Could not allocate a room code",
    503,
  );
}

async function joinRoom(env: Env, roomId: string): Promise<Response> {
  const guestToken = generateCapabilityToken();
  const guestTokenHash = await hashCapabilityToken(guestToken);
  const response = await roomStub(env, roomId).fetch(
    internalRequest("/join", {
      method: "POST",
      body: JSON.stringify({ guestTokenHash }),
    }),
  );

  if (!response.ok) {
    return cloneJsonResponse(response);
  }

  const status = (await response.json()) as { expiresAt: number };
  return Response.json(
    {
      roomId,
      displayCode: formatRoomCode(roomId),
      role: "guest",
      guestToken,
      expiresAt: status.expiresAt,
      websocketPath: `/rooms/${roomId}/connect`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function getRoomStatus(env: Env, roomId: string): Promise<Response> {
  const response = await roomStub(env, roomId).fetch(internalRequest("/status"));
  if (!response.ok) {
    return cloneJsonResponse(response);
  }

  const status = (await response.json()) as Record<string, unknown>;
  return Response.json({ roomId, displayCode: formatRoomCode(roomId), ...status });
}

function roomStub(env: Env, roomId: string): DurableObjectStub {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function internalRequest(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new Request(`https://room.internal${path}`, { ...init, headers });
}

function matchRoomRoute(
  pathname: string,
): { roomId: string; action: "join" | "status" | "connect" } | null {
  const match = /^\/rooms\/([^/]+)(?:\/(join|connect))?$/.exec(pathname);
  if (!match) {
    return null;
  }

  const roomId = match[1];
  if (!roomId) {
    return null;
  }

  return {
    roomId,
    action: (match[2] ?? "status") as "join" | "status" | "connect",
  };
}

function roomTtlSeconds(env: Env): number {
  const configured = Number.parseInt(env.ROOM_TTL_SECONDS ?? "", 10);
  if (!Number.isFinite(configured)) {
    return DEFAULT_ROOM_TTL_SECONDS;
  }

  return Math.max(
    MIN_ROOM_TTL_SECONDS,
    Math.min(MAX_ROOM_TTL_SECONDS, configured),
  );
}

function ensureOriginAllowed(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin || originAllowed(origin, env)) {
    return null;
  }

  return errorResponse("origin-not-allowed", "Origin is not allowed", 403);
}

function originAllowed(origin: string, env: Env): boolean {
  const configured = env.ALLOWED_ORIGINS?.trim() || DEFAULT_ALLOWED_ORIGINS;
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .some((pattern) => originMatches(origin, pattern));
}

function originMatches(origin: string, pattern: string): boolean {
  if (origin === pattern) {
    return true;
  }

  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1);
    return origin.startsWith(prefix);
  }

  return false;
}

function withCors(request: Request, env: Env, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !originAllowed(origin, env)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.append("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cloneJsonResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
