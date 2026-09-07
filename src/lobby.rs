use crate::protocol::{
    LobbyServerMessage, format_room_code, generate_capability_token, generate_participant_id,
    generate_room_id, hash_capability_token, hashes_equal,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, mpsc};

const MAX_ID_CREATION_ATTEMPTS: usize = 8;

pub type LobbyConnectionSender = mpsc::UnboundedSender<LobbyConnectionCommand>;

#[derive(Clone, Debug)]
pub enum LobbyConnectionCommand {
    Send(LobbyServerMessage),
    Close,
}

#[derive(Clone)]
pub struct LobbyStore {
    inner: Arc<Mutex<Inner>>,
    next_connection_id: Arc<AtomicU64>,
    max_lobbies: usize,
}

#[derive(Default)]
struct Inner {
    lobbies: HashMap<String, Lobby>,
}

struct Lobby {
    expires_at: u64,
    max_expires_at: u64,
    host_participant_id: String,
    max_participants: usize,
    participants: HashMap<String, Participant>,
}

struct Participant {
    token_hash: [u8; 32],
    connection: Option<Connection>,
}

struct Connection {
    id: u64,
    sender: LobbyConnectionSender,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LobbyStoreError {
    Capacity,
    HostRequired,
    InvalidCredentials,
    LobbyFull,
    LobbyNotFound,
    ParticipantNotFound,
    Randomness,
    RenewalLimitReached,
    TargetNotConnected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedLobby {
    pub lobby_id: String,
    pub display_code: String,
    pub participant_id: String,
    pub participant_token: String,
    pub host_participant_id: String,
    pub expires_at: u64,
    pub max_expires_at: u64,
    pub max_participants: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedLobby {
    pub participant_id: String,
    pub participant_token: String,
    pub host_participant_id: String,
    pub expires_at: u64,
    pub max_expires_at: u64,
    pub max_participants: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyStatus {
    pub host_participant_id: String,
    pub participant_count: usize,
    pub max_participants: usize,
    pub expires_at: u64,
    pub max_expires_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewedLobby {
    pub expires_at: u64,
    pub max_expires_at: u64,
}

pub struct LobbyRegistration {
    pub connection_id: u64,
    pub replaced: Option<LobbyConnectionSender>,
    pub connected_peers: Vec<LobbyConnectionSender>,
    pub participants: Vec<String>,
    pub host_participant_id: String,
}

impl LobbyStore {
    pub fn new(max_lobbies: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            next_connection_id: Arc::new(AtomicU64::new(1)),
            max_lobbies,
        }
    }

    pub async fn create_lobby(
        &self,
        ttl: Duration,
        max_participants: usize,
    ) -> Result<CreatedLobby, LobbyStoreError> {
        self.create_lobby_with_max_lifetime(ttl, ttl, max_participants)
            .await
    }

    pub async fn create_lobby_with_max_lifetime(
        &self,
        ttl: Duration,
        max_lifetime: Duration,
        max_participants: usize,
    ) -> Result<CreatedLobby, LobbyStoreError> {
        for _ in 0..MAX_ID_CREATION_ATTEMPTS {
            let lobby_id = generate_room_id().map_err(|_| LobbyStoreError::Randomness)?;
            let participant_id =
                generate_participant_id().map_err(|_| LobbyStoreError::Randomness)?;
            let participant_token =
                generate_capability_token().map_err(|_| LobbyStoreError::Randomness)?;
            let created_at = now_ms();
            let expires_at = created_at.saturating_add(duration_ms(ttl));
            let max_expires_at = created_at
                .saturating_add(duration_ms(max_lifetime))
                .max(expires_at);

            let mut inner = self.inner.lock().await;
            purge_expired(&mut inner);
            if inner.lobbies.len() >= self.max_lobbies {
                return Err(LobbyStoreError::Capacity);
            }
            if inner.lobbies.contains_key(&lobby_id) {
                continue;
            }

            let mut participants = HashMap::new();
            participants.insert(
                participant_id.clone(),
                Participant {
                    token_hash: hash_capability_token(&participant_token),
                    connection: None,
                },
            );

            inner.lobbies.insert(
                lobby_id.clone(),
                Lobby {
                    expires_at,
                    max_expires_at,
                    host_participant_id: participant_id.clone(),
                    max_participants,
                    participants,
                },
            );

            let display_code =
                format_room_code(&lobby_id).expect("generated lobby ID should always format");

            return Ok(CreatedLobby {
                lobby_id,
                display_code,
                host_participant_id: participant_id.clone(),
                participant_id,
                participant_token,
                expires_at,
                max_expires_at,
                max_participants,
            });
        }

        Err(LobbyStoreError::Capacity)
    }

    pub async fn join_lobby(&self, lobby_id: &str) -> Result<JoinedLobby, LobbyStoreError> {
        for _ in 0..MAX_ID_CREATION_ATTEMPTS {
            let participant_id =
                generate_participant_id().map_err(|_| LobbyStoreError::Randomness)?;
            let participant_token =
                generate_capability_token().map_err(|_| LobbyStoreError::Randomness)?;
            let token_hash = hash_capability_token(&participant_token);

            let mut inner = self.inner.lock().await;
            purge_expired(&mut inner);
            let lobby = inner
                .lobbies
                .get_mut(lobby_id)
                .ok_or(LobbyStoreError::LobbyNotFound)?;

            if lobby.participants.len() >= lobby.max_participants {
                return Err(LobbyStoreError::LobbyFull);
            }
            if lobby.participants.contains_key(&participant_id) {
                continue;
            }

            lobby.participants.insert(
                participant_id.clone(),
                Participant {
                    token_hash,
                    connection: None,
                },
            );

            return Ok(JoinedLobby {
                participant_id,
                participant_token,
                host_participant_id: lobby.host_participant_id.clone(),
                expires_at: lobby.expires_at,
                max_expires_at: lobby.max_expires_at,
                max_participants: lobby.max_participants,
            });
        }

        Err(LobbyStoreError::Capacity)
    }

    pub async fn status(&self, lobby_id: &str) -> Result<LobbyStatus, LobbyStoreError> {
        let mut inner = self.inner.lock().await;
        purge_expired(&mut inner);
        let lobby = inner
            .lobbies
            .get(lobby_id)
            .ok_or(LobbyStoreError::LobbyNotFound)?;

        Ok(LobbyStatus {
            host_participant_id: lobby.host_participant_id.clone(),
            participant_count: lobby.participants.len(),
            max_participants: lobby.max_participants,
            expires_at: lobby.expires_at,
            max_expires_at: lobby.max_expires_at,
        })
    }

    pub async fn authenticate(
        &self,
        lobby_id: &str,
        participant_id: &str,
        token: &str,
    ) -> Result<(), LobbyStoreError> {
        let token_hash = hash_capability_token(token);
        let mut inner = self.inner.lock().await;
        purge_expired(&mut inner);
        let lobby = inner
            .lobbies
            .get(lobby_id)
            .ok_or(LobbyStoreError::LobbyNotFound)?;
        let participant = lobby
            .participants
            .get(participant_id)
            .ok_or(LobbyStoreError::ParticipantNotFound)?;

        if hashes_equal(&participant.token_hash, &token_hash) {
            Ok(())
        } else {
            Err(LobbyStoreError::InvalidCredentials)
        }
    }

    pub async fn renew_lobby(
        &self,
        lobby_id: &str,
        participant_id: &str,
        token: &str,
        extension: Duration,
    ) -> Result<RenewedLobby, LobbyStoreError> {
        let token_hash = hash_capability_token(token);
        let mut inner = self.inner.lock().await;
        purge_expired(&mut inner);
        let lobby = inner
            .lobbies
            .get_mut(lobby_id)
            .ok_or(LobbyStoreError::LobbyNotFound)?;

        if lobby.host_participant_id != participant_id {
            return Err(LobbyStoreError::HostRequired);
        }

        let participant = lobby
            .participants
            .get(participant_id)
            .ok_or(LobbyStoreError::ParticipantNotFound)?;
        if !hashes_equal(&participant.token_hash, &token_hash) {
            return Err(LobbyStoreError::InvalidCredentials);
        }

        if lobby.expires_at >= lobby.max_expires_at {
            return Err(LobbyStoreError::RenewalLimitReached);
        }

        let next_expires_at = lobby
            .expires_at
            .saturating_add(duration_ms(extension))
            .min(lobby.max_expires_at);
        if next_expires_at <= lobby.expires_at {
            return Err(LobbyStoreError::RenewalLimitReached);
        }

        lobby.expires_at = next_expires_at;
        Ok(RenewedLobby {
            expires_at: lobby.expires_at,
            max_expires_at: lobby.max_expires_at,
        })
    }

    pub async fn register_connection(
        &self,
        lobby_id: &str,
        participant_id: &str,
        token: &str,
        sender: LobbyConnectionSender,
    ) -> Result<LobbyRegistration, LobbyStoreError> {
        let token_hash = hash_capability_token(token);
        let mut inner = self.inner.lock().await;
        purge_expired(&mut inner);
        let lobby = inner
            .lobbies
            .get_mut(lobby_id)
            .ok_or(LobbyStoreError::LobbyNotFound)?;

        let participant = lobby
            .participants
            .get_mut(participant_id)
            .ok_or(LobbyStoreError::ParticipantNotFound)?;

        if !hashes_equal(&participant.token_hash, &token_hash) {
            return Err(LobbyStoreError::InvalidCredentials);
        }

        let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
        let replaced = participant.connection.replace(Connection {
            id: connection_id,
            sender,
        });

        let connected_peers = lobby
            .participants
            .iter()
            .filter(|(id, _)| id.as_str() != participant_id)
            .filter_map(|(_, participant)| {
                participant
                    .connection
                    .as_ref()
                    .map(|connection| connection.sender.clone())
            })
            .collect();

        let mut participants = lobby
            .participants
            .iter()
            .filter(|(_, participant)| participant.connection.is_some())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        participants.sort();

        Ok(LobbyRegistration {
            connection_id,
            replaced: replaced.map(|connection| connection.sender),
            connected_peers,
            participants,
            host_participant_id: lobby.host_participant_id.clone(),
        })
    }

    pub async fn unregister_connection(
        &self,
        lobby_id: &str,
        participant_id: &str,
        connection_id: u64,
    ) -> Vec<LobbyConnectionSender> {
        let mut inner = self.inner.lock().await;
        let Some(lobby) = inner.lobbies.get_mut(lobby_id) else {
            return Vec::new();
        };
        let Some(participant) = lobby.participants.get_mut(participant_id) else {
            return Vec::new();
        };

        if !participant
            .connection
            .as_ref()
            .is_some_and(|connection| connection.id == connection_id)
        {
            return Vec::new();
        }

        participant.connection.take();

        lobby
            .participants
            .values()
            .filter_map(|participant| {
                participant
                    .connection
                    .as_ref()
                    .map(|connection| connection.sender.clone())
            })
            .collect()
    }

    pub async fn target_sender(
        &self,
        lobby_id: &str,
        from: &str,
        to: &str,
    ) -> Result<LobbyConnectionSender, LobbyStoreError> {
        if from == to {
            return Err(LobbyStoreError::ParticipantNotFound);
        }

        let mut inner = self.inner.lock().await;
        purge_expired(&mut inner);
        let lobby = inner
            .lobbies
            .get(lobby_id)
            .ok_or(LobbyStoreError::LobbyNotFound)?;

        if !lobby.participants.contains_key(from) {
            return Err(LobbyStoreError::ParticipantNotFound);
        }

        let target = lobby
            .participants
            .get(to)
            .ok_or(LobbyStoreError::ParticipantNotFound)?;

        target
            .connection
            .as_ref()
            .map(|connection| connection.sender.clone())
            .ok_or(LobbyStoreError::TargetNotConnected)
    }

    pub async fn cleanup_expired(&self) -> usize {
        let mut inner = self.inner.lock().await;
        let before = inner.lobbies.len();
        purge_expired(&mut inner);
        before - inner.lobbies.len()
    }
}

fn purge_expired(inner: &mut Inner) {
    let now = now_ms();
    inner.lobbies.retain(|_, lobby| lobby.expires_at > now);
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
    async fn lobby_accepts_sixteen_unique_participants() {
        let store = LobbyStore::new(4);
        let created = store
            .create_lobby(Duration::from_secs(600), 16)
            .await
            .unwrap();

        let mut ids = vec![created.participant_id];
        for _ in 1..16 {
            ids.push(
                store
                    .join_lobby(&created.lobby_id)
                    .await
                    .unwrap()
                    .participant_id,
            );
        }

        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 16);
        assert_eq!(
            store
                .status(&created.lobby_id)
                .await
                .unwrap()
                .participant_count,
            16
        );
        assert!(matches!(
            store.join_lobby(&created.lobby_id).await,
            Err(LobbyStoreError::LobbyFull)
        ));
    }

    #[tokio::test]
    async fn participant_capabilities_are_independent() {
        let store = LobbyStore::new(4);
        let created = store
            .create_lobby(Duration::from_secs(600), 16)
            .await
            .unwrap();
        let joined = store.join_lobby(&created.lobby_id).await.unwrap();

        assert!(
            store
                .authenticate(
                    &created.lobby_id,
                    &created.participant_id,
                    &created.participant_token
                )
                .await
                .is_ok()
        );
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
        assert_eq!(
            store
                .authenticate(
                    &created.lobby_id,
                    &joined.participant_id,
                    &created.participant_token
                )
                .await,
            Err(LobbyStoreError::InvalidCredentials)
        );
    }

    #[tokio::test]
    async fn only_host_capability_can_renew_lobby() {
        let store = LobbyStore::new(4);
        let created = store
            .create_lobby_with_max_lifetime(
                Duration::from_secs(60),
                Duration::from_secs(180),
                4,
            )
            .await
            .unwrap();
        let joined = store.join_lobby(&created.lobby_id).await.unwrap();

        assert_eq!(
            store
                .renew_lobby(
                    &created.lobby_id,
                    &joined.participant_id,
                    &joined.participant_token,
                    Duration::from_secs(60),
                )
                .await,
            Err(LobbyStoreError::HostRequired)
        );
        assert_eq!(
            store
                .renew_lobby(
                    &created.lobby_id,
                    &created.participant_id,
                    &joined.participant_token,
                    Duration::from_secs(60),
                )
                .await,
            Err(LobbyStoreError::InvalidCredentials)
        );
    }

    #[tokio::test]
    async fn host_renewal_stops_at_absolute_lifetime_cap() {
        let store = LobbyStore::new(4);
        let created = store
            .create_lobby_with_max_lifetime(
                Duration::from_secs(60),
                Duration::from_secs(120),
                4,
            )
            .await
            .unwrap();

        let renewed = store
            .renew_lobby(
                &created.lobby_id,
                &created.participant_id,
                &created.participant_token,
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        assert_eq!(renewed.expires_at, created.max_expires_at);
        assert_eq!(renewed.max_expires_at, created.max_expires_at);
        assert!(renewed.expires_at > created.expires_at);

        assert_eq!(
            store
                .renew_lobby(
                    &created.lobby_id,
                    &created.participant_id,
                    &created.participant_token,
                    Duration::from_secs(60),
                )
                .await,
            Err(LobbyStoreError::RenewalLimitReached)
        );
    }

    #[tokio::test]
    async fn targeted_routing_reaches_only_the_requested_participant() {
        let store = LobbyStore::new(4);
        let created = store
            .create_lobby(Duration::from_secs(600), 4)
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

        let (guest_sender, _guest_receiver) = mpsc::unbounded_channel();
        store
            .register_connection(
                &created.lobby_id,
                &joined.participant_id,
                &joined.participant_token,
                guest_sender,
            )
            .await
            .unwrap();

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
    }
}
