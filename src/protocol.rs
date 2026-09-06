use getrandom::fill;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ROOM_CODE_LENGTH: usize = 12;
pub const PARTICIPANT_ID_LENGTH: usize = 8;
pub const ROOM_CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const MAX_SIGNAL_BYTES: usize = 32 * 1024;
pub const WEBSOCKET_PROTOCOL: &str = "multiplayer-setup-v1";
pub const CAPABILITY_PROTOCOL_PREFIX: &str = "cap.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerRole {
    Host,
    Guest,
}

impl PeerRole {
    pub const fn other(self) -> Self {
        match self {
            Self::Host => Self::Guest,
            Self::Guest => Self::Host,
        }
    }
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    Ping {
        #[serde(default)]
        nonce: Option<String>,
    },
    Signal {
        payload: Value,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    Connected {
        role: PeerRole,
    },
    PeerConnected {
        #[serde(rename = "peerRole")]
        peer_role: PeerRole,
    },
    PeerDisconnected {
        #[serde(rename = "peerRole")]
        peer_role: PeerRole,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
    },
    Signal {
        from: PeerRole,
        payload: Value,
    },
    Error {
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum LobbyClientMessage {
    Ping {
        #[serde(default)]
        nonce: Option<String>,
    },
    Signal {
        to: String,
        payload: Value,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum LobbyServerMessage {
    Connected {
        #[serde(rename = "participantId")]
        participant_id: String,
        #[serde(rename = "hostParticipantId")]
        host_participant_id: String,
        participants: Vec<String>,
    },
    ParticipantConnected {
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    ParticipantDisconnected {
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
    },
    Signal {
        from: String,
        payload: Value,
    },
    Error {
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientMessageError {
    Invalid,
    TooLarge,
}

pub fn normalize_room_id(value: &str) -> String {
    value
        .bytes()
        .filter(|byte| *byte != b'-' && !byte.is_ascii_whitespace())
        .map(|byte| (byte as char).to_ascii_uppercase())
        .collect()
}

pub fn is_valid_room_id(value: &str) -> bool {
    let normalized = normalize_room_id(value);
    normalized.len() == ROOM_CODE_LENGTH
        && normalized
            .bytes()
            .all(|byte| ROOM_CODE_ALPHABET.contains(&byte))
}

pub fn is_valid_participant_id(value: &str) -> bool {
    value.len() == PARTICIPANT_ID_LENGTH
        && value
            .bytes()
            .all(|byte| ROOM_CODE_ALPHABET.contains(&byte))
}

pub fn format_room_code(value: &str) -> Option<String> {
    let normalized = normalize_room_id(value);
    if !is_valid_room_id(&normalized) {
        return None;
    }

    Some(format!(
        "{}-{}-{}",
        &normalized[..4],
        &normalized[4..8],
        &normalized[8..12]
    ))
}

pub fn generate_room_id() -> Result<String, getrandom::Error> {
    generate_human_id(ROOM_CODE_LENGTH)
}

pub fn generate_participant_id() -> Result<String, getrandom::Error> {
    generate_human_id(PARTICIPANT_ID_LENGTH)
}

pub fn generate_capability_token() -> Result<String, getrandom::Error> {
    let mut random = [0_u8; 32];
    fill(&mut random)?;
    Ok(hex_encode(&random))
}

pub fn hash_capability_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub fn hashes_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |difference, (left, right)| {
            difference | (*left ^ *right)
        })
        == 0
}

pub fn parse_client_message(text: &str) -> Result<ClientMessage, ClientMessageError> {
    if text.len() > MAX_SIGNAL_BYTES {
        return Err(ClientMessageError::TooLarge);
    }

    let message =
        serde_json::from_str::<ClientMessage>(text).map_err(|_| ClientMessageError::Invalid)?;

    validate_nonce(match &message {
        ClientMessage::Ping { nonce } => nonce.as_ref(),
        ClientMessage::Signal { .. } => None,
    })?;

    Ok(message)
}

pub fn parse_lobby_client_message(text: &str) -> Result<LobbyClientMessage, ClientMessageError> {
    if text.len() > MAX_SIGNAL_BYTES {
        return Err(ClientMessageError::TooLarge);
    }

    let message = serde_json::from_str::<LobbyClientMessage>(text)
        .map_err(|_| ClientMessageError::Invalid)?;

    match &message {
        LobbyClientMessage::Ping { nonce } => validate_nonce(nonce.as_ref())?,
        LobbyClientMessage::Signal { to, .. } if !is_valid_participant_id(to) => {
            return Err(ClientMessageError::Invalid);
        }
        LobbyClientMessage::Signal { .. } => {}
    }

    Ok(message)
}

fn validate_nonce(nonce: Option<&String>) -> Result<(), ClientMessageError> {
    if nonce.is_some_and(|nonce| nonce.len() > 128) {
        Err(ClientMessageError::Invalid)
    } else {
        Ok(())
    }
}

fn generate_human_id(length: usize) -> Result<String, getrandom::Error> {
    let mut random = vec![0_u8; length];
    fill(&mut random)?;

    Ok(random
        .into_iter()
        .map(|byte| ROOM_CODE_ALPHABET[(byte & 31) as usize] as char)
        .collect())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_ids_are_human_readable_and_valid() {
        for _ in 0..64 {
            let room_id = generate_room_id().expect("OS randomness should be available");
            assert_eq!(room_id.len(), ROOM_CODE_LENGTH);
            assert!(is_valid_room_id(&room_id));
            assert_eq!(format_room_code(&room_id).unwrap().len(), 14);
        }
    }

    #[test]
    fn participant_ids_are_compact_and_valid() {
        for _ in 0..64 {
            let participant_id =
                generate_participant_id().expect("OS randomness should be available");
            assert_eq!(participant_id.len(), PARTICIPANT_ID_LENGTH);
            assert!(is_valid_participant_id(&participant_id));
        }
    }

    #[test]
    fn room_ids_normalize_separators_and_case() {
        assert_eq!(normalize_room_id("abcd-efgh-jkmn"), "ABCDEFGHJKMN");
        assert!(is_valid_room_id("abcd-efgh-jkmn"));
    }

    #[test]
    fn ambiguous_room_characters_are_rejected() {
        for value in [
            "OOOOOOOOOOOO",
            "IIIIIIIIIIII",
            "LLLLLLLLLLLL",
            "UUUUUUUUUUUU",
        ] {
            assert!(!is_valid_room_id(value));
        }
    }

    #[test]
    fn capability_hashes_are_deterministic() {
        let token = generate_capability_token().expect("OS randomness should be available");
        let first = hash_capability_token(&token);
        let second = hash_capability_token(&token);

        assert_eq!(token.len(), 64);
        assert!(hashes_equal(&first, &second));
        assert_ne!(hex_encode(&first), token);
    }

    #[test]
    fn signaling_payloads_remain_opaque() {
        let message = parse_client_message(
            r#"{"type":"signal","payload":{"description":{"type":"offer","sdp":"v=0"}}}"#,
        )
        .unwrap();

        assert_eq!(
            message,
            ClientMessage::Signal {
                payload: serde_json::json!({
                    "description": {
                        "type": "offer",
                        "sdp": "v=0"
                    }
                })
            }
        );
    }

    #[test]
    fn lobby_signals_require_a_valid_target() {
        let participant_id =
            generate_participant_id().expect("OS randomness should be available");
        let message = parse_lobby_client_message(
            &serde_json::json!({
                "type": "signal",
                "to": participant_id,
                "payload": {"candidate": {"candidate": "x"}}
            })
            .to_string(),
        )
        .unwrap();

        assert!(matches!(message, LobbyClientMessage::Signal { .. }));
        assert_eq!(
            parse_lobby_client_message(r#"{"type":"signal","to":"bad","payload":{}}"#),
            Err(ClientMessageError::Invalid)
        );
    }

    #[test]
    fn malformed_and_oversized_messages_are_rejected() {
        assert_eq!(
            parse_client_message("not-json"),
            Err(ClientMessageError::Invalid)
        );

        let oversized = serde_json::json!({
            "type": "signal",
            "payload": "x".repeat(MAX_SIGNAL_BYTES)
        })
        .to_string();

        assert_eq!(
            parse_client_message(&oversized),
            Err(ClientMessageError::TooLarge)
        );
        assert_eq!(
            parse_lobby_client_message(&oversized),
            Err(ClientMessageError::TooLarge)
        );
    }
}
