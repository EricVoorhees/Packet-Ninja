import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { createConnection, createServer, Socket } from "node:net";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { writeRegistryConfig } from "./config.js";
import { cleanupRuntime, clearState, ensureWorkspace, readState, resolveProjectPaths, SessionState, writeState } from "./state.js";

export interface SessionOptions {
  rootDir: string;
  port?: number;
  persistent: boolean;
  offline: boolean;
  useAres: boolean;
  aresShadowUrl?: string;
}

export interface SessionStatus {
  state: SessionState | null;
  running: boolean;
}

export interface SessionLease {
  state: SessionState;
  owned: boolean;
  shouldStopOnRelease: boolean;
  release: () => Promise<void>;
}

export interface SessionExecutionOptions {
  cwd?: string;
}

type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

const INTERRUPT_SIGNALS: InterruptSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const WORKER_MODE_ENV = "PACKAGE_NINJA_INTERNAL_WORKER_MODE";
const READY_TIMEOUT_ENV = "PACKAGE_NINJA_INTERNAL_READY_TIMEOUT_MS";
const OWNED_SESSION_PID_ENV = "PACKAGE_NINJA_INTERNAL_OWNED_SESSION_PID_PATH";
const COMMAND_WORKER_PID_ENV = "PACKAGE_NINJA_INTERNAL_COMMAND_WORKER_PID_PATH";
const FOREGROUND_PARENT_PID_ENV = "PACKAGE_NINJA_INTERNAL_FOREGROUND_PARENT_PID";
const REGISTRY_SIGNAL_ENV = "VER" + "DACCIO_HANDLE_KILL_SIGNALS";
const USE_GO_RUNNER_ENV = "PACKAGE_NINJA_USE_GO_RUNNER";
const GO_WORKER_PATH_ENV = "PACKAGE_NINJA_GO_WORKER_PATH";
const USE_ARES_RUNTIME_ENV = "PACKAGE_NINJA_USE_ARES";
const ARES_BINARY_ENV = "PACKAGE_NINJA_ARES_PATH";
const ARES_LISTEN_ENV = "PACKAGE_NINJA_ARES_LISTEN";
const ARES_UPSTREAM_ENV = "PACKAGE_NINJA_ARES_UPSTREAM";
const ARES_DATA_DIR_ENV = "PACKAGE_NINJA_ARES_DATA_DIR";
const ARES_SHADOW_URL_ENV = "PACKAGE_NINJA_ARES_SHADOW_URL";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 200;
const DEFAULT_HANDSHAKE_RETRIES = 3;
const HANDSHAKE_TIMEOUT_ENV = "PACKAGE_NINJA_INTERNAL_HANDSHAKE_TIMEOUT_MS";
const DEFAULT_ARES_HEALTH_TIMEOUT_MS = 500;
const ARES_HEALTH_TIMEOUT_ENV = "PACKAGE_NINJA_INTERNAL_ARES_HEALTH_TIMEOUT_MS";

