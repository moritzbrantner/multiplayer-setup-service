use std::fs;
use std::path::PathBuf;

fn web_file(name: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join("web").join(name)).expect("web demo asset should be readable")
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
fn demo_pages_are_static_and_locally_linked() {
    let index = web_file("index.html");
    assert!(index.contains("./tic-tac-toe.html"));
    assert!(index.contains("./pong.html"));
    assert!(index.contains("./arena.html"));
    assert!(!index.contains("/demo/"));
}
