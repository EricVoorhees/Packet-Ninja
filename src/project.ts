import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./state.js";

export type PackageManager = "npm" | "pnpm" | "yarn";
export type PackageManagerSource = "override" | "pnpm-lock.yaml" | "yarn.lock" | "package-lock.json" | "fallback";
export type InstallMode = "auto" | "always" | "never";

interface PackageJsonShape {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: {
    registry?: string;
  };
  scripts?: Record<string, string>;
}

export interface ProjectContext {
  rootDir: string;
  packageManager: PackageManager;
  packageManagerSource: PackageManagerSource;
  packageJsonPath: string;
  packageJson: PackageJsonShape;
  lockfileName: "pnpm-lock.yaml" | "yarn.lock" | "package-lock.json" | null;
  hasNodeModules: boolean;
  hasDeclaredDependencies: boolean;
}

export interface ProjectCommand {
  command: string;
  args: string[];
}

export interface InstallDecision {
  shouldInstall: boolean;
  message: string;
}

export function ensureSafePublishRegistry(project: ProjectContext, registryUrl: string): void {
  const publishRegistry = normalizeRegistry(project.packageJson.publishConfig?.registry);
  if (!publishRegistry) {
    return;
  }

  if (publishRegistry !== normalizeRegistry(registryUrl)) {
    throw new Error(
      `package.json publishConfig.registry points to ${publishRegistry}. Package Ninja will not publish to a non-local registry.`
    );
  }
}

export async function loadProjectContext(rootDir: string, preferredPackageManager?: PackageManager): Promise<ProjectContext> {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    throw new Error("No package.json found in this directory.");
  }

  let packageJson: PackageJsonShape;
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(raw) as PackageJsonShape;
  } catch {
    throw new Error("Could not read package.json.");
  }

  const detection = await detectPackageManager(rootDir, preferredPackageManager);

  return {
    rootDir,
    packageManager: detection.packageManager,
    packageManagerSource: detection.source,
    packageJsonPath,
    packageJson,
    lockfileName: detection.lockfileName,
    hasNodeModules: await pathExists(path.join(rootDir, "node_modules")),
    hasDeclaredDependencies: hasDeclaredDependencies(packageJson)
  };
}

export function resolveScriptName(
  project: ProjectContext,
  defaultScriptName: "dev" | "test",
  overrideScriptName?: string
): string {
  const targetScriptName = overrideScriptName ?? defaultScriptName;

  if (project.packageJson.scripts?.[targetScriptName]) {
    return targetScriptName;
  }

  throw new Error(`No "${targetScriptName}" script found in package.json.`);
}

export function decideInstallBeforeDev(project: ProjectContext, installMode: InstallMode): InstallDecision {
  if (installMode === "always") {
    return {
      shouldInstall: true,
      message: "Dependencies: installing because --install was provided."
    };
  }

  if (installMode === "never") {
    return {
      shouldInstall: false,
      message: "Dependencies: skipping install because --no-install was provided."
    };
  }

  if (!project.hasNodeModules && project.hasDeclaredDependencies) {
    return {
      shouldInstall: true,
      message: "Dependencies: installing because node_modules is missing."
    };
  }

  if (!project.hasNodeModules && !project.hasDeclaredDependencies && project.lockfileName) {
    return {
      shouldInstall: false,
      message: "Dependencies: up to date."
    };
  }

  if (!project.lockfileName) {
    return {
      shouldInstall: true,
      message: "Dependencies: installing because no recognized lockfile was found."
    };
  }

  return {
    shouldInstall: false,
    message: "Dependencies: up to date."
  };
}

export function buildInstallCommand(project: ProjectContext, args: string[]): ProjectCommand {
  return {
    command: project.packageManager,
    args: ["install", ...args]
  };
}

export function buildPublishCommand(project: ProjectContext, args: string[]): ProjectCommand {
  if (project.packageManager === "yarn") {
    if (usesModernYarn(project.packageJson.packageManager)) {
      return {
        command: "yarn",
        args: ["npm", "publish", ...args]
      };
    }

    return {
      command: "yarn",
      args: ["publish", ...args]
    };
  }

  return {
    command: project.packageManager,
    args: ["publish", ...args]
  };
}

export function buildScriptCommand(
  project: ProjectContext,
  scriptName: string,
  args: string[],
  defaultScriptName?: "dev" | "test"
): ProjectCommand {
  const isDefaultScript = defaultScriptName !== undefined && scriptName === defaultScriptName;

  if (project.packageManager === "npm") {
    if (isDefaultScript && scriptName === "test") {
      return {
        command: "npm",
        args: ["test", ...(args.length > 0 ? ["--", ...args] : [])]
      };
    }

    return {
      command: "npm",
      args: ["run", scriptName, ...(args.length > 0 ? ["--", ...args] : [])]
    };
  }

  if (project.packageManager === "yarn") {
    if (isDefaultScript) {
      return {
        command: "yarn",
        args: [scriptName, ...args]
      };
    }

    return {
      command: "yarn",
      args: ["run", scriptName, ...args]
    };
  }

  if (isDefaultScript) {
    return {
      command: "pnpm",
      args: [scriptName, ...args]
    };
  }

  return {
    command: "pnpm",
    args: ["run", scriptName, ...(args.length > 0 ? ["--", ...args] : [])]
  };
}

async function detectPackageManager(
  rootDir: string,
  preferredPackageManager?: PackageManager
): Promise<{
  packageManager: PackageManager;
  source: PackageManagerSource;
  lockfileName: ProjectContext["lockfileName"];
}> {
  if (preferredPackageManager) {
    return {
      packageManager: preferredPackageManager,
      source: "override",
      lockfileName: await findLockfile(rootDir)
    };
  }

  if (await pathExists(path.join(rootDir, "pnpm-lock.yaml"))) {
    return {
      packageManager: "pnpm",
      source: "pnpm-lock.yaml",
      lockfileName: "pnpm-lock.yaml"
    };
  }

  if (await pathExists(path.join(rootDir, "yarn.lock"))) {
    return {
      packageManager: "yarn",
      source: "yarn.lock",
      lockfileName: "yarn.lock"
    };
  }

  if (await pathExists(path.join(rootDir, "package-lock.json"))) {
    return {
      packageManager: "npm",
      source: "package-lock.json",
      lockfileName: "package-lock.json"
    };
  }

  return {
    packageManager: "npm",
    source: "fallback",
    lockfileName: null
  };
}

async function findLockfile(rootDir: string): Promise<ProjectContext["lockfileName"]> {
  if (await pathExists(path.join(rootDir, "pnpm-lock.yaml"))) {
    return "pnpm-lock.yaml";
  }

  if (await pathExists(path.join(rootDir, "yarn.lock"))) {
    return "yarn.lock";
  }

  if (await pathExists(path.join(rootDir, "package-lock.json"))) {
    return "package-lock.json";
  }

  return null;
}

function usesModernYarn(packageManagerField: string | undefined): boolean {
  if (!packageManagerField) {
    return false;
  }

  const [, version] = packageManagerField.split("@");
  if (!version) {
    return false;
  }

  return !version.startsWith("1.");
}

function hasDeclaredDependencies(packageJson: PackageJsonShape): boolean {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies
  ].some((section) => section !== undefined && Object.keys(section).length > 0);
}

function normalizeRegistry(registry: string | undefined): string | null {
  if (!registry) {
    return null;
  }

  return registry.replace(/\/+$/, "");
}
