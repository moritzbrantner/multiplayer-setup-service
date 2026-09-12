use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::env;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::protocol::is_valid_participant_id;
use crate::{
    AppState, bearer_capability_token, error_response, invalid_credentials_response,
    lobby_store_error_response, validated_room_id,
};

const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS: u64 = 600;
const MIN_TURN_CREDENTIAL_TTL_SECONDS: u64 = 60;
const MAX_TURN_CREDENTIAL_TTL_SECONDS: u64 = 3_600;
const HMAC_BLOCK_BYTES: usize = 64;
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Clone, Debug)]
struct TurnCredentialIssuer {
    urls: Vec<String>,
    shared_secret: Vec<u8>,
    ttl: Duration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnCredentialRequest {
    participant_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnCredentialResponse {
    ice_servers: Vec<TurnIceServer>,
    expires_at: u64,
}

#[derive(Serialize)]
struct TurnIceServer {
    urls: Vec<String>,
    username: String,
    credential: String,
}

impl TurnCredentialIssuer {
    fn from_env() -> Result<Option<Self>, &'static str> {
        let urls = env::var("TURN_URLS").ok();
        let shared_secret = env::var("TURN_SHARED_SECRET").ok();

        match (urls, shared_secret) {
            (None, None) => Ok(None),
            (Some(urls), Some(shared_secret)) => {
                let urls = urls
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>();
                if urls.is_empty() || urls.iter().any(|url| !is_turn_url(url)) {
                    return Err("TURN_URLS must contain only turn: or turns: URLs");
                }
                if shared_secret.is_empty() {
                    return Err("TURN_SHARED_SECRET must not be empty");
                }
                let ttl = env::var("TURN_CREDENTIAL_TTL_SECONDS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(DEFAULT_TURN_CREDENTIAL_TTL_SECONDS)
                    .clamp(
                        MIN_TURN_CREDENTIAL_TTL_SECONDS,
                        MAX_TURN_CREDENTIAL_TTL_SECONDS,
                    );
                Ok(Some(Self {
                    urls,
                    shared_secret: shared_secret.into_bytes(),
                    ttl: Duration::from_secs(ttl),
                }))
            }
            _ => Err("TURN_URLS and TURN_SHARED_SECRET must be configured together"),
        }
    }

    fn issue(&self, participant_id: &str) -> Result<TurnCredentialResponse, &'static str> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock is before the Unix epoch")?
            .as_secs();
        Ok(self.issue_at(participant_id, now))
    }

    fn issue_at(&self, participant_id: &str, now_seconds: u64) -> TurnCredentialResponse {
        let expires_seconds = now_seconds.saturating_add(self.ttl.as_secs());
        let username = format!("{expires_seconds}:{participant_id}");
        let credential = base64_standard(&hmac_sha1(&self.shared_secret, username.as_bytes()));
        TurnCredentialResponse {
            ice_servers: vec![TurnIceServer {
                urls: self.urls.clone(),
                username,
                credential,
            }],
            expires_at: expires_seconds.saturating_mul(1_000),
        }
    }
}

pub(super) async fn issue_turn_credentials(
    State(state): State<AppState>,
    Path(raw_lobby_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<TurnCredentialRequest>,
) -> Response {
    let Some(lobby_id) = validated_room_id(&raw_lobby_id) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid-lobby-id",
            "Invalid lobby code",
        );
    };
    if !is_valid_participant_id(&request.participant_id) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid-participant-id",
            "Invalid participant identifier",
        );
    }
    let Some(token) = bearer_capability_token(&headers) else {
        return invalid_credentials_response();
    };
    if let Err(error) = state
        .lobbies
        .authenticate(&lobby_id, &request.participant_id, &token)
        .await
    {
        return lobby_store_error_response(error);
    }

    let issuer = match TurnCredentialIssuer::from_env() {
        Ok(Some(issuer)) => issuer,
        Ok(None) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "turn-not-configured",
                "TURN credentials are not configured on this service",
            );
        }
        Err(_) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "turn-misconfigured",
                "TURN credential configuration is invalid",
            );
        }
    };

    match issuer.issue(&request.participant_id) {
        Ok(credentials) => Json(credentials).into_response(),
        Err(_) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "turn-credentials-unavailable",
            "TURN credentials could not be generated",
        ),
    }
}

