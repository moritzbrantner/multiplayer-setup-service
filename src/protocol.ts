export const ROOM_CODE_LENGTH = 12;
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_SIGNAL_BYTES = 32 * 1024;
export const WEBSOCKET_PROTOCOL = "multiplayer-setup-v1";
export const CAPABILITY_PROTOCOL_PREFIX = "cap.";

export type PeerRole = "host" | "guest";

export type ClientMessage =
  | { readonly type: "ping"; readonly nonce?: string }
  | { readonly type: "signal"; readonly payload: unknown };

export type ServerMessage =
  | { readonly type: "connected"; readonly role: PeerRole }
  | { readonly type: "peer-connected"; readonly peerRole: PeerRole }
  | { readonly type: "peer-disconnected"; readonly peerRole: PeerRole }
  | { readonly type: "pong"; readonly nonce?: string }
  | {
      readonly type: "signal";
      readonly from: PeerRole;
      readonly payload: unknown;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
    };

export type ParseClientMessageResult =
  | { readonly ok: true; readonly value: ClientMessage }
  | {
      readonly ok: false;
      readonly code: "invalid-message" | "message-too-large";
    };

export function normalizeRoomId(value: string): string {
  return value.toUpperCase().replaceAll("-", "").replaceAll(" ", "");
}

export function isValidRoomId(value: string): boolean {
  const normalized = normalizeRoomId(value);
  return (
    normalized.length === ROOM_CODE_LENGTH &&
    [...normalized].every((character) => ROOM_CODE_ALPHABET.includes(character))
  );
}

export function formatRoomCode(value: string): string {
  const normalized = normalizeRoomId(value);
  if (!isValidRoomId(normalized)) {
    throw new Error("Invalid room ID");
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8)}`;
}

export function generateRoomId(): string {
  const random = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return [...random]
    .map((byte) => ROOM_CODE_ALPHABET[byte & 31])
    .join("");
}

export function generateCapabilityToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

export async function hashCapabilityToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseClientMessage(text: string): ParseClientMessageResult {
  if (new TextEncoder().encode(text).byteLength > MAX_SIGNAL_BYTES) {
    return { ok: false, code: "message-too-large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-message" };
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { ok: false, code: "invalid-message" };
  }

  if (parsed.type === "ping") {
    const nonce = parsed.nonce;
    if (
      nonce !== undefined &&
      (typeof nonce !== "string" || nonce.length > 128)
    ) {
      return { ok: false, code: "invalid-message" };
    }

    return {
      ok: true,
      value:
        nonce === undefined ? { type: "ping" } : { type: "ping", nonce },
    };
  }

  if (parsed.type === "signal" && Object.hasOwn(parsed, "payload")) {
    return { ok: true, value: { type: "signal", payload: parsed.payload } };
  }

  return { ok: false, code: "invalid-message" };
}

export function otherRole(role: PeerRole): PeerRole {
  return role === "host" ? "guest" : "host";
}

export function isPeerRole(value: string | null): value is PeerRole {
  return value === "host" || value === "guest";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
