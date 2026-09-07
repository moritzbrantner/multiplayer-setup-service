use std::fs;
use std::path::PathBuf;

fn repo_file(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join(path)).expect("repository asset should be readable")
}

fn web_file(name: &str) -> String {
    repo_file(&format!("web/{name}"))
}

#[test]
fn peer_session_exposes_reliable_and_realtime_channels() {
    let source = web_file("session.js");
    assert!(source.contains("createDataChannel(\"reliable\""));
    assert!(source.contains("createDataChannel(\"realtime\""));
    assert!(source.contains("maxRetransmits: 0"));
    assert!(source.contains("peer-to-peer-ready"));
}

#[test]
fn lobby_session_supports_mesh_and_host_topologies() {
    let source = web_file("lobby-session.js");
    assert!(source.contains("topology === \"mesh\""));
    assert!(source.contains("topology === \"host\""));
    assert!(source.contains("createDataChannel(\"reliable\""));
    assert!(source.contains("createDataChannel(\"realtime\""));
    assert!(source.contains("maxRetransmits: 0"));
    assert!(source.contains("JSON.stringify({ type: \"signal\", to, payload })"));
}

#[test]
fn games_share_the_peer_session_transport() {
    let tic_tac_toe = web_file("tic-tac-toe.js");
    let pong = web_file("pong.js");

    assert!(tic_tac_toe.contains("./session.js"));
    assert!(tic_tac_toe.contains("sendReliable"));
    assert!(pong.contains("./session.js"));
    assert!(pong.contains("sendRealtime"));
    assert!(pong.contains("sendReliable"));
}

#[test]
fn input_arena_transmits_commands_and_delegates_deterministic_calculation() {
    let arena = web_file("arena.js");
    let model = web_file("arena-model.mjs");

    assert!(arena.contains("./lobby-session.js"));
    assert!(arena.contains("./arena-model.mjs"));
    assert!(arena.contains("type: \"step\""));
    assert!(arena.contains("broadcastReliable"));
    assert!(arena.contains("applyStepToState"));

    assert!(model.contains("const STEP_DISTANCE = 12"));
    assert!(model.contains("current.x + message.dx * STEP_DISTANCE"));
    assert!(model.contains("current.y + message.dy * STEP_DISTANCE"));
    assert!(model.contains("Math.abs(message.dx) + Math.abs(message.dy) === 1"));
    assert!(model.contains("snapshot.seq < previous"));
}

#[test]
fn pages_explainer_documents_the_actual_multiplayer_boundary() {
    let index = web_file("index.html");
    let explainer = web_file("explainer.js");

    assert!(index.contains("Connect briefly. Play directly."));
    assert!(index.contains("The server gets peers connected. It does not run the game."));
    assert!(index.contains("data-topology=\"mesh\""));
    assert!(index.contains("data-topology=\"host\""));
    assert!(index.contains("max=\"16\""));
    assert!(index.contains("Input-only synchronization"));
    assert!(index.contains("./explainer.css"));
    assert!(index.contains("./explainer.js"));

    assert!(explainer.contains("TURN may relay"));
    assert!(explainer.contains("import { topologyEdgeCount } from \"./arena-model.mjs\""));
    assert!(explainer.contains("topologyEdgeCount(topology, count)"));
    assert!(explainer.contains("localStorage.setItem(\"multiplayer-setup-endpoint\""));
    assert!(explainer.contains("url.searchParams.set(\"api\", endpoint)"));
}

#[test]
fn pages_client_code_components_show_supported_browser_apis() {
    let index = web_file("index.html");
    let components = web_file("client-code-components.js");
    let styles = web_file("client-code-components.css");

    assert!(index.contains("id=\"client-code\""));
    assert!(index.contains("<client-code-gallery>"));
    assert!(index.contains("./client-code-components.css"));
    assert!(index.contains("./client-code-components.js"));
    assert!(index.contains("Copy the browser primitives into a real game."));

    assert!(components.contains("import { PeerSession } from \"./session.js\""));
    assert!(components.contains("import { LobbySession } from \"./lobby-session.js\""));
    assert!(components.contains("ContentSeederDiscovery"));
    assert!(components.contains("contentSharing: true"));
    assert!(components.contains("customElements.define(\"client-code-example\""));
    assert!(components.contains("customElements.define(\"client-code-gallery\""));
    assert!(styles.contains(".client-code-gallery"));
    assert!(styles.contains(".client-code-shell"));
}

#[test]
fn demo_pages_are_static_and_locally_linked() {
    let index = web_file("index.html");
    assert!(index.contains("./tic-tac-toe.html"));
    assert!(index.contains("./pong.html"));
    assert!(index.contains("./arena.html"));
    assert!(!index.contains("/demo/"));
}

#[test]
fn pages_workflow_is_read_only_until_deploy_and_publishes_only_web_assets() {
    let workflow = repo_file(".github/workflows/pages.yml");
    assert!(workflow.contains("permissions:\n  contents: read"));
    assert!(workflow.contains("path: web"));
    assert!(workflow.contains("pages: write"));
    assert!(workflow.contains("id-token: write"));
    assert!(workflow.contains("actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b"));
    assert!(
        workflow.contains("actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9")
    );
    assert!(workflow.contains("actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e"));
}
