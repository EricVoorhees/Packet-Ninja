import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseCommand } from "./cli.js";
import { buildRegistryConfig } from "./config.js";
import {
  buildInstallCommand,
  buildPublishCommand,
  buildScriptCommand,
  decideInstallBeforeDev,
  ensureSafePublishRegistry,
  loadProjectContext,
  resolveScriptName
} from "./project.js";
import { readState, resolveProjectPaths } from "./state.js";

type Manager = "npm" | "pnpm" | "yarn";
type CliSignal = "SIGINT" | "SIGTERM";

interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

interface InterruptResult extends CliResult {
  timedOut: boolean;
}

function assertCliExitCode(result: CliResult, expectedExitCode: number, label: string): void {
  if (result.exitCode === expectedExitCode) {
    return;
  }

  const output = result.output.trim().length > 0 ? result.output : "<no output>";
  assert.fail(`${label} expected exit code ${expectedExitCode}, received ${result.exitCode}.\n${output}`);
}

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const WORKER_MODE_ENV = "PACKAGE_NINJA_INTERNAL_WORKER_MODE";
const READY_TIMEOUT_ENV = "PACKAGE_NINJA_INTERNAL_READY_TIMEOUT_MS";
const OWNED_SESSION_PID_ENV = "PACKAGE_NINJA_INTERNAL_OWNED_SESSION_PID_PATH";
const COMMAND_WORKER_PID_ENV = "PACKAGE_NINJA_INTERNAL_COMMAND_WORKER_PID_PATH";
const SELFTEST_READY_ENV = "PACKAGE_NINJA_SELFTEST_READY_PATH";
const SELFTEST_APP_PID_ENV = "PACKAGE_NINJA_SELFTEST_APP_PID_PATH";

async function main(): Promise<void> {
  await runConfigContractTests();
  await runProjectContractTests();
  await runRuntimeSmokeTests();
  console.log("Self-test passed.");
}

async function runConfigContractTests(): Promise<void> {
  const online = buildRegistryConfig({
    runtimeDir: "/tmp/package-ninja",
    storageDir: "/tmp/package-ninja/storage",
    port: 4873,
    offline: false
  });

  assert.deepEqual(online.uplinks, {
    npmjs: {
      url: "https://registry.npmjs.org/"
    }
  });
  assert.equal((online.middlewares as { audit: { enabled: boolean } }).audit.enabled, true);

  const offline = buildRegistryConfig({
    runtimeDir: "/tmp/package-ninja",
    storageDir: "/tmp/package-ninja/storage",
    port: 4873,
    offline: true
  });

  assert.deepEqual(offline.uplinks, {});
  assert.equal((offline.middlewares as { audit: { enabled: boolean } }).audit.enabled, false);
  assert.deepEqual((offline.packages as Record<string, Record<string, string>>)["**"], {
    access: "$all",
    publish: "$all",
    unpublish: "$all"
  });
}

