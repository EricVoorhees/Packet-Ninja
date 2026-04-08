# Package Ninja

<p align="center">
  <img src="images/PackageNinjaMainCover.jpg" alt="Package Ninja hero image" width="100%" />
</p>

<p align="center">
  <strong>Zero-config local registry sessions for npm, pnpm, and yarn.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/package-ninja"><img alt="npm version" src="https://img.shields.io/npm/v/package-ninja?style=flat-square" /></a>
  <img alt="node version" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="language typescript" src="https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="registry runtime local" src="https://img.shields.io/badge/registry-local%20runtime-4B5EAA?style=flat-square" />
  <img alt="license mit" src="https://img.shields.io/badge/license-MIT-black?style=flat-square" />
</p>

**Stack:** `TypeScript` `Node.js` `Package Ninja Runtime`  
**Managers:** `npm` `pnpm` `yarn`

Package Ninja is a small CLI that runs normal package-manager commands through a local private registry session, with reliable startup, cleanup, and session reuse behavior.

## At a Glance

- No workflow rewrite: keep using npm, pnpm, and yarn commands.
- Zero-config default path for day-to-day local development.
- Clean lifecycle handling for startup, interruption, and teardown.
- Safe by default: local bind, temporary config injection, guarded publish flow.
- Interactive `dots` spinner during session preparation in TTY terminals.

### Showcase: Where It Shines

- Repeated local command runs with clean session reuse.
- Safer publish workflows with local-registry guardrails.
- Team workflows that need predictable, disposable package environments.

<p align="center">
  <img src="images/packages-3.jpg" alt="Package manager compatibility visual" width="88%" />
</p>

## Quick Start

```bash
npx package-ninja dev
```

That command:

1. Reads `package.json` from your target project.
2. Detects package manager via `--pm`, lockfiles, then npm fallback.
3. Starts or reuses a local registry session.
4. Runs your requested workflow.
5. Cleans up owned ephemeral runtime state.

## Commands

```bash
package-ninja run -- <command>
package-ninja install
package-ninja dev
package-ninja test
package-ninja publish
package-ninja start
package-ninja stop
package-ninja status
package-ninja help
```

`run` is the primitive command. `install`, `dev`, `test`, and `publish` are thin wrappers over the same session contract.

Command examples:

```bash
# Install dependencies through a controlled local session
package-ninja install

# Install and keep the session warm for reuse (fast follow-up commands)
package-ninja install --persistent

# Run dev script with a one-off (ephemeral) session
package-ninja dev

# Force install before dev
package-ninja dev --install

# Run a custom script from a workspace subdirectory
package-ninja dev --script dev:frontend --cwd apps/web

# Pass args through to your test script
package-ninja test -- --watch

# Run a custom command directly
package-ninja run -- npm pack

# Use a persistent session for multiple commands
package-ninja start
package-ninja run -- npm install
package-ninja run -- npm test
package-ninja stop

# Or do the same in one shot, then keep it running
package-ninja test --persistent
# later:
package-ninja test -- --watch
package-ninja stop

# Explicit package-manager command passthrough
package-ninja run -- pnpm test

# Publish using local session rules
package-ninja publish -- --tag next
```

## Key Flags

- `--cwd <path>` target project directory (default: current directory)
- `--pm <npm|pnpm|yarn>` override package-manager detection
- `--script <name>` override script name for `dev` or `test`
- `--install` force install before `dev`
- `--no-install` skip install before `dev`
- `--port <number>` preferred local registry port
- `--persistent` keep a reusable local session
- `--offline` disable npmjs uplink

Scope note: `--script` applies to `dev` and `test`; `--install` and `--no-install` apply to `dev`.

## Speed Notes

- Ephemeral mode optimizes cleanup and safety, but startup has a fixed cost.
- If you run several commands in a row, use `--persistent` on the first command (or `start`) and reuse the same session.
- Session reuse usually gives the biggest practical speed win because registry startup is paid once.
- Detailed performance analysis: [`docs/performance-deep-dive.md`](docs/performance-deep-dive.md)
- Startup architecture options and migration paths: [`docs/startup-architecture-options.md`](docs/startup-architecture-options.md)

### Performance Snapshot (Windows, April 8, 2026)

| Scenario | Direct npm | Package Ninja (ephemeral) | Difference |
| --- | --- | --- | --- |
| small install (1 dep) | ~1.8s | ~4.5s | +~2.7s |
| medium install (8 deps) | ~2.9s | ~7.3s | +~4.4s |

Typical fixed-cost profile per fresh ephemeral run:

