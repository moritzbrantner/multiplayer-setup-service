import { manifestFile, validateTrustedManifest } from "./content-verification.js";

function transferableFiles(manifest) {
  return manifest.files.filter((file) => file.chunks && file.chunks.sha256.length > 0);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export class ContentSeederDiscovery extends EventTarget {
  constructor({ session, manifest } = {}) {
    super();
    if (!session || session.contentSharing !== true) {
      throw new Error("ContentSeederDiscovery requires a LobbySession with contentSharing enabled");
    }
    validateTrustedManifest(manifest);

    this.session = session;
    this.manifest = manifest;
    this.trustedContentIds = new Set(transferableFiles(manifest).map((file) => file.sha256));
    this.peerContent = new Map();
    this.localContentIds = [];
    this.closed = false;

    this.onSeed = (event) => this.#handleSeed(event.detail);
    this.onDisconnect = (event) => this.#handleDisconnect(event.detail?.participantId);
    session.addEventListener("content-seed", this.onSeed);
    session.addEventListener("participant-disconnected", this.onDisconnect);
  }

  setSeederEnabled(enabled, { paths = null } = {}) {
    if (this.closed) throw new Error("ContentSeederDiscovery is closed");
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");

    const contentIds = enabled ? this.#contentIdsForPaths(paths) : [];
    this.session.announceSeedContent(contentIds);
    this.localContentIds = contentIds;
    this.#emitChange();
    return [...contentIds];
  }

  advertisedContentIds() {
    return [...this.localContentIds];
  }

  seedersForContentId(contentId) {
    if (!this.trustedContentIds.has(contentId)) return [];
    return [...this.peerContent.entries()]
      .filter(([, contentIds]) => contentIds.has(contentId))
      .map(([peerId]) => peerId)
      .sort();
  }

  seedersForPath(path) {
    const file = manifestFile(this.manifest, path);
    if (!file.chunks || file.chunks.sha256.length === 0) return [];
    return this.seedersForContentId(file.sha256);
  }

  snapshot() {
    return [...this.peerContent.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([peerId, contentIds]) => ({
        peerId,
        contentIds: [...contentIds].sort(),
      }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.removeEventListener("content-seed", this.onSeed);
    this.session.removeEventListener("participant-disconnected", this.onDisconnect);
    this.peerContent.clear();
    this.localContentIds = [];
  }

  #contentIdsForPaths(paths) {
    if (paths == null) {
      return sortedUnique(transferableFiles(this.manifest).map((file) => file.sha256));
    }
    if (!Array.isArray(paths)) throw new Error("paths must be an array when provided");

    const contentIds = [];
    for (const path of paths) {
      const file = manifestFile(this.manifest, path);
      if (!file.chunks || file.chunks.sha256.length === 0) {
        throw new Error(`Content is not transferable through the chunk protocol: ${path}`);
      }
      contentIds.push(file.sha256);
    }
    return sortedUnique(contentIds);
  }

  #handleSeed(detail) {
    if (this.closed || typeof detail?.peerId !== "string" || !Array.isArray(detail.contentIds)) return;

    const trusted = detail.contentIds.filter((contentId) => this.trustedContentIds.has(contentId));
    if (trusted.length === 0) this.peerContent.delete(detail.peerId);
    else this.peerContent.set(detail.peerId, new Set(trusted));
    this.#emitChange();
  }

  #handleDisconnect(peerId) {
    if (this.closed || typeof peerId !== "string") return;
    if (this.peerContent.delete(peerId)) this.#emitChange();
  }

  #emitChange() {
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: {
          localContentIds: [...this.localContentIds],
          seeders: this.snapshot(),
        },
      }),
    );
  }
}
