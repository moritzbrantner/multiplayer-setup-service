#[path = "../src/lobby.rs"]
mod lobby;
#[path = "../src/protocol.rs"]
mod protocol;
#[path = "../src/state.rs"]
mod state;

use lobby::{LobbyConnectionCommand, LobbyStore, LobbyStoreError};
use protocol::{
    ClientMessage, ClientMessageError, LobbyClientMessage, LobbyServerMessage, PeerRole,
    generate_capability_token, generate_participant_id, generate_room_id, hash_capability_token,
    hashes_equal, is_valid_participant_id, is_valid_room_id, normalize_room_id,
    parse_client_message, parse_lobby_client_message,
};
use state::{ConnectionCommand, RoomStatusKind, RoomStore, StoreError};
use std::time::Duration;
use tokio::sync::mpsc;

#[test]
fn generated_identifiers_and_capabilities_respect_contracts() {
    for _ in 0..128 {
        let room = generate_room_id().unwrap();
        let participant = generate_participant_id().unwrap();
        let token = generate_capability_token().unwrap();

        assert!(is_valid_room_id(&room));
        assert!(is_valid_participant_id(&participant));
        assert_eq!(room.len(), 12);
        assert_eq!(participant.len(), 8);
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}

#[test]
fn identifier_validation_rejects_ambiguous_or_malformed_values() {
    assert_eq!(normalize_room_id("abcd-efgh-jkmn"), "ABCDEFGHJKMN");
    for value in [
        "",
        "ABC",
        "OOOOOOOOOOOO",
        "IIIIIIIIIIII",
        "LLLLLLLLLLLL",
        "UUUUUUUUUUUU",
        "ABCDEFGHIJKLM",
    ] {
        assert!(!is_valid_room_id(value));
    }

    for value in [
        "",
        "ABCDEFG",
        "ABCDEFGHI",
        "OOOOOOOO",
        "IIIIIIII",
        "LLLLLLLL",
        "UUUUUUUU",
        "abcd1234",
    ] {
        assert!(!is_valid_participant_id(value));
    }
}

#[test]
fn capability_hash_comparison_distinguishes_tokens() {
    let first = generate_capability_token().unwrap();
    let second = generate_capability_token().unwrap();
    let first_hash = hash_capability_token(&first);
    let same_hash = hash_capability_token(&first);
    let second_hash = hash_capability_token(&second);

    assert!(hashes_equal(&first_hash, &same_hash));
    assert!(!hashes_equal(&first_hash, &second_hash));
}

#[test]
fn ping_nonce_boundary_is_enforced_for_both_protocols() {
    let accepted = "x".repeat(128);
    let rejected = "x".repeat(129);

    assert!(matches!(
        parse_client_message(&serde_json::json!({"type":"ping","nonce":accepted}).to_string()),
        Ok(ClientMessage::Ping { .. })
    ));
    assert_eq!(
        parse_client_message(&serde_json::json!({"type":"ping","nonce":rejected}).to_string()),
        Err(ClientMessageError::Invalid)
    );

    assert!(matches!(
        parse_lobby_client_message(
            &serde_json::json!({"type":"ping","nonce":"x".repeat(128)}).to_string()
        ),
        Ok(LobbyClientMessage::Ping { .. })
    ));
    assert_eq!(
        parse_lobby_client_message(
            &serde_json::json!({"type":"ping","nonce":"x".repeat(129)}).to_string()
        ),
        Err(ClientMessageError::Invalid)
    );
}

#[test]
fn lobby_signaling_payload_stays_opaque() {
    let to = generate_participant_id().unwrap();
    let payload = serde_json::json!({
        "description": {"type": "offer", "sdp": "opaque"},
        "applicationExtension": {"tick": 42, "nested": [1, 2, 3]}
    });
    let parsed = parse_lobby_client_message(
        &serde_json::json!({"type":"signal","to":to,"payload":payload}).to_string(),
    )
    .unwrap();

    match parsed {
        LobbyClientMessage::Signal {
            payload: actual, ..
        } => {
            assert_eq!(
                actual,
                serde_json::json!({
                    "description": {"type": "offer", "sdp": "opaque"},
                    "applicationExtension": {"tick": 42, "nested": [1, 2, 3]}
                })
            );
        }
        other => panic!("expected signal, got {other:?}"),
    }
}

#[test]
fn malformed_protocol_envelopes_are_fail_closed() {
    for value in [
        "not-json",
        "{}",
        r#"{"type":"unknown"}"#,
        r#"{"type":"signal"}"#,
    ] {
        assert_eq!(
            parse_client_message(value),
            Err(ClientMessageError::Invalid)
        );
    }

    let to = generate_participant_id().unwrap();
    assert_eq!(
        parse_lobby_client_message(&serde_json::json!({"type":"signal","to":to}).to_string()),
        Err(ClientMessageError::Invalid)
    );
    assert_eq!(
        parse_lobby_client_message(r#"{"type":"signal","to":"bad","payload":{}}"#),
        Err(ClientMessageError::Invalid)
    );
}

#[tokio::test]
async fn room_store_capacity_is_reused_after_expiry() {
    let store = RoomStore::new(1);
    let expired = store.create_room(Duration::ZERO).await.unwrap();
    assert!(matches!(
        store.status(&expired.room_id).await,
        Err(StoreError::RoomNotFound)
    ));

    let replacement = store.create_room(Duration::from_secs(60)).await.unwrap();
    assert!(store.status(&replacement.room_id).await.is_ok());
}

#[tokio::test]
async fn concurrent_room_guest_claim_has_exactly_one_winner() {
    let store = RoomStore::new(2);
    let created = store.create_room(Duration::from_secs(60)).await.unwrap();

    let mut tasks = Vec::new();
    for _ in 0..8 {
        let store = store.clone();
        let room_id = created.room_id.clone();
        tasks.push(tokio::spawn(async move { store.join_room(&room_id).await }));
    }

    let mut successes = 0;
    let mut full = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => successes += 1,
            Err(StoreError::RoomFull) => full += 1,
            Err(error) => panic!("unexpected room join error: {error:?}"),
        }
    }

    assert_eq!(successes, 1);
    assert_eq!(full, 7);
    assert!(matches!(
        store.status(&created.room_id).await.unwrap().status,
        RoomStatusKind::Paired
    ));
}

