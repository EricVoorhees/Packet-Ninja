# Package Ninja

<p align="center">
  <img src="images/PackageNinjaMainCover.jpg" alt="Package Ninja hero image" width="100%" />
</p>

<p align="center">
  <strong>Run npm, pnpm, and yarn inside a controlled, disposable local package environment.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/package-ninja"><img alt="npm version" src="https://img.shields.io/npm/v/package-ninja?style=flat-square" /></a>
  <img alt="node version" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="language Go" src="https://img.shields.io/badge/language-Go-00ADD8?style=flat-square&logo=go&logoColor=white" />
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-black?style=flat-square" />
</p>

**Framework tags:** `Node.js` `TypeScript` `Go (optional runner/entry)`  
**Package managers:** `npm` `pnpm` `yarn`

Package Ninja keeps your normal package-manager workflow, but routes execution through a local session lifecycle with explicit startup, safety, cleanup, and reuse behavior.

## Why Package Ninja

- No workflow rewrite: use standard npm/pnpm/yarn commands and scripts.
- Controlled execution layer: commands run through a local registry session.
- Safer publish path: non-local `publishConfig.registry` is blocked by default.
- Clean lifecycle contract: startup, interruption handling, and teardown are enforced.
- Better repeatability: easier to run install/test/publish flows in a predictable environment.

<p align="center">
  <img src="images/packages-3.jpg" alt="Package manager compatibility visual" width="88%" />
</p>

## What Changed Recently (April 2026)

Warm-path reliability was hardened so fast path behavior is stable instead of probabilistic:

- Go entry handshake now uses retry + jitter (`3` attempts, total `30ms` budget).
- Worker validates handshake endpoint responsiveness before marking session ready.
- Startup now clears stale `ready.json` and validates ready payload against current `pid` and `port`.
- `stop`/stale-session cleanup now clears ready markers to prevent stale-ready false positives.
- Added dedicated self-test coverage for immediate repeated `status` checks after `start`.

Result: warm-path checks are now deterministic under repetition, and stale-ready regressions are covered by tests.

## Quick Start

```bash
npx package-ninja dev
```

That run will:

1. detect the project manager (`--pm` override -> lockfile -> npm fallback)
2. create or reuse a local session
3. execute your command through that session
4. clean up owned ephemeral runtime state

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

`run` is the primitive command. `install`, `dev`, `test`, and `publish` are workflow wrappers over the same session contract.

## Command Examples

```bash
# Install dependencies through a local controlled session
package-ninja install

# Keep session warm for follow-up commands
package-ninja install --persistent

# Run dev script in a one-off ephemeral session
package-ninja dev

# Force install before dev
package-ninja dev --install

# Custom script from workspace subdirectory
package-ninja dev --script dev:frontend --cwd apps/web

# Pass args to test script
package-ninja test -- --watch

# Direct command passthrough
package-ninja run -- npm pack

# Manual warm session
package-ninja start
package-ninja run -- npm install
package-ninja run -- npm test
package-ninja stop

# Publish under local session safety rules
package-ninja publish -- --tag next
```

## Key Flags

- `--cwd <path>` project directory (default: current directory)
- `--pm <npm|pnpm|yarn>` package-manager override
- `--script <name>` script override for `dev`/`test`
- `--install` force install before `dev`
- `--no-install` skip install before `dev`
- `--port <number>` preferred local registry port
- `--persistent` keep a reusable session running
- `--offline` disable npmjs uplink

## Speed and Performance

Package Ninja has a fixed per-session overhead on cold ephemeral runs. For repeated commands, session reuse is the primary speed lever.

### Current Snapshot (Windows, April 8, 2026)

Fresh local median samples (`n=3`) with identical install args:

`npm install <deps> --ignore-scripts --no-audit --no-fund`

| Scenario | Direct npm | Package Ninja (ephemeral, Node worker) | Package Ninja (ephemeral, Go worker) |
| --- | --- | --- | --- |
| small install (1 dep) | ~1.4s | ~4.8s | ~4.0s |
| medium install (8 deps) | ~1.7s | ~6.3s | ~4.9s |

Warm persistent follow-up (same project, no-op install, median `n=3`):

