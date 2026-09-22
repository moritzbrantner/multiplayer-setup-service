const CHAT_KIND = "multiplayer-lobby-chat-v1";
const PING_KIND = "multiplayer-lobby-ping-v1";
const PONG_KIND = "multiplayer-lobby-pong-v1";
const MAX_CHAT_MESSAGE_LENGTH = 500;
const MAX_RENDERED_MESSAGES = 80;
const PING_INTERVAL_MS = 2_000;
const PING_TIMEOUT_MS = 10_000;
const LATENCY_SAMPLE_COUNT = 5;

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function normalizeChatText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_CHAT_MESSAGE_LENGTH) return null;
  return text;
}

export function buildInviteUrl({
  locationHref,
  code,
  codeParam = "lobby",
  apiBase,
  extras = {},
  autoJoin = true,
}) {
  const normalizedCode = String(code ?? "").trim();
  if (!normalizedCode) throw new Error("Invite code is required");
  const url = new URL(locationHref);
  url.hash = "";
  url.searchParams.set(codeParam, normalizedCode);
  if (apiBase) url.searchParams.set("api", apiBase);
  for (const [key, value] of Object.entries(extras)) {
    if (value === undefined || value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  if (autoJoin) url.searchParams.set("join", "1");
  else url.searchParams.delete("join");
  return url.toString();
}

export function readInviteJoin({ search, codeParam = "lobby" }) {
  const params = new URLSearchParams(search);
  const code = String(params.get(codeParam) ?? "").trim();
  return {
    code,
    autoJoin: Boolean(code) && params.get("join") === "1",
  };
}

export function summarizeLatency(sampleMap) {
  const peerMedians = [...sampleMap.values()]
    .map((samples) => median(samples))
    .filter((value) => Number.isFinite(value));
  if (peerMedians.length === 0) return { text: "Ping —", quality: "unknown" };
  const rounded = peerMedians.map((value) => Math.max(0, Math.round(value)));
  const worst = Math.max(...rounded);
  const quality = worst < 60 ? "good" : worst < 120 ? "fair" : "poor";
  if (rounded.length === 1) return { text: `Ping ${rounded[0]} ms`, quality };
  return {
    text: `Peer ping ${Math.min(...rounded)}–${Math.max(...rounded)} ms`,
    quality,
  };
}

async function copyText(text) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const documentRef = globalThis.document;
  if (!documentRef?.body || typeof documentRef.execCommand !== "function") {
    throw new Error("Clipboard is unavailable");
  }
  const textarea = documentRef.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  documentRef.body.append(textarea);
  textarea.select();
  const copied = documentRef.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard is unavailable");
}

function isMultipartySession(session) {
  return typeof session?.readyPeerIds === "function" && "participantId" in session;
}

function shortId(id) {
  if (!id) return "Peer";
  return String(id).slice(0, 8);
}

export class LobbyExperience {
  constructor({
    session,
    root = document,
    locationHref = window.location.href,
    codeParam = "lobby",
    inviteTitle = "Join my multiplayer lobby",
    inviteExtras = () => ({}),
    pingIntervalMs = PING_INTERVAL_MS,
  }) {
    if (!session) throw new Error("LobbyExperience requires a session");
    this.session = session;
    this.root = root;
    this.locationHref = locationHref;
    this.codeParam = codeParam;
    this.inviteTitle = inviteTitle;
    this.inviteExtras = inviteExtras;
    this.pingIntervalMs = pingIntervalMs;
    this.multiparty = isMultipartySession(session);
    this.abortController = new AbortController();
    this.inviteUrl = null;
    this.pingTimer = null;
    this.pendingPings = new Map();
    this.latencySamples = new Map();
    this.seenChatIds = new Set();
    this.chatLog = root.querySelector?.("[data-lobby-chat-log]") ?? null;
    this.chatForm = root.querySelector?.("[data-lobby-chat-form]") ?? null;
    this.chatInput = root.querySelector?.("[data-lobby-chat-input]") ?? null;
    this.chatSend = root.querySelector?.("[data-lobby-chat-send]") ?? null;
    this.inviteRow = root.querySelector?.("[data-lobby-invite-row]") ?? null;
    this.inviteNodes = [...(root.querySelectorAll?.("[data-lobby-invite]") ?? [])];
    this.shareButtons = [...(root.querySelectorAll?.("[data-lobby-share]") ?? [])];
    this.latencyNodes = [...(root.querySelectorAll?.("[data-lobby-latency]") ?? [])];

    this.#wireDom();
    this.#wireSession();
    this.#updateChatAvailability();
    this.#renderLatency();
  }

  close() {
    this.abortController.abort();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pendingPings.clear();
  }

  sendChat(value) {
    const text = normalizeChatText(value);
    if (!text || this.#readyPeerIds().length === 0) return false;
    const senderId = this.#localId();
    if (!senderId) return false;
    const message = {
      kind: CHAT_KIND,
      id: randomId("chat"),
      senderId,
      text,
    };
    try {
      this.#sendChatMessage(message);
    } catch {
      return false;
    }
    this.#rememberChat(message.id);
    this.#appendChat(message, true);
    return true;
  }

  #wireDom() {
    const signal = this.abortController.signal;
    this.chatForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.chatInput) return;
      if (this.sendChat(this.chatInput.value)) this.chatInput.value = "";
      this.chatInput.focus();
    }, { signal });

    for (const button of this.shareButtons) {
      button.addEventListener("click", () => this.#shareInvite(button), { signal });
    }
  }

  #wireSession() {
    const signal = this.abortController.signal;
    const publishInvite = (event) => this.#setInvite(event.detail?.displayCode);
    this.session.addEventListener("room", publishInvite, { signal });
    this.session.addEventListener("lobby", publishInvite, { signal });
    this.session.addEventListener("p2p-ready", () => {
      this.#updateChatAvailability();
      this.#ensurePingLoop();
    }, { signal });
    this.session.addEventListener("peer-ready", () => {
      this.#updateChatAvailability();
      this.#ensurePingLoop();
      this.#probeLatency();
    }, { signal });
    this.session.addEventListener("participant-disconnected", (event) => {
      const peerId = event.detail?.participantId;
      if (peerId) this.latencySamples.delete(peerId);
      this.#updateChatAvailability();
      this.#renderLatency();
    }, { signal });
    this.session.addEventListener("peer-statechange", () => {
      this.#updateChatAvailability();
      this.#renderLatency();
    }, { signal });
    this.session.addEventListener("channel-close", () => {
      this.#updateChatAvailability();
      this.#renderLatency();
    }, { signal });
    this.session.addEventListener("reliable", (event) => this.#handleReliable(event.detail), { signal });
    this.session.addEventListener("realtime", (event) => this.#handleRealtime(event.detail), { signal });
  }

  #localId() {
    return this.multiparty ? this.session.participantId : this.session.role;
  }

  #hostId() {
    return this.multiparty ? this.session.hostParticipantId : "host";
  }

  #singlePeerId() {
    return this.session.role === "host" ? "guest" : this.session.role === "guest" ? "host" : null;
  }

  #readyPeerIds() {
    if (this.multiparty) return this.session.readyPeerIds();
    const peerId = this.#singlePeerId();
    return this.session.reliable?.readyState === "open" && this.session.realtime?.readyState === "open" && peerId
      ? [peerId]
      : [];
  }

  #setInvite(code) {
    const normalizedCode = String(code ?? "").trim();
    if (!normalizedCode) return;
    this.inviteUrl = buildInviteUrl({
      locationHref: this.locationHref,
      code: normalizedCode,
      codeParam: this.codeParam,
      apiBase: this.session.apiBase,
      extras: this.inviteExtras(this.session) ?? {},
      autoJoin: true,
    });
    for (const node of this.inviteNodes) {
      if ("value" in node) node.value = this.inviteUrl;
      if ("href" in node) node.href = this.inviteUrl;
      if (!("value" in node)) node.textContent = this.inviteUrl;
    }
    for (const button of this.shareButtons) button.disabled = false;
    this.inviteRow?.classList?.remove("hidden");
  }

  async #shareInvite(button) {
    if (!this.inviteUrl) return;
    const original = button.textContent;
    try {
      if (globalThis.navigator?.share) {
        await navigator.share({ title: this.inviteTitle, url: this.inviteUrl });
        button.textContent = "Shared";
      } else {
        await copyText(this.inviteUrl);
        button.textContent = "Copied";
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      if (!this.abortController.signal.aborted) button.textContent = original;
    }, 1_500);
  }

  #updateChatAvailability() {
    const ready = this.#readyPeerIds().length > 0;
    if (this.chatInput) this.chatInput.disabled = !ready;
    if (this.chatSend) this.chatSend.disabled = !ready;
    if (this.chatInput) {
      this.chatInput.placeholder = ready ? "Message the lobby" : "Chat becomes available when a peer connects";
    }
  }

  #sendChatMessage(message) {
    if (this.multiparty) {
      const isHost = this.session.participantId === this.session.hostParticipantId;
      if (this.session.topology === "host" && !isHost) {
        if (this.session.readyPeerIds().includes(this.session.hostParticipantId)) {
          this.session.sendReliable(this.session.hostParticipantId, message);
        }
        return;
      }
      this.#broadcastReliable(message);
      return;
    }
    this.session.sendReliable(message);
  }

  #broadcastReliable(message, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    for (const peerId of this.session.readyPeerIds()) {
      if (excluded.has(peerId)) continue;
      try {
        this.session.sendReliable(peerId, message);
      } catch {
        // A peer can disappear between the readiness snapshot and the send.
      }
    }
  }

  #handleReliable(detail) {
    const peerId = this.multiparty ? detail?.peerId : this.#singlePeerId();
    const message = this.multiparty ? detail?.data : detail;
    if (message?.kind !== CHAT_KIND) return;
    const text = normalizeChatText(message.text);
    if (!text || typeof message.id !== "string" || !message.id || typeof message.senderId !== "string") return;
    if (this.seenChatIds.has(message.id)) return;

    if (this.multiparty) {
      const localIsHost = this.session.participantId === this.session.hostParticipantId;
      if (this.session.topology === "mesh") {
        if (message.senderId !== peerId) return;
      } else if (localIsHost) {
        if (message.senderId !== peerId) return;
      } else {
        if (peerId !== this.session.hostParticipantId) return;
        if (!this.session.participants.has(message.senderId)) return;
      }

      this.#rememberChat(message.id);
      this.#appendChat({ ...message, text }, false);
      if (this.session.topology === "host" && localIsHost) {
        this.#broadcastReliable({ ...message, text }, { exclude: [peerId] });
      }
      return;
    }

    const expectedSender = this.session.role === "host" ? "guest" : "host";
    if (message.senderId !== expectedSender) return;
    this.#rememberChat(message.id);
    this.#appendChat({ ...message, text }, false);
  }

  #rememberChat(id) {
    this.seenChatIds.add(id);
    if (this.seenChatIds.size <= 512) return;
    const oldest = this.seenChatIds.values().next().value;
    this.seenChatIds.delete(oldest);
  }

  #appendChat(message, local) {
    if (!this.chatLog) return;
    const item = this.root.createElement("li");
    item.className = "chat-message";
    item.dataset.local = String(local);
    const sender = this.root.createElement("strong");
    sender.textContent = local ? "You" : this.#displayName(message.senderId);
    const body = this.root.createElement("span");
    body.textContent = message.text;
    item.append(sender, body);
    this.chatLog.append(item);
    while (this.chatLog.children.length > MAX_RENDERED_MESSAGES) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  #displayName(senderId) {
    if (senderId === this.#hostId()) return "Host";
    if (!this.multiparty && senderId === "guest") return "Guest";
    return `Player ${shortId(senderId)}`;
  }

  #ensurePingLoop() {
    if (this.pingTimer) return;
    this.#probeLatency();
    this.pingTimer = setInterval(() => this.#probeLatency(), this.pingIntervalMs);
  }

  #probeLatency() {
    const readyPeers = this.#readyPeerIds();
    const current = nowMs();
    for (const [id, pending] of this.pendingPings) {
      if (current - pending.startedAt > PING_TIMEOUT_MS) this.pendingPings.delete(id);
    }
    for (const peerId of readyPeers) {
      const id = randomId("ping");
      const startedAt = nowMs();
      this.pendingPings.set(id, { peerId, startedAt });
      const message = { kind: PING_KIND, id, senderId: this.#localId() };
      try {
        if (this.multiparty) this.session.sendRealtime(peerId, message);
        else this.session.sendRealtime(message);
      } catch {
        this.pendingPings.delete(id);
      }
    }
    if (readyPeers.length === 0) this.#renderLatency();
  }

  #handleRealtime(detail) {
    const peerId = this.multiparty ? detail?.peerId : this.#singlePeerId();
    const message = this.multiparty ? detail?.data : detail;
    if (!peerId || !message || typeof message !== "object") return;

    if (message.kind === PING_KIND) {
      if (typeof message.id !== "string" || !message.id) return;
      if (this.multiparty && message.senderId !== peerId) return;
      if (!this.multiparty) {
        const expectedSender = this.session.role === "host" ? "guest" : "host";
        if (message.senderId !== expectedSender) return;
      }
      const pong = { kind: PONG_KIND, id: message.id, senderId: this.#localId() };
      try {
        if (this.multiparty) this.session.sendRealtime(peerId, pong);
        else this.session.sendRealtime(pong);
      } catch {
        // A channel can close between receive and reply; the next probe will recover the display.
      }
      return;
    }

    if (message.kind !== PONG_KIND || typeof message.id !== "string") return;
    const pending = this.pendingPings.get(message.id);
    if (!pending || pending.peerId !== peerId) return;
    if (this.multiparty && message.senderId !== peerId) return;
    if (!this.multiparty) {
      const expectedSender = this.session.role === "host" ? "guest" : "host";
      if (message.senderId !== expectedSender) return;
    }
    this.pendingPings.delete(message.id);
    const rtt = Math.max(0, nowMs() - pending.startedAt);
    const samples = this.latencySamples.get(peerId) ?? [];
    samples.push(rtt);
    while (samples.length > LATENCY_SAMPLE_COUNT) samples.shift();
    this.latencySamples.set(peerId, samples);
    this.#renderLatency();
  }

  #renderLatency() {
    const ready = new Set(this.#readyPeerIds());
    for (const peerId of this.latencySamples.keys()) {
      if (!ready.has(peerId)) this.latencySamples.delete(peerId);
    }
    const summary = summarizeLatency(this.latencySamples);
    for (const node of this.latencyNodes) {
      node.textContent = summary.text;
      node.dataset.quality = summary.quality;
      node.title = summary.text === "Ping —"
        ? "WebRTC data-channel round-trip time will appear after a peer connects."
        : "Median WebRTC realtime DataChannel round-trip time over the latest samples.";
    }
  }
}
