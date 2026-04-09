#!/usr/bin/env node

import { rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, Server } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { runServer } from "package-ninja-registry-runtime";

const WORKER_MODE_ENV = "PACKAGE_NINJA_INTERNAL_WORKER_MODE";
const FOREGROUND_PARENT_PID_ENV = "PACKAGE_NINJA_INTERNAL_FOREGROUND_PARENT_PID";
const HANDSHAKE_READY_TIMEOUT_MS = 50;
const HANDSHAKE_READY_ATTEMPTS = 12;

async function main(): Promise<void> {
  const [configPath, readyPath, handshakeEndpoint, host, portValue] = process.argv.slice(2);

  if (!configPath || !readyPath || !handshakeEndpoint || !host || !portValue) {
    throw new Error("registry-worker requires <configPath> <readyPath> <handshakeEndpoint> <host> <port>.");
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
  const handshakeServer = await startHandshakeServer(handshakeEndpoint);
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    shutdownPromise = (async () => {
      await Promise.all([
        rm(readyPath, { force: true }).catch(() => {}),
        closeHandshakeServer(handshakeServer, handshakeEndpoint)
      ]).catch(() => {});
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    })();

    void shutdownPromise.finally(() => {
      process.exit(0);
    });
  };

  server.once("error", (error: Error) => {
    const finalizeError = async (): Promise<void> => {
      if (shutdownPromise) {
        await shutdownPromise.catch(() => {});
      } else {
        await closeHandshakeServer(handshakeServer, handshakeEndpoint).catch(() => {});
      }
      console.error(`Registry worker error: ${error.message}`);
      process.exit(1);
    };

    void finalizeError();
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

    await assertHandshakeReady(handshakeEndpoint);

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

async function assertHandshakeReady(handshakeEndpoint: string): Promise<void> {
  for (let attempt = 0; attempt < HANDSHAKE_READY_ATTEMPTS; attempt += 1) {
    if (await pingHandshakeEndpoint(handshakeEndpoint, HANDSHAKE_READY_TIMEOUT_MS)) {
      return;
    }

    const jitterMs = 4 + Math.floor(Math.random() * 7);
    await delay(jitterMs);
  }

  throw new Error(`Handshake endpoint did not become ready: ${handshakeEndpoint}`);
}

async function pingHandshakeEndpoint(handshakeEndpoint: string, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(handshakeEndpoint);
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
      clearTimeout(timeout);
      finish(chunk.toString().trim().toLowerCase() === "pong");
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

async function startHandshakeServer(handshakeEndpoint: string): Promise<Server> {
  if (process.platform !== "win32") {
    await rm(handshakeEndpoint, { force: true }).catch(() => {});
  }

  const server = createServer((socket) => {
    socket.on("data", () => {
      socket.write("pong\n");
      socket.end();
    });
  });

  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(handshakeEndpoint, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function closeHandshakeServer(server: Server, handshakeEndpoint: string): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  if (process.platform !== "win32") {
    await rm(handshakeEndpoint, { force: true }).catch(() => {});
  }
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
