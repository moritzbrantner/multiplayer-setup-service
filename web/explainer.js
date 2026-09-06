const phaseCopy = {
  create: {
    title: "The setup service creates a short-lived rendezvous point.",
    body: "The host creates a room or lobby and receives a private capability. Other participants join using the public code and receive their own capabilities.",
  },
  signal: {
    title: "Peers exchange only WebRTC setup messages through the server.",
    body: "SDP offers, answers and ICE candidates are relayed as opaque payloads. The service authenticates who may talk to whom, but it does not interpret game state.",
  },
  direct: {
    title: "Gameplay moves onto peer-to-peer DataChannels.",
    body: "Once the WebRTC links are ready, game inputs and events travel directly between browsers whenever NAT traversal permits. TURN may relay packets when a direct route is impossible.",
  },
};

const mechanism = document.querySelector("#mechanism-shell");
const phaseTitle = document.querySelector("#phase-title");
const phaseBody = document.querySelector("#phase-body");
const phaseButtons = [...document.querySelectorAll("[data-phase-button]")];

function setPhase(phase) {
  if (!phaseCopy[phase]) return;
  mechanism.dataset.phase = phase;
  phaseTitle.textContent = phaseCopy[phase].title;
  phaseBody.textContent = phaseCopy[phase].body;
  for (const button of phaseButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.phaseButton === phase));
  }
}

for (const button of phaseButtons) {
  button.addEventListener("click", () => setPhase(button.dataset.phaseButton));
}

const svg = document.querySelector("#network-graph");
const topologyButtons = [...document.querySelectorAll("[data-topology]")];
const playerRange = document.querySelector("#participant-count-control");
const playerOutput = document.querySelector("#participant-count-output");
const topologyTitle = document.querySelector("#topology-title");
const topologyResult = document.querySelector("#topology-result");
const topologyNote = document.querySelector("#topology-note");
let topology = "mesh";

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function meshPositions(count) {
  const center = 250;
  const radius = count <= 4 ? 150 : 182;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
    return {
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
    };
  });
}

function hostPositions(count) {
  const positions = [{ x: 250, y: 250 }];
  const guests = count - 1;
  const radius = guests <= 4 ? 150 : 185;
  for (let index = 0; index < guests; index += 1) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / guests;
    positions.push({
      x: 250 + Math.cos(angle) * radius,
      y: 250 + Math.sin(angle) * radius,
    });
  }
  return positions;
}

function connectionCount(kind, count) {
  return kind === "mesh" ? (count * (count - 1)) / 2 : count - 1;
}

function renderTopology() {
  const count = Number(playerRange.value);
  playerOutput.value = String(count);
  playerOutput.textContent = String(count);
  svg.replaceChildren();

  const positions = topology === "mesh" ? meshPositions(count) : hostPositions(count);
  const edges = [];
  if (topology === "mesh") {
    for (let left = 0; left < count; left += 1) {
      for (let right = left + 1; right < count; right += 1) edges.push([left, right]);
    }
  } else {
    for (let guest = 1; guest < count; guest += 1) edges.push([0, guest]);
  }

  for (const [from, to] of edges) {
    svg.append(
      svgElement("line", {
        x1: positions[from].x,
        y1: positions[from].y,
        x2: positions[to].x,
        y2: positions[to].y,
        class: `graph-edge${topology === "host" ? " host-edge" : ""}`,
      }),
    );
  }

  for (let index = 0; index < count; index += 1) {
    const { x, y } = positions[index];
    const isHost = topology === "host" && index === 0;
    svg.append(
      svgElement("circle", {
        cx: x,
        cy: y,
        r: isHost ? 24 : 19,
        class: `graph-node${isHost ? " host-node" : ""}`,
      }),
    );
    const label = svgElement("text", {
      x,
      y,
      class: `graph-label${isHost ? " host-label" : ""}`,
    });
    label.textContent = isHost ? "Host" : `P${index + 1}`;
    svg.append(label);
  }

  const connections = connectionCount(topology, count);
  if (topology === "mesh") {
    topologyTitle.textContent = "Full mesh";
    topologyResult.textContent = `${count} players create ${connections} direct peer relationships. Each device maintains ${Math.max(0, count - 1)} WebRTC connections.`;
    topologyNote.textContent = "Best when messages are compact and every peer can run the same deterministic simulation locally. Inputs fan out directly; there is no gameplay server in the middle.";
  } else {
    topologyTitle.textContent = "Host-spoke";
    topologyResult.textContent = `${count} players create ${connections} direct peer relationships. The host maintains ${Math.max(0, count - 1)} links; every guest maintains one.`;
    topologyNote.textContent = "Simpler for heavier realtime prototypes. Guests send inputs to the host, which can forward the same commands without becoming the owner of game semantics.";
  }
}

for (const button of topologyButtons) {
  button.addEventListener("click", () => {
    topology = button.dataset.topology;
    for (const candidate of topologyButtons) {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    }
    renderTopology();
  });
}
playerRange.addEventListener("input", renderTopology);

const endpointInput = document.querySelector("#endpoint-input");
const endpointButton = document.querySelector("#endpoint-apply");
const endpointStatus = document.querySelector("#endpoint-status");
const demoLinks = [...document.querySelectorAll("[data-demo-link]")];

function normalizedEndpoint(value) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function updateDemoLinks(endpoint, persist = true) {
  for (const link of demoLinks) {
    const url = new URL(link.dataset.demoLink, window.location.href);
    if (endpoint) url.searchParams.set("api", endpoint);
    link.href = `${url.pathname.split("/").at(-1)}${url.search}`;
  }

  if (endpoint) {
    endpointStatus.textContent = `Demo links now use ${endpoint}`;
    if (persist) localStorage.setItem("multiplayer-setup-endpoint", endpoint);
  } else {
    endpointStatus.textContent = "Enter the HTTPS address of your deployed setup service to make the demos connect from GitHub Pages.";
    if (persist) localStorage.removeItem("multiplayer-setup-endpoint");
  }
}

endpointButton.addEventListener("click", () => {
  const endpoint = normalizedEndpoint(endpointInput.value);
  if (endpointInput.value.trim() && !endpoint) {
    endpointStatus.textContent = "Use a complete http:// or https:// address.";
    return;
  }
  updateDemoLinks(endpoint);
});

endpointInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") endpointButton.click();
});

const storedEndpoint = normalizedEndpoint(localStorage.getItem("multiplayer-setup-endpoint") || "");
if (storedEndpoint) endpointInput.value = storedEndpoint;
updateDemoLinks(storedEndpoint, false);
setPhase("create");
renderTopology();
