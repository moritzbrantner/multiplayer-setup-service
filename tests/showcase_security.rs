use std::fs;
use std::path::PathBuf;

fn repo_file(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join(path)).expect("repository asset should be readable")
}

#[test]
fn card_showcase_uses_host_validated_intents_and_hidden_views() {
    let html = repo_file("web/card-game.html");
    let client = repo_file("web/card-game.js");
    let model = repo_file("web/card-game-model.mjs");

    assert!(html.contains("Four-player color-match card game"));
    assert!(html.contains("Send forged card ID"));
    assert!(html.contains("Replay last intent"));
    assert!(client.contains("./lobby-session.js"));
    assert!(client.contains("./game-commands.js"));
    assert!(client.contains("topology: \"host\""));
    assert!(client.contains("host(4)"));
    assert!(client.contains("type: \"card-intent\""));
    assert!(client.contains("commands.sendToHost(CARD_INTENT_COMMAND, intent)"));
    assert!(client.contains("currentCommands.handle(CARD_INTENT_COMMAND"));
    assert!(!client.contains("data?.type === \"card-intent\""));
    assert!(client.contains("type: \"card-rejection\""));
    assert!(model.contains("stale-sequence"));
    assert!(model.contains("card-not-in-hand"));
    assert!(model.contains("illegal-card"));
    assert!(model.contains("hand: state.hands[viewerId]"));
    assert!(model.contains("handCount: state.hands[id].length"));
}

#[test]
fn pong_showcase_keeps_score_and_paddle_speed_host_authoritative() {
    let html = repo_file("web/pong.html");
    let client = repo_file("web/pong.js");
    let model = repo_file("web/pong-model.mjs");

    assert!(html.contains("attempt forged 99–0 score"));
    assert!(client.contains("movePaddleToward"));
    assert!(client.contains("mayAcceptPongScore"));
    assert!(client.contains("Blocked forged guest score"));
    assert!(model.contains("return role === \"guest\""));
    assert!(model.contains("const maxStep = speed * dt"));
}

#[test]
fn showcase_docs_state_the_remaining_host_trust_boundary() {
    let docs = repo_file("docs/cheat-boundaries.md");
    assert!(docs.contains("The host is trusted."));
    assert!(docs.contains("malicious host"));
    assert!(docs.contains("multi-party randomness/shuffling"));
    assert!(docs.contains("requests or inputs"));
}
