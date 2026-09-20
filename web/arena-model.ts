import { isRecord } from "./events.ts";
export type Position = {x: number; y: number};
export type StepCommand = {type: "step"; participantId: string; seq: number; dx: number; dy: number};
export type ArenaState = {players: Map<string, Position>; lastSequence: Map<string, number>; participants: Set<string>};
const MIN_POSITION = 20;
const MAX_POSITION = 980;
const STEP_DISTANCE = 12;

function clampPosition(value: number) {
  return Math.max(MIN_POSITION, Math.min(MAX_POSITION, value));
}

export function hashId(id: string) {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function initialPlayer(id: string) {
  const hash = hashId(id);
  return { x: 80 + (hash % 841), y: 80 + ((hash >>> 10) % 841) };
}

export function validStep(message: unknown): message is StepCommand {
  return (
    isRecord(message) && message.type === "step" &&
    typeof message.participantId === "string" &&
    message.participantId.length > 0 &&
    typeof message.seq === "number" && Number.isInteger(message.seq) &&
    message.seq > 0 &&
    typeof message.dx === "number" && Number.isInteger(message.dx) &&
    typeof message.dy === "number" && Number.isInteger(message.dy) &&
    Math.abs(message.dx) + Math.abs(message.dy) === 1
  );
}

export function applyStepToState({ players, lastSequence, participants }: ArenaState, message: unknown) {
  if (!validStep(message) || !participants.has(message.participantId)) return false;

  const previous = lastSequence.get(message.participantId) ?? 0;
  if (message.seq <= previous) return false;

  const current = players.get(message.participantId) ?? initialPlayer(message.participantId);
  players.set(message.participantId, {
    x: clampPosition(current.x + message.dx * STEP_DISTANCE),
    y: clampPosition(current.y + message.dy * STEP_DISTANCE),
  });
  lastSequence.set(message.participantId, message.seq);
  return true;
}

export function applySnapshotEntry({ players, lastSequence, participants }: ArenaState, snapshot: unknown) {
  if (
    !isRecord(snapshot) || typeof snapshot.id !== "string" ||
    !participants.has(snapshot.id) ||
    typeof snapshot.x !== "number" || !Number.isInteger(snapshot.x) ||
    typeof snapshot.y !== "number" || !Number.isInteger(snapshot.y) ||
    typeof snapshot.seq !== "number" || !Number.isInteger(snapshot.seq) ||
    snapshot.seq < 0
  ) {
    return false;
  }

  const previous = lastSequence.get(snapshot.id) ?? 0;
  if (snapshot.seq < previous) return false;

  players.set(snapshot.id, {
    x: clampPosition(snapshot.x),
    y: clampPosition(snapshot.y),
  });
  lastSequence.set(snapshot.id, snapshot.seq);
  return true;
}

export function topologyEdgeCount(topology: string, participantCount: number) {
  if (topology !== "mesh" && topology !== "host") {
    throw new Error("Unknown topology");
  }
  if (!Number.isInteger(participantCount) || participantCount < 0) {
    throw new Error("Participant count must be a non-negative integer");
  }
  return topology === "mesh"
    ? (participantCount * (participantCount - 1)) / 2
    : Math.max(0, participantCount - 1);
}

export function isTopologyReady({
  topology,
  participantId,
  hostParticipantId,
  participantCount,
  readyPeerIds,
}: {topology: string; participantId: string; hostParticipantId: string; participantCount: number; readyPeerIds: string[]}) {
  const ready = new Set(readyPeerIds);
  if (topology === "mesh") {
    return ready.size === Math.max(0, participantCount - 1);
  }
  if (topology !== "host") return false;
  if (participantId === hostParticipantId) {
    return ready.size === Math.max(0, participantCount - 1);
  }
  return ready.has(hostParticipantId);
}
