import { ResilientLobbySession } from "./resilient-lobby-session.ts";
import { refreshTurnIceServers, TurnCredentialError } from "./turn-credentials.ts";
import { TypedEventTarget } from "./events.ts";
import type { Timer } from "./events.ts";
import type { LobbyOptions } from "./lobby-types.ts";

/** Demo policy: public STUN for direct ICE; service-issued TURN for recovery. */
export class DemoLobbySession extends ResilientLobbySession {
  private refreshTimer: Timer | null = null;
  private credentialAbort = new AbortController();
  private refreshFailures = 0;
  constructor(options: LobbyOptions = {}) {
    super({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }], ...options });
  }
  override async host(maxParticipants = 16) {
    const lobby = await super.host(maxParticipants);
    await this.refreshCredentials();
    return lobby;
  }
  override async join(code: string) {
    const lobby = await super.join(code);
    await this.refreshCredentials();
    return lobby;
  }
  private async refreshCredentials(): Promise<void> {
    if (this.closed) return;
    try {
      const credentials = await refreshTurnIceServers(this, { signal: this.credentialAbort.signal });
      if (this.closed) { this.setTurnIceServers([]); return; }
      this.refreshFailures = 0;
      const remaining = credentials.expiresAt - Date.now();
      if (remaining <= 0) throw new Error("TURN credentials have expired");
      this.refreshTimer = setTimeout(() => { this.refreshCredentials().catch((error: unknown) => this.reportCredentialError(error)); }, Math.max(1_000, remaining - Math.min(60_000, remaining / 2)));
    } catch (error) {
      if (this.closed || (error instanceof TurnCredentialError && error.code === "turn-not-configured")) return;
      this.reportCredentialError(error);
      this.refreshFailures += 1;
      if (this.refreshFailures <= 3) {
        this.refreshTimer = setTimeout(() => { this.refreshCredentials().catch((failure: unknown) => this.reportCredentialError(failure)); }, 5_000 * this.refreshFailures);
      }
    }
  }
  private reportCredentialError(error: unknown): void {
    this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
  }
  override close(): void {
    this.credentialAbort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    super.close();
    this.setTurnIceServers([]);
  }
}

type PeerEvents = {
  room: {roomId: string; displayCode: string; role: "host" | "guest"};
  statechange: {state: string}; "p2p-ready": Record<string, never>;
  reliable: unknown; realtime: unknown;
  "channel-close": {kind: string}; error: {error: unknown};
};
/** Adapt the demos' two-player API to the same resilient lobby transport. */
export class DemoPeerSession extends TypedEventTarget<PeerEvents> {
  readonly lobby: DemoLobbySession;
  role: "host" | "guest" | null = null;
  constructor(options: LobbyOptions = {}) {
    super();
    this.lobby = new DemoLobbySession({ ...options, topology: "host" });
    this.lobby.addEventListener("statechange", (event) => this.dispatchEvent(new CustomEvent("statechange", {detail: event.detail})));
    this.lobby.addEventListener("peer-statechange", (event) => this.dispatchEvent(new CustomEvent("statechange", {detail: {state: event.detail.state}})));
    this.lobby.addEventListener("peer-ready", () => this.dispatchEvent(new CustomEvent("p2p-ready", {detail: {}})));
    for (const kind of ["reliable", "realtime"] as const) {
      this.lobby.addEventListener(kind, (event) => this.dispatchEvent(new CustomEvent(kind, {detail: event.detail.data})));
    }
    this.lobby.addEventListener("channel-close", (event) => this.dispatchEvent(new CustomEvent("channel-close", {detail: event.detail})));
    this.lobby.addEventListener("error", (event) => this.dispatchEvent(new CustomEvent("error", {detail: event.detail})));
  }
  get apiBase() { return this.lobby.apiBase; }
  get displayCode() { return this.lobby.displayCode; }
  get roomId() { return this.lobby.lobbyId; }
  get reliable() { return this.remoteLink()?.reliable ?? null; }
  get realtime() { return this.remoteLink()?.realtime ?? null; }
  private remoteLink() { return this.lobby.links.values().next().value; }
  private remoteId(): string {
    const id = this.lobby.readyPeerIds()[0];
    if (!id) throw new Error("Peer-to-peer channel is not ready");
    return id;
  }
  async host() {
    this.role = "host";
    const lobby = await this.lobby.host(2);
    this.dispatchEvent(new CustomEvent("room", {detail: {roomId: lobby.lobbyId, displayCode: lobby.displayCode, role: this.role}}));
    return lobby;
  }
  async join(code: string) {
    this.role = "guest";
    const lobby = await this.lobby.join(code);
    if (lobby.maxParticipants !== 2) { this.close(); throw new Error("This game requires a two-player lobby"); }
    this.dispatchEvent(new CustomEvent("room", {detail: {roomId: lobby.lobbyId, displayCode: lobby.displayCode, role: this.role}}));
    return lobby;
  }
  sendReliable(data: unknown) { this.lobby.sendReliable(this.remoteId(), data); }
  sendRealtime(data: unknown) { this.lobby.sendRealtime(this.remoteId(), data); }
  close() { this.lobby.close(); }
}