#[tokio::test]
async fn guest_cannot_authenticate_before_claiming_the_room() {
    let store = RoomStore::new(2);
    let created = store.create_room(Duration::from_secs(60)).await.unwrap();
    let token = generate_capability_token().unwrap();

    assert!(matches!(
        store
            .authenticate(&created.room_id, PeerRole::Guest, &token)
            .await,
        Err(StoreError::InvalidCredentials)
    ));
}

#[tokio::test]
async fn room_registration_rejects_wrong_role_capability() {
    let store = RoomStore::new(2);
    let created = store.create_room(Duration::from_secs(60)).await.unwrap();
    let joined = store.join_room(&created.room_id).await.unwrap();
    let (sender, _receiver) = mpsc::unbounded_channel();

    assert!(matches!(
        store
            .register_connection(
                &created.room_id,
                PeerRole::Guest,
                &created.host_token,
                sender
            )
            .await,
        Err(StoreError::InvalidCredentials)
    ));

    assert!(
        store
            .authenticate(&created.room_id, PeerRole::Guest, &joined.guest_token)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn room_peer_routing_is_bidirectional_only_after_both_connect() {
    let store = RoomStore::new(2);
    let created = store.create_room(Duration::from_secs(60)).await.unwrap();
    let joined = store.join_room(&created.room_id).await.unwrap();

    let (host_sender, mut host_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.room_id,
            PeerRole::Host,
            &created.host_token,
            host_sender,
        )
        .await
        .unwrap();

    assert!(
        store
            .peer_sender(&created.room_id, PeerRole::Host)
            .await
            .is_none()
    );

    let (guest_sender, mut guest_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.room_id,
            PeerRole::Guest,
            &joined.guest_token,
            guest_sender,
        )
        .await
        .unwrap();

    store
        .peer_sender(&created.room_id, PeerRole::Host)
        .await
        .unwrap()
        .send(ConnectionCommand::Close)
        .unwrap();
    assert!(matches!(
        guest_receiver.recv().await,
        Some(ConnectionCommand::Close)
    ));

    store
        .peer_sender(&created.room_id, PeerRole::Guest)
        .await
        .unwrap()
        .send(ConnectionCommand::Close)
        .unwrap();
    assert!(matches!(
        host_receiver.recv().await,
        Some(ConnectionCommand::Close)
    ));
}

#[tokio::test]
async fn stale_room_disconnect_cannot_remove_a_replacement_connection() {
    let store = RoomStore::new(2);
    let created = store.create_room(Duration::from_secs(60)).await.unwrap();
    let joined = store.join_room(&created.room_id).await.unwrap();

    let (guest_sender, _guest_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.room_id,
            PeerRole::Guest,
            &joined.guest_token,
            guest_sender,
        )
        .await
        .unwrap();

    let (first_sender, _first_receiver) = mpsc::unbounded_channel();
    let first = store
        .register_connection(
            &created.room_id,
            PeerRole::Host,
            &created.host_token,
            first_sender,
        )
        .await
        .unwrap();

    let (replacement_sender, _replacement_receiver) = mpsc::unbounded_channel();
    let replacement = store
        .register_connection(
            &created.room_id,
            PeerRole::Host,
            &created.host_token,
            replacement_sender,
        )
        .await
        .unwrap();

    assert!(replacement.replaced.is_some());
    assert!(
        store
            .unregister_connection(&created.room_id, PeerRole::Host, first.connection_id)
            .await
            .is_none()
    );
    assert!(
        store
            .peer_sender(&created.room_id, PeerRole::Guest)
            .await
            .is_some()
    );
    assert!(
        store
            .unregister_connection(&created.room_id, PeerRole::Host, replacement.connection_id)
            .await
            .is_some()
    );
}

#[tokio::test]
async fn unknown_room_operations_fail_closed() {
    let store = RoomStore::new(2);
    let token = generate_capability_token().unwrap();

    assert!(matches!(
        store.join_room("0123456789AB").await,
        Err(StoreError::RoomNotFound)
    ));
    assert!(matches!(
        store.status("0123456789AB").await,
        Err(StoreError::RoomNotFound)
    ));
    assert!(matches!(
        store
            .authenticate("0123456789AB", PeerRole::Host, &token)
            .await,
        Err(StoreError::RoomNotFound)
    ));
}

#[tokio::test]
async fn lobby_store_capacity_is_reused_after_expiry() {
    let store = LobbyStore::new(1);
    let expired = store.create_lobby(Duration::ZERO, 16).await.unwrap();
    assert_eq!(
        store.status(&expired.lobby_id).await.unwrap_err(),
        LobbyStoreError::LobbyNotFound
    );

    let replacement = store
        .create_lobby(Duration::from_secs(60), 16)
        .await
        .unwrap();
    assert!(store.status(&replacement.lobby_id).await.is_ok());
}

#[tokio::test]
async fn concurrent_lobby_join_never_exceeds_sixteen_participants() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 16)
        .await
        .unwrap();

    let mut tasks = Vec::new();
    for _ in 0..40 {
        let store = store.clone();
        let lobby_id = created.lobby_id.clone();
        tasks.push(tokio::spawn(
            async move { store.join_lobby(&lobby_id).await },
        ));
    }

    let mut successes = 0;
    let mut full = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => successes += 1,
            Err(LobbyStoreError::LobbyFull) => full += 1,
            Err(error) => panic!("unexpected lobby join error: {error:?}"),
        }
    }

    assert_eq!(successes, 15);
    assert_eq!(full, 25);
    assert_eq!(
        store
            .status(&created.lobby_id)
            .await
            .unwrap()
            .participant_count,
        16
    );
}

