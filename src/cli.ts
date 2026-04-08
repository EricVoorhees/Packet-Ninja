#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { InstallMode, PackageManager } from "./project.js";
import { formatStatus, readStatus, runWithSession, startSession, stopSession } from "./session.js";
import { runSpinnerTask } from "./spinner.js";
import { executeProjectCommand } from "./workflow.js";

type CommandName = "start" | "run" | "stop" | "status" | "install" | "dev" | "test" | "publish" | "help";

interface ParsedCommand {
  command: CommandName;
  rootDir: string;
  persistent: boolean;
  offline: boolean;
  packageManager?: PackageManager;
  scriptName?: string;
  installMode: InstallMode;
  port?: number;
  childCommand?: string;
  childArgs: string[];
}

const HEADER = `
Package Ninja
=============
`;

export async function main(): Promise<void> {
  const parsed = parseCommand(process.argv.slice(2));

  switch (parsed.command) {
    case "start": {
      printHeader();
      console.log(`State: session.starting | root=${parsed.rootDir}`);
      const state = await runSpinnerTask(
        "Starting Package Ninja session...",
        async () => await startSession(parsed),
        {
          fallbackLine: (message) => {
            console.log(message);
          },
          successMessage: "Package Ninja session ready"
        }
      );
      console.log(`State: session.ready | registry=${state.registryUrl} | mode=${state.persistent ? "persistent" : "ephemeral"}`);
      console.log("Package Ninja active");
      console.log(`Registry: ${state.registryUrl}`);
      console.log(`Mode: ${state.persistent ? "persistent" : "ephemeral"}`);
      console.log(`PID: ${state.pid}`);
      return;
    }

    case "run": {
      if (!parsed.childCommand) {
        throw new Error("`package-ninja run` requires a command after `--`.");
      }

      const result = await runWithSession(parsed, parsed.childCommand, parsed.childArgs, { cwd: parsed.rootDir });
      process.exitCode = result.exitCode;
      return;
    }

    case "install": {
      printHeader();
      const result = await executeProjectCommand(
        "install",
        {
          cwd: parsed.rootDir,
          rootDir: parsed.rootDir,
          persistent: parsed.persistent,
          offline: parsed.offline,
          packageManager: parsed.packageManager,
          installMode: parsed.installMode,
          passthroughArgs: parsed.childArgs,
          port: parsed.port
        },
        consoleReporter
      );
      process.exitCode = result.exitCode;
      return;
    }

    case "dev": {
      printHeader();
      const result = await executeProjectCommand(
        "dev",
        {
          cwd: parsed.rootDir,
          rootDir: parsed.rootDir,
          persistent: parsed.persistent,
          offline: parsed.offline,
          packageManager: parsed.packageManager,
          scriptName: parsed.scriptName,
          installMode: parsed.installMode,
          passthroughArgs: parsed.childArgs,
          port: parsed.port
        },
        consoleReporter
      );
      process.exitCode = result.exitCode;
      return;
    }

    case "test": {
      printHeader();
      const result = await executeProjectCommand(
        "test",
        {
          cwd: parsed.rootDir,
          rootDir: parsed.rootDir,
          persistent: parsed.persistent,
          offline: parsed.offline,
          packageManager: parsed.packageManager,
          scriptName: parsed.scriptName,
          installMode: parsed.installMode,
          passthroughArgs: parsed.childArgs,
          port: parsed.port
        },
        consoleReporter
      );
      process.exitCode = result.exitCode;
      return;
    }

    case "publish": {
      printHeader();
      const result = await executeProjectCommand(
        "publish",
        {
          cwd: parsed.rootDir,
          rootDir: parsed.rootDir,
          persistent: parsed.persistent,
          offline: parsed.offline,
          packageManager: parsed.packageManager,
          installMode: parsed.installMode,
          passthroughArgs: parsed.childArgs,
          port: parsed.port
        },
        consoleReporter
      );
      process.exitCode = result.exitCode;
      return;
    }

    case "stop": {
      console.log(`State: session.stopping | root=${parsed.rootDir}`);
      const stopped = await stopSession(parsed.rootDir);
      if (!stopped) {
        console.log("State: session.idle");
        console.log("Package Ninja is not running.");
        return;
      }

      console.log(`State: session.stopped | registry=${stopped.registryUrl}`);
      console.log("Package Ninja stopped.");
      console.log(`Registry: ${stopped.registryUrl}`);
      return;
    }

    case "status": {
      printHeader();
      const status = await readStatus(parsed.rootDir);
      console.log(formatStatus(status));
      return;
    }

    case "help":
    default:
      printHelp();
  }
}

