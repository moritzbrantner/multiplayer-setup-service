# Gameplay authority and cheat boundaries

`multiplayer-setup-service` authenticates lobby membership and relays opaque WebRTC signaling. It deliberately does not interpret gameplay payloads, so connecting through the service does not make arbitrary peer messages trustworthy.

The browser showcase games demonstrate two reusable patterns.

## Four-player color-match card game

The card demo uses host-spoke topology. Guests send small reliable `card-intent` commands; they do not publish game state.

The host owns the demo's deck, hands, turn order, and rule transition. Before applying an intent it checks:

- the sender is still a participant;
- the message shape and sequence number are valid;
- duplicate/replayed sequence numbers are rejected;
- it is the sender's turn;
- a played card is actually in that sender's authoritative hand;
- the card matches the top color or value.

After an accepted transition, the host sends each participant an individualized view. A guest receives its own hand plus public hand counts, not the other guests' cards.

The page includes deliberate forged-card and replay probes so this boundary can be observed rather than only described.

### What this does not prove

The host is trusted. It sees every hand and chooses the shuffle seed, so a malicious host can inspect hidden information or bias game state. The seeded shuffle is a reproducibility mechanism, not a cryptographic fairness protocol.

A competitive hidden-information game should either use a trusted gameplay server or add a separately reviewed verifiable protocol, for example commitments plus multi-party randomness/shuffling and reveal proofs. That belongs above the setup service rather than inside the opaque signaling layer.

## Pong

Pong also uses a host-authoritative model:

- the guest may send a paddle target;
- the host clamps that target to the field and moves the guest paddle at the authoritative speed limit;
- the host alone computes ball movement, collisions, and score;
- only the guest accepts host score publications;
- a guest-originated `pong-score` message is rejected and can be exercised with the visible forged-score probe.

This prevents a modified guest from teleporting its authoritative paddle or declaring that it scored.

It does not reliably prevent automation that stays inside the legal input envelope. A bot that chooses excellent legal paddle targets can look like a very skilled human. A malicious host can also alter its authoritative simulation. Stronger competitive integrity would require a different authority/trust model and, where useful, rate limits, replay evidence, signed match records, or server-side adjudication.

## Reusable rule

Treat network messages as **requests or inputs**, not facts. Assign authority for each fact, validate messages against that authority, sequence state-changing inputs, make duplicate handling idempotent, and expose only the minimum state each peer needs.