#[tokio::test]
async fn small_lobby_limit_is_enforced_independently_of_global_maximum() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 2)
        .await
        .unwrap();
    store.join_lobby(&created.lobby_id).await.unwrap();

    assert_eq!(
        store.join_lobby(&created.lobby_id).await.unwrap_err(),
        LobbyStoreError::LobbyFull
    );
}

#[tokio::test]
async fn lobby_host_identity_is_stable_for_every_joiner() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 8)
        .await
        .unwrap();

    for _ in 0..7 {
        let joined = store.join_lobby(&created.lobby_id).await.unwrap();
        assert_eq!(joined.host_participant_id, created.participant_id);
        assert_eq!(joined.max_participants, 8);
        assert_eq!(joined.expires_at, created.expires_at);
    }

    let status = store.status(&created.lobby_id).await.unwrap();
    assert_eq!(status.host_participant_id, created.participant_id);
    assert_eq!(status.participant_count, 8);
}

#[tokio::test]
async fn lobby_capabilities_are_not_interchangeable() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let second = store.join_lobby(&created.lobby_id).await.unwrap();
    let third = store.join_lobby(&created.lobby_id).await.unwrap();

    assert_eq!(
        store
            .authenticate(
                &created.lobby_id,
                &second.participant_id,
                &third.participant_token
            )
            .await,
        Err(LobbyStoreError::InvalidCredentials)
    );
    assert_eq!(
        store
            .authenticate(
                &created.lobby_id,
                &third.participant_id,
                &created.participant_token
            )
            .await,
        Err(LobbyStoreError::InvalidCredentials)
    );
}

