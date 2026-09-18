export const GAME_COMMAND_PROTOCOL = "multiplayer-game-command-v1";

const MAX_COMMAND_NAME_LENGTH = 128;
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePeerId(peerId) {
  if (typeof peerId !== "string" || peerId === "") throw new Error("peerId must be a non-empty string");
  return peerId;
}

function requireCommandName(command) {
  if (
    typeof command !== "string" ||
    command.length < 1 ||
    command.length > MAX_COMMAND_NAME_LENGTH ||
    !COMMAND_NAME_PATTERN.test(command)
  ) {
    throw new Error("command must be a compact protocol-safe name");
  }
  return command;
}

function commandEnvelope(command, payload) {
  const envelope = { protocol: GAME_COMMAND_PROTOCOL, command: requireCommandName(command), payload };
  try {
    JSON.stringify(envelope);
  } catch {
    throw new Error("command payload must be JSON-serializable");
  }
  return envelope;
}

function parseCommandEnvelope(value) {
  if (!isObject(value) || value.protocol !== GAME_COMMAND_PROTOCOL) return null;
  return {
    command: requireCommandName(value.command),
    payload: value.payload,
  };
}

export class GameCommands extends EventTarget {
  constructor({ session } = {}) {
    super();
    if (
      !session ||
      typeof session.addEventListener !== "function" ||
      typeof session.removeEventListener !== "function" ||
      typeof session.sendReliable !== "function" ||
      typeof session.broadcastReliable !== "function"
    ) {
      throw new Error("GameCommands requires a LobbySession-compatible reliable transport");
    }

    this.session = session;
    this.handlers = new Map();
    this.closed = false;
    this.onReliable = (event) => this.#receive(event.detail?.peerId, event.detail?.data);
    session.addEventListener("reliable", this.onReliable);
  }

  send(peerId, command, payload = null) {
    this.#assertOpen();
    this.session.sendReliable(requirePeerId(peerId), commandEnvelope(command, payload));
  }

  sendToHost(command, payload = null) {
    this.#assertOpen();
    const peerId = this.session.hostParticipantId;
    if (typeof peerId !== "string" || peerId === "") {
      throw new Error("Lobby session does not have a host participant");
    }
    if (peerId === this.session.participantId) {
      throw new Error("The local participant is the host; apply the command locally instead");
    }
    this.send(peerId, command, payload);
  }

  broadcast(command, payload = null, options = {}) {
    this.#assertOpen();
    this.session.broadcastReliable(commandEnvelope(command, payload), options);
  }

  handle(command, handler) {
    this.#assertOpen();
    const name = requireCommandName(command);
    if (typeof handler !== "function") throw new Error("command handler must be a function");

    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);

    return () => {
      const current = this.handlers.get(name);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(name);
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.removeEventListener("reliable", this.onReliable);
    this.handlers.clear();
  }

  #receive(peerId, value) {
    if (this.closed || typeof peerId !== "string" || peerId === "") return;

    let envelope;
    try {
      envelope = parseCommandEnvelope(value);
    } catch (error) {
      this.#emit("error", { peerId, error });
      return;
    }
    if (!envelope) return;

    const detail = { peerId, command: envelope.command, payload: envelope.payload };
    this.#emit("command", detail);

    const handlers = this.handlers.get(envelope.command);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        Promise.resolve(handler(envelope.payload, detail)).catch((error) => {
          this.#emit("error", { peerId, command: envelope.command, error });
        });
      } catch (error) {
        this.#emit("error", { peerId, command: envelope.command, error });
      }
    }
  }

  #assertOpen() {
    if (this.closed) throw new Error("GameCommands is closed");
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