- session startup: ~1.7s
- command wrapper/process handoff: ~0.7s to ~1.0s
- session stop: ~0.01s

Back-to-back command demo:

- Two ephemeral installs (small): ~9.0s total
- Warm-session reuse (`--persistent` + second run + `stop`): ~6.4s total
- Net improvement with reuse in that run: ~29%

Plain-language summary:

- The first command pays session startup cost.
- Reuse mode removes most of that repeated startup penalty.

### State Output

Package Ninja now prints explicit phase lines so you always know what is happening and where:

- `State: project.inspecting | command=install | root=...`
- `State: session.preparing | persistent=false | offline=false`
- `State: session.started | registry=http://127.0.0.1:... | mode=ephemeral`
- `State: command.start | name=install | manager=pnpm`
- `State: command.done | name=install | exitCode=0`

Example:

```bash
# First command starts and keeps a session
package-ninja install --persistent

# Follow-up commands reuse it
package-ninja test
package-ninja run -- npm pack

# Clean finish
package-ninja stop
```

## Session and Safety Model

- Registry binds to `127.0.0.1`.
- Ports are local and dynamic unless a preferred port is supplied.
- Temporary runtime storage is used by default for ephemeral sessions.
- Active sessions are reused per project instead of duplicated.
- Owned ephemeral sessions are cleaned up after completion and interruption.
- Manually started sessions are left running when reused by another command.
- `publish` is blocked when `package.json.publishConfig.registry` points to a non-local registry.
- Registry settings are injected via temporary env/userconfig, not global npm config mutation.

## What This Gives You

Package Ninja is not just routing traffic. It gives you a controlled, disposable package environment per run.

1. Isolation
- Package-manager traffic goes through one local control point first.
- Upstream npm access can be disabled with `--offline`.

2. Publish safety
- Publish is routed through session rules instead of global npm config.
- If `publishConfig.registry` points to a non-local target, Package Ninja blocks publish.

3. More deterministic behavior
- A local control layer makes installs easier to repeat and troubleshoot.
- This is useful for repeated runs and dependency debugging.

4. Session lifecycle control
- Ephemeral sessions are created for a run and cleaned up after.
- Persistent sessions are explicit with `start` and `stop`.

5. Consistency across npm, pnpm, and yarn
- Different package managers flow through the same local session model.

6. Better debugging leverage
- Session boundaries make install, script, and publish behavior easier to inspect.

Simple product summary:
- Package Ninja turns package execution from global and unpredictable into local, controlled, and disposable.

What it is not:
- not a replacement for npm, pnpm, or yarn
- not a package manager fork
- not automatic source-code privacy

## Runtime Flow

<p align="center">
  <img src="images/PackageNinjaBreakdown.jpg" alt="Package Ninja architecture and flow breakdown" width="94%" />
</p>

Primary validation command:

```bash
npm test
```

Self-test coverage:

- startup failure cleanup
- readiness-timeout cleanup
- owned interruption cleanup (process and temp-runtime cleanup)
- reused-session interruption behavior
- publish safety for owned and reused sessions
- nonzero child exit propagation and cleanup
- compatibility across npm, pnpm, and yarn

### Reliability Matrix

| Capability | npm | pnpm | yarn |
| --- | --- | --- | --- |
| `install` | live-proven | live-proven | live-proven |
| `dev` | live-proven | live-proven | live-proven |
| `test` | live-proven | live-proven | live-proven |
| `run` | live-proven | live-proven | live-proven |
| passthrough args | live-proven | live-proven | live-proven |
| publish block safety | live-proven | live-proven | live-proven |
| manual session reuse | live-proven | live-proven | live-proven |
| owned failure cleanup | live-proven | live-proven | live-proven |
| interruption cleanup (owned/reused contract) | live-proven | live-proven | live-proven |
| repeated full-suite stability | live-proven | live-proven | live-proven |
| machine hygiene after runs | live-proven | live-proven | live-proven |

Latest confidence pass (local, no manual cleanup between runs, April 8, 2026):

- `node dist/selftest.js` passed 8/8 back-to-back
- `npm test` passed 7/7 back-to-back
- no active Package Ninja worker processes after runs
- no leaked temp runtime directories after runs

## Local Development

```bash
npm install
npm run build
npm test
```

For direct local execution in this repo:

```bash
node dist/cli.js dev --cwd D:/Projects/my-app
node dist/cli.js test --cwd D:/Projects/my-app -- --watch
node dist/cli.js publish --cwd D:/Projects/my-package
```

## Closing Line

Stop trusting global state.  
Run your packages in a controlled environment.
