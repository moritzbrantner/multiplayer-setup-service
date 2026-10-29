# Scrabble launcher acceptance handoff

Independent acceptance for issue #44 was authored against baseline
`28ade7b757f5564625dec4383dce3c7d1e8fe005`, before production changes. Authority:
issue #44, repository AGENTS.md, Scrabble's current
`docs/specs/game-creation.md`, and the owner-requested moenarch.com deployment.
Shared convention sourceRevision: `5ad0db36974c8b0e5f9812c90ee34a4f227852c3`.

## Public API contract

`PUT /lobbies/{canonicalLobbyId}/game-reference` accepts a Bearer participant
capability and JSON `{participantId, application: "scrabble", matchId}`. Only
that lobby's existing host capability may write. A canonical created match is
`b_<16 lowercase hex>_<32 lowercase hex>`; the setup service stores only this
bounded public reference and never runs or creates a Scrabble game.

First registration and identical retries return 200 with exactly
`{application:"scrabble",matchId}`. Concurrent identical writes all succeed;
a different reference returns 409 `game-reference-conflict` and preserves the
first. Public GET returns the same object, or 409 `game-not-bound`, or 404 for
unknown/expired lobby. Malformed references return 400. Missing/mismatched
capabilities return 401, a valid non-host capability 403. Renewal preserves the
binding. Binding lifetime follows its lobby; process restart discards it along
with the in-memory lobby. No binding extends Scrabble's independently owned
six-hour lifecycle. A previously issued canonical Scrabble match invitation works
without another setup-service lookup after lobby expiry.

## Launcher browser boundary

`/scrabble.html` offers **Create Scrabble lobby**, then **Open Scrabble board**
and a public **Invite link**. The host capability remains in memory on this
page. The board opens at the fixed trusted Scrabble origin:
`https://scrabble.moenarch.com/scrabble/?launch=moenarch&session=<lobby>&view=board`.
The Scrabble board creates the real game and retains its creation nonce itself.
It reports only `{type:"scrabble-match-created",session,match}` to the fixed
launcher origin via postMessage. The launcher requires the exact Scrabble origin,
its exact opened board window, matching session and canonical public match ID
before authenticated binding. No board claim nonce or participant credential
crosses this message boundary. Retrying Open reuses the original board popup.

A guest opens the launcher invite and **Open Scrabble player** opens
`https://scrabble.moenarch.com/scrabble/?launch=moenarch&session=<lobby>&match=<match>&view=player`.
Reloading the launcher loses host capability and resolves the existing public
binding; it must never silently create another board/game. Production API
configuration stays fixed; `setupApi` may override the setup service only when
the launcher itself runs on loopback, solely for local acceptance.

## Gates and limits

- `cargo test --locked --test scrabble_binding`: real compiled service over
  HTTP, current host versus guest/forged/missing capabilities, malformed and
  bounded references, immutable concurrent registration, renewal, 60-second expiry and process restart.
- `bun run --cwd web build`, then the repository browser runner with
  `scrabble-launcher.spec.ts`: real launcher, real setup service, two isolated
  Chromium contexts, controlled Scrabble popup preserving real cross-origin
  postMessage semantics. It rejects wrong origin/source/session/match, resolves
  one reference for guests, retries/reloads without duplicating a board, and
  checks capabilities do not enter URLs/local/session storage. No retained trace
  may capture host capability. This boundary fixture does not establish gameplay.
- The HTTP expiry regression intentionally takes 61 seconds because the binary
  enforces a 60-second minimum TTL. It proves bound reads and writes fail after
  expiry; the restart regression proves a new service process loses the binding.
- Scrabble #80 separately owns the Pages adapter and real local Rust
  WebTransport integrated journey: trusted board creates exactly once, two
  isolated players join that match, host starts, legal move propagates, reconnect
  preserves identity, and canonical match link survives setup-lobby expiry.
  These are required before declaring the complete owner journey passed.
- After merge/deployment, verify revision at moenarch.com and repeat the actual
  board/two-player journey through the published `scrabble.moenarch.com` app. A reachable launcher
  or green boundary fixture alone is not live acceptance.

