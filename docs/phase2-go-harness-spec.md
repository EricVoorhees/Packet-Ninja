# Phase 2 Go Harness Spec (Verified Migration)

Date: April 8, 2026

## Objective

Keep the current runtime contract and reliability, while removing command orchestration tax.

Measured fixed costs today:

- Registry startup (cold): ~1.6s to ~1.9s
- Command orchestration/handoff: ~0.7s to ~1.0s

Phase 2 targets the second line item first.

## Current System Map (Source of Truth)

Current flow:

- `src/cli.ts` parses command and routes to workflow/session logic.
- `src/workflow.ts` acquires/reuses session and prints state phases.
- `src/session.ts` starts/stops the native runtime worker, writes state, runs command worker.
- `src/command-worker.ts` owns subprocess signal handling + cleanup.
- `src/state.ts` owns atomic `state.json` writes and tolerant reads.
- `src/selftest.ts` enforces the reliability contract.

Phase 2 must be a drop-in replacement for command orchestration behavior, not a runtime rewrite.

## Scope and Non-Goals

### In Scope

1. Replace Node command worker execution path with Go harness binary.
2. Keep session model and reliability contract intact.
3. Preserve all selftest behavior and exit semantics.
4. Add warm-path orchestration optimization with strict parity checks.

### Out of Scope

- Registry protocol rewrite (packument/tarball/publish server logic).
- Runtime engine replacement.
- Contract changes to publish safety.
- Selftest coverage reduction.

## Contract to Preserve (Must-Pass)

From `src/selftest.ts`, Phase 2 must preserve:

- startup failure cleanup
- readiness timeout cleanup
- owned interruption cleanup
- reused-session interruption cleanup
- zero leaked temp runtime directories
- zero orphan process trees
- npm/pnpm/yarn command compatibility
- publish blocking behavior for non-local registries
- exact exit code propagation behavior

No Phase 2 release is valid without unchanged selftest pass behavior.

## Phase 2 Architecture

### Stage 1: Go Worker Replacement (Lowest Risk)

- Keep Node CLI/session lifecycle.
- Replace `command-worker.ts` with `command-worker-go`.
- Use existing manifest contract (`command`, `args`, `cwd`, `envEntries`, `parentPid`) to reduce blast radius.

### Stage 2: Warm Session Fast Path

Read `.package-ninja/state.json` in Go and validate all of:
1. state exists and parses
2. pid alive
3. registry health responds inside strict timeout
If valid, run command immediately (skip extra startup waits).

### Stage 3: Optional Pipe/Socket Handshake

- Add transport-level heartbeat once Stage 1+2 parity is proven.
- Windows: named pipe `\\.\pipe\package-ninja-<scope>-<sessionId>`
- Unix: socket `/tmp/package-ninja-<scope>-<sessionId>.sock`

### Stage 4: Optional Go Entry CLI

- Only after runner parity + soak metrics are clean.

## Protocol and State Semantics

### Handshake Messages (if transport is enabled)

- `ping` -> `pong` (liveness)
- `status` -> state snapshot (`ready`, `busy`, `uptime`, `pid`)
- `ensure` -> confirms active session metadata

### State Compatibility Requirements

- Remain backward compatible with current `state.json`.
- Any additional fields must be optional and non-breaking.
- Continue atomic write semantics (temp + rename).
- Continue tolerant parse semantics for transient partial reads.

### Session Contention Rules

- Add lock/mutex around session ensure/start path.
- Guarantee idempotent concurrent `ensure session` behavior.
- Include stale-lock recovery policy with bounded timeout.

## Process Hygiene Requirements

### Windows

- Child command tree must be in a Job Object with kill-on-close semantics.
- Handle parent already-in-job scenarios gracefully.
- Ctrl+C must terminate child tree without orphans.
- No leaked `node.exe`, `npm.exe`, `pnpm.exe`, `yarn.exe`.

### Linux/macOS

- Child commands run in dedicated process group.
- Forward interrupt first (`SIGINT`/`SIGTERM`) then bounded forced kill.
- Kill entire group on parent death / forced shutdown.

## Command Parity Requirements

### Shell and Quoting

Preserve current behavior across platforms:
1. Windows command execution semantics compatible with current `cmd.exe` wrapping.
2. Unix command execution semantics compatible with current shell invocation.
Argument quoting and escaping must preserve npm/pnpm/yarn compatibility.

### StdIO

- Streaming must be unbuffered and live.
- Preserve practical ordering of stdout/stderr as seen today.

### Exit Semantics

- Preserve child code passthrough.
- Preserve signal-to-exit-code mapping (`SIGINT=130`, `SIGTERM=143`, `SIGHUP=129`).

### Environment Injection

Preserve registry/userconfig env set:
1. `PACKAGE_NINJA_REGISTRY_URL`
2. `npm_config_registry` / `NPM_CONFIG_REGISTRY`
3. `npm_config_userconfig` / `NPM_CONFIG_USERCONFIG`
4. `YARN_NPM_REGISTRY_SERVER`
Do not mutate user global config files.

## Performance Targets

- Warm orchestration path (excluding package-manager work): <50ms target.
- Warm liveness/handshake check: <10ms typical.
- Cold path unchanged expectation until runtime rewrite phase.

## Test Gate Additions (Beyond Existing Selftest)

1. Go worker parity: normal/nonzero/signal exit behavior.
2. Stdout/stderr real-time streaming parity.
3. Warm-path orchestration benchmark guard (coarse threshold).
4. Concurrent session ensure race test.
5. Parent-death cleanup test (no orphan trees).
6. Windows job object nested-job scenario test.
7. Shell quoting regression tests for npm/pnpm/yarn command variants.

## Rollout Plan

1. Feature-flagged rollout: `PACKAGE_NINJA_USE_GO_RUNNER=1`.
2. Internal soak with repeated selftest + repeated command loops.
3. Compare leak/hygiene/latency against Node baseline.
4. Promote to default only after parity window passes.

Rollback remains immediate by disabling feature flag.

## Known Risks and Mitigations

1. Windows job object edge cases.
Mitigation: explicit nested-job tests + fallback teardown path.
2. Shell quoting drift from Node behavior.
Mitigation: command fixture parity tests across managers.
3. Pipe/socket permission or cleanup issues.
Mitigation: ACL rules, deterministic endpoint naming, stale endpoint cleanup.
4. Over-aggressive timeouts causing false cold starts.
Mitigation: conservative defaults + jitter-tolerant retry window.

## Definition of Done (Phase 2)

- Existing selftest suite passes unchanged.
- New Go parity tests pass on Windows and Unix.
- Warm orchestration target is met on repeated runs.
- No increase in orphan process or runtime-dir leak incidents.
- Feature flag is safe to enable by default.
