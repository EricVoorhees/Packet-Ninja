# Package Ninja

<p align="center">
  <img src="images/PackageNinjaMainCover.jpg" alt="Package Ninja hero image" width="100%" />
</p>

<p align="center">
  <strong>Run npm, pnpm, and yarn in a controlled, disposable package environment.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/package-ninja"><img alt="npm version" src="https://img.shields.io/npm/v/package-ninja?style=flat-square" /></a>
  <img alt="node version" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="language TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="language Go" src="https://img.shields.io/badge/language-Go-00ADD8?style=flat-square&logo=go&logoColor=white" />
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-black?style=flat-square" />
</p>

**Framework tags:** `Node.js` `TypeScript` `Go`  
**Package managers:** `npm` `pnpm` `yarn`

Package Ninja keeps your existing package-manager workflow and runs it through the native Ares local runtime, with explicit startup, cleanup, and reuse behavior.

## Why teams use it

- **Isolation:** installs and publishes run through local runtime sessions, not your global machine state.
- **Safety:** non-local `publishConfig.registry` is blocked by default.
- **Determinism:** repeated install/test flows are more reproducible under session control.
- **Clean lifecycle:** interruption and failure cleanup are enforced.
- **Cross-manager consistency:** npm, pnpm, and yarn all route through one runtime layer.
- **Debug visibility:** session state and parity outputs are inspectable.

<p align="center">
  <img src="images/packages-3.jpg" alt="Package manager compatibility visual" width="88%" />
</p>

## Quick start

```bash
npx package-ninja dev
```

That command:
1. detects your package manager (`--pm` override -> lockfile -> npm fallback)
2. starts or reuses a local Ares session
3. runs your command through that session
4. cleans owned ephemeral state

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

## Command examples

```bash
# install through a controlled local session
package-ninja install

# keep session warm for follow-up commands
package-ninja install --persistent

# run default dev script
package-ninja dev

# force install before dev
package-ninja dev --install

# skip install before dev
package-ninja dev --no-install

# run custom script from subdirectory
package-ninja dev --script dev:frontend --cwd apps/web

# pass args through to test
package-ninja test -- --watch

# run a direct command through the same session model
package-ninja run -- npm pack

# manual warm session lifecycle
package-ninja start
package-ninja run -- npm install
package-ninja run -- npm test
package-ninja stop

# publish with local safety checks
package-ninja publish -- --tag next

# optional Ares parity shadow target
package-ninja install --ares-shadow-url https://registry.npmjs.org

# strict parity gate (fails on parity mismatches)
package-ninja install --ares-shadow-url https://registry.npmjs.org --ares-strict-parity
```

## Flags

- `--cwd <path>` target project directory (default: current directory)
- `--pm <npm|pnpm|yarn>` package-manager override
- `--script <name>` script override for `dev` and `test`
- `--install` force install before `dev`
- `--no-install` skip install before `dev`
- `--ares-shadow-url <url>` optional shadow target for parity probes
- `--ares-strict-parity` fail command execution when parity checks fail
- `--port <number>` preferred local registry port
- `--persistent` keep a reusable session running
- `--offline` disable npmjs uplink

## Safety model

- Local bind only (`127.0.0.1`)
- Ephemeral runtime dirs cleaned after owned session completion
- Persistent sessions are explicit (`--persistent` or `start`)
- Global npm config is not mutated
- Publish is blocked when `publishConfig.registry` points to a non-local target

## Ares parity and stats

When `--ares-shadow-url` is set, Package Ninja writes parity results to:

`<project-root>/.package-ninja/parity-report.json`

When a session is running, runtime stats are available at:

`GET <registry-url>/-/stats`

This includes upstream totals and collapse metrics for metadata/tarball routes.

<p align="center">
  <img src="images/PackageNinjaBreakdown.jpg" alt="Package Ninja architecture and flow breakdown" width="94%" />
</p>

## Reliability status

The reliability test harness covers:

- startup/teardown behavior
- interruption cleanup (owned and reused sessions)
- package-manager compatibility
- publish safety checks
- repeated session state checks

Run the full reliability suite:

```bash
npm test
```

## Local development

```bash
npm install
npm run build
npm test
```

## Release and publish

Use the publish runbook:

`docs/NPM_PUBLISH.md`

Optional Go builds:

```bash
make build-go
```

If `make` is unavailable:

```bash
go build -C go/command-worker -o ../../bin/command-worker-go.exe .
go build -C go/ninja -o ../../bin/ninja.exe .
go build -C go/ares -o ../../bin/ares-registry.exe ./cmd/ares-registry
```

## Closing line

Stop trusting global state.  
Run your packages in a controlled environment.
