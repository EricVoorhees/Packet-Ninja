# Changelog

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
