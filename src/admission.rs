use axum::extract::ws::Message;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderValue, StatusCode, header::RETRY_AFTER};
use axum::middleware::Next;
use axum::response::Response;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const MAX_CLIENTS: usize = 4096;
const MAX_REQUESTS_IN_FLIGHT: usize = 128;
const HTTP_RATE: u32 = 120;
const HTTP_BURST: u32 = 240;
const CLIENT_IDLE_TTL: Duration = Duration::from_secs(120);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(30);
const REQUEST_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Admission {
    clients: Arc<Mutex<Clients>>,
    in_flight: Arc<Semaphore>,
}

struct Clients {
    entries: HashMap<IpAddr, Bucket>,
    next_cleanup: Instant,
}

struct Bucket {
    tokens: f64,
    updated: Instant,
    capacity: u32,
    per_second: u32,
}

impl Bucket {
    fn new(capacity: u32, per_second: u32, now: Instant) -> Self {
        Self {
            tokens: f64::from(capacity),
            updated: now,
            capacity,
            per_second,
        }
    }

    fn allow(&mut self, cost: u32, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        self.tokens = (self.tokens + elapsed * f64::from(self.per_second))
            .min(f64::from(self.capacity));
        self.updated = now;
        if f64::from(cost) > self.tokens {
            return false;
        }
        self.tokens -= f64::from(cost);
        true
    }
}

impl Default for Admission {
    fn default() -> Self {
        Self {
            clients: Arc::new(Mutex::new(Clients {
                entries: HashMap::new(),
                next_cleanup: Instant::now() + CLEANUP_INTERVAL,
            })),
            in_flight: Arc::new(Semaphore::new(MAX_REQUESTS_IN_FLIGHT)),
        }
    }
}

impl Admission {
    fn allow(&self, ip: IpAddr, now: Instant) -> Result<(), StatusCode> {
        let mut clients = self
            .clients
            .lock()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if now >= clients.next_cleanup {
            clients.entries.retain(|_, bucket| {
                now.saturating_duration_since(bucket.updated) < CLIENT_IDLE_TTL
            });
            clients.next_cleanup = now + CLEANUP_INTERVAL;
        }
        if !clients.entries.contains_key(&ip) && clients.entries.len() >= MAX_CLIENTS {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        let bucket = clients
            .entries
            .entry(ip)
            .or_insert_with(|| Bucket::new(HTTP_BURST, HTTP_RATE, now));
        if bucket.allow(1, now) {
            Ok(())
        } else {
            Err(StatusCode::TOO_MANY_REQUESTS)
        }
    }
}

pub async fn limit_http(
    State(admission): State<Admission>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    // Never trust arbitrary X-Forwarded-For headers. Behind a proxy, this bucket
    // intentionally describes that proxy; enforce end-client limits at the edge.
    if let Err(status) = admission.allow(peer.ip(), Instant::now()) {
        return rejected(status);
    }
    let Ok(_permit) = admission.in_flight.clone().try_acquire_owned() else {
        return rejected(StatusCode::SERVICE_UNAVAILABLE);
    };
    match tokio::time::timeout(REQUEST_DEADLINE, next.run(request)).await {
        Ok(response) => response,
        Err(_) => rejected(StatusCode::REQUEST_TIMEOUT),
    }
}

fn rejected(status: StatusCode) -> Response {
    let mut response = crate::error_response(
        status,
        "signaling-admission-limited",
        "Signaling request capacity is temporarily exhausted",
    );
    response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from_static("1"));
    response
}

pub struct SocketRate {
    messages: Bucket,
    bytes: Bucket,
}

impl Default for SocketRate {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            messages: Bucket::new(128, 64, now),
            bytes: Bucket::new(1024 * 1024, 512 * 1024, now),
        }
    }
}

impl SocketRate {
    pub fn allow(&mut self, frame: &Message) -> bool {
        let bytes = match frame {
            Message::Text(text) => text.len(),
            Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
            Message::Close(_) => 0,
        };
        let Ok(bytes) = u32::try_from(bytes) else {
            return false;
        };
        let now = Instant::now();
        self.messages.allow(1, now) && self.bytes.allow(bytes, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_has_a_bounded_burst_and_refill() {
        let now = Instant::now();
        let mut bucket = Bucket::new(2, 1, now);
        assert!(bucket.allow(2, now));
        assert!(!bucket.allow(1, now));
        assert!(!bucket.allow(1, now + Duration::from_millis(500)));
        assert!(bucket.allow(1, now + Duration::from_secs(1)));
        assert!(!bucket.allow(3, now + Duration::from_secs(100)));
        assert!(bucket.allow(2, now + Duration::from_secs(100)));
    }

    #[test]
    fn exhausting_one_client_does_not_exhaust_another() {
        let admission = Admission::default();
        let now = Instant::now();
        let first = IpAddr::from([192, 0, 2, 1]);
        let second = IpAddr::from([192, 0, 2, 2]);
        for _ in 0..HTTP_BURST {
            assert_eq!(admission.allow(first, now), Ok(()));
        }
        assert_eq!(
            admission.allow(first, now),
            Err(StatusCode::TOO_MANY_REQUESTS)
        );
        assert_eq!(admission.allow(second, now), Ok(()));
        assert_eq!(admission.allow(first, now + Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn client_tracking_is_bounded_and_idle_entries_are_reclaimed() {
        let admission = Admission::default();
        let now = Instant::now();
        for value in 0..MAX_CLIENTS {
            let ip = IpAddr::V4(std::net::Ipv4Addr::from(value as u32));
            assert_eq!(admission.allow(ip, now), Ok(()));
        }
        let next = IpAddr::from([192, 0, 2, 1]);
        assert_eq!(
            admission.allow(next, now),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert_eq!(admission.allow(next, now + CLIENT_IDLE_TTL), Ok(()));
        assert_eq!(admission.clients.lock().unwrap().entries.len(), 1);
    }

    #[test]
    fn websocket_control_frames_also_consume_rate_capacity() {
        let mut rate = SocketRate::default();
        let frame = Message::Ping(Vec::new().into());
        for _ in 0..128 {
            assert!(rate.allow(&frame));
        }
        assert!(!rate.allow(&frame));
    }
}
