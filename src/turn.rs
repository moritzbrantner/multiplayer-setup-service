use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::env;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::protocol::is_valid_participant_id;
use crate::{
    bearer_capability_token, error_response, invalid_credentials_response,
    lobby_store_error_response, validated_room_id, AppState,
};

const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS: u64 = 600;
const MIN_TURN_CREDENTIAL_TTL_SECONDS: u64 = 60;
const MAX_TURN_CREDENTIAL_TTL_SECONDS: u64 = 3_600;
const HMAC_BLOCK_BYTES: usize = 64;

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
        let credential = STANDARD.encode(hmac_sha1(&self.shared_secret, username.as_bytes()));
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
        let digest = Sha1::digest(key);
        normalized_key[..digest.len()].copy_from_slice(&digest);
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36_u8; HMAC_BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; HMAC_BLOCK_BYTES];
    for index in 0..HMAC_BLOCK_BYTES {
        inner_pad[index] ^= normalized_key[index];
        outer_pad[index] ^= normalized_key[index];
    }

    let mut inner = Sha1::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha1::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha1_matches_rfc_2202_vector() {
        let key = [0x0b_u8; 20];
        assert_eq!(
            hmac_sha1(&key, b"Hi There"),
            [
                0xb6, 0x17, 0x31, 0x86, 0x55, 0x05, 0x72, 0x64, 0xe2, 0x8b, 0xc0, 0xb6, 0xfb,
                0x37, 0x8c, 0x8e, 0xf1, 0x46, 0xbe, 0x00,
            ]
        );
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
        assert_eq!(response.ice_servers[0].credential, "/DRe79smvE5QcZBsM8zp2Cv4tcE=");
    }

    #[test]
    fn turn_url_validation_rejects_non_turn_schemes() {
        assert!(is_turn_url("turn:turn.example.com:3478"));
        assert!(is_turn_url("turns:turn.example.com:5349"));
        assert!(!is_turn_url("https://turn.example.com"));
    }
}
