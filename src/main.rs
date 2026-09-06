mod protocol;
mod state;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_TYPE, ORIGIN, SEC_WEBSOCKET_PROTOCOL};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use protocol::{
    CAPABILITY_PROTOCOL_PREFIX, ClientMessage, ClientMessageError, MAX_SIGNAL_BYTES, PeerRole,
    ServerMessage, WEBSOCKET_PROTOCOL, format_room_code, is_valid_room_id, normalize_room_id,
    parse_client_message,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use state::{ConnectionCommand, RoomStore, StoreError};
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8787";
const DEFAULT_ROOM_TTL_SECONDS: u64 = 600;
const MIN_ROOM_TTL_SECONDS: u64 = 60;
const MAX_ROOM_TTL_SECONDS: u64 = 3600;
const DEFAULT_CLEANUP_INTERVAL_SECONDS: u64 = 30;
const MIN_CLEANUP_INTERVAL_SECONDS: u64 = 5;
const MAX_CLEANUP_INTERVAL_SECONDS: u64 = 300;
const DEFAULT_MAX_ROOMS: usize = 10_000;
const MAX_MAX_ROOMS: usize = 100_000;
const DEFAULT_ALLOWED_ORIGINS: &str =
    "https://moritzbrantner.github.io,http://localhost:*,http://127.0.0.1:*";

#[derive(Clone)]
struct AppState {
    rooms: RoomStore,
    allowed_origins: AllowedOrigins,
    room_ttl: Duration,
}

#[derive(Clone)]
struct AllowedOrigins {
    patterns: Arc<Vec<String>>,
}

impl AllowedOrigins {
    fn from_config(value: &str) -> Self {
        let patterns = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect();

        Self {
            patterns: Arc::new(patterns),
        }
    }

    fn allows(&self, origin: &str) -> bool {
        self.patterns
            .iter()
            .any(|pattern| origin_matches(origin, pattern))
    }
}

#[derive(Deserialize)]
struct ConnectQuery {
    role: PeerRole,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    protocol_version: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomResponse {
    room_id: String,
    display_code: String,
    role: PeerRole,
    host_token: String,
    expires_at: u64,
    websocket_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinRoomResponse {
    room_id: String,
    display_code: String,
    role: PeerRole,
    guest_token: String,
    expires_at: u64,
    websocket_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    room_id: String,
    display_code: String,
    status: state::RoomStatusKind,
    expires_at: u64,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();

    let bind_addr = env::var("BIND_ADDR")
        .unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_owned())
        .parse::<SocketAddr>()?;
    let room_ttl = Duration::from_secs(configured_u64(
        "ROOM_TTL_SECONDS",
        DEFAULT_ROOM_TTL_SECONDS,
        MIN_ROOM_TTL_SECONDS,
        MAX_ROOM_TTL_SECONDS,
    ));
    let cleanup_interval = Duration::from_secs(configured_u64(
        "CLEANUP_INTERVAL_SECONDS",
        DEFAULT_CLEANUP_INTERVAL_SECONDS,
        MIN_CLEANUP_INTERVAL_SECONDS,
        MAX_CLEANUP_INTERVAL_SECONDS,
    ));
    let max_rooms = configured_usize("MAX_ROOMS", DEFAULT_MAX_ROOMS, 1, MAX_MAX_ROOMS);
    let allowed_origins = AllowedOrigins::from_config(
        &env::var("ALLOWED_ORIGINS").unwrap_or_else(|_| DEFAULT_ALLOWED_ORIGINS.to_owned()),
    );

    let state = AppState {
        rooms: RoomStore::new(max_rooms),
        allowed_origins: allowed_origins.clone(),
        room_ttl,
    };

    spawn_cleanup(state.rooms.clone(), cleanup_interval);

    let cors_origins = allowed_origins.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin
                .to_str()
                .is_ok_and(|origin| cors_origins.allows(origin))
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE])
        .max_age(Duration::from_secs(86_400));

    let app = Router::new()
        .route("/health", get(health))
        .route("/rooms", post(create_room))
        .route("/rooms/{room_id}", get(room_status))
        .route("/rooms/{room_id}/join", post(join_room))
        .route("/rooms/{room_id}/connect", get(connect_room))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    info!(%bind_addr, "multiplayer setup service listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "multiplayer-setup-service",
        protocol_version: 1,
    })
}