export function parseCommand(argv: string[]): ParsedCommand {
  const commandName = (argv[0] ?? "help") as CommandName;
  const supportedCommands: CommandName[] = [
    "start",
    "run",
    "stop",
    "status",
    "install",
    "dev",
    "test",
    "publish",
    "help"
  ];

  if (!supportedCommands.includes(commandName)) {
    throw new Error(`Unknown command: ${argv[0]}`);
  }

  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex === -1 ? argv.slice(1) : argv.slice(1, separatorIndex);
  const passthroughArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);

  let rootDir = process.cwd();
  let persistent = false;
  let offline = false;
  let packageManager: PackageManager | undefined;
  let scriptName: string | undefined;
  let installMode: InstallMode = "auto";
  let port: number | undefined;

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];

    if (option === "--cwd" || option === "--root") {
      const value = optionArgs[index + 1];
      if (!value) {
        throw new Error(`Expected a path after ${option}.`);
      }

      rootDir = path.resolve(value);
      index += 1;
      continue;
    }

    if (option === "--port") {
      const value = optionArgs[index + 1];
      if (!value) {
        throw new Error("Expected a port number after --port.");
      }

      const numericPort = Number.parseInt(value, 10);
      if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65_535) {
        throw new Error(`Invalid port: ${value}`);
      }

      port = numericPort;
      index += 1;
      continue;
    }

    if (option === "--persistent") {
      persistent = true;
      continue;
    }

    if (option === "--offline") {
      offline = true;
      continue;
    }

    if (option === "--pm" || option === "--package-manager") {
      const value = optionArgs[index + 1];
      if (value !== "npm" && value !== "pnpm" && value !== "yarn") {
        throw new Error(`Expected npm, pnpm, or yarn after ${option}.`);
      }

      packageManager = value;
      index += 1;
      continue;
    }

    if (option === "--script") {
      const value = optionArgs[index + 1];
      if (!value) {
        throw new Error("Expected a script name after --script.");
      }

      scriptName = value;
      index += 1;
      continue;
    }

    if (option === "--install") {
      if (installMode === "never") {
        throw new Error("Cannot use --install and --no-install together.");
      }

      installMode = "always";
      continue;
    }

    if (option === "--no-install") {
      if (installMode === "always") {
        throw new Error("Cannot use --install and --no-install together.");
      }

      installMode = "never";
      continue;
    }

    throw new Error(`Unknown option: ${option}`);
  }

  validateCommandOptions(commandName, scriptName, installMode);

  return {
    command: commandName,
    rootDir,
    persistent,
    offline,
    packageManager,
    scriptName,
    installMode,
    port,
    childCommand: commandName === "run" ? passthroughArgs[0] : undefined,
    childArgs: commandName === "run" ? passthroughArgs.slice(1) : passthroughArgs
  };
}

function validateCommandOptions(commandName: CommandName, scriptName: string | undefined, installMode: InstallMode): void {
  if (scriptName && commandName !== "dev" && commandName !== "test") {
    throw new Error("--script only applies to `package-ninja dev` and `package-ninja test`.");
  }

  if (installMode !== "auto" && commandName !== "dev") {
    throw new Error("--install and --no-install only apply to `package-ninja dev`.");
  }
}

function printHelp(): void {
  console.log(`Package Ninja

Zero-config local registry sessions for npm, pnpm, and yarn.

Usage
  package-ninja <command> [options] [-- <args>]

Commands
  package-ninja start [--cwd <path>]
  package-ninja run [--cwd <path>] -- <command>
  package-ninja install [--cwd <path>] [--pm npm|pnpm|yarn] [-- <args>]
  package-ninja dev [--cwd <path>] [--pm npm|pnpm|yarn] [--script <name>] [--install|--no-install] [-- <args>]
  package-ninja test [--cwd <path>] [--pm npm|pnpm|yarn] [--script <name>] [-- <args>]
  package-ninja publish [--cwd <path>] [--pm npm|pnpm|yarn] [-- <args>]
  package-ninja status [--cwd <path>]
  package-ninja stop [--cwd <path>]
  package-ninja help

Flags
  --cwd <path>                 Target project directory (default: current directory)
  --pm <npm|pnpm|yarn>         Override package manager detection
  --script <name>              Override script name for dev/test
  --install                    Force install before dev
  --no-install                 Skip install before dev
  --port <number>              Preferred local registry port
  --persistent                 Keep a reusable local session after command completion
  --offline                    Disable npmjs uplink

Examples
  package-ninja start
  package-ninja run -- npm install
  package-ninja install
  package-ninja install --persistent
  package-ninja dev
  package-ninja dev --install
  package-ninja dev --script dev:frontend --cwd apps\\web
  package-ninja test -- --watch
  package-ninja publish -- --tag next
  package-ninja run -- pnpm test
  package-ninja stop`);
}

const consoleReporter = {
  line(message: string): void {
    console.log(message);
  }
};

function printHeader(): void {
  console.log(HEADER);
}

if (isDirectExecution()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${normalizeErrorMessage(message)}`);
    process.exitCode = 1;
  });
}

function normalizeErrorMessage(message: string): string {
  if (message.includes("Package Ninja will not publish to a non-local registry")) {
    return "Publish blocked: external publishConfig.registry detected.";
  }

  if (message.includes("Registry worker exited before signaling readiness.")) {
    return "Failed to start Package Ninja session.";
  }

  if (message.includes("Registry readiness timed out.")) {
    return "Failed to start Package Ninja session.";
  }

  if (message.includes("Unknown command:")) {
    return `${message}. Run "package-ninja help" for usage.`;
  }

  return message;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}