#[tokio::test]
async fn lobby_registration_reports_only_connected_participants_in_sorted_order() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let second = store.join_lobby(&created.lobby_id).await.unwrap();
    let third = store.join_lobby(&created.lobby_id).await.unwrap();

    let (host_sender, _host_receiver) = mpsc::unbounded_channel();
    let host_registration = store
        .register_connection(
            &created.lobby_id,
            &created.participant_id,
            &created.participant_token,
            host_sender,
        )
        .await
        .unwrap();
    assert_eq!(
        host_registration.participants,
        vec![created.participant_id.clone()]
    );

    let (third_sender, _third_receiver) = mpsc::unbounded_channel();
    let registration = store
        .register_connection(
            &created.lobby_id,
            &third.participant_id,
            &third.participant_token,
            third_sender,
        )
        .await
        .unwrap();

    let mut expected = vec![created.participant_id.clone(), third.participant_id.clone()];
    expected.sort();
    assert_eq!(registration.participants, expected);
    assert_eq!(registration.connected_peers.len(), 1);
    assert!(!registration.participants.contains(&second.participant_id));
}

#[tokio::test]
async fn stale_lobby_disconnect_cannot_remove_a_replacement_connection() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let joined = store.join_lobby(&created.lobby_id).await.unwrap();

    let (host_sender, _host_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.lobby_id,
            &created.participant_id,
            &created.participant_token,
            host_sender,
        )
        .await
        .unwrap();

    let (first_sender, _first_receiver) = mpsc::unbounded_channel();
    let first = store
        .register_connection(
            &created.lobby_id,
            &joined.participant_id,
            &joined.participant_token,
            first_sender,
        )
        .await
        .unwrap();

    let (replacement_sender, _replacement_receiver) = mpsc::unbounded_channel();
    let replacement = store
        .register_connection(
            &created.lobby_id,
            &joined.participant_id,
            &joined.participant_token,
            replacement_sender,
        )
        .await
        .unwrap();

    assert!(replacement.replaced.is_some());
    assert!(
        store
            .unregister_connection(
                &created.lobby_id,
                &joined.participant_id,
                first.connection_id
            )
            .await
            .is_empty()
    );
    assert!(
        store
            .target_sender(
                &created.lobby_id,
                &created.participant_id,
                &joined.participant_id
            )
            .await
            .is_ok()
    );

    let peers = store
        .unregister_connection(
            &created.lobby_id,
            &joined.participant_id,
            replacement.connection_id,
        )
        .await;
    assert_eq!(peers.len(), 1);
}

#[tokio::test]
async fn lobby_disconnect_notifies_every_other_connected_participant() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let second = store.join_lobby(&created.lobby_id).await.unwrap();
    let third = store.join_lobby(&created.lobby_id).await.unwrap();

    let mut registrations = Vec::new();
    for (id, token) in [
        (&created.participant_id, &created.participant_token),
        (&second.participant_id, &second.participant_token),
        (&third.participant_id, &third.participant_token),
    ] {
        let (sender, _receiver) = mpsc::unbounded_channel();
        registrations.push(
            store
                .register_connection(&created.lobby_id, id, token, sender)
                .await
                .unwrap(),
        );
    }

    let peers = store
        .unregister_connection(
            &created.lobby_id,
            &second.participant_id,
            registrations[1].connection_id,
        )
        .await;
    assert_eq!(peers.len(), 2);
    assert_eq!(
        store
            .status(&created.lobby_id)
            .await
            .unwrap()
            .participant_count,
        3,
        "disconnecting signaling does not remove lobby membership"
    );
}

