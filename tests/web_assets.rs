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
fn demo_pages_are_static_and_locally_linked() {
    let index = web_file("index.html");
    assert!(index.contains("./tic-tac-toe.html"));
    assert!(index.contains("./pong.html"));
    assert!(!index.contains("/demo/"));
}
