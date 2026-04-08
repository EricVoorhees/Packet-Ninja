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
import { runSpinnerTask } from "./spinner.js";
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

function reportState(
  reporter: ProjectExecutionReporter,
  state: string,
  details: Record<string, string | number | boolean | undefined> = {}
): void {
  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" | ");

  if (detailText.length === 0) {
    reporter.line(`State: ${state}`);
    return;
  }

  reporter.line(`State: ${state} | ${detailText}`);
}

export async function executeProjectCommand(
  commandName: ProjectCommandName,
  options: ProjectExecutionOptions,
  reporter: ProjectExecutionReporter
): Promise<ProjectExecutionResult> {
  reportState(reporter, "project.inspecting", { command: commandName, root: options.cwd });
  const project = await loadProjectContext(options.cwd, options.packageManager);
  reportState(reporter, "project.ready", {
    manager: project.packageManager,
    managerSource: project.packageManagerSource,
    root: project.rootDir
  });

  reportState(reporter, "session.preparing", {
    persistent: options.persistent,
    offline: options.offline
  });

  const lease = await runSpinnerTask(
    "Preparing local registry session...",
    async () =>
      await acquireSession({
        rootDir: options.cwd,
        port: options.port,
        persistent: options.persistent,
        offline: options.offline
      }),
    {
      fallbackLine: reporter.line.bind(reporter),
      successMessage: "Local registry session ready"
    }
  );

  const sessionMode = lease.state.persistent ? "persistent" : "ephemeral";
  reportState(reporter, lease.owned ? "session.started" : "session.reused", {
    registry: lease.state.registryUrl,
    mode: sessionMode
  });

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
        reportState(reporter, "command.start", { name: "install", manager: project.packageManager });
        reporter.line("Running install...");
        const command = buildInstallCommand(project, options.passthroughArgs);
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        reportState(reporter, "command.done", { name: "install", exitCode });
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

        reportState(reporter, "command.start", { name: scriptName, manager: project.packageManager });
        reporter.line(`Running ${scriptName}...`);
        const command = buildScriptCommand(project, scriptName, options.passthroughArgs, "dev");
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        reportState(reporter, "command.done", { name: scriptName, exitCode });
        break;
      }

      case "test": {
        const scriptName = resolveScriptName(project, "test", options.scriptName);
        reportState(reporter, "command.start", { name: scriptName, manager: project.packageManager });
        reporter.line(`Running ${scriptName}...`);
        const command = buildScriptCommand(project, scriptName, options.passthroughArgs, "test");
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        reportState(reporter, "command.done", { name: scriptName, exitCode });
        break;
      }

      case "publish": {
        ensureSafePublishRegistry(project, lease.state.registryUrl);
        reportState(reporter, "command.start", { name: "publish", manager: project.packageManager });
        reporter.line("Running publish...");
        reporter.line(`Target registry: ${lease.state.registryUrl}`);
        const command = buildPublishCommand(project, options.passthroughArgs);
        exitCode = await runCommandInSession(lease.state, command.command, command.args, { cwd: project.rootDir });
        reportState(reporter, "command.done", { name: "publish", exitCode });
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
      reportState(reporter, "session.stopped", { registry: lease.state.registryUrl });
      reporter.line("Package Ninja stopped.");
    } else if (lease.owned && lease.state.persistent) {
      reportState(reporter, "session.idle", { registry: lease.state.registryUrl, mode: "persistent" });
      reporter.line("Session kept active for reuse. Run `package-ninja stop` when finished.");
    }
  }
}