async function runProjectContractTests(): Promise<void> {
  const tempRoot = path.join(os.tmpdir(), `package-ninja-contract-${Date.now()}`);
  await mkdir(tempRoot, { recursive: true });

  try {
    const fixture = path.join(tempRoot, "fixture");
    await createProjectFixture(fixture, "pnpm", {
      packageManagerField: "pnpm@9.0.0",
      dependencies: {
        leftpad: "1.3.0"
      },
      scripts: {
        dev: "vite",
        test: "vitest"
      }
    });

    const project = await loadProjectContext(fixture);
    assert.equal(project.packageManager, "pnpm");
    assert.equal(project.packageManagerSource, "pnpm-lock.yaml");
    assert.equal(resolveScriptName(project, "dev"), "dev");
    assert.equal(resolveScriptName(project, "test"), "test");
    assert.equal(decideInstallBeforeDev(project, "auto").shouldInstall, true);
    assert.deepEqual(buildScriptCommand(project, "test", ["--watch"], "test"), {
      command: "pnpm",
      args: ["test", "--watch"]
    });
    assert.deepEqual(buildInstallCommand(project, []), {
      command: "pnpm",
      args: ["install"]
    });
    assert.deepEqual(buildPublishCommand(project, []), {
      command: "pnpm",
      args: ["publish"]
    });
    assert.doesNotThrow(() => ensureSafePublishRegistry(project, "http://127.0.0.1:4873"));
    assert.throws(
      () =>
        ensureSafePublishRegistry(
          {
            ...project,
            packageJson: {
              ...project.packageJson,
              publishConfig: {
                registry: "https://registry.npmjs.org/"
              }
            }
          },
          "http://127.0.0.1:4873"
        ),
      /Package Ninja will not publish to a non-local registry/
    );

    await mkdir(path.join(fixture, "node_modules"), { recursive: true });
    const hydratedProject = await loadProjectContext(fixture);
    assert.equal(decideInstallBeforeDev(hydratedProject, "auto").shouldInstall, false);

    const missingPackageJson = path.join(tempRoot, "missing-package-json");
    await mkdir(missingPackageJson, { recursive: true });
    await assert.rejects(() => loadProjectContext(missingPackageJson), /No package\.json found in this directory\./);

    const emptyProject = path.join(tempRoot, "empty-project");
    await createProjectFixture(emptyProject, "npm", {
      lockfile: false
    });
    const emptyProjectContext = await loadProjectContext(emptyProject);
    assert.equal(emptyProjectContext.hasDeclaredDependencies, false);
    assert.equal(decideInstallBeforeDev(emptyProjectContext, "auto").shouldInstall, true);

    const onlyTestProject = path.join(tempRoot, "only-test");
    await createProjectFixture(onlyTestProject, "npm", {
      replaceScripts: true,
      scripts: {
        test: "node -p process.env.PACKAGE_NINJA_REGISTRY_URL"
      }
    });
    const onlyTestContext = await loadProjectContext(onlyTestProject);
    assert.equal(resolveScriptName(onlyTestContext, "test"), "test");
    assert.throws(() => resolveScriptName(onlyTestContext, "dev"), /No "dev" script found in package\.json\./);

    const customScriptProject = path.join(tempRoot, "custom-script");
    await createProjectFixture(customScriptProject, "npm", {
      replaceScripts: true,
      scripts: {
        "dev:frontend": "node -p process.env.PACKAGE_NINJA_REGISTRY_URL"
      }
    });
    const customScriptContext = await loadProjectContext(customScriptProject);
    assert.equal(resolveScriptName(customScriptContext, "dev", "dev:frontend"), "dev:frontend");
    assert.equal(
      decideInstallBeforeDev(customScriptContext, "never").message,
      "Dependencies: skipping install because --no-install was provided."
    );

    const zeroDependencyProject = path.join(tempRoot, "zero-dependency");
    await createProjectFixture(zeroDependencyProject, "npm", {
      lockfile: false,
      scripts: {
        dev: "node -p process.env.PACKAGE_NINJA_REGISTRY_URL"
      }
    });
    const zeroDependencyContext = await loadProjectContext(zeroDependencyProject);
    assert.equal(
      decideInstallBeforeDev(zeroDependencyContext, "auto").message,
      "Dependencies: installing because no recognized lockfile was found."
    );
    await writeFile(path.join(zeroDependencyProject, "package-lock.json"), '{"name":"zero-dependency","lockfileVersion":3}\n', "utf8");
    const zeroDependencyHydrated = await loadProjectContext(zeroDependencyProject);
    assert.equal(decideInstallBeforeDev(zeroDependencyHydrated, "auto").message, "Dependencies: up to date.");

    const mismatchProject = path.join(tempRoot, "mismatch");
    await createProjectFixture(mismatchProject, "pnpm", {
      scripts: {
        test: "node -p process.env.npm_config_user_agent"
      }
    });
    const mismatchContext = await loadProjectContext(mismatchProject, "npm");
    assert.equal(mismatchContext.packageManager, "npm");
    assert.equal(mismatchContext.packageManagerSource, "override");
    assert.deepEqual(buildScriptCommand(mismatchContext, "test", ["--watch"], "test"), {
      command: "npm",
      args: ["test", "--", "--watch"]
    });
    assert.deepEqual(buildScriptCommand(mismatchContext, "dev:api", ["--host"], "dev"), {
      command: "npm",
      args: ["run", "dev:api", "--", "--host"]
    });

    const npmProject = path.join(tempRoot, "npm-project");
    await createProjectFixture(npmProject, "npm");
    const npmContext = await loadProjectContext(npmProject);
    assert.equal(npmContext.packageManager, "npm");
    assert.equal(npmContext.packageManagerSource, "package-lock.json");
    assert.deepEqual(buildInstallCommand(npmContext, ["--ignore-scripts"]), {
      command: "npm",
      args: ["install", "--ignore-scripts"]
    });

    const yarnProject = path.join(tempRoot, "yarn-project");
    await createProjectFixture(yarnProject, "yarn", {
      packageManagerField: "yarn@4.2.2",
      scripts: {
        dev: "node dev.js",
        test: "node test.js",
        "dev:frontend": "node frontend.js"
      }
    });
    const yarnContext = await loadProjectContext(yarnProject);
    assert.equal(yarnContext.packageManager, "yarn");
    assert.equal(yarnContext.packageManagerSource, "yarn.lock");
    assert.deepEqual(buildInstallCommand(yarnContext, ["--immutable"]), {
      command: "yarn",
      args: ["install", "--immutable"]
    });
    assert.deepEqual(buildScriptCommand(yarnContext, "test", ["--watch"], "test"), {
      command: "yarn",
      args: ["test", "--watch"]
    });
    assert.deepEqual(buildScriptCommand(yarnContext, "dev:frontend", ["--host"], "dev"), {
      command: "yarn",
      args: ["run", "dev:frontend", "--host"]
    });
    assert.deepEqual(buildPublishCommand(yarnContext, ["--tag", "next"]), {
      command: "yarn",
      args: ["npm", "publish", "--tag", "next"]
    });

    const yarnClassicProject = path.join(tempRoot, "yarn-classic");
    await createProjectFixture(yarnClassicProject, "yarn", {
      packageManagerField: "yarn@1.22.22"
    });
    const yarnClassicContext = await loadProjectContext(yarnClassicProject);
    assert.deepEqual(buildPublishCommand(yarnClassicContext, []), {
      command: "yarn",
      args: ["publish"]
    });

    const publishFailureProject = path.join(tempRoot, "publish-failure");
    await createProjectFixture(publishFailureProject, "npm", {
      publishConfig: {
        registry: "https://registry.npmjs.org/"
      }
    });
    const publishFailureContext = await loadProjectContext(publishFailureProject);
    assert.throws(
      () => ensureSafePublishRegistry(publishFailureContext, "http://127.0.0.1:4873"),
      /Package Ninja will not publish to a non-local registry/
    );

    const parseFixture = path.join(tempRoot, "parse-fixture");
    await createProjectFixture(parseFixture, "npm", {
      scripts: {
        dev: "node server.js",
        test: "node test.js"
      }
    });

    assert.deepEqual(parseCommand(["dev", "--cwd", parseFixture, "--script", "dev", "--install"]), {
      command: "dev",
      rootDir: path.resolve(parseFixture),
      persistent: false,
      offline: false,
      packageManager: undefined,
      scriptName: "dev",
      installMode: "always",
      port: undefined,
      childCommand: undefined,
      childArgs: []
    });

    assert.deepEqual(parseCommand(["test", "--cwd", parseFixture, "--pm", "pnpm", "--", "--watch"]), {
      command: "test",
      rootDir: path.resolve(parseFixture),
      persistent: false,
      offline: false,
      packageManager: "pnpm",
      scriptName: undefined,
      installMode: "auto",
      port: undefined,
      childCommand: undefined,
      childArgs: ["--watch"]
    });

    assert.throws(() => parseCommand(["test", "--install"]), /only apply to `package-ninja dev`/);
    assert.throws(
      () => parseCommand(["install", "--script", "build"]),
      /only applies to `package-ninja dev` and `package-ninja test`/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runRuntimeSmokeTests(): Promise<void> {
  console.log("Self-test: runtime smoke");
  const smokeRoot = path.join(os.tmpdir(), `package-ninja-runtime-${Date.now()}`);
  await mkdir(smokeRoot, { recursive: true });

  try {
    const npmBase = path.join(smokeRoot, "npm-base");
    await createProjectFixture(npmBase, "npm");

    const npmFail = path.join(smokeRoot, "npm-fail");
    await createProjectFixture(npmFail, "npm", {
      scripts: {
        test: "node fail.js"
      }
    });

    const npmBlockedPublish = path.join(smokeRoot, "npm-blocked-publish");
    await createProjectFixture(npmBlockedPublish, "npm", {
      publishConfig: {
        registry: "https://registry.npmjs.org/"
      }
    });

    const npmInterrupt = path.join(smokeRoot, "npm-interrupt");
    await createProjectFixture(npmInterrupt, "npm", {
      scripts: {
        dev: "node hold.js",
        test: "node hold.js",
        preinstall: "node hold.js"
      }
    });

    const pnpmBase = path.join(smokeRoot, "pnpm-base");
    await createProjectFixture(pnpmBase, "pnpm");

    const pnpmFail = path.join(smokeRoot, "pnpm-fail");
    await createProjectFixture(pnpmFail, "pnpm", {
      scripts: {
        test: "node fail.js"
      }
    });

    const pnpmBlockedPublish = path.join(smokeRoot, "pnpm-blocked-publish");
    await createProjectFixture(pnpmBlockedPublish, "pnpm", {
      publishConfig: {
        registry: "https://registry.npmjs.org/"
      }
    });

    const yarnBase = path.join(smokeRoot, "yarn-base");
    await createProjectFixture(yarnBase, "yarn");

    const yarnFail = path.join(smokeRoot, "yarn-fail");
    await createProjectFixture(yarnFail, "yarn", {
      scripts: {
        test: "node fail.js"
      }
    });

    const yarnBlockedPublish = path.join(smokeRoot, "yarn-blocked-publish");
    await createProjectFixture(yarnBlockedPublish, "yarn", {
      publishConfig: {
        registry: "https://registry.npmjs.org/"
      }
    });

    await proveFailureSafety(npmBase, npmFail);
    await proveStatusHandshakeStability(npmBase);
    await proveOwnedInterruptionCleanup(npmInterrupt);
    await proveReusedInterruptionCleanup(npmInterrupt);
    await proveManagerCompatibility(smokeRoot, npmBase, pnpmBase, yarnBase, pnpmFail, yarnFail);
    await provePublishSafety(npmBlockedPublish, pnpmBlockedPublish, yarnBlockedPublish);
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function proveFailureSafety(npmBase: string, npmFail: string): Promise<void> {
  console.log("Self-test: failure safety");
  const workerFailure = runCli(["start", "--cwd", npmBase], {
    env: {
      [WORKER_MODE_ENV]: "fail"
    }
  });
  assert.notEqual(workerFailure.exitCode, 0);
  assert.match(workerFailure.output, /Registry worker exited before signaling readiness|Failed to start Package Ninja session/);
  await assertSessionCleared(npmBase);

  const timeoutFailure = runCli(["start", "--cwd", npmBase], {
    env: {
      [WORKER_MODE_ENV]: "stall-ready",
      [READY_TIMEOUT_ENV]: "1000"
    }
  });
  assert.notEqual(timeoutFailure.exitCode, 0);
  assert.match(timeoutFailure.output, /Registry readiness timed out|Failed to start Package Ninja session/);
  await assertSessionCleared(npmBase);

  const failedTest = runCli(["test", "--cwd", npmFail]);
  assert.equal(failedTest.exitCode, 7);
  await assertSessionCleared(npmFail);

  const failedRun = runCli(["run", "--cwd", npmFail, "--", "node", "fail.js"]);
  assert.equal(failedRun.exitCode, 7);
  await assertSessionCleared(npmFail);
}

async function proveStatusHandshakeStability(projectDir: string): Promise<void> {
  console.log("Self-test: status handshake stability");
  const startResult = runCli(["start", "--cwd", projectDir]);
  assert.equal(startResult.exitCode, 0);
  await waitForSessionRunning(projectDir);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = runCli(["status", "--cwd", projectDir]);
    assert.match(status.output, /Package Ninja active/);
  }

  const stopResult = runCli(["stop", "--cwd", projectDir]);
  assert.equal(stopResult.exitCode, 0);
  await assertSessionCleared(projectDir);
}

async function proveOwnedInterruptionCleanup(npmInterrupt: string): Promise<void> {
  console.log("Self-test: owned interruption cleanup");
  for (const scenario of [
    {
      label: "dev",
      args: ["dev", "--cwd", npmInterrupt, "--no-install"]
    },
    {
      label: "test",
      args: ["test", "--cwd", npmInterrupt]
    },
    {
      label: "install",
      args: ["install", "--cwd", npmInterrupt]
    },
    {
      label: "run",
      args: ["run", "--cwd", npmInterrupt, "--", "node", "hold.js"]
    }
  ]) {
    const beforeRuntimeDirs = await listTempRuntimeDirNames();
    const probe = await createInterruptProbe(npmInterrupt, scenario.label);
    const interrupted = await spawnCliAndInterrupt(scenario.args, npmInterrupt, {
      readinessPath: probe.readyPath,
      env: {
        [SELFTEST_READY_ENV]: probe.readyPath,
        [SELFTEST_APP_PID_ENV]: probe.appPidPath,
        [COMMAND_WORKER_PID_ENV]: probe.workerPidPath,
        [OWNED_SESSION_PID_ENV]: probe.sessionPidPath
      }
    });

    assert.notEqual(interrupted.exitCode, 0);
    assert.equal(interrupted.timedOut, false);
    await assertSessionCleared(npmInterrupt);
    await assertPidStoppedFromFile(probe.appPidPath, `${scenario.label} app child`);
    await assertPidStoppedFromFile(probe.workerPidPath, `${scenario.label} command worker`);
    await assertPidStoppedFromFile(probe.sessionPidPath, `${scenario.label} registry worker`);
    await assertDirectoryUnlocked(npmInterrupt);
    await assertNoLeakedTempRuntimeDirs(beforeRuntimeDirs, `${scenario.label} interruption`);
  }
}

async function proveReusedInterruptionCleanup(npmInterrupt: string): Promise<void> {
  console.log("Self-test: reused interruption cleanup");
  const startResult = runCli(["start", "--cwd", npmInterrupt]);
  assert.equal(startResult.exitCode, 0);
  await waitForSessionRunning(npmInterrupt);
  const runningState = await readState(resolveProjectPaths(npmInterrupt).statePath);
  assert.notEqual(runningState, null);
  const registryPid = runningState!.pid;

  const probe = await createInterruptProbe(npmInterrupt, "reused-dev");
  const reusedInterrupt = await spawnCliAndInterrupt(["dev", "--cwd", npmInterrupt, "--no-install"], npmInterrupt, {
    expectReuse: true,
    readinessPath: probe.readyPath,
    env: {
      [SELFTEST_READY_ENV]: probe.readyPath,
      [SELFTEST_APP_PID_ENV]: probe.appPidPath,
      [COMMAND_WORKER_PID_ENV]: probe.workerPidPath
    }
  });
  assert.notEqual(reusedInterrupt.exitCode, 0);
  assert.equal(reusedInterrupt.timedOut, false);
  await assertSessionRunning(npmInterrupt);
  await assertPidStoppedFromFile(probe.appPidPath, "reused app child");
  await assertPidStoppedFromFile(probe.workerPidPath, "reused command worker");
  await assertPidRunning(registryPid, "reused registry worker");

  const stopResult = runCli(["stop", "--cwd", npmInterrupt]);
  assert.equal(stopResult.exitCode, 0);
  await assertSessionCleared(npmInterrupt);
  await assertPidStopped(registryPid, "reused registry worker after stop");
}

async function proveManagerCompatibility(
  smokeRoot: string,
  npmBase: string,
  pnpmBase: string,
  yarnBase: string,
  pnpmFail: string,
  yarnFail: string
): Promise<void> {
  console.log("Self-test: package manager compatibility");
  const npmInstall = runCli(["install", "--cwd", npmBase]);
  assertCliExitCode(npmInstall, 0, "npm install");
  await assertSessionCleared(npmBase);

  const npmDev = runCli(["dev", "--cwd", npmBase, "--no-install"]);
  assertCliExitCode(npmDev, 0, "npm dev");
  assert.match(npmDev.output, /http:\/\/127\.0\.0\.1:/);
  await assertSessionCleared(npmBase);

  const npmTest = runCli(["test", "--cwd", npmBase, "--", "--watch"]);
  assertCliExitCode(npmTest, 0, "npm test");
  assert.match(npmTest.output, /--watch/);
  await assertSessionCleared(npmBase);

  const npmRun = runCli(["run", "--cwd", npmBase, "--", "node", "registry.js"]);
  assertCliExitCode(npmRun, 0, "npm run");
  assert.match(npmRun.output, /http:\/\/127\.0\.0\.1:/);
  await assertSessionCleared(npmBase);

  const npmReuseStart = runCli(["start", "--cwd", npmBase]);
  assertCliExitCode(npmReuseStart, 0, "npm reuse start");
  await waitForSessionRunning(npmBase);
  const npmReuseTest = runCli(["test", "--cwd", npmBase, "--", "--watch"]);
  assertCliExitCode(npmReuseTest, 0, "npm reuse test");
  assert.match(npmReuseTest.output, /Reusing active registry session/);
  await assertSessionRunning(npmBase);
  const npmReuseStop = runCli(["stop", "--cwd", npmBase]);
  assertCliExitCode(npmReuseStop, 0, "npm reuse stop");
  await assertSessionCleared(npmBase);

  const pnpmDev = runCli(["dev", "--cwd", pnpmBase, "--no-install"]);
  assertCliExitCode(pnpmDev, 0, "pnpm dev");
  assert.match(pnpmDev.output, /http:\/\/127\.0\.0\.1:/);
  await assertSessionCleared(pnpmBase);

  const pnpmTest = runCli(["test", "--cwd", pnpmBase, "--", "--watch"]);
  assertCliExitCode(pnpmTest, 0, "pnpm test");
  assert.match(pnpmTest.output, /--watch/);
  await assertSessionCleared(pnpmBase);

  const pnpmRun = runCli(["run", "--cwd", pnpmBase, "--", "node", "registry.js"]);
  assertCliExitCode(pnpmRun, 0, "pnpm run");
  await assertSessionCleared(pnpmBase);

  const pnpmFailure = runCli(["test", "--cwd", pnpmFail]);
  assertCliExitCode(pnpmFailure, 7, "pnpm intentional failure");
  await assertSessionCleared(pnpmFail);

  const pnpmReuseStart = runCli(["start", "--cwd", pnpmBase]);
  assertCliExitCode(pnpmReuseStart, 0, "pnpm reuse start");
  await waitForSessionRunning(pnpmBase);
  const pnpmReuseTest = runCli(["test", "--cwd", pnpmBase, "--", "--watch"]);
  assertCliExitCode(pnpmReuseTest, 0, "pnpm reuse test");
  assert.match(pnpmReuseTest.output, /Reusing active registry session/);
  await assertSessionRunning(pnpmBase);
  const pnpmReuseStop = runCli(["stop", "--cwd", pnpmBase]);
  assertCliExitCode(pnpmReuseStop, 0, "pnpm reuse stop");
  await assertSessionCleared(pnpmBase);

  const directPnpmInstall = runDirectPackageManager("pnpm", ["install", "--store-dir", ".pnpm-store"], pnpmBase);
  const packageNinjaPnpmInstall = runCli(["install", "--cwd", pnpmBase, "--", "--store-dir", ".pnpm-store"]);
  assertCliExitCode(directPnpmInstall, 0, "direct pnpm install");
  assertCliExitCode(packageNinjaPnpmInstall, 0, "package-ninja pnpm install");
  await assertSessionCleared(pnpmBase);

  const yarnInstall = runCli(["install", "--cwd", yarnBase]);
  assertCliExitCode(yarnInstall, 0, "yarn install");
  await assertSessionCleared(yarnBase);

  const yarnDev = runCli(["dev", "--cwd", yarnBase, "--no-install"]);
  assertCliExitCode(yarnDev, 0, "yarn dev");
  assert.match(yarnDev.output, /http:\/\/127\.0\.0\.1:/);
  await assertSessionCleared(yarnBase);

  const yarnTest = runCli(["test", "--cwd", yarnBase, "--", "--watch"]);
  assertCliExitCode(yarnTest, 0, "yarn test");
  assert.match(yarnTest.output, /--watch/);
  await assertSessionCleared(yarnBase);

  const yarnRun = runCli(["run", "--cwd", yarnBase, "--", "node", "registry.js"]);
  assertCliExitCode(yarnRun, 0, "yarn run");
  await assertSessionCleared(yarnBase);

  const yarnFailure = runCli(["test", "--cwd", yarnFail]);
  assertCliExitCode(yarnFailure, 7, "yarn intentional failure");
  await assertSessionCleared(yarnFail);

  const yarnReuseStart = runCli(["start", "--cwd", yarnBase]);
  assertCliExitCode(yarnReuseStart, 0, "yarn reuse start");
  await waitForSessionRunning(yarnBase);
  const yarnReuseTest = runCli(["test", "--cwd", yarnBase, "--", "--watch"]);
  assertCliExitCode(yarnReuseTest, 0, "yarn reuse test");
  assert.match(yarnReuseTest.output, /Reusing active registry session/);
  await assertSessionRunning(yarnBase);
  const yarnReuseStop = runCli(["stop", "--cwd", yarnBase]);
  assertCliExitCode(yarnReuseStop, 0, "yarn reuse stop");
  await assertSessionCleared(yarnBase);

  const proofMatrixPath = path.join(smokeRoot, "proof-matrix-check.txt");
  await writeFile(proofMatrixPath, "runtime smoke complete\n", "utf8");
}

async function provePublishSafety(npmBlockedPublish: string, pnpmBlockedPublish: string, yarnBlockedPublish: string): Promise<void> {
  console.log("Self-test: publish safety");
  const npmOwned = runCli(["publish", "--cwd", npmBlockedPublish]);
  assert.equal(npmOwned.exitCode, 1);
  assert.match(npmOwned.output, /publishConfig\.registry|Publish blocked/);
  await assertSessionCleared(npmBlockedPublish);

  const pnpmOwned = runCli(["publish", "--cwd", pnpmBlockedPublish]);
  assert.equal(pnpmOwned.exitCode, 1);
  assert.match(pnpmOwned.output, /publishConfig\.registry|Publish blocked/);
  await assertSessionCleared(pnpmBlockedPublish);

  const yarnOwned = runCli(["publish", "--cwd", yarnBlockedPublish]);
  assert.equal(yarnOwned.exitCode, 1);
  assert.match(yarnOwned.output, /publishConfig\.registry|Publish blocked/);
  await assertSessionCleared(yarnBlockedPublish);

  await proveBlockedPublishReuse(npmBlockedPublish);
  await proveBlockedPublishReuse(pnpmBlockedPublish);
  await proveBlockedPublishReuse(yarnBlockedPublish);
}

async function proveBlockedPublishReuse(projectDir: string): Promise<void> {
  const startResult = runCli(["start", "--cwd", projectDir]);
  assert.equal(startResult.exitCode, 0);
  await waitForSessionRunning(projectDir);

  const publishResult = runCli(["publish", "--cwd", projectDir]);
  assert.equal(publishResult.exitCode, 1);
  assert.match(publishResult.output, /Reusing active registry session/);
  await assertSessionRunning(projectDir);

  const stopResult = runCli(["stop", "--cwd", projectDir]);
  assert.equal(stopResult.exitCode, 0);
  await assertSessionCleared(projectDir);
}

async function createProjectFixture(
  projectDir: string,
  manager: Manager,
  options: {
    packageManagerField?: string;
    dependencies?: Record<string, string>;
    publishConfig?: { registry?: string };
    scripts?: Record<string, string>;
    lockfile?: boolean;
    replaceScripts?: boolean;
  } = {}
): Promise<void> {
  await mkdir(projectDir, { recursive: true });

  const defaultScripts = {
    dev: "node registry.js",
    test: "node args.js"
  };

  const packageJson = {
    name: path.basename(projectDir),
    version: "1.0.0",
    ...(options.packageManagerField ? { packageManager: options.packageManagerField } : {}),
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.publishConfig ? { publishConfig: options.publishConfig } : {}),
    scripts: options.replaceScripts ? (options.scripts ?? {}) : { ...defaultScripts, ...(options.scripts ?? {}) }
  };

  await writeFile(path.join(projectDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(projectDir, "registry.js"), "console.log(process.env.PACKAGE_NINJA_REGISTRY_URL)\n", "utf8");
  await writeFile(path.join(projectDir, "args.js"), "console.log(process.argv.slice(2).join(' '))\n", "utf8");
  await writeFile(path.join(projectDir, "fail.js"), "process.exit(7)\n", "utf8");
  await writeFile(
    path.join(projectDir, "hold.js"),
    [
      "const fs = require('node:fs');",
      "const readyPath = process.env.PACKAGE_NINJA_SELFTEST_READY_PATH;",
      "const pidPath = process.env.PACKAGE_NINJA_SELFTEST_APP_PID_PATH;",
      "if (pidPath) { fs.writeFileSync(pidPath, `${process.pid}\\n`, 'utf8'); }",
      "if (readyPath) { fs.writeFileSync(readyPath, 'ready\\n', 'utf8'); }",
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );

  if (options.lockfile !== false) {
    if (manager === "npm") {
      await writeFile(path.join(projectDir, "package-lock.json"), `{"name":"${path.basename(projectDir)}","lockfileVersion":3}\n`, "utf8");
    }

    if (manager === "pnpm") {
      await writeFile(path.join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    }

    if (manager === "yarn") {
      await writeFile(path.join(projectDir, "yarn.lock"), "# yarn lockfile\n", "utf8");
    }
  }
}

function runCli(args: string[], options: RunCliOptions = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {})
    },
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    output: `${stdout}${stderr}`
  };
}

function runDirectPackageManager(command: string, args: string[], cwd: string): CliResult {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    output: `${stdout}${stderr}`
  };
}

async function spawnCliAndInterrupt(
  args: string[],
  projectDir: string,
  options: {
    expectReuse?: boolean;
    env?: NodeJS.ProcessEnv;
    readinessPath?: string;
    signal?: CliSignal;
  } = {}
): Promise<InterruptResult> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  if (options.expectReuse) {
    await waitForOutput(() => `${stdout}${stderr}`, /Reusing active registry session/, 8_000);
  }

  if (options.readinessPath) {
    await waitForPathOrChildExit(options.readinessPath, child, () => `${stdout}${stderr}`, 8_000);
  } else if (!options.expectReuse) {
    await waitForSessionRunningOrChildExit(projectDir, child, () => `${stdout}${stderr}`, 8_000);
  }

  child.kill(options.signal ?? "SIGINT");
  const { code, timedOut } = await waitForChildExit(child, 8_000);
  if (timedOut && child.pid) {
    child.kill("SIGTERM");
    await waitForChildExit(child, 2_000);
  }

  await delay(300);

  return {
    exitCode: code ?? 1,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
    timedOut
  };
}

async function waitForOutput(getOutput: () => string, pattern: RegExp, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(getOutput())) {
      return;
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for output matching ${pattern}. Current output:\n${getOutput()}`);
}

async function waitForChildExit(
  child: import("node:child_process").ChildProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const exitPromise = once(child, "exit").then(([code, signal]) => {
    exitCode = (code as number | null) ?? null;
    exitSignal = (signal as NodeJS.Signals | null) ?? null;
  });

  const timeoutPromise = delay(timeoutMs).then(() => "timeout");
  const outcome = await Promise.race([exitPromise.then(() => "exit"), timeoutPromise]);

  if (outcome === "timeout") {
    return {
      code: exitCode,
      signal: exitSignal,
      timedOut: true
    };
  }

  return {
    code: exitCode,
    signal: exitSignal,
    timedOut: false
  };
}

async function waitForPath(targetPath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(targetPath, "utf8");
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for file ${targetPath}.`);
}

