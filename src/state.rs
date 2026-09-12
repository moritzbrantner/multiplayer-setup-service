#[path = "outbox.rs"]
pub mod outbox;

use crate::protocol::{
    PeerRole, ServerMessage, generate_capability_token, generate_room_id, hash_capability_token,
    hashes_equal,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const MAX_ROOM_CREATION_ATTEMPTS: usize = 5;

pub type ConnectionSender = outbox::Sender;

#[derive(Clone, Debug)]
pub enum ConnectionCommand {
    Send(ServerMessage),
    Close,
}

impl outbox::Command for ConnectionCommand {
    fn into_text(self) -> Option<String> {
        match self {
            Self::Send(message) => {
                Some(serde_json::to_string(&message).expect("server message should serialize"))
            }
            Self::Close => None,
        }
    }
}

#[derive(Clone)]
pub struct RoomStore {
    inner: Arc<Mutex<Inner>>,
    next_connection_id: Arc<AtomicU64>,
    max_rooms: usize,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, Room>,
}

struct Room {
    expires_at: u64,
    host_token_hash: [u8; 32],
    guest_token_hash: Option<[u8; 32]>,
    host_connection: Option<Connection>,
    guest_connection: Option<Connection>,
}

struct Connection {
    id: u64,
    sender: ConnectionSender,
}

#[derive(Debug)]
pub enum StoreError {
    Capacity,
    InvalidCredentials,
    Randomness,
    RoomFull,
    RoomNotFound,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRoom {
    pub room_id: String,
    pub display_code: String,
    pub host_token: String,
    pub expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedRoom {
    pub guest_token: String,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomStatusKind {
    Waiting,
    Paired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomStatus {
    pub status: RoomStatusKind,
    pub expires_at: u64,
}

pub struct Registration {
    pub connection_id: u64,
    pub replaced: Option<ConnectionSender>,
    pub peer: Option<ConnectionSender>,
}

impl RoomStore {
    pub fn new(max_rooms: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            next_connection_id: Arc::new(AtomicU64::new(1)),
            max_rooms,
        }
    }

    pub async fn create_room(&self, ttl: Duration) -> Result<CreatedRoom, StoreError> {
        for _ in 0..MAX_ROOM_CREATION_ATTEMPTS {
            let room_id = generate_room_id().map_err(|_| StoreError::Randomness)?;
            let host_token = generate_capability_token().map_err(|_| StoreError::Randomness)?;
            let expires_at = now_ms().saturating_add(duration_ms(ttl));
            let host_token_hash = hash_capability_token(&host_token);

            let mut inner = self.inner.lock().await;
            if inner.rooms.len() >= self.max_rooms {
                purge_expired(&mut inner);
                if inner.rooms.len() >= self.max_rooms {
                    return Err(StoreError::Capacity);
                }
            }
            if inner.rooms.contains_key(&room_id) {
                continue;
            }

            inner.rooms.insert(
                room_id.clone(),
                Room {
                    expires_at,
                    host_token_hash,
                    guest_token_hash: None,
                    host_connection: None,
                    guest_connection: None,
                },
            );

            let display_code = crate::protocol::format_room_code(&room_id)
                .expect("generated room ID should always format");

            return Ok(CreatedRoom {
                room_id,
                display_code,
                host_token,
                expires_at,
            });
        }

        Err(StoreError::Capacity)
    }

    pub async fn join_room(&self, room_id: &str) -> Result<JoinedRoom, StoreError> {
        let guest_token = generate_capability_token().map_err(|_| StoreError::Randomness)?;
        let guest_token_hash = hash_capability_token(&guest_token);

        let mut inner = self.inner.lock().await;
        purge_room_if_expired(&mut inner, room_id);
        let room = inner
            .rooms
            .get_mut(room_id)
            .ok_or(StoreError::RoomNotFound)?;

        if room.guest_token_hash.is_some() {
            return Err(StoreError::RoomFull);
        }

        room.guest_token_hash = Some(guest_token_hash);
        Ok(JoinedRoom {
            guest_token,
            expires_at: room.expires_at,
        })
    }

    pub async fn status(&self, room_id: &str) -> Result<RoomStatus, StoreError> {
        let mut inner = self.inner.lock().await;
        purge_room_if_expired(&mut inner, room_id);
        let room = inner.rooms.get(room_id).ok_or(StoreError::RoomNotFound)?;

        Ok(RoomStatus {
            status: if room.guest_token_hash.is_some() {
                RoomStatusKind::Paired
            } else {
                RoomStatusKind::Waiting
            },
            expires_at: room.expires_at,
        })
    }

    pub async fn authenticate(
        &self,
        room_id: &str,
        role: PeerRole,
        token: &str,
    ) -> Result<(), StoreError> {
        let token_hash = hash_capability_token(token);
        let mut inner = self.inner.lock().await;
        purge_room_if_expired(&mut inner, room_id);
        let room = inner.rooms.get(room_id).ok_or(StoreError::RoomNotFound)?;
        let expected = token_hash_for_role(room, role).ok_or(StoreError::InvalidCredentials)?;

        if hashes_equal(expected, &token_hash) {
            Ok(())
        } else {
            Err(StoreError::InvalidCredentials)
        }
    }

    pub async fn register_connection(
        &self,
        room_id: &str,
        role: PeerRole,
        token: &str,
        sender: ConnectionSender,
    ) -> Result<Registration, StoreError> {
        let token_hash = hash_capability_token(token);
        let mut inner = self.inner.lock().await;
        purge_room_if_expired(&mut inner, room_id);
        let room = inner
            .rooms
            .get_mut(room_id)
            .ok_or(StoreError::RoomNotFound)?;
        let expected = token_hash_for_role(room, role).ok_or(StoreError::InvalidCredentials)?;

        if !hashes_equal(expected, &token_hash) {
            return Err(StoreError::InvalidCredentials);
        }

        let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
        let connection = Connection {
            id: connection_id,
            sender,
        };

        let replaced = connection_slot_mut(room, role).replace(connection);
        let peer = connection_slot(room, role.other())
            .as_ref()
            .map(|connection| connection.sender.clone());

        Ok(Registration {
            connection_id,
            replaced: replaced.map(|connection| connection.sender),
            peer,
        })
    }

    pub async fn unregister_connection(
        &self,
        room_id: &str,
        role: PeerRole,
        connection_id: u64,
    ) -> Option<ConnectionSender> {
        let mut inner = self.inner.lock().await;
        let room = inner.rooms.get_mut(room_id)?;
        let slot = connection_slot_mut(room, role);

        if slot
            .as_ref()
            .is_some_and(|connection| connection.id == connection_id)
        {
            slot.take();
            return connection_slot(room, role.other())
                .as_ref()
                .map(|connection| connection.sender.clone());
        }

        None
    }

    pub async fn peer_sender(&self, room_id: &str, role: PeerRole) -> Option<ConnectionSender> {
        let mut inner = self.inner.lock().await;
        purge_room_if_expired(&mut inner, room_id);
        let room = inner.rooms.get(room_id)?;
        connection_slot(room, role.other())
            .as_ref()
            .map(|connection| connection.sender.clone())
    }

    pub async fn cleanup_expired(&self) -> usize {
        let mut inner = self.inner.lock().await;
        let before = inner.rooms.len();
        purge_expired(&mut inner);
        before - inner.rooms.len()
    }
}

fn connection_slot(room: &Room, role: PeerRole) -> &Option<Connection> {
    match role {
        PeerRole::Host => &room.host_connection,
        PeerRole::Guest => &room.guest_connection,
    }
}

fn connection_slot_mut(room: &mut Room, role: PeerRole) -> &mut Option<Connection> {
    match role {
        PeerRole::Host => &mut room.host_connection,
        PeerRole::Guest => &mut room.guest_connection,
    }
}

fn token_hash_for_role(room: &Room, role: PeerRole) -> Option<&[u8; 32]> {
    match role {
        PeerRole::Host => Some(&room.host_token_hash),
        PeerRole::Guest => room.guest_token_hash.as_ref(),
    }
}

fn purge_room_if_expired(inner: &mut Inner, room_id: &str) {
    let now = now_ms();
    if inner
        .rooms
        .get(room_id)
        .is_some_and(|room| room.expires_at <= now)
    {
        inner.rooms.remove(room_id);
    }
}

fn purge_expired(inner: &mut Inner) {
    let now = now_ms();
    inner.rooms.retain(|_, room| room.expires_at > now);
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn room_can_be_claimed_by_only_one_guest() {
        let store = RoomStore::new(8);
        let created = store.create_room(Duration::from_secs(600)).await.unwrap();

        let joined = store.join_room(&created.room_id).await.unwrap();
        assert_eq!(joined.guest_token.len(), 64);
        assert!(matches!(
            store.join_room(&created.room_id).await,
            Err(StoreError::RoomFull)
        ));

        let status = store.status(&created.room_id).await.unwrap();
        assert!(matches!(status.status, RoomStatusKind::Paired));
    }

    #[tokio::test]
    async fn host_and_guest_capabilities_are_distinct() {
        let store = RoomStore::new(8);
        let created = store.create_room(Duration::from_secs(600)).await.unwrap();
        let joined = store.join_room(&created.room_id).await.unwrap();

        assert!(
            store
                .authenticate(&created.room_id, PeerRole::Host, &created.host_token)
                .await
                .is_ok()
        );
        assert!(
            store
                .authenticate(&created.room_id, PeerRole::Guest, &joined.guest_token)
                .await
                .is_ok()
        );
        assert!(matches!(
            store
                .authenticate(&created.room_id, PeerRole::Guest, &created.host_token)
                .await,
            Err(StoreError::InvalidCredentials)
        ));
    }

    #[tokio::test]
    async fn reconnect_replaces_only_the_same_role_connection() {
        let store = RoomStore::new(8);
        let created = store.create_room(Duration::from_secs(600)).await.unwrap();
        store.join_room(&created.room_id).await.unwrap();

        let (first_sender, _first_receiver) = outbox::channel();
        let first = store
            .register_connection(
                &created.room_id,
                PeerRole::Host,
                &created.host_token,
                first_sender,
            )
            .await
            .unwrap();
        assert!(first.replaced.is_none());

        let (second_sender, _second_receiver) = outbox::channel();
        let second = store
            .register_connection(
                &created.room_id,
                PeerRole::Host,
                &created.host_token,
                second_sender,
            )
            .await
            .unwrap();

        assert!(second.replaced.is_some());
        assert!(second.connection_id > first.connection_id);
    }
}
