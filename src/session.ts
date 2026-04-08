import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
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
  const port = options.port ?? (await choosePort(0));
  const registryUrl = `http://127.0.0.1:${port}`;

  await mkdir(runtimeDir, { recursive: true });
  const configPath = await writeRegistryConfig({
    runtimeDir,
    storageDir,
    port,
    offline: options.offline
  });

  await writeNpmRc(npmrcPath, registryUrl);
  const child = await launchRegistryWorker({
    configPath,
    logPath,
    readyPath,
    rootDir: options.rootDir,
    port
  });

  try {
    await waitForReady(child, readyPath, logPath);
  } catch (error) {
    await stopChildProcess(child);
    await cleanupFailedStartup(runtimeDir, options.persistent);
    throw error;
  }

  const state: SessionState = {
    pid: child.pid ?? -1,
    port,
    registryUrl,
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
  const configPath = await writeRegistryConfig({
    runtimeDir,
    storageDir,
    port,
    offline: options.offline
  });

  await writeNpmRc(npmrcPath, registryUrl);
  const child = await launchRegistryWorker({
    configPath,
    logPath,
    rootDir: options.rootDir,
    readyPath,
    port,
    detached: false
  });

  try {
    await waitForReady(child, readyPath, logPath);
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
  const workerPath = fileURLToPath(new URL("./command-worker.js", import.meta.url));
  const commandEnv = {
    ...process.env,
    PACKAGE_NINJA_REGISTRY_URL: registryUrl,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
    npm_config_userconfig: npmrcPath,
    NPM_CONFIG_USERCONFIG: npmrcPath,
    YARN_NPM_REGISTRY_SERVER: registryUrl
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

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, manifestPath], {
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

interface LaunchOptions {
  configPath: string;
  readyPath: string;
  logPath: string;
  rootDir: string;
  port: number;
  detached?: boolean;
}

function resolveRuntimeDir(workspaceDir: string, persistent: boolean): string {
  if (persistent) {
    return path.join(workspaceDir, "persistent");
  }

  return path.join(os.tmpdir(), "package-ninja", randomUUID());
}

async function launchRegistryWorker(options: LaunchOptions): Promise<ChildProcess> {
  const workerPath = fileURLToPath(new URL("./registry-worker.js", import.meta.url));

  await mkdir(path.dirname(options.logPath), { recursive: true });

  const logFile = await open(options.logPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o666);
  try {
    const child = spawn(
      process.execPath,
      [workerPath, options.configPath, options.readyPath, "127.0.0.1", String(options.port)],
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

async function writeNpmRc(npmrcPath: string, registryUrl: string): Promise<void> {
  const content = [`registry=${registryUrl}/`, `always-auth=false`, ``].join("\n");
  await writeFile(npmrcPath, content, "utf8");
}

async function waitForReady(child: ChildProcess, readyPath: string, logPath: string): Promise<void> {
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

function parseReadyPayload(raw: string): { port?: number } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as { port?: number };
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
