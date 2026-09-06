import {
  CAPABILITY_PROTOCOL_PREFIX,
  hashCapabilityToken,
  isPeerRole,
  otherRole,
  parseClientMessage,
  WEBSOCKET_PROTOCOL,
  type PeerRole,
  type ServerMessage,
} from "./protocol";

type RoomRecord = {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hostTokenHash: string;
  readonly guestTokenHash?: string;
  readonly pairedAt?: number;
};

type PeerAttachment = {
  readonly role: PeerRole;
};

const ROOM_STORAGE_KEY = "room";

export class SignalingRoom {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/initialize")) {
      return this.initialize(request);
    }

    if (request.method === "POST" && url.pathname.endsWith("/join")) {
      return this.join(request);
    }

    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      return this.status();
    }

    if (request.method === "GET" && url.pathname.endsWith("/connect")) {
      return this.connect(request);
    }

    return jsonResponse(
      { error: { code: "not-found", message: "Room endpoint not found" } },
      404,
    );
  }

  async webSocketMessage(
    socket: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) {
      socket.close(1011, "Missing peer attachment");
      return;
    }

    if (typeof message !== "string") {
      socket.close(1003, "Text messages required");
      return;
    }

    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      if (parsed.code === "message-too-large") {
        socket.close(1009, "Signaling message too large");
        return;
      }

      this.send(socket, {
        type: "error",
        code: "invalid-message",
        message: "Expected a signaling envelope or ping",
      });
      return;
    }

    if (parsed.value.type === "ping") {
      this.send(
        socket,
        parsed.value.nonce === undefined
          ? { type: "pong" }
          : { type: "pong", nonce: parsed.value.nonce },
      );
      return;
    }

    const peer = this.findSocket(otherRole(attachment.role));
    if (!peer) {
      this.send(socket, {
        type: "error",
        code: "peer-not-connected",
        message: "The other peer is not connected to signaling yet",
      });
      return;
    }

    this.send(peer, {
      type: "signal",
      from: attachment.role,
      payload: parsed.value.payload,
    });
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) {
      return;
    }

    this.notifyRole(otherRole(attachment.role), {
      type: "peer-disconnected",
      peerRole: attachment.role,
    });
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Signaling socket error");
  }

  async alarm(): Promise<void> {
    await this.expireRoom();
  }

  private async initialize(request: Request): Promise<Response> {
    const existing = await this.state.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    if (existing && existing.expiresAt > Date.now()) {
      return jsonResponse(
        { error: { code: "room-exists", message: "Room already exists" } },
        409,
      );
    }

    const input = await parseJson<{
      createdAt?: unknown;
      expiresAt?: unknown;
      hostTokenHash?: unknown;
    }>(request);

    if (
      !input ||
      typeof input.createdAt !== "number" ||
      typeof input.expiresAt !== "number" ||
      typeof input.hostTokenHash !== "string" ||
      input.hostTokenHash.length !== 64 ||
      input.expiresAt <= input.createdAt
    ) {
      return jsonResponse(
        {
          error: {
            code: "invalid-initialize",
            message: "Invalid room initialization payload",
          },
        },
        400,
      );
    }

    if (existing) {
      await this.expireRoom();
    }

    const room: RoomRecord = {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      hostTokenHash: input.hostTokenHash,
    };

    await this.state.storage.put(ROOM_STORAGE_KEY, room);
    await this.state.storage.setAlarm(room.expiresAt);

    return jsonResponse(
      { status: "waiting", expiresAt: room.expiresAt },
      201,
    );
  }

  private async join(request: Request): Promise<Response> {
    const room = await this.getLiveRoom();
    if (!room) {
      return jsonResponse(
        { error: { code: "room-not-found", message: "Room is not available" } },
        404,
      );
    }

    if (room.guestTokenHash) {
      return jsonResponse(
        { error: { code: "room-full", message: "Room already has two peers" } },
        409,
      );
    }

    const input = await parseJson<{ guestTokenHash?: unknown }>(request);
    if (
      !input ||
      typeof input.guestTokenHash !== "string" ||
      input.guestTokenHash.length !== 64
    ) {
      return jsonResponse(
        {
          error: {
            code: "invalid-join",
            message: "Invalid room join payload",
          },
        },
        400,
      );
    }

    const paired: RoomRecord = {
      ...room,
      guestTokenHash: input.guestTokenHash,
      pairedAt: Date.now(),
    };
    await this.state.storage.put(ROOM_STORAGE_KEY, paired);

    return jsonResponse(
      { status: "paired", expiresAt: paired.expiresAt },
      200,
    );
  }

  private async status(): Promise<Response> {
    const room = await this.getLiveRoom();
    if (!room) {
      return jsonResponse(
        { error: { code: "room-not-found", message: "Room is not available" } },
        404,
      );
    }

    return jsonResponse({
      status: room.guestTokenHash ? "paired" : "waiting",
      expiresAt: room.expiresAt,
    });
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(
        {
          error: {
            code: "websocket-required",
            message: "Expected a WebSocket upgrade request",
          },
        },
        426,
      );
    }

    const room = await this.getLiveRoom();
    if (!room) {
      return jsonResponse(
        { error: { code: "room-not-found", message: "Room is not available" } },
        404,
      );
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const protocols = parseWebSocketProtocols(request);
    const token = protocols
      .find((protocol) => protocol.startsWith(CAPABILITY_PROTOCOL_PREFIX))
      ?.slice(CAPABILITY_PROTOCOL_PREFIX.length);
    if (
      !isPeerRole(role) ||
      !protocols.includes(WEBSOCKET_PROTOCOL) ||
      !token ||
      token.length !== 64
    ) {
      return jsonResponse(
        {
          error: {
            code: "invalid-credentials",
            message: "A valid role and capability token are required",
          },
        },
        401,
      );
    }

    const expectedHash =
      role === "host" ? room.hostTokenHash : room.guestTokenHash;
    if (!expectedHash || (await hashCapabilityToken(token)) !== expectedHash) {
      return jsonResponse(
        {
          error: {
            code: "invalid-credentials",
            message: "A valid role and capability token are required",
          },
        },
        401,
      );
    }

    this.replaceExistingSocket(role);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role } satisfies PeerAttachment);
    this.state.acceptWebSocket(server);

    this.send(server, { type: "connected", role });

    const peerRole = otherRole(role);
    if (this.findSocket(peerRole)) {
      this.send(server, { type: "peer-connected", peerRole });
      this.notifyRole(peerRole, { type: "peer-connected", peerRole: role });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": WEBSOCKET_PROTOCOL },
    });
  }

  private async getLiveRoom(): Promise<RoomRecord | null> {
    const room = await this.state.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    if (!room) {
      return null;
    }

    if (room.expiresAt <= Date.now()) {
      await this.expireRoom();
      return null;
    }

    return room;
  }

  private async expireRoom(): Promise<void> {
    for (const socket of this.state.getWebSockets()) {
      socket.close(4000, "Room expired");
    }

    await this.state.storage.deleteAll();
  }

  private replaceExistingSocket(role: PeerRole): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as PeerAttachment | null;
      if (attachment?.role === role) {
        socket.close(4001, "Replaced by a newer signaling connection");
      }
    }
  }

  private findSocket(role: PeerRole): WebSocket | null {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as PeerAttachment | null;
      if (attachment?.role === role && socket.readyState === WebSocket.OPEN) {
        return socket;
      }
    }

    return null;
  }

  private notifyRole(role: PeerRole, message: ServerMessage): void {
    const socket = this.findSocket(role);
    if (socket) {
      this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

async function parseJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseWebSocketProtocols(request: Request): string[] {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
