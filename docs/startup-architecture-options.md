# Startup Architecture Options (Deep Dive)

Date: April 8, 2026

## Objective

Assess whether Package Ninja can reach near-instant startup while preserving current guarantees:

- npm / pnpm / yarn compatibility
- local-registry publish safety
- interruption cleanup on Windows
- disposable-session workflow

## What Is Slow Today

From measured runs in this repo:

- registry startup: ~1.6s to ~1.9s
- command-wrapper/process handoff: ~0.7s to ~1.0s
- stop: near-zero

Root cause:

- `package-ninja` currently starts a Verdaccio runtime for fresh ephemeral runs.
- Verdaccio startup and plugin initialization dominate cold-start latency.
- This cost repeats when commands do not reuse a warm session.

## Cross-Check of Proposed Approaches

### 1. Go Static Runtime

Pros:

- Very fast cold-start potential.
- Single static binary distribution.
- Low memory footprint.

Cons against current Package Ninja contract:

- Re-implementing npm-registry behavior is non-trivial (packuments, dist-tags, tarball routes, proxy behavior, cache semantics).
- Verdaccio parity for edge cases takes significant engineering and compatibility testing.
- Requires a separate long-term runtime surface to maintain.

Verdict:

- Technically strong for a future runtime engine.
- High migration cost and high compatibility risk if done in one jump.

### 2. Redbean

Pros:

- Excellent static file server startup.
- Tiny footprint.

Cons against current contract:

- Best for static assets, not dynamic npm-registry proxy/mirror behavior.
- Poor fit for complex package-manager compatibility logic.
- Lua-centric customization increases maintenance complexity.

Verdict:

- Great for static serving.
- Not a practical fit for a full Package Ninja runtime.

### 3. Bun + Hono (+ SQLite index)

Pros:

- Fast startup compared with Node+Verdaccio.
- Stays in JS/TS ecosystem.
- Easier hiring/maintenance path than full Go rewrite for current team shape.

Cons:

- Still requires implementing npm-registry-compatible API surface.
- Bun runtime and node-tooling edge behavior must be validated against npm/pnpm/yarn at scale.
- Not a drop-in replacement for Verdaccio behavior.

Verdict:

- Best “fast runtime” candidate if staying in JS/TS.
- Still a rewrite, not a quick optimization.

## Reality Check on “5–10ms”

For a complete npm-compatible proxy runtime, 5–10ms cold start is generally unrealistic once:

- network listeners and routing are initialized
- metadata index is loaded
- runtime safety hooks are set up

However, users can experience “near-instant” command starts if:

- the registry stays warm between commands
- session reuse is automatic and reliable

In practice, this is the highest impact path with lowest risk.

## Recommended Path (Practical and Safe)

### Phase 1 (now): Reuse-first UX and state clarity

- keep runtime internals stable
- improve command-state visibility (done in this repo)
- default teams to warm-session workflows

### Phase 2: Warm daemon mode (biggest speed gain without rewrite)

- optional background daemon per machine/project
- idle timeout cleanup (for hygiene)
- command flow attaches to daemon in <200ms path

### Phase 3: Runtime v2 exploration (parallel track)

- prototype Bun/Go minimal registry subset behind a compatibility harness
- run against the same selftest matrix and manager-compatibility tests
- migrate only when parity is proven

## Decision Guidance

If priority is shipping speed gains now:

- keep current runtime
- invest in warm-session/daemon behavior and observability

If priority is long-term cold-start optimization:

- start a Runtime v2 track (Bun or Go)
- keep current runtime as stable production baseline until parity is proven