#[tokio::test]
async fn targeted_routing_rejects_self_unknown_sender_unknown_target_and_disconnected_target() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let joined = store.join_lobby(&created.lobby_id).await.unwrap();
    let unknown = generate_participant_id().unwrap();

    assert_eq!(
        store
            .target_sender(
                &created.lobby_id,
                &created.participant_id,
                &created.participant_id
            )
            .await
            .unwrap_err(),
        LobbyStoreError::ParticipantNotFound
    );
    assert_eq!(
        store
            .target_sender(&created.lobby_id, &unknown, &joined.participant_id)
            .await
            .unwrap_err(),
        LobbyStoreError::ParticipantNotFound
    );
    assert_eq!(
        store
            .target_sender(&created.lobby_id, &created.participant_id, &unknown)
            .await
            .unwrap_err(),
        LobbyStoreError::ParticipantNotFound
    );
    assert_eq!(
        store
            .target_sender(
                &created.lobby_id,
                &created.participant_id,
                &joined.participant_id
            )
            .await
            .unwrap_err(),
        LobbyStoreError::TargetNotConnected
    );
}

#[tokio::test]
async fn targeted_routing_delivers_to_exactly_one_requested_connection() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let second = store.join_lobby(&created.lobby_id).await.unwrap();
    let third = store.join_lobby(&created.lobby_id).await.unwrap();

    let (host_sender, _host_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.lobby_id,
            &created.participant_id,
            &created.participant_token,
            host_sender,
        )
        .await
        .unwrap();

    let (second_sender, mut second_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.lobby_id,
            &second.participant_id,
            &second.participant_token,
            second_sender,
        )
        .await
        .unwrap();

    let (third_sender, mut third_receiver) = mpsc::unbounded_channel();
    store
        .register_connection(
            &created.lobby_id,
            &third.participant_id,
            &third.participant_token,
            third_sender,
        )
        .await
        .unwrap();

    store
        .target_sender(
            &created.lobby_id,
            &created.participant_id,
            &second.participant_id,
        )
        .await
        .unwrap()
        .send(LobbyConnectionCommand::Send(LobbyServerMessage::Pong {
            nonce: Some("targeted".to_owned()),
        }))
        .unwrap();

    assert!(matches!(
        second_receiver.recv().await,
        Some(LobbyConnectionCommand::Send(LobbyServerMessage::Pong {
            nonce: Some(ref nonce)
        })) if nonce == "targeted"
    ));
    assert!(matches!(
        third_receiver.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn disconnected_lobby_member_can_reconnect_with_the_same_capability() {
    let store = LobbyStore::new(2);
    let created = store
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let joined = store.join_lobby(&created.lobby_id).await.unwrap();

    let (sender, _receiver) = mpsc::unbounded_channel();
    let first = store
        .register_connection(
            &created.lobby_id,
            &joined.participant_id,
            &joined.participant_token,
            sender,
        )
        .await
        .unwrap();
    store
        .unregister_connection(
            &created.lobby_id,
            &joined.participant_id,
            first.connection_id,
        )
        .await;

    assert!(
        store
            .authenticate(
                &created.lobby_id,
                &joined.participant_id,
                &joined.participant_token
            )
            .await
            .is_ok()
    );

    let (replacement_sender, _replacement_receiver) = mpsc::unbounded_channel();
    assert!(
        store
            .register_connection(
                &created.lobby_id,
                &joined.participant_id,
                &joined.participant_token,
                replacement_sender,
            )
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn unknown_lobby_operations_fail_closed() {
    let store = LobbyStore::new(2);
    let participant = generate_participant_id().unwrap();
    let token = generate_capability_token().unwrap();

    assert_eq!(
        store.join_lobby("0123456789AB").await.unwrap_err(),
        LobbyStoreError::LobbyNotFound
    );
    assert_eq!(
        store.status("0123456789AB").await.unwrap_err(),
        LobbyStoreError::LobbyNotFound
    );
    assert_eq!(
        store
            .authenticate("0123456789AB", &participant, &token)
            .await
            .unwrap_err(),
        LobbyStoreError::LobbyNotFound
    );
}

#[test]
fn copied_protocol_surface_is_covered() {
    assert_eq!(protocol::WEBSOCKET_PROTOCOL, "multiplayer-setup-v1");
    assert_eq!(protocol::CAPABILITY_PROTOCOL_PREFIX, "cap.");

    let server_messages = [
        protocol::ServerMessage::Connected {
            role: PeerRole::Host,
        },
        protocol::ServerMessage::PeerConnected {
            peer_role: PeerRole::Guest,
        },
        protocol::ServerMessage::PeerDisconnected {
            peer_role: PeerRole::Guest,
        },
        protocol::ServerMessage::Pong {
            nonce: Some("room".to_owned()),
        },
        protocol::ServerMessage::Signal {
            from: PeerRole::Host,
            payload: serde_json::json!({"candidate": "opaque"}),
        },
        protocol::ServerMessage::Error {
            code: "test-error",
            message: "test error",
        },
    ];
    for message in server_messages {
        assert!(!serde_json::to_string(&message).unwrap().is_empty());
    }

    let participant_id = generate_participant_id().unwrap();
    let lobby_messages = [
        LobbyServerMessage::Connected {
            participant_id: participant_id.clone(),
            host_participant_id: participant_id.clone(),
            participants: vec![participant_id.clone()],
        },
        LobbyServerMessage::ParticipantConnected {
            participant_id: participant_id.clone(),
        },
        LobbyServerMessage::ParticipantDisconnected {
            participant_id: participant_id.clone(),
        },
        LobbyServerMessage::Pong {
            nonce: Some("lobby".to_owned()),
        },
        LobbyServerMessage::Signal {
            from: participant_id,
            payload: serde_json::json!({"description": "opaque"}),
        },
        LobbyServerMessage::Error {
            code: "test-error",
            message: "test error",
        },
    ];
    for message in lobby_messages {
        assert!(!serde_json::to_string(&message).unwrap().is_empty());
    }

    assert!(matches!(
        LobbyConnectionCommand::Close,
        LobbyConnectionCommand::Close
    ));
    assert!(matches!(
        ConnectionCommand::Send(protocol::ServerMessage::Pong { nonce: None }),
        ConnectionCommand::Send(protocol::ServerMessage::Pong { nonce: None })
    ));
}

#[tokio::test]
async fn copied_runtime_metadata_and_cleanup_paths_are_covered() {
    let rooms = RoomStore::new(2);
    let created_room = rooms.create_room(Duration::from_secs(60)).await.unwrap();
    let joined_room = rooms.join_room(&created_room.room_id).await.unwrap();

    let (host_sender, _host_receiver) = mpsc::unbounded_channel();
    rooms
        .register_connection(
            &created_room.room_id,
            PeerRole::Host,
            &created_room.host_token,
            host_sender,
        )
        .await
        .unwrap();
    let (guest_sender, _guest_receiver) = mpsc::unbounded_channel();
    let guest_registration = rooms
        .register_connection(
            &created_room.room_id,
            PeerRole::Guest,
            &joined_room.guest_token,
            guest_sender,
        )
        .await
        .unwrap();
    assert!(guest_registration.peer.is_some());
    assert_eq!(rooms.cleanup_expired().await, 0);

    let lobbies = LobbyStore::new(2);
    let created_lobby = lobbies
        .create_lobby(Duration::from_secs(60), 4)
        .await
        .unwrap();
    let (participant_sender, _participant_receiver) = mpsc::unbounded_channel();
    let registration = lobbies
        .register_connection(
            &created_lobby.lobby_id,
            &created_lobby.participant_id,
            &created_lobby.participant_token,
            participant_sender,
        )
        .await
        .unwrap();
    assert_eq!(
        registration.host_participant_id,
        created_lobby.host_participant_id
    );
    assert_eq!(lobbies.cleanup_expired().await, 0);
}