export async function startSession(options: SessionOptions): Promise<SessionState> {
  const paths = resolveProjectPaths(options.rootDir);
  await ensureWorkspace(paths);

  const existing = await readState(paths.statePath);
  if (existing) {
    if (isProcessRunning(existing.pid)) {
      throw new Error(`Package Ninja is already running at ${existing.registryUrl} (pid ${existing.pid}).`);
    }

    await clearState(paths.statePath);
    await cleanupRuntime(existing);
  }

  const runtimeDir = resolveRuntimeDir(paths.workspaceDir, options.persistent);
  const storageDir = path.join(runtimeDir, "storage");
  const npmrcPath = path.join(runtimeDir, ".npmrc");
  const logPath = path.join(runtimeDir, "package-ninja-registry.log");
  const readyPath = path.join(runtimeDir, "ready.json");
  const runtimeKind = resolveRuntimeKind(options);
  const handshakeEndpoint = runtimeKind === "verdaccio" ? resolveHandshakeEndpoint() : undefined;
  const port = options.port ?? (await choosePort(0));
  const registryUrl = `http://127.0.0.1:${port}`;

  await mkdir(runtimeDir, { recursive: true });
  await rm(readyPath, { force: true }).catch(() => {});
  let configPath = path.join(runtimeDir, "package-ninja.runtime.config.json");
  if (runtimeKind === "verdaccio") {
    configPath = await writeRegistryConfig({
      runtimeDir,
      storageDir,
      port,
      offline: options.offline
    });
  } else {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          runtimeKind: "ares",
          port,
          registryUrl,
          storageDir,
          offline: options.offline,
          shadowRegistryUrl: options.aresShadowUrl ?? process.env[ARES_SHADOW_URL_ENV] ?? null
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  await writeNpmRc(npmrcPath, registryUrl);
  const child =
    runtimeKind === "ares"
      ? await launchAresWorker({
          logPath,
          rootDir: options.rootDir,
          port,
          storageDir,
          offline: options.offline,
          shadowUrl: options.aresShadowUrl
        })
      : await launchRegistryWorker({
          configPath,
          logPath,
          readyPath,
          handshakeEndpoint: handshakeEndpoint ?? resolveHandshakeEndpoint(),
          rootDir: options.rootDir,
          port
        });

  try {
    if (runtimeKind === "ares") {
      await waitForAresReady(child, resolveHealthcheckUrl(port), logPath);
    } else {
      await waitForReady(child, readyPath, logPath, child.pid ?? -1, port);
    }
  } catch (error) {
    await stopChildProcess(child);
    await cleanupFailedStartup(runtimeDir, options.persistent);
    throw error;
  }

  const state: SessionState = {
    pid: child.pid ?? -1,
    port,
    registryUrl,
    runtimeKind,
    handshakeEndpoint,
    healthcheckUrl: runtimeKind === "ares" ? resolveHealthcheckUrl(port) : undefined,
    shadowRegistryUrl: runtimeKind === "ares" ? options.aresShadowUrl ?? process.env[ARES_SHADOW_URL_ENV] : undefined,
    rootDir: options.rootDir,
    runtimeDir,
    storageDir,
    configPath,
    logPath,
    npmrcPath,
    persistent: options.persistent,
    offline: options.offline,
    createdAt: new Date().toISOString()
  };

  await writeState(paths.statePath, state);
  return state;
}

export async function stopSession(rootDir: string): Promise<SessionState | null> {
  const paths = resolveProjectPaths(rootDir);
  const state = await readState(paths.statePath);

  if (!state) {
    return null;
  }

  if (isProcessRunning(state.pid)) {
    await stopProcessByPid(state.pid);
  }

  await clearState(paths.statePath);
  await clearReadyMarker(state);
  await cleanupRuntime(state);
  return state;
}

export async function readStatus(rootDir: string): Promise<SessionStatus> {
  const paths = resolveProjectPaths(rootDir);
  const state = await readState(paths.statePath);

  if (!state) {
    return { state: null, running: false };
  }

  const running = isProcessRunning(state.pid);
  if (!running) {
    await clearState(paths.statePath);
    await clearReadyMarker(state);
    await cleanupRuntime(state);
    return { state: null, running: false };
  }

  if (!(await isSessionResponsive(state))) {
    await stopProcessByPid(state.pid).catch(() => {});
    await clearState(paths.statePath);
    await clearReadyMarker(state);
    await cleanupRuntime(state);
    return { state: null, running: false };
  }

  return { state, running: true };
}

export async function runWithSession(
  options: SessionOptions,
  command: string,
  args: string[],
  executionOptions: SessionExecutionOptions = {}
): Promise<{
  exitCode: number;
  state: SessionState;
  reused: boolean;
}> {
  const lease = await acquireSession(options);
  try {
    const exitCode = await runCommandInSession(lease.state, command, args, executionOptions);
    return {
      exitCode,
      state: lease.state,
      reused: !lease.owned
    };
  } finally {
    if (lease.shouldStopOnRelease) {
      await lease.release();
    }
  }
}

export async function acquireSession(options: SessionOptions): Promise<SessionLease> {
  const status = await readStatus(options.rootDir);
  if (status.state && status.running) {
    return {
      state: status.state,
      owned: false,
      shouldStopOnRelease: false,
      release: async () => {}
    };
  }

  if (options.persistent) {
    const state = await startSession(options);
    await maybeWriteInternalPid(OWNED_SESSION_PID_ENV, state.pid);
    return {
      state,
      owned: true,
      shouldStopOnRelease: false,
      release: async () => {}
    };
  }

  const state = await startForegroundSession(options);
  await maybeWriteInternalPid(OWNED_SESSION_PID_ENV, state.pid);
  return {
    state,
    owned: true,
    shouldStopOnRelease: true,
    release: async () => {
      await shutdownForegroundSession(state.child, state.runtimeDir, state.persistent);
    }
  };
}

export async function runCommandInSession(
  state: SessionState,
  command: string,
  args: string[],
  executionOptions: SessionExecutionOptions = {}
): Promise<number> {
  return await runChildCommand(command, args, state.registryUrl, state.npmrcPath, executionOptions.cwd ?? state.rootDir);
}

export function formatStatus(status: SessionStatus): string {
  if (!status.state || !status.running) {
    return "Package Ninja is not running.";
  }

  const lines = [
    "🔐 Package Ninja active",
    `→ Registry: ${status.state.registryUrl}`,
    `→ PID: ${status.state.pid}`,
    `→ Runtime: ${status.state.runtimeKind ?? "verdaccio"}`,
    `→ Mode: ${status.state.persistent ? "persistent" : "ephemeral"}`,
    `→ Proxy: ${status.state.offline ? "offline only" : "npmjs uplink enabled"}`
  ];

  return lines.join("\n");
}

interface ForegroundSession extends SessionState {
  child: ChildProcess;
}

async function startForegroundSession(options: SessionOptions): Promise<ForegroundSession> {
  const paths = resolveProjectPaths(options.rootDir);
  await ensureWorkspace(paths);

  const existing = await readState(paths.statePath);
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(`Package Ninja is already running at ${existing.registryUrl} (pid ${existing.pid}).`);
  }

  if (existing) {
    await clearState(paths.statePath);
    await cleanupRuntime(existing);
  }

  const runtimeDir = resolveRuntimeDir(paths.workspaceDir, options.persistent);
  const storageDir = path.join(runtimeDir, "storage");
  const port = options.port ?? (await choosePort(0));
  const registryUrl = `http://127.0.0.1:${port}`;
  const logPath = path.join(runtimeDir, "package-ninja-registry.log");
  const npmrcPath = path.join(runtimeDir, ".npmrc");
  const readyPath = path.join(runtimeDir, "ready.json");
  const runtimeKind = resolveRuntimeKind(options);
  const handshakeEndpoint = runtimeKind === "verdaccio" ? resolveHandshakeEndpoint() : undefined;
  await mkdir(runtimeDir, { recursive: true });
  let configPath = path.join(runtimeDir, "package-ninja.runtime.config.json");
  if (runtimeKind === "verdaccio") {
    configPath = await writeRegistryConfig({
      runtimeDir,
      storageDir,
      port,
      offline: options.offline
    });
  } else {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          runtimeKind: "ares",
          port,
          registryUrl,
          storageDir,
          offline: options.offline,
          shadowRegistryUrl: options.aresShadowUrl ?? process.env[ARES_SHADOW_URL_ENV] ?? null
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  await writeNpmRc(npmrcPath, registryUrl);
  await rm(readyPath, { force: true }).catch(() => {});
  const child =
    runtimeKind === "ares"
      ? await launchAresWorker({
          logPath,
          rootDir: options.rootDir,
          port,
          storageDir,
          offline: options.offline,
          shadowUrl: options.aresShadowUrl,
          detached: false
        })
      : await launchRegistryWorker({
          configPath,
          logPath,
          rootDir: options.rootDir,
          readyPath,
          handshakeEndpoint: handshakeEndpoint ?? resolveHandshakeEndpoint(),
          port,
          detached: false
        });

  try {
    if (runtimeKind === "ares") {
      await waitForAresReady(child, resolveHealthcheckUrl(port), logPath);
    } else {
      await waitForReady(child, readyPath, logPath, child.pid ?? -1, port);
    }
  } catch (error) {
    await stopChildProcess(child);
    await cleanupFailedStartup(runtimeDir, options.persistent);
    throw error;
  }

  if (!options.persistent) {
    launchRuntimeWatchdog(process.pid, child.pid ?? -1, runtimeDir);
  }

  return {
    child,
    pid: child.pid ?? -1,
    port,
    registryUrl,
    runtimeKind,
    handshakeEndpoint,
    healthcheckUrl: runtimeKind === "ares" ? resolveHealthcheckUrl(port) : undefined,
    shadowRegistryUrl: runtimeKind === "ares" ? options.aresShadowUrl ?? process.env[ARES_SHADOW_URL_ENV] : undefined,
    rootDir: options.rootDir,
    runtimeDir,
    storageDir,
    configPath,
    logPath,
    npmrcPath,
    persistent: options.persistent,
    offline: options.offline,
    createdAt: new Date().toISOString()
  };
}

async function shutdownForegroundSession(
  child: ChildProcess,
  runtimeDir: string,
  persistent: boolean
): Promise<void> {
  await stopChildProcess(child);

  if (!persistent) {
    await cleanupRuntime({
      pid: -1,
      port: -1,
      registryUrl: "",
      rootDir: "",
      runtimeDir,
      storageDir: "",
      configPath: "",
      logPath: "",
      npmrcPath: "",
      persistent: false,
      offline: false,
      createdAt: ""
    });
  }
}

async function runChildCommand(
  command: string,
  args: string[],
  registryUrl: string,
  npmrcPath: string,
  cwd: string
): Promise<number> {
  const runtimeDir = path.dirname(npmrcPath);
  const manifestPath = path.join(runtimeDir, `command-worker-${randomUUID()}.json`);
  const nodeWorkerPath = fileURLToPath(new URL("./command-worker.js", import.meta.url));
  const commandEnv = {
    ...process.env,
    PACKAGE_NINJA_REGISTRY_URL: registryUrl,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
    npm_config_userconfig: npmrcPath,
    NPM_CONFIG_USERCONFIG: npmrcPath,
    YARN_NPM_REGISTRY_SERVER: registryUrl,
    BUN_CONFIG_REGISTRY: registryUrl
  };

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        command,
        args,
        cwd,
        envEntries: Object.entries(commandEnv)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value: String(value) })),
        parentPid: process.pid
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const goWorkerPath = await resolveGoWorkerPath();

  return await new Promise((resolve, reject) => {
    const child = goWorkerPath
      ? spawn(goWorkerPath, [manifestPath], {
          cwd,
          stdio: "inherit",
          windowsHide: process.platform === "win32",
          env: commandEnv
        })
      : spawn(process.execPath, [nodeWorkerPath, manifestPath], {
          cwd,
          stdio: "inherit",
          windowsHide: process.platform === "win32",
          env: commandEnv
        });

    void maybeWriteInternalPid(COMMAND_WORKER_PID_ENV, child.pid ?? -1);

    let settled = false;
    let observedInterrupt: InterruptSignal | null = null;
    let childExited = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const signalHandlers = new Map<InterruptSignal, () => void>();
    const processExitHandler = (): void => {
      if (!child.pid || childExited) {
        return;
      }

      forceStopCommandChildSync(child.pid);
    };

    const cleanup = (): void => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }

      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
      process.off("exit", processExitHandler);
      void rm(manifestPath, { force: true }).catch(() => {});
    };

    const finish = (code: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(code);
    };

    const scheduleForceKill = (): void => {
      if (forceKillTimer || child.pid === undefined) {
        return;
      }

      forceKillTimer = setTimeout(() => {
        if (childExited || child.pid === undefined || !isProcessRunning(child.pid)) {
          return;
        }

        void forceStopCommandChild(child.pid);
      }, 1_500);

      forceKillTimer.unref();
    };

    for (const signal of INTERRUPT_SIGNALS) {
      const handler = (): void => {
        if (observedInterrupt === null) {
          observedInterrupt = signal;
          if (process.platform === "win32") {
            if (child.pid !== undefined) {
              void forceStopCommandChild(child.pid);
            }
          } else {
            void forwardSignalToCommandChild(child, signal);
            scheduleForceKill();
          }
          return;
        }

        if (child.pid !== undefined) {
          void forceStopCommandChild(child.pid);
        }
      };

      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    process.on("exit", processExitHandler);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      childExited = true;

      if (observedInterrupt) {
        finish(signalToExitCode(observedInterrupt));
        return;
      }

      if (signal) {
        finish(signalToExitCode(signal));
        return;
      }

      finish(code ?? 0);
    });
  });
}

