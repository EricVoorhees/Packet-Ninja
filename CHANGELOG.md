# Changelog

## 1.1.0 - 2026-04-09

### Ares-only runtime cutover

- Promoted Ares to the only runtime path in session startup, status checks, and command workflows.
- Removed legacy runtime toggle/fallback logic from CLI, workflow, and session orchestration.
- Removed legacy runtime worker/config modules and related contract tests.
- Updated the Go entry binary to use Ares health checks for warm-session fast-path routing.

### Repository and docs cleanup

- Removed legacy runtime npm dependency and regenerated npm/pnpm lockfiles.
- Refreshed README to document the Ares-default contract and professional command examples.
- Updated architecture docs to match current Ares-only runtime behavior.

### Validation snapshot

- `npm run build` passed.
- `npm test` passed (`Self-test passed`).
- Go binaries built successfully for command worker, entry binary, and Ares registry.
- Tracked repository sources/docs contain no legacy runtime references.

## 1.0.0 - 2026-04-08

### Runtime reliability lock

- Hardened startup readiness handling against transient partial file reads.
- Hardened session state reads against transient partial file reads.
- Switched readiness and state writes to atomic file replacement.
- Added an owned-session runtime watchdog to guarantee ephemeral temp-runtime cleanup on hard interruption.
- Expanded interruption self-test coverage to assert no leaked temp runtime directories after owned interruption scenarios.

### CLI and docs polish

- Polished CLI `help` output and command/flag descriptions.
- Normalized top-level error formatting for cleaner user-facing output.
- Aligned command workflow messages to consistent wording.
- Refreshed README and proof matrix to match the locked reliability contract and compatibility guarantees.

### Validation snapshot

- `node dist/selftest.js` passed 8/8 back-to-back.
- `npm test` passed 7/7 back-to-back.
- Post-run checks confirmed no active Package Ninja worker processes.
- Post-run checks confirmed no leaked temp runtime directories.
