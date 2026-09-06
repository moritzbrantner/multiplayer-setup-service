import { describe, expect, it } from "vitest";
import {
  formatRoomCode,
  generateCapabilityToken,
  generateRoomId,
  hashCapabilityToken,
  isValidRoomId,
  MAX_SIGNAL_BYTES,
  normalizeRoomId,
  parseClientMessage,
} from "../src/protocol";

describe("room codes", () => {
  it("generates normalized human-readable room IDs", () => {
    for (let index = 0; index < 32; index += 1) {
      const roomId = generateRoomId();
      expect(roomId).toHaveLength(12);
      expect(isValidRoomId(roomId)).toBe(true);
      expect(formatRoomCode(roomId)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  it("normalizes lowercase and separators", () => {
    expect(normalizeRoomId("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(isValidRoomId("abcd-efgh-jkmn")).toBe(true);
  });

  it("rejects ambiguous Crockford characters", () => {
    expect(isValidRoomId("OOOOOOOOOOOO")).toBe(false);
    expect(isValidRoomId("IIIIIIIIIIII")).toBe(false);
    expect(isValidRoomId("LLLLLLLLLLLL")).toBe(false);
    expect(isValidRoomId("UUUUUUUUUUUU")).toBe(false);
  });
});

describe("capability tokens", () => {
  it("hashes tokens deterministically without storing the plaintext", async () => {
    const token = generateCapabilityToken();
    const first = await hashCapabilityToken(token);
    const second = await hashCapabilityToken(token);

    expect(token).toHaveLength(64);
    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toContain(token);
  });
});

describe("signaling envelopes", () => {
  it("accepts opaque signaling payloads", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "signal",
          payload: { description: { type: "offer", sdp: "v=0" } },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        type: "signal",
        payload: { description: { type: "offer", sdp: "v=0" } },
      },
    });
  });

  it("accepts bounded pings", () => {
    expect(parseClientMessage('{"type":"ping","nonce":"abc"}')).toEqual({
      ok: true,
      value: { type: "ping", nonce: "abc" },
    });
  });

  it("rejects malformed and oversized frames", () => {
    expect(parseClientMessage("not-json")).toEqual({
      ok: false,
      code: "invalid-message",
    });

    const oversized = JSON.stringify({
      type: "signal",
      payload: "x".repeat(MAX_SIGNAL_BYTES),
    });
    expect(parseClientMessage(oversized)).toEqual({
      ok: false,
      code: "message-too-large",
    });
  });
});
