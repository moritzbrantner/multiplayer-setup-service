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

        let child = command.spawn().expect("service binary should start");
        let service = Self { child, port };
        service.wait_until_ready();
        service
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(
                request(self.port, "GET", "/health", None, &[]),
                Ok((200, _))
            ) {
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

const MATCH: &str = "b_000000006ac18f30_0123456789abcdef0123456789abcdef";
const OTHER_MATCH: &str = "b_000000006ac18f30_fedcba9876543210fedcba9876543210";
const CONFIGURED_MATCH: &str = "p_000000006ac18f30_0123456789abcdef0123456789abcdef";

fn bind(service: &Service, lobby: &str, actor: &Value, match_id: &str) -> (u16, String) {
    request(service.port, "PUT", &format!("/lobbies/{lobby}/game-reference"),
        Some(&serde_json::json!({"participantId": actor["participantId"], "application": "scrabble", "matchId": match_id}).to_string()),
        &[("Authorization", &format!("Bearer {}", actor["participantToken"].as_str().unwrap()))]).unwrap()
}

fn lookup(service: &Service, lobby: &str) -> (u16, String) {
    request(
        service.port,
        "GET",
        &format!("/lobbies/{lobby}/game-reference"),
        None,
        &[],
    )
    .unwrap()
}

#[test]
fn scrabble_binding_requires_current_host_capability_and_reveals_only_public_reference() {
    let service = Service::start();
    let host = create_lobby(&service);
    let lobby = host["lobbyId"].as_str().unwrap();
    let (status, body) = lookup(&service, lobby);
    assert_eq!(status, 409);
    assert_eq!(json(&body)["error"]["code"], "game-not-bound");
    let (_, body) = request(
        service.port,
        "POST",
        &format!("/lobbies/{lobby}/join"),
        None,
        &[],
    )
    .unwrap();
    let guest = json(&body);
    let (status, _) = bind(&service, lobby, &guest, MATCH);
    assert_eq!(
        status, 403,
        "a genuine guest capability grants no host authority"
    );
    let mut forged = host.clone();
    forged["participantToken"] = guest["participantToken"].clone();
    assert_eq!(bind(&service, lobby, &forged, MATCH).0, 401);
    let unauthenticated = serde_json::json!({"participantId": host["participantId"], "application": "scrabble", "matchId": MATCH}).to_string();
    assert_eq!(
        request(
            service.port,
            "PUT",
            &format!("/lobbies/{lobby}/game-reference"),
            Some(&unauthenticated),
            &[]
        )
        .unwrap()
        .0,
        401
    );
    assert_eq!(
        lookup(&service, lobby).0,
        409,
        "denied writes must leave lobby unbound"
    );
    assert_eq!(bind(&service, lobby, &host, MATCH).0, 200);
    let (status, body) = lookup(&service, lobby);
    assert_eq!(status, 200);
    assert_eq!(
        json(&body),
        serde_json::json!({"application": "scrabble", "matchId": MATCH})
    );
    for actor in [&host, &guest] {
        assert!(!body.contains(actor["participantToken"].as_str().unwrap()));
    }
    assert_eq!(bind(&service, "ffffffffffff", &host, MATCH).0, 404);
    assert_eq!(lookup(&service, "ffffffffffff").0, 404);
}

#[test]
fn scrabble_binding_is_atomic_immutable_retry_safe_and_survives_lobby_renewal() {
    let service = Service::start();
    let host = create_lobby(&service);
    let lobby = host["lobbyId"].as_str().unwrap();
    thread::scope(|scope| {
        let workers: Vec<_> = (0..12)
            .map(|_| scope.spawn(|| bind(&service, lobby, &host, MATCH)))
            .collect();
        for worker in workers {
            let (status, body) = worker.join().unwrap();
            assert_eq!(status, 200);
            assert_eq!(
                json(&body),
                serde_json::json!({"application": "scrabble", "matchId": MATCH})
            );
        }
    });
    let (status, body) = bind(&service, lobby, &host, OTHER_MATCH);
    assert_eq!(status, 409);
    assert_eq!(json(&body)["error"]["code"], "game-reference-conflict");
    let body = serde_json::json!({"participantId": host["participantId"]}).to_string();
    assert_eq!(
        request(
            service.port,
            "POST",
            &format!("/lobbies/{lobby}/renew"),
            Some(&body),
            &[(
                "Authorization",
                &format!("Bearer {}", host["participantToken"].as_str().unwrap())
            )]
        )
        .unwrap()
        .0,
        200
    );
    assert_eq!(json(&lookup(&service, lobby).1)["matchId"], MATCH);
}

#[test]
fn scrabble_binding_validates_bounded_game_reference_before_mutation() {
    let service = Service::start();
    let host = create_lobby(&service);
    let lobby = host["lobbyId"].as_str().unwrap();
    for invalid in [
        lobby,
        "g_000000006ac18f30_0123456789abcdef0123456789abcdef",
        "b_bad",
        "p_bad",
        "p_000000006ac18f30_0123456789ABCDEF0123456789abcdef",
        "p_000000006ac18f30-0123456789abcdef0123456789abcdef",
        "p_000000006ac18f30_0123456789abcdef0123456789abcde",
        "p_000000006ac18f30_0123456789abcdef0123456789abcdef0",
        "p_000000006ac18f30_0123456789abcdef0123456789abcdef\n",
        "b_000000006ac18f30_0123456789abcdef0123456789abcdef\n",
        "https://evil.example/game",
        &"b_".repeat(512),
    ] {
        assert_eq!(bind(&service, lobby, &host, invalid).0, 400);
    }
    for application in ["other-game", "", &"x".repeat(1024)] {
        let body = serde_json::json!({"participantId": host["participantId"], "application": application, "matchId": MATCH}).to_string();
        assert_eq!(
            request(
                service.port,
                "PUT",
                &format!("/lobbies/{lobby}/game-reference"),
                Some(&body),
                &[(
                    "Authorization",
                    &format!("Bearer {}", host["participantToken"].as_str().unwrap())
                )]
            )
            .unwrap()
            .0,
            400
        );
    }
    assert_eq!(lookup(&service, lobby).0, 409);
    assert_eq!(bind(&service, lobby, &host, MATCH).0, 200);
}

#[test]
fn scrabble_binding_expires_with_lobby_and_cannot_be_read_or_replaced() {
    let service = Service::start();
    let bindings: Vec<_> = [MATCH, CONFIGURED_MATCH]
        .into_iter()
        .map(|match_id| {
            let host = create_lobby(&service);
            let lobby = host["lobbyId"].as_str().unwrap().to_owned();
            assert_eq!(bind(&service, &lobby, &host, match_id).0, 200);
            (host, lobby, match_id)
        })
        .collect();
    // The production configuration deliberately has a 60-second minimum TTL.
    // Exercise that public policy rather than inventing a test-only clock seam.
    thread::sleep(Duration::from_secs(61));
    for (host, lobby, match_id) in bindings {
        assert_eq!(lookup(&service, &lobby).0, 404);
        assert_eq!(bind(&service, &lobby, &host, match_id).0, 404);
        assert_eq!(bind(&service, &lobby, &host, OTHER_MATCH).0, 404);
    }
}

#[test]
fn scrabble_binding_disappears_on_service_restart_with_its_lobby() {
    let service = Service::start();
    let host = create_lobby(&service);
    let lobby = host["lobbyId"].as_str().unwrap().to_owned();
    assert_eq!(bind(&service, &lobby, &host, MATCH).0, 200);
    drop(service);
    let restarted = Service::start();
    assert_eq!(lookup(&restarted, &lobby).0, 404);
    assert_eq!(bind(&restarted, &lobby, &host, MATCH).0, 404);
}

#[test]
fn malformed_game_reference_json_shapes_return_bad_request_without_binding() {
    let service = Service::start();
    let host = create_lobby(&service);
    let lobby = host["lobbyId"].as_str().unwrap();
    let valid = serde_json::json!({"participantId":host["participantId"],"application":"scrabble","matchId":MATCH});
    let mut malformed = Vec::new();
    for field in ["participantId", "application", "matchId"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        malformed.push(missing);
        for wrong in [
            serde_json::Value::Null,
            serde_json::json!(17),
            serde_json::json!([]),
        ] {
            let mut candidate = valid.clone();
            candidate[field] = wrong;
            malformed.push(candidate);
        }
    }
    let mut unknown = valid.clone();
    unknown["privateState"] = serde_json::json!({});
    malformed.push(unknown);
    malformed.extend([
        serde_json::json!([]),
        serde_json::json!(null),
        serde_json::json!("not an object"),
    ]);
    for candidate in malformed {
        let (status, body) = request(
            service.port,
            "PUT",
            &format!("/lobbies/{lobby}/game-reference"),
            Some(&candidate.to_string()),
            &[(
                "Authorization",
                &format!("Bearer {}", host["participantToken"].as_str().unwrap()),
            )],
        )
        .unwrap();
        assert_eq!(
            status, 400,
            "malformed public reference shapes must be bad requests"
        );
        assert_eq!(json(&body)["error"]["code"], "invalid-game-reference");
        assert_eq!(
            lookup(&service, lobby).0,
            409,
            "invalid shape must not bind"
        );
    }
}

#[test]
fn configured_scrabble_reference_preserves_capability_privacy_retries_and_immutability() {
    let service = Service::start();
    let host = create_lobby(&service);
    let lobby = host["lobbyId"].as_str().unwrap();
    let (status, body) = request(
        service.port,
        "POST",
        &format!("/lobbies/{lobby}/join"),
        None,
        &[],
    )
    .unwrap();
    assert_eq!(status, 200);
    let guest = json(&body);
    assert_eq!(bind(&service, lobby, &guest, CONFIGURED_MATCH).0, 403);
    let mut forged = host.clone();
    forged["participantToken"] = guest["participantToken"].clone();
    assert_eq!(bind(&service, lobby, &forged, CONFIGURED_MATCH).0, 401);
    assert_eq!(lookup(&service, lobby).0, 409);
    thread::scope(|scope| {
        let workers: Vec<_> = (0..12)
            .map(|_| scope.spawn(|| bind(&service, lobby, &host, CONFIGURED_MATCH)))
            .collect();
        for worker in workers {
            let (status, body) = worker.join().unwrap();
            assert_eq!(status, 200);
            assert_eq!(
                json(&body),
                serde_json::json!({"application":"scrabble","matchId":CONFIGURED_MATCH})
            );
        }
    });
    assert_eq!(
        bind(&service, lobby, &host, MATCH).0,
        409,
        "a legacy reference cannot replace a configured game"
    );
    let (status, body) = lookup(&service, lobby);
    assert_eq!(status, 200);
    assert_eq!(
        json(&body),
        serde_json::json!({"application":"scrabble","matchId":CONFIGURED_MATCH})
    );
    for actor in [&host, &guest] {
        assert!(!body.contains(actor["participantToken"].as_str().unwrap()));
    }
    let renewal = serde_json::json!({"participantId":host["participantId"]}).to_string();
    assert_eq!(
        request(
            service.port,
            "POST",
            &format!("/lobbies/{lobby}/renew"),
            Some(&renewal),
            &[(
                "Authorization",
                &format!("Bearer {}", host["participantToken"].as_str().unwrap())
            )]
        )
        .unwrap()
        .0,
        200
    );
    assert_eq!(
        json(&lookup(&service, lobby).1)["matchId"],
        CONFIGURED_MATCH
    );
    let legacy_host = create_lobby(&service);
    let legacy_lobby = legacy_host["lobbyId"].as_str().unwrap();
    assert_eq!(bind(&service, legacy_lobby, &legacy_host, MATCH).0, 200);
    assert_eq!(
        bind(&service, legacy_lobby, &legacy_host, CONFIGURED_MATCH).0,
        409
    );
    assert_eq!(json(&lookup(&service, legacy_lobby).1)["matchId"], MATCH);
}
