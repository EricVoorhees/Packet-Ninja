import {
  buildInstallCommand,
  buildPublishCommand,
  buildScriptCommand,
  decideInstallBeforeDev,
  ensureSafePublishRegistry,
  InstallMode,
  loadProjectContext,
  PackageManager,
  resolveScriptName
} from "./project.js";
import { acquireSession, runCommandInSession, SessionOptions } from "./session.js";
import { SessionState } from "./state.js";

export type ProjectCommandName = "install" | "dev" | "test" | "publish";

export interface ProjectExecutionOptions extends SessionOptions {
  cwd: string;
  packageManager?: PackageManager;
  scriptName?: string;
  installMode: InstallMode;
  passthroughArgs: string[];
}

export interface ProjectExecutionReporter {
  line(message: string): void;
}

export interface ProjectExecutionResult {
  exitCode: number;
  sessionState: SessionState;
  reusedSession: boolean;
}

export async function executeProjectCommand(
  commandName: ProjectCommandName,
  options: ProjectExecutionOptions,
  reporter: ProjectExecutionReporter
): Promise<ProjectExecutionResult> {
  const project = await loadProjectContext(options.cwd, options.packageManager);
  const lease = await acquireSession({
    rootDir: options.cwd,
    port: options.port,
    persistent: options.persistent,
    offline: options.offline
  });

  const sessionMode = lease.state.persistent ? "persistent" : "ephemeral";

  reporter.line("Package Ninja active");
  reporter.line(`Registry: ${lease.state.registryUrl}`);
  reporter.line(`Package manager: ${project.packageManager}`);
  reporter.line(`Mode: ${sessionMode}`);

  if (!lease.owned) {
    reporter.line("Reusing active registry session.");
  }

  if (project.packageManagerSource === "fallback") {
    reporter.line("Could not determine package manager. Falling back to npm.");
  }

  let exitCode = 0;

  try {
    switch (commandName) {
      case "install": {
        reporter.line("Running install...");
        const command = buildInstallCommand(project, options.passthroughArgs);
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        break;
      }

      case "dev": {
        const scriptName = resolveScriptName(project, "dev", options.scriptName);
        const installDecision = decideInstallBeforeDev(project, options.installMode);
        reporter.line(installDecision.message);

        if (installDecision.shouldInstall) {
          const installCommand = buildInstallCommand(project, []);
          exitCode = await runCommandInSession(lease.state, installCommand.command, installCommand.args, {
            cwd: project.rootDir
          });

          if (exitCode !== 0) {
            return {
              exitCode,
              sessionState: lease.state,
              reusedSession: !lease.owned
            };
          }
        }

        reporter.line(`Running ${scriptName}...`);
        const command = buildScriptCommand(project, scriptName, options.passthroughArgs, "dev");
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        break;
      }

      case "test": {
        const scriptName = resolveScriptName(project, "test", options.scriptName);
        reporter.line(`Running ${scriptName}...`);
        const command = buildScriptCommand(project, scriptName, options.passthroughArgs, "test");
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        break;
      }

      case "publish": {
        ensureSafePublishRegistry(project, lease.state.registryUrl);
        reporter.line("Running publish...");
        reporter.line(`Target registry: ${lease.state.registryUrl}`);
        const command = buildPublishCommand(project, options.passthroughArgs);
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        break;
      }
    }

    return {
      exitCode,
      sessionState: lease.state,
      reusedSession: !lease.owned
    };
  } finally {
    await lease.release();
    if (lease.shouldStopOnRelease) {
      reporter.line("Package Ninja stopped.");
    } else if (lease.owned && lease.state.persistent) {
      reporter.line("Session kept active for reuse. Run `package-ninja stop` when finished.");
    }
  }
}
