# Package Ninja Performance Deep Dive

Date: April 8, 2026  
Platform: Windows (Node 20+)

## Goal

Break down where time is spent in `package-ninja install/dev/test/run`, identify what is structural vs. optimizable, and define safe next-step speed work without compromising reliability.

## Measured Baseline (Current)

Small/medium install comparison (`n=3`, median) using:

`npm install <deps> --ignore-scripts --no-audit --no-fund`

| Scenario | Direct npm | Package Ninja (ephemeral, Node worker) | Package Ninja (ephemeral, Go worker) |
| --- | --- | --- | --- |
| small (1 dep) | ~1.4s | ~4.8s | ~4.0s |
| medium (8 deps) | ~1.7s | ~6.3s | ~4.9s |

Interpretation:

- Package Ninja adds a fixed overhead layer per ephemeral command.
- The fixed cost dominates small installs and is amortized on larger installs.

## Latency Budget (Phase Breakdown)

From direct phase probes (current build):

1. Registry startup (`startSession` + ready handshake): ~1.7s average  
2. Command worker overhead (`runCommandInSession` wrapper path): ~0.7s to ~1.0s  
3. Actual package-manager work: variable by dependency set/network/cache

Most of the "why is this slower than direct npm?" answer is in #1.

## What Was Optimized Safely

Windows command-worker previously polled full process snapshots (`Get-CimInstance Win32_Process`) every 250ms during command execution.  
That polling path was removed.

Result:

- Lower per-command overhead.
- Reliability preserved (`npm test` full selftest still passes).

## Recent Optimization Impact

Warm persistent follow-up (same project, no-op install, `n=3`, median):

| Path | Median |
| --- | --- |
| persistent follow-up (Node worker) | ~2.8s |
| persistent follow-up (Go worker) | ~1.6s |

Interpretation:

- Reuse remains the highest-impact safe speed lever.
- Go worker meaningfully reduces command orchestration overhead.
- Cold startup is still a real fixed cost until registry-start architecture changes.

## Current Safe Speed Lever

`--persistent` on one-shot commands now behaves as expected: the command leaves a reusable session running.

Example:

```bash
package-ninja install --persistent
package-ninja test
package-ninja run -- npm pack
package-ninja stop
```

Why this matters:

- Registry startup cost is paid once.
- Follow-up commands skip fresh startup and become materially faster.

## What Is Structural (Cannot Be "Free")

- A local registry process has non-trivial startup time on Windows.
- Isolation and hard cleanup guarantees require process boundaries and supervision.
- Force-safe interrupt handling (especially Windows tree cleanup) has unavoidable control-path overhead.

This means "identical speed to direct npm for single command ephemeral runs" is not a realistic target without changing product guarantees.

## Next Safe Optimization Candidates

1. Warm-session UX defaults  
   Keep current runtime internals, but make reusable sessions easier to opt into (e.g., docs, aliases, shell examples, optional config flag).

2. Temp-path fallback strategy  
   If `%TEMP%` is space constrained, auto-fallback runtime root to project-local `.package-ninja/runtime` with strict cleanup.

3. Lighter worker handoff format  
   Replace manifest file handoff with direct argv/IPC payload while preserving cleanup behavior.

4. Optional low-verbosity mode  
   Reduce console I/O in tight loops for CI/stress runs (small gain, low risk).

## Changes To Avoid (High Risk)

- Removing process boundary protections just for speed.
- Weakening interruption cleanup contracts.
- Reworking session lifecycle architecture before proving incremental gains.

## Instrumentation Checklist For Future Runs

Collect and compare:

1. `startSession` time
2. `runCommandInSession` overhead with trivial command (`node -e ""`)
3. end-to-end install time (small/medium/large)
4. cleanup/hygiene checks after interrupt storms

Always report medians and p95 across repeated runs, not single samples.