async fn create_room(State(state): State<AppState>) -> Response {
    match state.rooms.create_room(state.room_ttl).await {
        Ok(created) => (
            StatusCode::CREATED,
            Json(CreateRoomResponse {
                websocket_path: format!("/rooms/{}/connect", created.room_id),
                room_id: created.room_id,
                display_code: created.display_code,
                role: PeerRole::Host,
                host_token: created.host_token,
                expires_at: created.expires_at,
            }),
        )
            .into_response(),
        Err(error) => store_error_response(error),
    }
}

async fn join_room(State(state): State<AppState>, Path(raw_room_id): Path<String>) -> Response {
    let Some(room_id) = validated_room_id(&raw_room_id) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid-room-id",
            "Invalid room code",
        );
    };

    match state.rooms.join_room(&room_id).await {
        Ok(joined) => Json(JoinRoomResponse {
            websocket_path: format!("/rooms/{room_id}/connect"),
            display_code: format_room_code(&room_id).expect("validated room ID should format"),
            room_id,
            role: PeerRole::Guest,
            guest_token: joined.guest_token,
            expires_at: joined.expires_at,
        })
        .into_response(),
        Err(error) => store_error_response(error),
    }
}

async fn room_status(State(state): State<AppState>, Path(raw_room_id): Path<String>) -> Response {
    let Some(room_id) = validated_room_id(&raw_room_id) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid-room-id",
            "Invalid room code",
        );
    };

    match state.rooms.status(&room_id).await {
        Ok(status) => Json(StatusResponse {
            display_code: format_room_code(&room_id).expect("validated room ID should format"),
            room_id,
            status: status.status,
            expires_at: status.expires_at,
        })
        .into_response(),
        Err(error) => store_error_response(error),
    }
}

async fn connect_room(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(raw_room_id): Path<String>,
    Query(query): Query<ConnectQuery>,
    headers: HeaderMap,
) -> Response {
    if let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok())
        && !state.allowed_origins.allows(origin)
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "origin-not-allowed",
            "Origin is not allowed",
        );
    }

    let Some(room_id) = validated_room_id(&raw_room_id) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid-room-id",
            "Invalid room code",
        );
    };

    let protocols = websocket_protocols(&headers);
    if !protocols.contains(&WEBSOCKET_PROTOCOL) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "invalid-credentials",
            "A valid role and capability token are required",
        );
    }

    let Some(token) = protocols
        .iter()
        .find_map(|protocol| protocol.strip_prefix(CAPABILITY_PROTOCOL_PREFIX))
        .filter(|token| token.len() == 64)
        .map(ToOwned::to_owned)
    else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "invalid-credentials",
            "A valid role and capability token are required",
        );
    };

    if let Err(error) = state.rooms.authenticate(&room_id, query.role, &token).await {
        return store_error_response(error);
    }

    ws.max_message_size(MAX_SIGNAL_BYTES)
        .protocols([WEBSOCKET_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state, room_id, query.role, token))
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    room_id: String,
    role: PeerRole,
    token: String,
) {
    let (sender, mut commands) = mpsc::unbounded_channel();
    let registration = match state
        .rooms
        .register_connection(&room_id, role, &token, sender)
        .await
    {
        Ok(registration) => registration,
        Err(_) => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    if let Some(replaced) = registration.replaced {
        let _ = replaced.send(ConnectionCommand::Close);
    }

    if send_server(&mut socket, &ServerMessage::Connected { role })
        .await
        .is_err()
    {
        let _ = state
            .rooms
            .unregister_connection(&room_id, role, registration.connection_id)
            .await;
        return;
    }

    if let Some(peer) = registration.peer {
        let _ = send_server(
            &mut socket,
            &ServerMessage::PeerConnected {
                peer_role: role.other(),
            },
        )
        .await;
        let _ = peer.send(ConnectionCommand::Send(ServerMessage::PeerConnected {
            peer_role: role,
        }));
    }

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(ConnectionCommand::Send(message)) => {
                        if send_server(&mut socket, &message).await.is_err() {
                            break;
                        }
                    }
                    Some(ConnectionCommand::Close) | None => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !handle_client_text(&mut socket, &state, &room_id, role, &text).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Some(Ok(Message::Ping(_))) => {}
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                }
            }
        }
    }

    if let Some(peer) = state
        .rooms
        .unregister_connection(&room_id, role, registration.connection_id)
        .await
    {
        let _ = peer.send(ConnectionCommand::Send(ServerMessage::PeerDisconnected {
            peer_role: role,
        }));
    }
}