async function resolveGoWorkerPath(): Promise<string | null> {
  if (process.env[USE_GO_RUNNER_ENV] !== "1") {
    return null;
  }

  const explicitPath = process.env[GO_WORKER_PATH_ENV];
  if (explicitPath) {
    return await pathExists(explicitPath) ? explicitPath : null;
  }

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    path.join(packageRoot, "bin", process.platform === "win32" ? "command-worker-go.exe" : "command-worker-go"),
    path.join(packageRoot, "bin", "command-worker-go.exe"),
    path.join(packageRoot, "bin", "command-worker-go")
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface LaunchOptions {
  configPath: string;
  readyPath: string;
  handshakeEndpoint: string;
  logPath: string;
  rootDir: string;
  port: number;
  detached?: boolean;
}

interface AresLaunchOptions {
  logPath: string;
  rootDir: string;
  port: number;
  storageDir: string;
  offline: boolean;
  shadowUrl?: string;
  detached?: boolean;
}

function resolveRuntimeDir(workspaceDir: string, persistent: boolean): string {
  if (persistent) {
    return path.join(workspaceDir, "persistent");
  }

  return path.join(os.tmpdir(), "package-ninja", randomUUID());
}

function resolveRuntimeKind(options: SessionOptions): "verdaccio" | "ares" {
  if (options.useAres || process.env[USE_ARES_RUNTIME_ENV] === "1") {
    return "ares";
  }

  return "verdaccio";
}

function resolveHealthcheckUrl(port: number): string {
  return `http://127.0.0.1:${port}/-/health`;
}

function resolveHandshakeEndpoint(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\package-ninja-${randomUUID()}`;
  }

  return path.join(os.tmpdir(), `package-ninja-${randomUUID()}.sock`);
}

async function isSessionResponsive(state: SessionState): Promise<boolean> {
  if ((state.runtimeKind ?? "verdaccio") === "ares") {
    if (!state.healthcheckUrl) {
      return true;
    }

    for (let attempt = 0; attempt < DEFAULT_HANDSHAKE_RETRIES; attempt += 1) {
      if (await pingHealthcheckUrl(state.healthcheckUrl, readAresHealthTimeout())) {
        return true;
      }
    }

    return false;
  }

  if (!state.handshakeEndpoint) {
    return true;
  }

  const timeoutMs = readHandshakeTimeout();
  for (let attempt = 0; attempt < DEFAULT_HANDSHAKE_RETRIES; attempt += 1) {
    if (await pingHandshakeEndpoint(state.handshakeEndpoint, timeoutMs)) {
      return true;
    }
  }

  return false;
}

async function pingHandshakeEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    timeout.unref();

    socket.once("connect", () => {
      socket.write("ping\n");
    });

    socket.once("data", (chunk: Buffer | string) => {
      const response = chunk.toString().trim().toLowerCase();
      clearTimeout(timeout);
      finish(response === "pong");
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      finish(false);
    });

    socket.once("close", () => {
      clearTimeout(timeout);
      finish(false);
    });
  });
}

async function pingHealthcheckUrl(url: string, timeoutMs: number): Promise<boolean> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref();

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: abortController.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function launchRegistryWorker(options: LaunchOptions): Promise<ChildProcess> {
  const workerPath = fileURLToPath(new URL("./registry-worker.js", import.meta.url));

  await mkdir(path.dirname(options.logPath), { recursive: true });

  const logFile = await open(options.logPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o666);
  try {
    const child = spawn(
      process.execPath,
      [workerPath, options.configPath, options.readyPath, options.handshakeEndpoint, "127.0.0.1", String(options.port)],
      {
        cwd: options.rootDir,
        detached: options.detached ?? true,
        stdio: ["ignore", logFile.fd, logFile.fd],
        env: {
          ...process.env,
          [REGISTRY_SIGNAL_ENV]: "false",
          [WORKER_MODE_ENV]: process.env[WORKER_MODE_ENV] ?? "",
          [FOREGROUND_PARENT_PID_ENV]: options.detached === false ? String(process.pid) : ""
        }
      }
    );

    await logFile.close();

    if (options.detached ?? true) {
      child.unref();
    }

    return child;
  } catch (error) {
    await logFile.close();
    throw error;
  }
}

async function launchAresWorker(options: AresLaunchOptions): Promise<ChildProcess> {
  const aresPath = await resolveAresBinaryPath();

  await mkdir(path.dirname(options.logPath), { recursive: true });
  await mkdir(options.storageDir, { recursive: true });

  const logFile = await open(options.logPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o666);
  const listenAddress = `127.0.0.1:${options.port}`;
  const upstreamUrl = resolveAresUpstream(options);

  try {
    const child = spawn(aresPath, [], {
      cwd: options.rootDir,
      detached: options.detached ?? true,
      stdio: ["ignore", logFile.fd, logFile.fd],
      windowsHide: process.platform === "win32",
      env: {
        ...process.env,
        [ARES_LISTEN_ENV]: listenAddress,
        [ARES_DATA_DIR_ENV]: options.storageDir,
        [ARES_UPSTREAM_ENV]: upstreamUrl,
        [ARES_SHADOW_URL_ENV]: options.shadowUrl ?? process.env[ARES_SHADOW_URL_ENV] ?? ""
      }
    });

    await logFile.close();

    if (options.detached ?? true) {
      child.unref();
    }

    return child;
  } catch (error) {
    await logFile.close();
    throw error;
  }
}

function resolveAresUpstream(options: AresLaunchOptions): string {
  const explicitUpstream = process.env[ARES_UPSTREAM_ENV];
  if (explicitUpstream) {
    return explicitUpstream;
  }

  if (options.offline) {
    return "http://127.0.0.1:9";
  }

  return "https://registry.npmjs.org";
}

async function resolveAresBinaryPath(): Promise<string> {
  const explicitPath = process.env[ARES_BINARY_ENV];
  if (explicitPath && (await pathExists(explicitPath))) {
    return explicitPath;
  }

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    path.join(packageRoot, "bin", process.platform === "win32" ? "ares-registry.exe" : "ares-registry"),
    path.join(packageRoot, "bin", "ares-registry.exe"),
    path.join(packageRoot, "bin", "ares-registry")
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('Ares runtime binary not found. Build it with "npm run build:go-ares".');
}

async function writeNpmRc(npmrcPath: string, registryUrl: string): Promise<void> {
  const content = [`registry=${registryUrl}/`, `always-auth=false`, ``].join("\n");
  await writeFile(npmrcPath, content, "utf8");
}

interface ReadyPayload {
  port?: number;
  pid?: number;
}

async function waitForReady(
  child: ChildProcess,
  readyPath: string,
  logPath: string,
  expectedPid: number,
  expectedPort: number
): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = readReadyTimeout();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(await renderStartupFailure(logPath, "Registry worker exited before signaling readiness."));
    }

    try {
      const raw = await readFile(readyPath, "utf8");
      const ready = parseReadyPayload(raw);
      if (ready === null) {
        await delay(200);
        continue;
      }

      if (ready.port !== expectedPort) {
        await delay(200);
        continue;
      }

      if (expectedPid > 0 && ready.pid !== expectedPid) {
        await delay(200);
        continue;
      }

      if (ready.port) {
        return;
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    await delay(200);
  }

  throw new Error(await renderStartupFailure(logPath, "Registry readiness timed out."));
}

async function waitForAresReady(child: ChildProcess, healthcheckUrl: string, logPath: string): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = readReadyTimeout();
  const healthTimeoutMs = readAresHealthTimeout();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(await renderStartupFailure(logPath, "Ares worker exited before signaling readiness."));
    }

    if (await pingHealthcheckUrl(healthcheckUrl, healthTimeoutMs)) {
      return;
    }

    await delay(120);
  }

  throw new Error(await renderStartupFailure(logPath, "Ares readiness timed out."));
}

function parseReadyPayload(raw: string): ReadyPayload | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as ReadyPayload;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // The worker writes ready.json asynchronously; tolerate transient partial reads.
      return null;
    }

    throw error;
  }
}

async function renderStartupFailure(logPath: string, message: string): Promise<string> {
  return message;
}

async function choosePort(preferredPort: number): Promise<number> {
  const preferred = await reservePort(preferredPort);
  if (preferred !== null) {
    return preferred;
  }

  const fallback = await reservePort(0);
  if (fallback === null) {
    throw new Error("Could not find an open port for Package Ninja.");
  }

  return fallback;
}

async function reservePort(port: number): Promise<number | null> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();

    server.once("error", () => {
      resolve(null);
    });

    server.listen({ host: "127.0.0.1", port }, () => {
      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address !== null && "port" in address ? address.port : null;

      server.close(() => {
        resolve(resolvedPort);
      });
    });
  });
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

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return;
    }

    await delay(200);
  }
}

async function stopProcessByPid(pid: number): Promise<void> {
  process.kill(pid, "SIGINT");
  await waitForExit(pid, 8_000);

  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGTERM");
    await waitForExit(pid, 5_000);
  }

  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 2_000);
  }
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.pid && isProcessRunning(child.pid)) {
    await stopProcessByPid(child.pid);
  }
}

async function forwardSignalToCommandChild(child: ChildProcess, signal: InterruptSignal): Promise<void> {
  if (!child.pid || !isProcessRunning(child.pid)) {
    return;
  }

  try {
    process.kill(child.pid, signal);
  } catch {
    // Ignore delivery failures and let the forced cleanup path handle it if needed.
  }
}

async function forceStopCommandChild(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) {
    return;
  }

  if (process.platform === "win32") {
    await killWindowsProcessTree(pid);
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore force-kill failures during shutdown.
  }
}

async function cleanupFailedStartup(runtimeDir: string, persistent: boolean): Promise<void> {
  if (persistent) {
    return;
  }

  await cleanupRuntime({
    pid: -1,
    port: -1,
    registryUrl: "",
    rootDir: "",
    runtimeDir,
    storageDir: "",
    configPath: "",
    logPath: "",
    npmrcPath: "",
    persistent: false,
    offline: false,
    createdAt: ""
  });
}

async function clearReadyMarker(state: SessionState): Promise<void> {
  const readyPath = path.join(state.runtimeDir, "ready.json");
  await rm(readyPath, { force: true }).catch(() => {});
}

async function maybeWriteInternalPid(envName: string, pid: number): Promise<void> {
  const targetPath = process.env[envName];
  if (!targetPath || pid <= 0) {
    return;
  }

  await writeFile(targetPath, `${pid}\n`, "utf8");
}

function readReadyTimeout(): number {
  const raw = process.env[READY_TIMEOUT_ENV];
  if (!raw) {
    return DEFAULT_READY_TIMEOUT_MS;
  }

  const timeoutMs = Number.parseInt(raw, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_READY_TIMEOUT_MS;
  }

  return timeoutMs;
}

function readHandshakeTimeout(): number {
  const raw = process.env[HANDSHAKE_TIMEOUT_ENV];
  if (!raw) {
    return DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  const timeoutMs = Number.parseInt(raw, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  return timeoutMs;
}

function readAresHealthTimeout(): number {
  const raw = process.env[ARES_HEALTH_TIMEOUT_ENV];
  if (!raw) {
    return DEFAULT_ARES_HEALTH_TIMEOUT_MS;
  }

  const timeoutMs = Number.parseInt(raw, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_ARES_HEALTH_TIMEOUT_MS;
  }

  return timeoutMs;
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

function forceStopCommandChildSync(pid: number): void {
  if (!isProcessRunning(pid)) {
    return;
  }

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      // Ignore synchronous cleanup failures during process exit.
    }
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore synchronous cleanup failures during process exit.
  }
}

function signalToExitCode(signal: string): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function launchRuntimeWatchdog(parentPid: number, registryPid: number, runtimeDir: string): void {
  const watcherPath = fileURLToPath(new URL("./runtime-watchdog.js", import.meta.url));

  try {
    const watcher = spawn(process.execPath, [watcherPath, String(parentPid), String(registryPid), runtimeDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32"
    });
    watcher.unref();
  } catch {
    // Best effort only; normal cleanup paths still run when possible.
  }
}
