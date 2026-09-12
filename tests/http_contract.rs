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
    fn start() -> Self {
        Self::start_with_admission(120, 240)
    }

    fn start_with_admission(rate: u32, burst: u32) -> Self {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);

        let child = Command::new(env!("CARGO_BIN_EXE_multiplayer-setup-service"))
            .env("BIND_ADDR", format!("127.0.0.1:{port}"))
            .env("RUST_LOG", "error")
            .env("ROOM_TTL_SECONDS", "60")
            .env("MAX_ROOMS", "32")
            .env("MAX_LOBBIES", "32")
            .env("HTTP_REQUESTS_PER_SECOND", rate.to_string())
            .env("HTTP_BURST_REQUESTS", burst.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("service binary should start");

        let service = Self { child, port };
        service.wait_until_ready();
        service
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(request(self.port, "GET", "/health", None), Ok((200, _))) {
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
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{content_headers}\r\n{body}"
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

#[test]
fn multiparty_http_contract_round_trips_without_exposing_capabilities() {
    let service = Service::start();

    let (status, body) = request(service.port, "GET", "/health", None).unwrap();
    assert_eq!(status, 200);
    assert_eq!(json(&body)["protocolVersion"], 1);

    let (status, body) = request(
        service.port,
        "POST",
        "/lobbies",
        Some(r#"{"maxParticipants":1}"#),
    )
    .unwrap();
    assert_eq!(status, 400);
    assert_eq!(json(&body)["error"]["code"], "invalid-lobby-size");

    let (status, body) = request(
        service.port,
        "POST",
        "/lobbies",
        Some(r#"{"maxParticipants":16}"#),
    )
    .unwrap();
    assert_eq!(status, 201);
    let created = json(&body);
    let lobby_id = created["lobbyId"].as_str().unwrap();
    let host_id = created["participantId"].as_str().unwrap();
    let host_token = created["participantToken"].as_str().unwrap();
    assert_eq!(created["hostParticipantId"], host_id);
    assert_eq!(created["maxParticipants"], 16);
    assert_eq!(host_token.len(), 64);

    let (status, body) =
        request(service.port, "GET", &format!("/lobbies/{lobby_id}"), None).unwrap();
    assert_eq!(status, 200);
    let public_status = json(&body);
    assert_eq!(public_status["participantCount"], 1);
    assert_eq!(public_status["hostParticipantId"], host_id);
    assert!(public_status.get("participantToken").is_none());

    let (status, body) = request(
        service.port,
        "POST",
        &format!("/lobbies/{lobby_id}/join"),
        None,
    )
    .unwrap();
    assert_eq!(status, 200);
    let joined = json(&body);
    assert_ne!(joined["participantId"], host_id);
    assert_ne!(joined["participantToken"], host_token);
    assert_eq!(joined["hostParticipantId"], host_id);

    let (status, body) =
        request(service.port, "GET", &format!("/lobbies/{lobby_id}"), None).unwrap();
    assert_eq!(status, 200);
    assert_eq!(json(&body)["participantCount"], 2);
}

#[test]
fn legacy_two_player_http_contract_remains_compatible() {
    let service = Service::start();

    let (status, body) = request(service.port, "POST", "/rooms", None).unwrap();
    assert_eq!(status, 201);
    let created = json(&body);
    let room_id = created["roomId"].as_str().unwrap();
    assert_eq!(created["role"], "host");
    assert_eq!(created["hostToken"].as_str().unwrap().len(), 64);

    let (status, body) = request(
        service.port,
        "POST",
        &format!("/rooms/{room_id}/join"),
        None,
    )
    .unwrap();
    assert_eq!(status, 200);
    let joined = json(&body);
    assert_eq!(joined["role"], "guest");
    assert_eq!(joined["guestToken"].as_str().unwrap().len(), 64);

    let (status, body) = request(
        service.port,
        "POST",
        &format!("/rooms/{room_id}/join"),
        None,
    )
    .unwrap();
    assert_eq!(status, 409);
    assert_eq!(json(&body)["error"]["code"], "room-full");

    let (status, body) = request(service.port, "GET", &format!("/rooms/{room_id}"), None).unwrap();
    assert_eq!(status, 200);
    assert_eq!(json(&body)["status"], "paired");
}

#[test]
fn http_admission_rejects_a_burst_without_disabling_health_or_other_routes() {
    let service = Service::start_with_admission(1, 4);
    let mut limited = false;
    for _ in 0..12 {
        let (status, body) = request(service.port, "GET", "/health", None).unwrap();
        if status == 429 {
            assert_eq!(json(&body)["error"]["code"], "signaling-admission-limited");
            limited = true;
            break;
        }
        assert_eq!(status, 200);
    }
    assert!(limited, "the configured per-client burst must be enforced");
    thread::sleep(Duration::from_millis(1100));
    assert_eq!(
        request(service.port, "GET", "/health", None).unwrap().0,
        200
    );
}