async function waitForPathOrChildExit(
  targetPath: string,
  child: import("node:child_process").ChildProcess,
  getOutput: () => string,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(targetPath, "utf8");
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      const output = getOutput();
      throw new Error(
        `CLI exited before readiness file ${targetPath} was created (exitCode=${child.exitCode}, signal=${child.signalCode ?? "none"}).\n${output}`
      );
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for file ${targetPath}. Current output:\n${getOutput()}`);
}

async function waitForSessionRunning(projectDir: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = runCli(["status", "--cwd", projectDir]);
    if (status.output.includes("Package Ninja active")) {
      await assertSessionState(projectDir, true);
      return;
    }

    await delay(150);
  }

  throw new Error(`Timed out waiting for Package Ninja session in ${projectDir}.`);
}

async function waitForSessionRunningOrChildExit(
  projectDir: string,
  child: import("node:child_process").ChildProcess,
  getOutput: () => string,
  timeoutMs = 15_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = runCli(["status", "--cwd", projectDir]);
    if (status.output.includes("Package Ninja active")) {
      await assertSessionState(projectDir, true);
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      const output = getOutput();
      throw new Error(
        `CLI exited before Package Ninja session became active for ${projectDir} (exitCode=${child.exitCode}, signal=${child.signalCode ?? "none"}).\n${output}`
      );
    }

    await delay(150);
  }

  throw new Error(`Timed out waiting for Package Ninja session in ${projectDir}. Current output:\n${getOutput()}`);
}

async function assertSessionRunning(projectDir: string): Promise<void> {
  const status = runCli(["status", "--cwd", projectDir]);
  assert.match(status.output, /Package Ninja active/);
  await assertSessionState(projectDir, true);
}

async function assertSessionCleared(projectDir: string): Promise<void> {
  const status = runCli(["status", "--cwd", projectDir]);
  assert.match(status.output, /Package Ninja is not running\./);
  await assertSessionState(projectDir, false);
}

async function assertSessionState(projectDir: string, running: boolean): Promise<void> {
  const paths = resolveProjectPaths(projectDir);
  const state = await readState(paths.statePath);
  if (running) {
    assert.notEqual(state, null);
    return;
  }

  assert.equal(state, null);
}

async function createInterruptProbe(
  projectDir: string,
  label: string
): Promise<{
  readyPath: string;
  appPidPath: string;
  workerPidPath: string;
  sessionPidPath: string;
}> {
  const probeDir = path.join(projectDir, ".package-ninja", "selftest");
  await mkdir(probeDir, { recursive: true });

  const probe = {
    readyPath: path.join(probeDir, `${label}.ready`),
    appPidPath: path.join(probeDir, `${label}.app.pid`),
    workerPidPath: path.join(probeDir, `${label}.worker.pid`),
    sessionPidPath: path.join(probeDir, `${label}.session.pid`)
  };

  await Promise.all(
    Object.values(probe).map(async (filePath) => {
      await rm(filePath, { force: true }).catch(() => {});
    })
  );

  return probe;
}

async function assertPidStoppedFromFile(pidPath: string, label: string): Promise<void> {
  const pid = await readPidFile(pidPath);
  await assertPidStopped(pid, label);
}

async function assertPidStopped(pid: number, label: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8_000) {
    if (!isProcessRunning(pid)) {
      return;
    }

    await delay(150);
  }

  assert.fail(`${label} should have stopped, but pid ${pid} is still running.`);
}

async function assertPidRunning(pid: number, label: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8_000) {
    if (isProcessRunning(pid)) {
      return;
    }

    await delay(150);
  }

  assert.fail(`${label} should still be running, but pid ${pid} is not active.`);
}

async function readPidFile(pidPath: string): Promise<number> {
  const raw = await readFile(pidPath, "utf8");
  const pid = Number.parseInt(raw.trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `Expected a valid pid in ${pidPath}.`);
  return pid;
}

async function assertDirectoryUnlocked(projectDir: string): Promise<void> {
  const renamedPath = `${projectDir}-unlock-probe`;
  await rm(renamedPath, { recursive: true, force: true }).catch(() => {});

  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    try {
      await rename(projectDir, renamedPath);
      await rename(renamedPath, projectDir);
      return;
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }

      await delay(150);
    }
  }

  assert.fail(`Project directory ${projectDir} remained locked after interruption cleanup.`);
}

async function assertNoLeakedTempRuntimeDirs(before: Set<string>, label: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15_000) {
    const after = await listTempRuntimeDirNames();
    const leaked = [...after].filter((name) => !before.has(name));
    if (leaked.length === 0) {
      return;
    }

    await delay(200);
  }

  const after = await listTempRuntimeDirNames();
  const leaked = [...after].filter((name) => !before.has(name));
  assert.fail(`Detected leaked temporary runtime directories after ${label}: ${leaked.join(", ")}`);
}

async function listTempRuntimeDirNames(): Promise<Set<string>> {
  const runtimeRoot = path.join(os.tmpdir(), "package-ninja");

  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    if (isMissing(error)) {
      return new Set<string>();
    }

    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY")
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
