//! Non-blocking signaling delivery. A full per-recipient outbox cancels that
//! recipient instead of dropping an SDP/ICE message and leaving a silently
//! inconsistent session. Aggregate pressure rejects new relays without
//! disconnecting an otherwise healthy recipient.

use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};

pub const QUEUE_CAPACITY: usize = 32;
pub const TOTAL_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const TOTAL_CONTROL_BYTES: usize = 2 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = crate::protocol::MAX_SIGNAL_BYTES + 1024;
const ITEM_OVERHEAD: usize = 128;

pub trait Command {
    /// None is cancellation, which must never wait behind queued data.
    fn into_text(self) -> Option<String>;
}

#[derive(Clone)]
pub struct Sender {
    sender: mpsc::Sender<QueuedText>,
    close: watch::Sender<bool>,
    budget: Arc<Semaphore>,
}

pub struct Receiver {
    receiver: mpsc::Receiver<QueuedText>,
    close: watch::Receiver<bool>,
}

#[derive(Debug)]
pub struct QueuedText {
    pub text: String,
    // Retain this reservation through the socket write, not just until dequeue.
    pub _reservation: OwnedSemaphorePermit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SendError {
    Closed,
    Full,
    BudgetExhausted,
    TooLarge,
}

fn shared_queue_budget() -> Arc<Semaphore> {
    static BUDGET: OnceLock<Arc<Semaphore>> = OnceLock::new();
    BUDGET
        .get_or_init(|| Arc::new(Semaphore::new(TOTAL_QUEUE_BYTES)))
        .clone()
}

fn shared_control_budget() -> Arc<Semaphore> {
    static BUDGET: OnceLock<Arc<Semaphore>> = OnceLock::new();
    BUDGET
        .get_or_init(|| Arc::new(Semaphore::new(TOTAL_CONTROL_BYTES)))
        .clone()
}

pub fn channel() -> (Sender, Receiver) {
    channel_with_budget(QUEUE_CAPACITY, shared_queue_budget())
}

fn channel_with_budget(capacity: usize, budget: Arc<Semaphore>) -> (Sender, Receiver) {
    let (sender, receiver) = mpsc::channel(capacity);
    let (close_sender, close_receiver) = watch::channel(false);
    (
        Sender {
            sender,
            close: close_sender,
            budget,
        },
        Receiver {
            receiver,
            close: close_receiver,
        },
    )
}

/// Direct responses use a separate bounded reserve so queue saturation can be
/// reported without letting unrelated queued traffic consume that capacity.
pub fn reserve(text: &String) -> Result<OwnedSemaphorePermit, SendError> {
    reserve_from(shared_control_budget(), text)
}

fn reserve_from(budget: Arc<Semaphore>, text: &String) -> Result<OwnedSemaphorePermit, SendError> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(SendError::TooLarge);
    }
    let bytes = text.capacity().saturating_add(ITEM_OVERHEAD);
    let permits = u32::try_from(bytes).map_err(|_| SendError::TooLarge)?;
    budget
        .try_acquire_many_owned(permits)
        .map_err(|_| SendError::BudgetExhausted)
}

impl Sender {
    pub fn send(&self, command: impl Command) -> Result<(), SendError> {
        let Some(text) = command.into_text() else {
            self.close.send_replace(true);
            return Ok(());
        };
        if *self.close.borrow() || self.sender.is_closed() {
            return Err(SendError::Closed);
        }
        // Global saturation is not evidence that this recipient is slow. Reject
        // the relay, but preserve the healthy connection so unrelated pressure
        // cannot evict it.
        let reservation = reserve_from(self.budget.clone(), &text)?;
        let queued = QueuedText {
            text,
            _reservation: reservation,
        };
        self.sender.try_send(queued).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                self.close.send_replace(true);
                SendError::Full
            }
            mpsc::error::TrySendError::Closed(_) => SendError::Closed,
        })
    }
}