- Node worker path: ~2.8s
- Go worker path: ~1.6s

### Where Time Goes (cold ephemeral)

- registry startup: still the largest fixed cost
- command orchestration/handoff: materially reduced by Go worker path
- package-manager work: dependency/network/cache dependent

### Practical Guidance

- Single command: ephemeral is simplest.
- Multiple commands: use `--persistent` or `start`/`stop`.
- Reuse session startup once, then run follow-up commands quickly.

```bash
package-ninja install --persistent
package-ninja test
package-ninja run -- npm pack
package-ninja stop
```

Deep dive docs:

- [`docs/performance-deep-dive.md`](docs/performance-deep-dive.md)
- [`docs/startup-architecture-options.md`](docs/startup-architecture-options.md)
- [`docs/phase2-go-harness-spec.md`](docs/phase2-go-harness-spec.md)
- [`docs/phase3-ares-engine-plan.md`](docs/phase3-ares-engine-plan.md)

## Session States and CLI Output

The CLI prints explicit phase lines so state is always visible:

- `State: project.inspecting | command=install | root=...`
- `State: session.preparing | persistent=false | offline=false`
- `State: session.started | registry=http://127.0.0.1:... | mode=ephemeral`
- `State: command.start | name=install | manager=pnpm`
- `State: command.done | name=install | exitCode=0`

## Reliability Contract

Primary validation command:

```bash
npm test
```

Self-test coverage includes:

- startup failure cleanup
- readiness-timeout cleanup
- status handshake stability after start
- owned interruption cleanup (including runtime-dir cleanup)
- reused-session interruption behavior
- publish safety rules
- non-zero child exit propagation
- npm/pnpm/yarn compatibility

Latest local confidence pass (April 9, 2026):

- `node dist/selftest.js` passed `4/4` back-to-back
- `npm test` passed
- no active Package Ninja sessions after stop
- no stale `ready.json` markers after stop/cleanup

<p align="center">
  <img src="images/PackageNinjaBreakdown.jpg" alt="Package Ninja architecture and flow breakdown" width="94%" />
</p>

## Safety Model

- Registry binds to `127.0.0.1`.
- Session ports are local/dynamic unless you specify `--port`.
- Ephemeral runs use temporary runtime storage and clean it up.
- Persistent sessions are explicit and reusable.
- Global npm config is not mutated.
- Publish is blocked if `publishConfig.registry` is non-local.

## Optional Go Acceleration Path (Phase 2)

Package Ninja can use native Go components for faster orchestration while keeping runtime behavior compatible.

Build binaries:

```bash
make build-go
```

If `make` is unavailable:

```bash
go build -C go/command-worker -o ../../bin/command-worker-go.exe .
go build -C go/ninja -o ../../bin/ninja.exe .
```

Enable Go command worker (current stable opt-in):

```bash
PACKAGE_NINJA_USE_GO_RUNNER=1 node dist/cli.js install --cwd D:/Projects/my-app
```

PowerShell:

```powershell
$env:PACKAGE_NINJA_USE_GO_RUNNER='1'
node dist/cli.js install --cwd D:/Projects/my-app
```

Optional explicit worker path:

```bash
PACKAGE_NINJA_USE_GO_RUNNER=1 PACKAGE_NINJA_GO_WORKER_PATH=D:/PackageNinja/bin/command-worker-go.exe node dist/cli.js test --cwd D:/Projects/my-app
```

Optional native entry binary:

```bash
./bin/ninja.exe install --cwd D:/Projects/my-app
```

If the fast path is unavailable or unhealthy, execution falls back to the Node path.

## V2/V3 Status

- **Phase 2 (Go harness):** complete and reliability-hardened.
- **Current recommendation:** short real-world soak period before starting full registry-engine replacement.
- **Phase 3 (registry core rewrite):** optional next step, not required for current production reliability.

## Local Development

```bash
npm install
npm run build
npm test
```

Direct local execution in this repo:

```bash
node dist/cli.js dev --cwd D:/Projects/my-app
node dist/cli.js test --cwd D:/Projects/my-app -- --watch
node dist/cli.js publish --cwd D:/Projects/my-package
```

## Closing Line

Stop trusting global state.  
Run your packages in a controlled environment.