## Baseline observations

On baseline `28ade7b757f5564625dec4383dce3c7d1e8fe005`, running
`python3 ~/.local/share/coding-agent/disk-maintenance.py run -- cargo test --locked --test scrabble_binding`
compiled successfully; all five acceptance tests failed on the expected absent
HTTP route (404 instead of the specified successful/unbound/validation status).
Disposable build output was cleaned by the wrapper.

`bunx playwright test scrabble-launcher --list` discovered both configured
Chromium projects. Execution of the repository runner was unavailable at
baseline: its prerequisite `target/release/multiplayer-setup-service` was absent
(exit 127), and `turnserver` was not installed. This is missing browser execution
evidence, not a claimed browser failure/pass. The boundary tests must run after
those documented runner prerequisites are provisioned.

## Independent browser fixture correction

Chromium severs `window.opener` when the designated popup navigates to the
untrusted site in this fixture, so that navigation prevented message delivery
and destroyed the later positive report. The corrected boundary test preserves
the designated popup, dispatches a MessageEvent at the actual launcher event
target with its genuine WindowProxy, correct session/match and an untrusted
origin, and proves no registration occurs. Real browser-generated postMessage
continues to exercise incorrect session/match, unrelated popup source, and
successful trusted reporting. This isolates the handler's origin decision;
it does not claim a browser permits arbitrary spoofing of message origins.

Independent re-verification on the implementation candidate passed both
Chromium desktop and touch projects with their actual project viewport/touch
settings. The expected public reference, guest route, retry/reload and
credential-storage assertions were unchanged. This remains launcher-boundary
coverage; real Scrabble gameplay is covered separately by Scrabble #80.

## Independent configured-match compatibility (#53)

Consumer Scrabble #94 / PR #109 adds immutable selected profiles/settings under
current Atlas 1.25/1.31/1.39 and execution priority 4.1. A configured shared-board
match uses `p_<16 lowercase hex>_<32 lowercase hex>` so missing initialization
cannot silently become a default legacy match. Existing `b_` match identities and
all public reference fields remain unchanged. This service must accept exactly
both bounded shared-board families, retain rejection of `g_` and malformed or
uppercase IDs, and continue storing only the public opaque reference.

Independent acceptance author extends the real compiled HTTP test for configured
host/guest/forged credentials, concurrent identical registration, conflicts in
both directions between legacy/configured matches, public-only lookup, renewal
and expiry. The shared 61-second expiry test creates both families before one
unchanged TTL wait. Strict malformed-p framing extends the existing rejection
matrix. The launcher browser journey is parameterized over legacy and configured
IDs in both existing desktop/touch projects. Every source/origin/session check,
retry/reload/player route and credential-privacy assertion remains; the controlled
Scrabble protocol peer still does not claim actual gameplay.

Authoring baseline: `ce257ee1aba03e99c31f889a5c822bdf75e34ace`. Focused native
execution genuinely fails: the real service returns 400 for a well-formed
configured reference instead of reaching guest authorization (403). Later host
registration/reuse/privacy assertions remain unrun at baseline. Log:
`/tmp/setup53-native-baseline.log`. No production code is changed by this
acceptance handoff. Current convention sourceRevision remains
`5ad0db36974c8b0e5f9812c90ee34a4f227852c3`; task inspection is partial because
source relationships/completion are undeclared, so full repository gates remain.

Browser execution at authoring is unavailable: the declared runner needs a
release service binary and coturn `turnserver`, and the current Node 24.16.0
does not match this repository's exact 24.20.0 pin. These are setup gaps, not a
claimed browser failure or pass. The worker must provision the declared tools
and execute all four launcher cases after repair. Scrabble separately retains
the actual selected-profile gameplay and deployed owner journey. Before merge,
record **Awaiting live deployment verification** on #53 with head/revision,
public launcher and actual configured-match owner steps. Leave #53 open while
publishing or live evidence is pending; the native Scrabble #94 dependency must
not imply the published launcher accepts configured IDs before verification.