async fn handle_client_text(
    socket: &mut WebSocket,
    state: &AppState,
    room_id: &str,
    role: PeerRole,
    text: &str,
) -> bool {
    match parse_client_message(text) {
        Ok(ClientMessage::Ping { nonce }) => send_server(socket, &ServerMessage::Pong { nonce })
            .await
            .is_ok(),
        Ok(ClientMessage::Signal { payload }) => {
            relay_signal(socket, state, room_id, role, payload).await
        }
        Err(ClientMessageError::TooLarge) => {
            let _ = socket.send(Message::Close(None)).await;
            false
        }
        Err(ClientMessageError::Invalid) => send_server(
            socket,
            &ServerMessage::Error {
                code: "invalid-message",
                message: "Expected a signaling envelope or ping",
            },
        )
        .await
        .is_ok(),
    }
}

async fn relay_signal(
    socket: &mut WebSocket,
    state: &AppState,
    room_id: &str,
    role: PeerRole,
    payload: Value,
) -> bool {
    let Some(peer) = state.rooms.peer_sender(room_id, role).await else {
        return send_server(
            socket,
            &ServerMessage::Error {
                code: "peer-not-connected",
                message: "The other peer is not connected to signaling yet",
            },
        )
        .await
        .is_ok();
    };

    if peer
        .send(ConnectionCommand::Send(ServerMessage::Signal {
            from: role,
            payload,
        }))
        .is_ok()
    {
        true
    } else {
        send_server(
            socket,
            &ServerMessage::Error {
                code: "peer-not-connected",
                message: "The other peer is not connected to signaling yet",
            },
        )
        .await
        .is_ok()
    }
}

async fn send_server(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), axum::Error> {
    let text = serde_json::to_string(message).expect("server message should serialize");
    socket.send(Message::Text(text.into())).await
}

fn validated_room_id(raw: &str) -> Option<String> {
    let room_id = normalize_room_id(raw);
    is_valid_room_id(&room_id).then_some(room_id)
}

fn websocket_protocols(headers: &HeaderMap) -> Vec<&str> {
    headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect()
}

fn store_error_response(error: StoreError) -> Response {
    match error {
        StoreError::RoomNotFound => error_response(
            StatusCode::NOT_FOUND,
            "room-not-found",
            "Room is not available",
        ),
        StoreError::RoomFull => error_response(
            StatusCode::CONFLICT,
            "room-full",
            "Room already has two peers",
        ),
        StoreError::InvalidCredentials => error_response(
            StatusCode::UNAUTHORIZED,
            "invalid-credentials",
            "A valid role and capability token are required",
        ),
        StoreError::Capacity => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "room-capacity-reached",
            "Room capacity is temporarily exhausted",
        ),
        StoreError::Randomness => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "randomness-unavailable",
            "Secure randomness is unavailable",
        ),
    }
}

fn error_response(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(ErrorEnvelope {
            error: ErrorBody { code, message },
        }),
    )
        .into_response()
}

fn origin_matches(origin: &str, pattern: &str) -> bool {
    if origin == pattern {
        return true;
    }

    pattern
        .strip_suffix(":*")
        .is_some_and(|prefix| origin.starts_with(&format!("{prefix}:")))
}

fn configured_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn configured_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn spawn_cleanup(store: RoomStore, interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            let expired = store.cleanup_expired().await;
            if expired > 0 {
                info!(expired, "expired signaling rooms removed");
            }
        }
    });
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            warn!(%error, "failed to install Ctrl-C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                warn!(%error, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_local_origins_match_only_the_configured_prefix() {
        assert!(origin_matches(
            "http://localhost:5173",
            "http://localhost:*"
        ));
        assert!(origin_matches(
            "http://127.0.0.1:8080",
            "http://127.0.0.1:*"
        ));
        assert!(!origin_matches(
            "https://localhost.example.com:5173",
            "http://localhost:*"
        ));
    }
}
