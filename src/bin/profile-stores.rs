#![allow(dead_code)]

#[cfg(not(test))]
#[path = "../lobby.rs"]
mod lobby;
#[cfg(not(test))]
#[path = "../protocol.rs"]
mod protocol;
#[cfg(not(test))]
#[path = "../state.rs"]
mod state;

#[cfg(not(test))]
use lobby::LobbyStore;
#[cfg(not(test))]
use protocol::PeerRole;
#[cfg(not(test))]
use state::RoomStore;
#[cfg(not(test))]
use std::time::Duration;

#[cfg(not(test))]
const ROOM_COUNT: usize = 5_000;
#[cfg(not(test))]
const LOBBY_COUNT: usize = 1_000;
#[cfg(not(test))]
const TTL: Duration = Duration::from_secs(600);

#[cfg(not(test))]
#[tokio::main]
async fn main() {
    let room_store = RoomStore::new(ROOM_COUNT + 1);
    let mut rooms = Vec::with_capacity(ROOM_COUNT);

    for _ in 0..ROOM_COUNT {
        let created = room_store
            .create_room(TTL)
            .await
            .expect("profile room creation should stay below capacity");
        rooms.push((created.room_id, created.host_token));
    }

    for (room_id, _) in &rooms {
        let status = room_store
            .status(room_id)
            .await
            .expect("profile room should stay live");
        assert!(matches!(status.status, state::RoomStatusKind::Waiting));
    }

    for (room_id, token) in &rooms {
        room_store
            .authenticate(room_id, PeerRole::Host, token)
            .await
            .expect("profile host capability should authenticate");
    }

    let lobby_store = LobbyStore::new(LOBBY_COUNT + 1);
    let mut lobby_ids = Vec::with_capacity(LOBBY_COUNT);

    for _ in 0..LOBBY_COUNT {
        let created = lobby_store
            .create_lobby(TTL, 16)
            .await
            .expect("profile lobby creation should stay below capacity");
        lobby_ids.push(created.lobby_id);
    }

    for lobby_id in &lobby_ids {
        let status = lobby_store
            .status(lobby_id)
            .await
            .expect("profile lobby should stay live");
        assert_eq!(status.participant_count, 1);
    }

    println!(
        "{{\"rooms\":{ROOM_COUNT},\"roomStatusChecks\":{ROOM_COUNT},\"roomAuthentications\":{ROOM_COUNT},\"lobbies\":{LOBBY_COUNT},\"lobbyStatusChecks\":{LOBBY_COUNT}}}"
    );
}

#[cfg(test)]
fn main() {}
