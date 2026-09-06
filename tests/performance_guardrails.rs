#![cfg(not(debug_assertions))]

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

        let child = Command::new(env!("CARGO_BIN_EXE_multiplayer-setup-service"))
            .env("BIND_ADDR", format!("127.0.0.1:{port}"))
            .env("RUST_LOG", "error")
            .env("ROOM_TTL_SECONDS", "60")
            .env("MAX_ROOMS", "50000")
            .env("MAX_LOBBIES", "50000")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("release service binary should start");

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
            thread::sleep(Duration::from_millis(20));
        }
        panic!("release service did not become ready");
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
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;

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
        .expect("HTTP response should contain a status code");
    Ok((status, body.to_owned()))
}

fn json(body: &str) -> Value {
    serde_json::from_str(body).expect("response should be JSON")
}

fn assert_budget(label: &str, elapsed: Duration, budget: Duration, operations: usize) {
    let throughput = operations as f64 / elapsed.as_secs_f64().max(f64::EPSILON);
    eprintln!(
        "{label}: {operations} operations in {:.3}s ({throughput:.0} ops/s), budget {:.3}s",
        elapsed.as_secs_f64(),
        budget.as_secs_f64()
    );
    assert!(
        elapsed <= budget,
        "{label} exceeded broad performance budget: {elapsed:?} > {budget:?}"
    );
}

#[test]
fn release_service_stays_responsive_under_parallel_http_and_lobby_churn() {
    let service = Service::start();
    let port = service.port;

    let health_workers = 16;
    let health_per_worker = 100;
    let health_start = Instant::now();
    let health_threads = (0..health_workers)
        .map(|_| {
            thread::spawn(move || {
                for _ in 0..health_per_worker {
                    let (status, body) = request(port, "GET", "/health", None).unwrap();
                    assert_eq!(status, 200);
                    assert_eq!(json(&body)["status"], "ok");
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in health_threads {
        worker.join().unwrap();
    }
    assert_budget(
        "parallel health burst",
        health_start.elapsed(),
        Duration::from_secs(8),
        health_workers * health_per_worker,
    );

    let lobby_workers = 8;
    let lobbies_per_worker = 8;
    let lobby_start = Instant::now();
    let lobby_threads = (0..lobby_workers)
        .map(|_| {
            thread::spawn(move || {
                for _ in 0..lobbies_per_worker {
                    let (status, body) = request(
                        port,
                        "POST",
                        "/lobbies",
                        Some(r#"{"maxParticipants":16}"#),
                    )
                    .unwrap();
                    assert_eq!(status, 201);
                    let created = json(&body);
                    let lobby_id = created["lobbyId"].as_str().unwrap().to_owned();

                    for _ in 1..16 {
                        let (status, _) = request(
                            port,
                            "POST",
                            &format!("/lobbies/{lobby_id}/join"),
                            None,
                        )
                        .unwrap();
                        assert_eq!(status, 200);
                    }

                    let (status, _) = request(
                        port,
                        "POST",
                        &format!("/lobbies/{lobby_id}/join"),
                        None,
                    )
                    .unwrap();
                    assert_eq!(status, 409);

                    let (status, body) =
                        request(port, "GET", &format!("/lobbies/{lobby_id}"), None).unwrap();
                    assert_eq!(status, 200);
                    assert_eq!(json(&body)["participantCount"], 16);
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in lobby_threads {
        worker.join().unwrap();
    }
    let lobby_count = lobby_workers * lobbies_per_worker;
    let lobby_operations = lobby_count * 18;
    assert_budget(
        "16-player lobby saturation burst",
        lobby_start.elapsed(),
        Duration::from_secs(15),
        lobby_operations,
    );

    let room_workers = 8;
    let rooms_per_worker = 32;
    let room_start = Instant::now();
    let room_threads = (0..room_workers)
        .map(|_| {
            thread::spawn(move || {
                for _ in 0..rooms_per_worker {
                    let (status, body) = request(port, "POST", "/rooms", None).unwrap();
                    assert_eq!(status, 201);
                    let room_id = json(&body)["roomId"].as_str().unwrap().to_owned();

                    let (status, _) = request(
                        port,
                        "POST",
                        &format!("/rooms/{room_id}/join"),
                        None,
                    )
                    .unwrap();
                    assert_eq!(status, 200);

                    let (status, body) =
                        request(port, "GET", &format!("/rooms/{room_id}"), None).unwrap();
                    assert_eq!(status, 200);
                    assert_eq!(json(&body)["status"], "paired");
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in room_threads {
        worker.join().unwrap();
    }
    assert_budget(
        "two-player room churn",
        room_start.elapsed(),
        Duration::from_secs(10),
        room_workers * rooms_per_worker * 3,
    );
}
