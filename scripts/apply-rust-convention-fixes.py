from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/state.rs",
    '''            Self::Send(message) => {
                Some(serde_json::to_string(&message).expect("server message should serialize"))
            }''',
    '''            Self::Send(message) => match serde_json::to_string(&message) {
                Ok(text) => Some(text),
                Err(error) => {
                    tracing::error!(%error, "failed to serialize server message");
                    None
                }
            },''',
)
replace_once(
    "src/state.rs",
    '''            let display_code = crate::protocol::format_room_code(&room_id)
                .expect("generated room ID should always format");''',
    '''            let display_code = crate::protocol::format_room_code(&room_id)
                .ok_or(StoreError::Randomness)?;''',
)
replace_once(
    "src/state.rs",
    '''fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}''',
    '''fn now_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        Err(_) => 0,
    }
}''',
)

replace_once(
    "src/lobby.rs",
    '''            Self::Send(message) => {
                Some(serde_json::to_string(&message).expect("lobby message should serialize"))
            }''',
    '''            Self::Send(message) => match serde_json::to_string(&message) {
                Ok(text) => Some(text),
                Err(error) => {
                    tracing::error!(%error, "failed to serialize lobby message");
                    None
                }
            },''',
)
replace_once(
    "src/lobby.rs",
    '''            let display_code =
                format_room_code(&lobby_id).expect("generated lobby ID should always format");''',
    '''            let display_code =
                format_room_code(&lobby_id).ok_or(LobbyStoreError::Randomness)?;''',
)
replace_once(
    "src/lobby.rs",
    '''fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}''',
    '''fn now_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        Err(_) => 0,
    }
}''',
)

replace_once(
    "src/sockets.rs",
    '''async fn send_server(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).expect("server message should serialize");
    send_direct(socket, text).await
}

async fn send_lobby_server(socket: &mut WebSocket, message: &LobbyServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).expect("lobby server message should serialize");
    send_direct(socket, text).await
}''',
    '''async fn send_server(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    send_direct(socket, text).await
}

async fn send_lobby_server(socket: &mut WebSocket, message: &LobbyServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    send_direct(socket, text).await
}''',
)

main = Path("src/main.rs")
text = main.read_text()
room_old = 'format_room_code(&room_id).expect("validated room ID should format")'
lobby_old = 'format_room_code(&lobby_id).expect("validated lobby ID should format")'
if text.count(room_old) != 2 or text.count(lobby_old) != 3:
    raise SystemExit(
        f"src/main.rs: expected 2 room and 3 lobby format invariants, got {text.count(room_old)} and {text.count(lobby_old)}"
    )
text = text.replace(room_old, "display_room_code(&room_id)")
text = text.replace(lobby_old, "display_room_code(&lobby_id)")
marker = '''fn validated_room_id(raw: &str) -> Option<String> {
    let room_id = normalize_room_id(raw);
    is_valid_room_id(&room_id).then_some(room_id)
}
'''
helper = marker + '''
fn display_room_code(room_id: &str) -> String {
    match format_room_code(room_id) {
        Some(display_code) => display_code,
        None => room_id.to_owned(),
    }
}
'''
if text.count(marker) != 1:
    raise SystemExit("src/main.rs: validated_room_id marker changed")
main.write_text(text.replace(marker, helper, 1))

profile = Path("src/bin/profile-stores.rs")
text = profile.read_text()
replacements = [
    ("async fn main() {", "async fn main() -> Result<(), std::io::Error> {"),
    (
        '.expect("profile room creation should stay below capacity");',
        '.map_err(|error| profile_error("profile room creation should stay below capacity", error))?;',
    ),
    (
        '.expect("profile room should stay live");',
        '.map_err(|error| profile_error("profile room should stay live", error))?;',
    ),
    (
        '.expect("profile host capability should authenticate");',
        '.map_err(|error| profile_error("profile host capability should authenticate", error))?;',
    ),
    (
        '.expect("profile lobby creation should stay below capacity");',
        '.map_err(|error| profile_error("profile lobby creation should stay below capacity", error))?;',
    ),
    (
        '.expect("profile lobby should stay live");',
        '.map_err(|error| profile_error("profile lobby should stay live", error))?;',
    ),
]
for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit(
            f"src/bin/profile-stores.rs: expected one match for {old!r}, got {text.count(old)}"
        )
    text = text.replace(old, new, 1)
print_marker = '''    println!(
        "{{\\"rooms\\":{ROOM_COUNT},\\"roomStatusChecks\\":{ROOM_COUNT},\\"roomAuthentications\\":{ROOM_COUNT},\\"lobbies\\":{LOBBY_COUNT},\\"lobbyStatusChecks\\":{LOBBY_COUNT}}}"
    );
}'''
print_replacement = '''    println!(
        "{{\\"rooms\\":{ROOM_COUNT},\\"roomStatusChecks\\":{ROOM_COUNT},\\"roomAuthentications\\":{ROOM_COUNT},\\"lobbies\\":{LOBBY_COUNT},\\"lobbyStatusChecks\\":{LOBBY_COUNT}}}"
    );
    Ok(())
}

#[cfg(not(test))]
fn profile_error(context: &str, error: impl std::fmt::Debug) -> std::io::Error {
    std::io::Error::other(format!("{context}: {error:?}"))
}'''
if text.count(print_marker) != 1:
    raise SystemExit("src/bin/profile-stores.rs: println marker changed")
profile.write_text(text.replace(print_marker, print_replacement, 1))
