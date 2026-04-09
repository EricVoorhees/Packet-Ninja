# Phase 3: Ares Native Registry Engine Plan

Date: April 9, 2026

## Mission

Run a Go-native registry core as the default runtime without sacrificing reliability guarantees already proven in Phase 2.

This is an **engine replacement project**, not a cosmetic rewrite.

## Non-Negotiable Requirements

1. Protocol parity for core npm registry traffic:
- package metadata (packument)
- tarball downloads
- search passthrough and unknown-route passthrough

2. Stream-first behavior:
- tarballs must stream directly from upstream/cache to client
- avoid buffering full tarballs in memory

3. Data integrity:
- content-addressable tarball persistence (CAS)
- atomic index writes
- crash-safe cache/index consistency

4. Uplink efficiency:
- request collapsing to prevent upstream stampedes
- one upstream fetch per key during collapse windows

5. Transition safety:
- shadow/compare hooks for parity validation during rollout

## State Machine

States:

- `booting`: process initializing storage/network
- `ready`: healthy request handling
- `degraded`: serving but with upstream/cache errors above threshold
- `draining`: shutdown started, refusing new work
- `stopped`: terminal state

Allowed transitions:

- `booting -> ready|degraded|stopped`
- `ready -> degraded|draining`
- `degraded -> ready|draining`
- `draining -> stopped`

## Core Runtime Components

1. **HTTP Front Door**
- route classification: metadata, tarball, passthrough, health
- header policy for forwarding and conditional revalidation

2. **Uplink Client**
- timeout-bound upstream calls
- conditional requests (`If-None-Match`, `If-Modified-Since`)

3. **Collapse Coordinator**
- in-flight key coordination for metadata/tarball fetches
- followers wait for leader result instead of fanning out upstream requests

4. **CAS Tarball Store**
- tarballs persisted by digest
- key-to-digest index
- cache hit serves file directly

5. **Metadata Cache**
- on-disk metadata payload files
- atomic metadata index updates
- TTL-aware cache semantics

6. **Telemetry/Shadow Hooks**
- request timing and cache/collapse counters
- optional shadow target probe for parity transition checks

## Verification Matrix (Phase 3 Gates)

### Functional

- metadata fetch and revalidation behavior
- tarball cache miss -> hit flow
- search/passthrough correctness
- request collapsing on simultaneous identical requests

### Reliability

- startup/shutdown lifecycle correctness
- no corrupt index after forced interruption
- stale cache entry self-healing
- bounded behavior on upstream timeout/failure

### Performance

- warm-path command orchestration remains Phase-2 compliant
- tarball cache-hit TTFB and stream stability
- upstream-request count reduction under concurrency

## Rollout Plan

1. **Stage A (Now)**: Ares alpha module in-repo (`go/ares`) with tests.
2. **Stage B**: Ares runtime integrated with CLI/session lifecycle.
3. **Stage C**: Shadow-mode parity soak against target registry behavior.
4. **Stage D**: Ares-only cutover with reliability proof matrix locked.

## Tracking Checklist

- [x] Phase 3 architecture doc and acceptance gates
- [x] State machine model in code
- [x] Initial stream-first tarball pipeline in code
- [x] Initial request collapse coordinator in code
- [x] CAS and metadata persistence scaffolding in code
- [ ] Full registry route parity validation suite
- [x] Ares-only runtime integration in CLI/session path
- [x] Shadow parity report tooling
- [x] Internal upstream/collapse counters (`/-/stats`) for cutover validation
- [x] Cutover readiness review
