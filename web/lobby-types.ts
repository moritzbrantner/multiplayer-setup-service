import type { ContentData, Timer } from "./events.ts";
export type Topology = "mesh" | "host";
export type Lobby = {
  lobbyId: string; displayCode: string; participantId: string; participantToken: string;
  hostParticipantId: string; maxParticipants: number; websocketPath: string;
  expiresAt: number; maxExpiresAt: number;
};
export type LobbyOptions = {
  apiBase?: string; iceServers?: RTCIceServer[]; turnIceServers?: RTCIceServer[];
  iceConnectionTimeoutMs?: number;
  topology?: Topology; contentSharing?: boolean; reconnectMaxAttempts?: number;
  reconnectBaseDelayMs?: number; reconnectMaxDelayMs?: number; peerRecoveryAttempts?: number;
};
export type PeerLink = {
  peerId: string; peer: RTCPeerConnection;
  reliable: RTCDataChannel | null; realtime: RTCDataChannel | null; content: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[]; realtimeSequence: number; lastRealtimeSequence: number;
  offerStarted: boolean; readyEmitted: boolean; contentReadyEmitted: boolean;
  recoveryTimer: Timer | null;
  recoveryAttempts: number; recoveryInFlight: boolean; turnEnabled: boolean;
};
export type LobbyDetail = Omit<Lobby, "participantToken" | "websocketPath" | "expiresAt" | "maxExpiresAt"> & {topology: Topology; contentSharing: boolean};
export type PeerMessage = {peerId: string; data: unknown};
export type SessionEvents = {
  "signaling-changed": {socket: WebSocket | null; previousSocket: WebSocket | null};
  "signaling-closed": {attempt: number};
  "lobby": LobbyDetail;
  "lobby-renewed": {expiresAt: number; maxExpiresAt: number};
  "turn-configuration": {available: boolean};
  "seed-advertisement-local": {contentIds: string[]};
  "statechange": {state: string; attempt?: number; attempts?: number; delayMs?: number};
  "roster": {participants: string[]; hostParticipantId: string};
  "participant-connected": {participantId: string};
  "participant-disconnected": {participantId: string};
  "participant-signaling-disconnected": {participantId: string};
  "peer-statechange": {peerId: string; state: RTCPeerConnectionState};
  "peer-created": {peerId: string; initiator: boolean};
  "peer-ready": {peerId: string};
  "content-peer-ready": {peerId: string};
  "peer-recovery-exhausted": {peerId: string; attempts: number};
  "peer-recovery": {peerId: string; attempt: number; action: string; requested: boolean; usingTurn?: boolean};
  "content-seed": {peerId: string; contentIds: string[]};
  "channel-open": {peerId: string; kind: string};
  "channel-close": {peerId: string; kind: string};
  "reliable": PeerMessage; "realtime": PeerMessage;
  "content": {peerId: string; data: ContentData};
  "error": {error: unknown};
};
