const examples = [
  {
    id: "two-peer",
    label: "Two peers",
    title: "Host, join, then use two purpose-built channels",
    source: "session.js · PeerSession",
    description:
      "Use the small room API when exactly two browsers need a direct WebRTC relationship. Reliable messages carry durable commands; realtime messages prefer freshness over retransmission.",
    code: `import { PeerSession } from "./session.js";

const session = new PeerSession({
  apiBase: "https://multiplayer.example.com",
});

session.addEventListener("reliable", ({ detail }) => {
  applyCommand(detail);
});

session.addEventListener("realtime", ({ detail }) => {
  applyFreshHint(detail);
});

const room = await session.host();
// On the other browser: await session.join(room.displayCode);

session.sendReliable({ type: "move", column: 2 });
session.sendRealtime({ type: "cursor", x: 0.42, y: 0.73 });`,
    points: [
      "The setup service only creates the rendezvous and relays WebRTC setup data.",
      "Reliable and realtime semantics are explicit in the client API.",
      "The signaling socket is released once the peer-to-peer channels are ready.",
    ],
  },
  {
    id: "lobby",
    label: "2–16 players",
    title: "Pick a topology, then broadcast compact game inputs",
    source: "lobby-session.js · LobbySession",
    description:
      "Use LobbySession when the same static client must coordinate more than two participants. The browser chooses mesh or host-spoke; the service remains topology-agnostic signaling infrastructure.",
    code: `import { LobbySession } from "./lobby-session.js";

const lobby = new LobbySession({
  apiBase: "https://multiplayer.example.com",
  topology: "mesh", // or "host"
});

lobby.addEventListener("reliable", ({ detail }) => {
  applyInput(detail.peerId, detail.data);
});

await lobby.host(16);

lobby.broadcastReliable({
  type: "step",
  seq: 43,
  dx: 1,
  dy: 0,
});`,
    points: [
      "Lobby capacity is bounded to 2–16 participants.",
      "Mesh and host-spoke are client policy, not server-side game semantics.",
      "Only ready peers receive broadcasts, while each game validates commands locally.",
    ],
  },
  {
    id: "content",
    label: "Optional assets",
    title: "Opt in to seeding only trusted manifest content",
    source: "content-seeder-discovery.js · ContentSeederDiscovery",
    description:
      "Games that really need large shared assets can opt into content channels. Seeder discovery only advertises SHA-256 content IDs already present in the trusted manifest, keeping asset distribution separate from ordinary gameplay.",
    code: `import { LobbySession } from "./lobby-session.js";
import { ContentSeederDiscovery } from "./content-seeder-discovery.js";

const session = new LobbySession({
  apiBase: "https://multiplayer.example.com",
  topology: "mesh",
  contentSharing: true,
});

await session.join(lobbyCode);

const discovery = new ContentSeederDiscovery({
  session,
  manifest: trustedManifest,
});

discovery.setSeederEnabled(true, {
  paths: ["assets/world.pack"],
});

const peers = discovery.seedersForPath("assets/world.pack");`,
    points: [
      "Content sharing is disabled unless the client explicitly enables it.",
      "Seeder advertisements are filtered against the trusted manifest.",
      "Gameplay transport and bulk content distribution keep separate responsibilities.",
    ],
  },
];

function element(name, className, text = null) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

class ClientCodeExample extends HTMLElement {
  set example(value) {
    this._example = value;
    this.render();
  }

  get example() {
    return this._example;
  }

  connectedCallback() {
    if (this._example && !this.hasChildNodes()) this.render();
  }

  render() {
    const example = this._example;
    if (!example) return;

    this.replaceChildren();
    this.classList.add("client-code-example");

    const copy = element("div", "client-code-copy");
    copy.append(
      element("p", "client-code-source", example.source),
      element("h3", null, example.title),
      element("p", "client-code-description", example.description),
    );

    const points = element("ul", "client-code-points");
    for (const point of example.points) points.append(element("li", null, point));
    copy.append(points);

    const codeShell = element("div", "client-code-shell");
    const toolbar = element("div", "client-code-toolbar");
    toolbar.append(element("span", null, "Browser module"));

    const status = element("span", "client-code-copy-status");
    status.setAttribute("aria-live", "polite");

    const copyButton = element("button", "client-code-copy-button", "Copy code");
    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(example.code);
        status.textContent = "Copied";
        copyButton.textContent = "Copied";
        window.setTimeout(() => {
          status.textContent = "";
          copyButton.textContent = "Copy code";
        }, 1600);
      } catch {
        status.textContent = "Copy unavailable";
      }
    });
    toolbar.append(status, copyButton);

    const pre = element("pre");
    const code = element("code", null, example.code);
    pre.append(code);
    codeShell.append(toolbar, pre);

    this.append(copy, codeShell);
  }
}

class ClientCodeGallery extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready === "true") return;
    this.dataset.ready = "true";
    this.classList.add("client-code-gallery");

    const tabList = element("div", "client-code-tabs");
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "Client code examples");

    const stage = element("div", "client-code-stage");
    const buttons = [];
    const panels = [];

    const select = (selectedIndex) => {
      buttons.forEach((button, index) => {
        const active = index === selectedIndex;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        panels[index].hidden = !active;
      });
    };

    examples.forEach((example, index) => {
      const button = element("button", "client-code-tab", example.label);
      button.type = "button";
      button.id = `client-code-tab-${example.id}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `client-code-panel-${example.id}`);
      button.addEventListener("click", () => select(index));
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (index + direction + examples.length) % examples.length;
        select(nextIndex);
        buttons[nextIndex].focus();
      });
      buttons.push(button);
      tabList.append(button);

      const panel = element("div", "client-code-panel");
      panel.id = `client-code-panel-${example.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);

      const card = document.createElement("client-code-example");
      card.example = example;
      panel.append(card);
      panels.push(panel);
      stage.append(panel);
    });

    this.append(tabList, stage);
    select(0);
  }
}

customElements.define("client-code-example", ClientCodeExample);
customElements.define("client-code-gallery", ClientCodeGallery);