impl Receiver {
    pub async fn recv(&mut self) -> Option<QueuedText> {
        if *self.close.borrow() {
            self.discard();
            return None;
        }
        tokio::select! {
            biased;
            _ = self.close.changed() => {
                self.discard();
                None
            }
            message = self.receiver.recv() => message,
        }
    }

    fn discard(&mut self) {
        self.receiver.close();
        while self.receiver.try_recv().is_ok() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Text(Option<String>);

    impl Command for Text {
        fn into_text(self) -> Option<String> {
            self.0
        }
    }

    fn message() -> Text {
        Text(Some("signal".to_owned()))
    }

    #[tokio::test]
    async fn slow_recipient_is_cancelled_without_waiting_for_queue_space() {
        let budget = Arc::new(Semaphore::new(4096));
        let (sender, mut receiver) = channel_with_budget(1, budget.clone());
        sender.send(message()).unwrap();
        assert_eq!(sender.send(message()), Err(SendError::Full));
        assert!(receiver.recv().await.is_none());
        assert_eq!(budget.available_permits(), 4096);
        assert_eq!(sender.send(message()), Err(SendError::Closed));
    }

    #[tokio::test]
    async fn explicit_close_bypasses_a_full_queue() {
        let (sender, mut receiver) = channel_with_budget(1, Arc::new(Semaphore::new(4096)));
        sender.send(message()).unwrap();
        sender.send(Text(None)).unwrap();
        assert!(receiver.recv().await.is_none());
    }

    #[tokio::test]
    async fn aggregate_budget_rejects_a_relay_without_closing_its_healthy_recipient() {
        let bytes = "signal".len() + ITEM_OVERHEAD;
        let budget = Arc::new(Semaphore::new(bytes));
        let (first, mut receiver) = channel_with_budget(2, budget.clone());
        let (second, mut other) = channel_with_budget(2, budget.clone());
        first.send(message()).unwrap();
        let pending_write = receiver.recv().await.unwrap();
        assert_eq!(budget.available_permits(), 0);

        assert_eq!(second.send(message()), Err(SendError::BudgetExhausted));
        assert!(!*other.close.borrow());

        drop(pending_write);
        assert_eq!(budget.available_permits(), bytes);
        second.send(message()).unwrap();
        assert_eq!(other.recv().await.unwrap().text, "signal");
        assert_eq!(budget.available_permits(), bytes);
    }

    #[tokio::test]
    async fn cancelling_a_slow_peer_does_not_close_a_healthy_peer() {
        let budget = Arc::new(Semaphore::new(4096));
        let (slow, mut slow_receiver) = channel_with_budget(1, budget.clone());
        let (healthy, mut healthy_receiver) = channel_with_budget(1, budget.clone());
        slow.send(message()).unwrap();
        assert_eq!(slow.send(message()), Err(SendError::Full));
        healthy.send(message()).unwrap();
        assert_eq!(healthy_receiver.recv().await.unwrap().text, "signal");
        assert!(slow_receiver.recv().await.is_none());
        healthy.send(message()).unwrap();
        drop(slow_receiver);
        drop(healthy_receiver);
        assert_eq!(budget.available_permits(), 4096);
    }

    #[tokio::test]
    async fn oversized_messages_are_rejected_before_enqueue_without_closing_the_recipient() {
        let budget = Arc::new(Semaphore::new(TOTAL_QUEUE_BYTES));
        let (sender, mut receiver) = channel_with_budget(1, budget.clone());
        assert_eq!(
            sender.send(Text(Some("x".repeat(MAX_FRAME_BYTES + 1)))),
            Err(SendError::TooLarge)
        );
        assert!(!*receiver.close.borrow());
        assert_eq!(budget.available_permits(), TOTAL_QUEUE_BYTES);
        sender.send(message()).unwrap();
        assert_eq!(receiver.recv().await.unwrap().text, "signal");
    }
}
