#!/usr/bin/env node

import { rm } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

async function main(): Promise<void> {
  const [parentPidRaw, registryPidRaw, runtimeDir] = process.argv.slice(2);
  if (!runtimeDir) {
    return;
  }

  const parentPid = parsePid(parentPidRaw);
  const registryPid = parsePid(registryPidRaw);

  await waitForParentExit(parentPid);
  await waitForRegistryExit(registryPid);
  await removePathWithRetries(runtimeDir);
}

async function waitForParentExit(parentPid: number): Promise<void> {
  if (parentPid <= 0) {
    return;
  }

  while (isProcessRunning(parentPid)) {
    await delay(500);
  }
}

async function waitForRegistryExit(registryPid: number): Promise<void> {
  if (registryPid <= 0) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (!isProcessRunning(registryPid)) {
      return;
    }

    await delay(250);
  }
}

async function removePathWithRetries(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === 79) {
        return;
      }

      await delay(250);
    }
  }
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY")
  );
}

function parsePid(raw: string | undefined): number {
  if (!raw) {
    return -1;
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return -1;
  }

  return pid;
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

void main().finally(() => {
  process.exit(0);
});