fn is_turn_url(value: &str) -> bool {
    value.starts_with("turn:") || value.starts_with("turns:")
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    let mut normalized_key = [0_u8; HMAC_BLOCK_BYTES];
    if key.len() > HMAC_BLOCK_BYTES {
        normalized_key[..20].copy_from_slice(&sha1_digest(key));
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36_u8; HMAC_BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; HMAC_BLOCK_BYTES];
    for index in 0..HMAC_BLOCK_BYTES {
        inner_pad[index] ^= normalized_key[index];
        outer_pad[index] ^= normalized_key[index];
    }

    let mut inner = Vec::with_capacity(HMAC_BLOCK_BYTES + message.len());
    inner.extend_from_slice(&inner_pad);
    inner.extend_from_slice(message);
    let inner_digest = sha1_digest(&inner);

    let mut outer = Vec::with_capacity(HMAC_BLOCK_BYTES + inner_digest.len());
    outer.extend_from_slice(&outer_pad);
    outer.extend_from_slice(&inner_digest);
    sha1_digest(&outer)
}

fn sha1_digest(input: &[u8]) -> [u8; 20] {
    let bit_length = (input.len() as u64).wrapping_mul(8);
    let mut message = Vec::with_capacity(input.len() + 72);
    message.extend_from_slice(input);
    message.push(0x80);
    while message.len() % HMAC_BLOCK_BYTES != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());

    let mut h0 = 0x6745_2301_u32;
    let mut h1 = 0xEFCD_AB89_u32;
    let mut h2 = 0x98BA_DCFE_u32;
    let mut h3 = 0x1032_5476_u32;
    let mut h4 = 0xC3D2_E1F0_u32;

    for chunk in message.chunks_exact(HMAC_BLOCK_BYTES) {
        let mut words = [0_u32; 80];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (index, word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temporary = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temporary;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut digest = [0_u8; 20];
    for (index, value) in [h0, h1, h2, h3, h4].into_iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    digest
}

fn base64_standard(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);

        encoded.push(BASE64_ALPHABET[(first >> 2) as usize] as char);
        encoded.push(BASE64_ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() >= 2 {
            encoded.push(BASE64_ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() == 3 {
            encoded.push(BASE64_ALPHABET[(third & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_matches_known_vector() {
        assert_eq!(
            sha1_digest(b"abc"),
            [
                0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e, 0x25, 0x71, 0x78, 0x50,
                0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d,
            ]
        );
    }

    #[test]
    fn hmac_sha1_matches_rfc_2202_vector() {
        let key = [0x0b_u8; 20];
        assert_eq!(
            hmac_sha1(&key, b"Hi There"),
            [
                0xb6, 0x17, 0x31, 0x86, 0x55, 0x05, 0x72, 0x64, 0xe2, 0x8b, 0xc0, 0xb6, 0xfb, 0x37,
                0x8c, 0x8e, 0xf1, 0x46, 0xbe, 0x00,
            ]
        );
    }

    #[test]
    fn base64_matches_known_vector() {
        assert_eq!(base64_standard(b"Man"), "TWFu");
        assert_eq!(base64_standard(b"Ma"), "TWE=");
        assert_eq!(base64_standard(b"M"), "TQ==");
    }

    #[test]
    fn coturn_rest_credentials_embed_expiry_and_hmac_sha1_password() {
        let issuer = TurnCredentialIssuer {
            urls: vec!["turn:turn.example.com:3478?transport=udp".to_owned()],
            shared_secret: b"secret".to_vec(),
            ttl: Duration::from_secs(600),
        };
        let response = issuer.issue_at("11111111", 1_000);
        assert_eq!(response.expires_at, 1_600_000);
        assert_eq!(response.ice_servers.len(), 1);
        assert_eq!(response.ice_servers[0].username, "1600:11111111");
        assert_eq!(
            response.ice_servers[0].credential,
            "/DRe79smvE5QcZBsM8zp2Cv4tcE="
        );
    }

    #[test]
    fn turn_url_validation_rejects_non_turn_schemes() {
        assert!(is_turn_url("turn:turn.example.com:3478"));
        assert!(is_turn_url("turns:turn.example.com:5349"));
        assert!(!is_turn_url("https://turn.example.com"));
    }
}
