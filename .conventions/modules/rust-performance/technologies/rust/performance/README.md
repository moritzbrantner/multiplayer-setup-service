# Rust performance

Rust-specific conventions for crates where performance is an explicit engineering contract.

This scope inherits the general Rust and benchmarking conventions. Install it only for repositories or components where regressions in execution cost materially matter.

## RUST-004 — Use Divan for new Rust microbenchmarks

- Prefer Divan for new developer-facing Rust microbenchmark suites.
- Existing Criterion suites may remain; do not migrate working benchmarks solely for uniformity.
- Keep setup outside the measured region unless setup itself is the subject of the benchmark.
- Use deterministic inputs, prevent dead-code elimination, and report throughput when it makes the workload easier to interpret.

## RUST-005 — Use Iai-Callgrind for bounded blocking regression sentinels

- Performance-sensitive kernels that need a blocking CI regression signal should expose a deliberately small Iai-Callgrind suite through `benchmark:smoke` on supported Linux environments.
- Compare against a compatible relative baseline with an explicit regression threshold rather than an absolute instruction or event budget.
- Treat Callgrind instruction, cache, and event counts as deterministic performance proxies, not as equivalent to wall-clock latency.
- Keep the sentinel suite representative and inexpensive; the complete benchmark matrix remains separate evidence.
- A deliberate algorithm, compiler-target, or code-generation change may require an explicit baseline update rather than weakening the threshold.

## RUST-006 — Fingerprint Rust performance comparisons

- Record the Rust toolchain, target triple, target features or relevant `RUSTFLAGS`, optimization profile, dependency lock state, and benchmark workload version.
- Do not directly compare measurements from incompatible fingerprints.
- Preserve the fingerprint with benchmark evidence so an agent can distinguish an implementation regression from an environment change.

## RUST-007 — Keep wall-clock regression evidence on controlled runners

- Treat raw wall-clock timing from ordinary shared CI runners as informational rather than a blocking regression gate.
- Use controlled or dedicated hardware for wall-clock PR comparisons and historical trends; a managed benchmark service such as CodSpeed is an acceptable implementation.
- Do not encode portable performance contracts as absolute nanosecond limits.
- Keep wall-clock evidence complementary to deterministic regression sentinels rather than replacing them.
