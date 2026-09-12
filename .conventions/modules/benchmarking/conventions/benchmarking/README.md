# Benchmarking conventions

## BENCH-001 — Benchmark named representative scenarios

- Define a named workload, measured unit, optimization direction, sampling method, and environment fingerprint.
- Use deterministic inputs and keep setup outside the measured region unless setup itself is the subject of the benchmark.
- Record throughput when it makes differently sized workloads easier to compare.

## BENCH-002 — Compare candidates against versioned baselines

- Compare equivalent harness runs on equivalent infrastructure.
- Fail only regressions beyond committed relative and absolute-noise thresholds.
- Treat incompatible environment fingerprints as incomparable rather than silently accepting or rejecting the candidate.

## BENCH-003 — Separate blocking regression signals from noisy wall-clock timing

- Do not make raw wall-clock deltas from ordinary shared CI runners a blocking gate.
- Use a deterministic or sufficiently low-noise proxy for blocking regression thresholds when that proxy represents the intended workload.
- Keep the metric identity explicit: instruction counts, allocations, cache events, operation counts, and wall-clock latency are different evidence and must not be presented as interchangeable.
- Use controlled hardware when wall-clock latency itself is a blocking contract.

## BENCH-004 — Benchmark enough workload shapes to expose scaling regressions

- Performance-sensitive algorithms should cover multiple representative input sizes or shapes when one fixed case could hide an asymptotic, cache, allocation, or branch-behavior regression.
- Include common cases and a bounded stress or adversarial case when they exercise materially different behavior.
- Prefer a small stable matrix over an exhaustive benchmark suite that is too expensive to run or review routinely.

## BENCH-005 — Keep benchmark references outside production boundaries

- Reference implementations and comparison libraries should remain development-only or explicitly feature-gated unless production behavior deliberately depends on them.
- Benchmark-only dependencies must not silently become part of public APIs or runtime selection paths.
- Competitive benchmarks are evidence about implementation quality, not a requirement to copy another library's architecture.

## BENCH-006 — Treat profiling as explanatory evidence

- Capture CPU/hotspot profiles against a named representative scenario and record the exact source revision, profiler/tool version, target, features, and environment fingerprint.
- Preserve whether evidence is sampled, instrumented, or deterministic; sampled hotspots are evidence about where time was observed, not a correctness proof or an exact operation count.
- Compare profiles only when the workload and relevant environment inputs are equivalent. Otherwise report them as incomparable.
- Use profiles to explain or prioritize an observed regression; do not invent a performance regression solely from a changed sample percentage on an uncontrolled run.

## BENCH-007 — Keep memory metrics semantically distinct

- Record which memory signal is measured: retained/live heap, allocation count or rate, RSS/working set, GC pause, sampled peak, or another explicitly named metric.
- Use deterministic or bounded representative scenarios and retain tool, runtime, target, feature, and workload fingerprints with the evidence.
- Do not substitute one memory metric for another. A lower allocation rate does not prove lower retained memory, and a lower sampled peak does not prove lower steady-state RSS.
- Treat unavailable collectors or incompatible runtime configurations as unavailable/incomparable evidence rather than success.

## BENCH-008 — Bound service and load scenarios explicitly

- Service/load checks must declare the target, fixture/state setup, request count or duration, concurrency bound, timeout, and measured throughput/latency/error metrics.
- Default only to isolated local/test targets. Never run load scenarios against production endpoints unless a separate explicit operational policy authorizes that target.
- Keep load/performance evidence separate from behavioral correctness. A fast response with the wrong status or state transition is still incorrect.
- Prefer a small reproducible smoke workload for routine validation and reserve broad stress/capacity experiments for an explicit wider tier.

## BENCH-009 — Measure browser and mobile performance through representative journeys

- Browser traces should identify the immutable build artifact and representative interaction journey being measured; developer-server timing is not automatically deployment timing.
- Keep long tasks/main-thread work, React render counts or render budgets, network/loading evidence, and Lighthouse-style audits as distinct metrics rather than one synthetic truth.
- Mobile/Expo evidence should identify device/runtime conditions and distinguish startup, frame stalls, JavaScript/native CPU, memory, and interaction latency.
- Performance traces supplement behavioral and accessibility tests; loading a page or completing a trace does not prove the interaction is correct.

## BENCH-010 — Compare size only across equivalent artifacts

- Binary/bundle size evidence must identify the exact artifact, entry point, target, profile/mode, feature set, and relevant toolchain inputs.
- Compare equivalent artifacts against a versioned baseline; incompatible targets, feature sets, minification modes, or packaging boundaries are incomparable.
- Keep size evidence separate from runtime latency, CPU, and memory evidence. Smaller is not automatically faster or better.
- When a size budget is blocking, commit the budget and the artifact-selection rule so the measured boundary cannot drift silently.

## BENCH-011 — Use controlled history for blocking wall-clock trends

- Persistent wall-clock history intended for regression decisions must come from dedicated, pinned, or otherwise controlled execution environments with workload and environment fingerprints.
- Bind baseline and candidate evidence to exact source/artifact identities and preserve raw observations needed to explain the comparison.
- Ordinary shared-runner wall-clock results may remain informational but must not silently join controlled history as equivalent samples.
- Missing history, unavailable runners, or incompatible fingerprints remain unavailable/incomparable; never coerce them into a green trend.
