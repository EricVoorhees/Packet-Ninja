# Package Ninja Performance Deep Dive

Date: April 8, 2026  
Platform: Windows (Node 20+)

## Goal

Break down where time is spent in `package-ninja install/dev/test/run`, identify what is structural vs. optimizable, and define safe next-step speed work without compromising reliability.

## Measured Baseline

Small/medium install comparison (`npm install --ignore-scripts --no-audit --no-fund` vs `package-ninja install`):

| Scenario | Direct npm | Package Ninja (ephemeral) |
| --- | --- | --- |
| small (1 dep) | ~2.0s | ~5.2s |
| medium (8 deps) | ~3.8s | ~8.8s |

Interpretation:

- Package Ninja adds a fixed overhead layer per ephemeral command.
- The fixed cost dominates small installs and is amortized on larger installs.

## Latency Budget (Phase Breakdown)

From direct phase probes:

1. Registry startup (`startSession` + ready handshake): ~2.3s to ~2.9s  
2. Command worker overhead (`runCommandInSession` wrapper path): ~0.8s to ~1.2s  
3. Actual package-manager work: variable by dependency set/network/cache

Most of the "why is this slower than direct npm?" answer is in #1.

## What Was Optimized Safely

Windows command-worker previously polled full process snapshots (`Get-CimInstance Win32_Process`) every 250ms during command execution.  
That polling path was removed.

Result:

- Lower per-command overhead.
- Reliability preserved (`npm test` full selftest still passes).

## Recent Optimization Impact

Measured before and after the safe Windows command-worker change:

| Scenario | Before | After | Improvement |
| --- | --- | --- | --- |
| small install (ephemeral) | ~6.1s | ~5.2s | ~14.7% faster |
| medium install (ephemeral) | ~9.6s | ~8.8s | ~8.3% faster |

Measured warm-session reuse (`run` command):

| Pattern | Total |
| --- | --- |
| two ephemeral runs | ~6.9s |
| `--persistent` first run + reuse + stop | ~4.0s |

Interpretation:

- Reuse is currently the highest-impact safe speed lever.
- Ephemeral mode remains slower by design, because startup safety is paid each run.

## Current Safe Speed Lever (Now Enabled)

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
