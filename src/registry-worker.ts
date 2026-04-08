#!/usr/bin/env node

import { rename, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { runServer } from "package-ninja-registry-runtime";

const WORKER_MODE_ENV = "PACKAGE_NINJA_INTERNAL_WORKER_MODE";
const FOREGROUND_PARENT_PID_ENV = "PACKAGE_NINJA_INTERNAL_FOREGROUND_PARENT_PID";

async function main(): Promise<void> {
  const [configPath, readyPath, host, portValue] = process.argv.slice(2);

  if (!configPath || !readyPath || !host || !portValue) {
    throw new Error("registry-worker requires <configPath> <readyPath> <host> <port>.");
  }

  const port = Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port passed to registry-worker: ${portValue}`);
  }

  const workerMode = process.env[WORKER_MODE_ENV];
  const foregroundParentPid = parseParentPid(process.env[FOREGROUND_PARENT_PID_ENV]);
  if (workerMode === "fail") {
    throw new Error("Forced worker startup failure.");
  }

  const server = await runServer(configPath);
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    void rm(readyPath, { force: true }).catch(() => {});
    server.close(() => {
      process.exit(0);
    });
  };

  server.once("error", (error: Error) => {
    console.error(`Registry worker error: ${error.message}`);
    process.exit(1);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  if (foregroundParentPid !== null) {
    void monitorForegroundParent(foregroundParentPid, shutdown);
  }

  server.listen(port, host, async () => {
    if (workerMode === "stall-ready") {
      return;
    }

    const address = server.address();
    const payload =
      typeof address === "object" && address !== null
        ? {
            address: address.address,
            family: address.family,
            port: address.port
          }
        : {
            address: host,
            family: "unknown",
            port
          };

    const readyPayload = `${JSON.stringify({ ...payload, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`;
    const tempReadyPath = `${readyPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempReadyPath, readyPayload, "utf8");
    await rename(tempReadyPath, readyPath);
  });
}

async function monitorForegroundParent(parentPid: number, shutdown: () => void): Promise<void> {
  while (isProcessRunning(parentPid)) {
    await delay(500);
  }

  shutdown();
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

function parseParentPid(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return pid;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Registry worker failed: ${message}`);
  process.exit(1);
});
