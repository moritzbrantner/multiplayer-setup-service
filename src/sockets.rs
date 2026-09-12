use crate::AppState;
use crate::admission::SocketRate;
use crate::lobby::{LobbyConnectionCommand, LobbyStoreError};
use crate::protocol::{
    ClientMessage, ClientMessageError, LobbyClientMessage, LobbyServerMessage, PeerRole,
    ServerMessage, parse_client_message, parse_lobby_client_message,
};
use crate::state::{ConnectionCommand, outbox};
use axum::extract::ws::{Message, WebSocket};
use serde_json::Value;
use std::future::Future;
use std::time::Duration;

const WRITE_DEADLINE: Duration = Duration::from_secs(2);

pub(super) async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    room_id: String,
    role: PeerRole,
    token: String,
) {
    let (sender, mut commands) = outbox::channel();
    let mut rate = SocketRate::default();
    let registration = match state
        .rooms
        .register_connection(&room_id, role, &token, sender)
        .await
    {
        Ok(registration) => registration,
        Err(_) => {
            let _ = send_frame(&mut socket, Message::Close(None)).await;
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
                    Some(message) => {
                        if send_queued(&mut socket, message).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = send_frame(&mut socket, Message::Close(None)).await;
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break };
                if !rate.allow(&message) {
                    let _ = send_server(&mut socket, &ServerMessage::Error {
                        code: "signaling-rate-limited",
                        message: "Signaling message or byte rate exceeded",
                    }).await;
                    break;
                }
                match message {
                    Message::Text(text) => {
                        if !handle_client_text(&mut socket, &state, &room_id, role, &text).await {
                            break;
                        }
                    }
                    Message::Binary(_) => {
                        let _ = send_frame(&mut socket, Message::Close(None)).await;
                        break;
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(_) => break,
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

pub(super) async fn handle_lobby_socket(
    mut socket: WebSocket,
    state: AppState,
    lobby_id: String,
    participant_id: String,
    token: String,
) {
    let (sender, mut commands) = outbox::channel();
    let mut rate = SocketRate::default();
    let registration = match state
        .lobbies
        .register_connection(&lobby_id, &participant_id, &token, sender)
        .await
    {
        Ok(registration) => registration,
        Err(_) => {
            let _ = send_frame(&mut socket, Message::Close(None)).await;
            return;
        }
    };

    if let Some(replaced) = registration.replaced {
        let _ = replaced.send(LobbyConnectionCommand::Close);
    }

    if send_lobby_server(
        &mut socket,
        &LobbyServerMessage::Connected {
            participant_id: participant_id.clone(),
            host_participant_id: registration.host_participant_id,
            participants: registration.participants,
        },
    )
    .await
    .is_err()
    {
        state
            .lobbies
            .unregister_connection(&lobby_id, &participant_id, registration.connection_id)
            .await;
        return;
    }

    for peer in registration.connected_peers {
        let _ = peer.send(LobbyConnectionCommand::Send(
            LobbyServerMessage::ParticipantConnected {
                participant_id: participant_id.clone(),
            },
        ));
    }

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(message) => {
                        if send_queued(&mut socket, message).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = send_frame(&mut socket, Message::Close(None)).await;
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break };
                if !rate.allow(&message) {
                    let _ = send_lobby_server(&mut socket, &LobbyServerMessage::Error {
                        code: "signaling-rate-limited",
                        message: "Signaling message or byte rate exceeded",
                    }).await;
                    break;
                }
                match message {
                    Message::Text(text) => {
                        if !handle_lobby_client_text(
                            &mut socket,
                            &state,
                            &lobby_id,
                            &participant_id,
                            &text,
                        ).await {
                            break;
                        }
                    }
                    Message::Binary(_) => {
                        let _ = send_frame(&mut socket, Message::Close(None)).await;
                        break;
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(_) => break,
                }
            }
        }
    }

    for peer in state
        .lobbies
        .unregister_connection(&lobby_id, &participant_id, registration.connection_id)
        .await
    {
        let _ = peer.send(LobbyConnectionCommand::Send(
            LobbyServerMessage::ParticipantDisconnected {
                participant_id: participant_id.clone(),
            },
        ));
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
            let _ = send_frame(socket, Message::Close(None)).await;
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

async fn handle_lobby_client_text(
    socket: &mut WebSocket,
    state: &AppState,
    lobby_id: &str,
    participant_id: &str,
    text: &str,
) -> bool {
    match parse_lobby_client_message(text) {
        Ok(LobbyClientMessage::Ping { nonce }) => {
            send_lobby_server(socket, &LobbyServerMessage::Pong { nonce })
                .await
                .is_ok()
        }
        Ok(LobbyClientMessage::Signal { to, payload }) => {
            relay_lobby_signal(socket, state, lobby_id, participant_id, &to, payload).await
        }
        Err(ClientMessageError::TooLarge) => {
            let _ = send_frame(socket, Message::Close(None)).await;
            false
        }
        Err(ClientMessageError::Invalid) => send_lobby_server(
            socket,
            &LobbyServerMessage::Error {
                code: "invalid-message",
                message: "Expected a targeted signaling envelope or ping",
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

    match peer.send(ConnectionCommand::Send(ServerMessage::Signal {
        from: role,
        payload,
    })) {
        Ok(()) => true,
        Err(outbox::SendError::Closed) => send_server(
            socket,
            &ServerMessage::Error {
                code: "peer-not-connected",
                message: "The other peer is not connected to signaling yet",
            },
        )
        .await
        .is_ok(),
        Err(outbox::SendError::Full) => send_server(
            socket,
            &ServerMessage::Error {
                code: "peer-overloaded",
                message: "The recipient exceeded its signaling queue capacity and was disconnected",
            },
        )
        .await
        .is_ok(),
        Err(outbox::SendError::BudgetExhausted) => send_server(
            socket,
            &ServerMessage::Error {
                code: "signaling-capacity-exhausted",
                message: "Service signaling relay capacity is temporarily exhausted; the peer remains connected",
            },
        )
        .await
        .is_ok(),
        Err(outbox::SendError::TooLarge) => send_server(
            socket,
            &ServerMessage::Error {
                code: "signaling-envelope-too-large",
                message: "The relayed signaling envelope exceeds the server delivery limit",
            },
        )
        .await
        .is_ok(),
    }
}

async fn relay_lobby_signal(
    socket: &mut WebSocket,
    state: &AppState,
    lobby_id: &str,
    participant_id: &str,
    target_id: &str,
    payload: Value,
) -> bool {
    match state
        .lobbies
        .target_sender(lobby_id, participant_id, target_id)
        .await
    {
        Ok(target) => {
            match target.send(LobbyConnectionCommand::Send(LobbyServerMessage::Signal {
                from: participant_id.to_owned(),
                payload,
            })) {
                Ok(()) => true,
                Err(outbox::SendError::Closed) => send_lobby_server(
                    socket,
                    &LobbyServerMessage::Error {
                        code: "participant-not-connected",
                        message: "The target participant is not connected to signaling",
                    },
                )
                .await
                .is_ok(),
                Err(outbox::SendError::Full) => send_lobby_server(
                    socket,
                    &LobbyServerMessage::Error {
                        code: "participant-overloaded",
                        message: "The recipient exceeded its signaling queue capacity and was disconnected",
                    },
                )
                .await
                .is_ok(),
                Err(outbox::SendError::BudgetExhausted) => send_lobby_server(
                    socket,
                    &LobbyServerMessage::Error {
                        code: "signaling-capacity-exhausted",
                        message: "Service signaling relay capacity is temporarily exhausted; the participant remains connected",
                    },
                )
                .await
                .is_ok(),
                Err(outbox::SendError::TooLarge) => send_lobby_server(
                    socket,
                    &LobbyServerMessage::Error {
                        code: "signaling-envelope-too-large",
                        message: "The relayed signaling envelope exceeds the server delivery limit",
                    },
                )
                .await
                .is_ok(),
            }
        }
        Err(LobbyStoreError::TargetNotConnected) => send_lobby_server(
            socket,
            &LobbyServerMessage::Error {
                code: "participant-not-connected",
                message: "The target participant is not connected to signaling",
            },
        )
        .await
        .is_ok(),
        Err(_) => send_lobby_server(
            socket,
            &LobbyServerMessage::Error {
                code: "invalid-target",
                message: "The signaling target is not a participant in this lobby",
            },
        )
        .await
        .is_ok(),
    }
}

async fn send_server(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).expect("server message should serialize");
    send_direct(socket, text).await
}

async fn send_lobby_server(socket: &mut WebSocket, message: &LobbyServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).expect("lobby server message should serialize");
    send_direct(socket, text).await
}

async fn send_direct(socket: &mut WebSocket, text: String) -> Result<(), ()> {
    let _reservation = outbox::reserve(&text).map_err(|_| ())?;
    send_frame(socket, Message::Text(text.into())).await
}

async fn send_queued(socket: &mut WebSocket, message: outbox::QueuedText) -> Result<(), ()> {
    let result = send_frame(socket, Message::Text(message.text.into())).await;
    drop(message._reservation);
    result
}

async fn send_frame(socket: &mut WebSocket, message: Message) -> Result<(), ()> {
    finish_write(socket.send(message), WRITE_DEADLINE).await
}

async fn finish_write(
    write: impl Future<Output = Result<(), axum::Error>>,
    deadline: Duration,
) -> Result<(), ()> {
    tokio::time::timeout(deadline, write)
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stalled_writes_have_a_deadline() {
        assert!(
            finish_write(std::future::pending(), Duration::from_millis(1))
                .await
                .is_err()
        );
        assert!(
            finish_write(std::future::ready(Ok(())), Duration::from_secs(1))
                .await
                .is_ok()
        );
    }
}
