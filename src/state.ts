import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import process from "node:process";

export interface SessionState {
  pid: number;
  port: number;
  registryUrl: string;
  handshakeEndpoint?: string;
  rootDir: string;
  runtimeDir: string;
  storageDir: string;
  configPath: string;
  logPath: string;
  npmrcPath: string;
  persistent: boolean;
  offline: boolean;
  createdAt: string;
}

export interface ProjectPaths {
  rootDir: string;
  workspaceDir: string;
  statePath: string;
}

const SESSION_DIR_NAME = ".package-ninja";

export function resolveProjectPaths(rootDir: string): ProjectPaths {
  const workspaceDir = path.join(rootDir, SESSION_DIR_NAME);

  return {
    rootDir,
    workspaceDir,
    statePath: path.join(workspaceDir, "state.json")
  };
}

export async function ensureWorkspace(paths: ProjectPaths): Promise<void> {
  await mkdir(paths.workspaceDir, { recursive: true });
}

export async function readState(statePath: string): Promise<SessionState | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const raw = await readFile(statePath, "utf8");
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        if (attempt < 4) {
          await delay(50);
          continue;
        }

        return null;
      }

      const parsed = JSON.parse(trimmed) as SessionState | null;
      return parsed;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }

      if (error instanceof SyntaxError && attempt < 4) {
        await delay(50);
        continue;
      }

      throw error;
    }
  }

  return null;
}

export async function writeState(statePath: string, state: SessionState): Promise<void> {
  await writeAtomicFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function clearState(statePath: string): Promise<void> {
  await writeAtomicFile(statePath, "null\n");
}

export async function cleanupRuntime(state: SessionState): Promise<void> {
  if (state.persistent) {
    return;
  }

  await removePathWithRetries(state.runtimeDir);
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }

    throw error;
  }
}

export async function fileSize(targetPath: string): Promise<number> {
  const details = await stat(targetPath);
  return details.size;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function removePathWithRetries(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === 59) {
        throw error;
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

async function writeAtomicFile(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, targetPath);
}
