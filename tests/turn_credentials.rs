use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

struct Service {
    child: Child,
    port: u16,
}

impl Service {
    fn start(turn_enabled: bool) -> Self {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);

        let mut command = Command::new(env!("CARGO_BIN_EXE_multiplayer-setup-service"));
        command
            .env("BIND_ADDR", format!("127.0.0.1:{port}"))
            .env("RUST_LOG", "error")
            .env("ROOM_TTL_SECONDS", "60")
            .env("MAX_ROOMS", "32")
            .env("MAX_LOBBIES", "32")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if turn_enabled {
            command
                .env(
                    "TURN_URLS",
                    "turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp",
                )
                .env("TURN_SHARED_SECRET", "test-shared-secret")
                .env("TURN_CREDENTIAL_TTL_SECONDS", "600");
        }

        let child = command.spawn().expect("service binary should start");
        let service = Self { child, port };
        service.wait_until_ready();
        service
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(request(self.port, "GET", "/health", None, &[]), Ok((200, _))) {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("service did not become ready");
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> Result<(u16, String), std::io::Error> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;

    let body = body.unwrap_or_default();
    let content_headers = if body.is_empty() {
        String::new()
    } else {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        )
    };
    let extra_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{content_headers}{extra_headers}\r\n{body}"
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    let response = String::from_utf8_lossy(&bytes);
    let (head, body) = response
        .split_once("\r\n\r\n")
        .expect("HTTP response should contain headers");
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .expect("HTTP response should contain status");
    Ok((status, body.to_owned()))
}

fn json(body: &str) -> Value {
    serde_json::from_str(body).expect("response should be JSON")
}

fn create_lobby(service: &Service) -> Value {
    let (status, body) = request(
        service.port,
        "POST",
        "/lobbies",
        Some(r#"{"maxParticipants":2}"#),
        &[],
    )
    .unwrap();
    assert_eq!(status, 201);
    json(&body)
}

#[test]
fn authenticated_lobby_participant_receives_short_lived_turn_credentials() {
    let service = Service::start(true);
    let lobby = create_lobby(&service);
    let lobby_id = lobby["lobbyId"].as_str().unwrap();
    let participant_id = lobby["participantId"].as_str().unwrap();
    let token = lobby["participantToken"].as_str().unwrap();
    let body = format!(r#"{{"participantId":"{participant_id}"}}"#);
    let authorization = format!("Bearer {token}");

    let (status, response_body) = request(
        service.port,
        "POST",
        &format!("/lobbies/{lobby_id}/turn-credentials"),
        Some(&body),
        &[("Authorization", &authorization)],
    )
    .unwrap();
    assert_eq!(status, 200);
    let credentials = json(&response_body);
    let server = &credentials["iceServers"][0];
    assert_eq!(
        server["urls"],
        serde_json::json!([
            "turn:turn.example.test:3478?transport=udp",
            "turns:turn.example.test:5349?transport=tcp"
        ])
    );
    assert!(server["username"]
        .as_str()
        .unwrap()
        .ends_with(&format!(":{participant_id}")));
    assert!(!server["credential"].as_str().unwrap().is_empty());
    assert!(credentials["expiresAt"].as_u64().unwrap() > 0);
}

#[test]
fn turn_credentials_require_the_matching_participant_capability() {
    let service = Service::start(true);
    let lobby = create_lobby(&service);
    let lobby_id = lobby["lobbyId"].as_str().unwrap();
    let participant_id = lobby["participantId"].as_str().unwrap();
    let body = format!(r#"{{"participantId":"{participant_id}"}}"#);
    let path = format!("/lobbies/{lobby_id}/turn-credentials");

    let (status, response_body) =
        request(service.port, "POST", &path, Some(&body), &[]).unwrap();
    assert_eq!(status, 401);
    assert_eq!(json(&response_body)["error"]["code"], "invalid-credentials");

    let wrong = format!("Bearer {}", "f".repeat(64));
    let (status, response_body) = request(
        service.port,
        "POST",
        &path,
        Some(&body),
        &[("Authorization", &wrong)],
    )
    .unwrap();
    assert_eq!(status, 401);
    assert_eq!(json(&response_body)["error"]["code"], "invalid-credentials");
}

#[test]
fn authenticated_request_fails_closed_when_turn_is_not_configured() {
    let service = Service::start(false);
    let lobby = create_lobby(&service);
    let lobby_id = lobby["lobbyId"].as_str().unwrap();
    let participant_id = lobby["participantId"].as_str().unwrap();
    let token = lobby["participantToken"].as_str().unwrap();
    let body = format!(r#"{{"participantId":"{participant_id}"}}"#);
    let authorization = format!("Bearer {token}");

    let (status, response_body) = request(
        service.port,
        "POST",
        &format!("/lobbies/{lobby_id}/turn-credentials"),
        Some(&body),
        &[("Authorization", &authorization)],
    )
    .unwrap();
    assert_eq!(status, 503);
    assert_eq!(json(&response_body)["error"]["code"], "turn-not-configured");
}
