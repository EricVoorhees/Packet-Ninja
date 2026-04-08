#!/usr/bin/env node

import { readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface CommandWorkerManifest {
  command: string;
  args: string[];
  cwd: string;
  envEntries: Array<{ name: string; value: string }>;
  parentPid: number;
}

const INTERRUPT_SIGNALS: InterruptSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const COMMAND_CHILD_PID_ENV = "PACKAGE_NINJA_INTERNAL_COMMAND_CHILD_PID_PATH";
const WINDOWS_JOB_WRAPPER = String.raw`
param([string]$ManifestPath)

$ErrorActionPreference = "Stop"
$manifest = Get-Content -Path $ManifestPath -Raw | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PackageNinjaJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr job, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, IntPtr returnLength);

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public IntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public Int64 TotalUserTime;
    public Int64 TotalKernelTime;
    public Int64 ThisPeriodTotalUserTime;
    public Int64 ThisPeriodTotalKernelTime;
    public UInt32 TotalPageFaultCount;
    public UInt32 TotalProcesses;
    public UInt32 ActiveProcesses;
    public UInt32 TotalTerminatedProcesses;
  }

  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000;
    int length = Marshal.SizeOf(info);
    IntPtr ptr = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      if (!SetInformationJobObject(job, 9, ptr, (uint)length)) {
        throw new InvalidOperationException("SetInformationJobObject failed.");
      }
    } finally {
      Marshal.FreeHGlobal(ptr);
    }

    return job;
  }

  public static UInt32 GetActiveProcessCount(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
    int length = Marshal.SizeOf(info);
    IntPtr ptr = Marshal.AllocHGlobal(length);
    try {
      if (!QueryInformationJobObject(job, 1, ptr, (uint)length, IntPtr.Zero)) {
        throw new InvalidOperationException("QueryInformationJobObject failed.");
      }

      info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(ptr, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      return info.ActiveProcesses;
    } finally {
      Marshal.FreeHGlobal(ptr);
    }
  }
}
"@

function Quote-CmdArgument([string]$arg) {
  if ($arg.Length -eq 0) {
    return '""'
  }

  if ($arg -notmatch '[\s"&|<>^()]') {
    return $arg
  }

  $escaped = $arg -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

$commandParts = @([string]$manifest.command)
foreach ($item in $manifest.args) {
  $commandParts += [string]$item
}

$cmdLine = ($commandParts | ForEach-Object { Quote-CmdArgument $_ }) -join " "

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = '/d /s /c "' + $cmdLine + '"'
$psi.WorkingDirectory = [string]$manifest.cwd
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $false
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false

foreach ($entry in $manifest.envEntries) {
  if ($null -ne $entry.value) {
    $psi.Environment[[string]$entry.name] = [string]$entry.value
  }
}

$job = [PackageNinjaJob]::CreateKillOnCloseJob()
try {
  $process = [System.Diagnostics.Process]::Start($psi)
  if ($null -eq $process) {
    throw "Failed to start wrapped command."
  }

  if (-not [PackageNinjaJob]::AssignProcessToJobObject($job, $process.Handle)) {
    throw "AssignProcessToJobObject failed."
  }

  while (-not $process.HasExited) {
    Start-Sleep -Milliseconds 100
  }

  while ([PackageNinjaJob]::GetActiveProcessCount($job) -gt 0) {
    Start-Sleep -Milliseconds 100
  }

  exit $process.ExitCode
} finally {
  [PackageNinjaJob]::CloseHandle($job) | Out-Null
}
`;

async function main(): Promise<void> {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) {
    throw new Error("command-worker requires <manifestPath>.");
  }

  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as CommandWorkerManifest;
  const commandEnv = Object.fromEntries(manifest.envEntries.map((entry) => [entry.name, entry.value]));
  const wrapperPath = path.join(path.dirname(manifestPath), `command-job-${process.pid}.ps1`);
  if (process.platform === "win32") {
    await writeFile(wrapperPath, WINDOWS_JOB_WRAPPER, "utf8");
  }

  const child =
    process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapperPath, manifestPath], {
          cwd: manifest.cwd,
          stdio: "inherit",
          windowsHide: true,
          env: commandEnv
        })
      : spawn(manifest.command, manifest.args, {
          cwd: manifest.cwd,
          stdio: "inherit",
          shell: true,
          windowsHide: false,
          env: commandEnv
        });

  await maybeWriteInternalPid(COMMAND_CHILD_PID_ENV, child.pid ?? -1);

  let childExited = false;
  let observedInterrupt: InterruptSignal | null = null;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;
  const signalHandlers = new Map<InterruptSignal, () => void>();

  const parentMonitor = setInterval(() => {
    if (!isProcessRunning(manifest.parentPid)) {
      if (observedInterrupt === null) {
        observedInterrupt = "SIGTERM";
      }

      if (child.pid !== undefined) {
        void forceStopCommandChild(child.pid);
      }
    }
  }, 500);
  parentMonitor.unref();

  const cleanup = (): void => {
    clearInterval(parentMonitor);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }

    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
    process.off("exit", processExitHandler);
    if (process.platform === "win32") {
      void rm(wrapperPath, { force: true }).catch(() => {});
    }
  };

  const processExitHandler = (): void => {
    if (!child.pid || childExited) {
      return;
    }

    forceStopCommandChildSync(child.pid);
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
      }

      if (child.pid === undefined) {
        return;
      }

      if (process.platform === "win32") {
        void forceStopCommandChild(child.pid);
        return;
      }

      void forwardSignalToCommandChild(child.pid, signal);
      scheduleForceKill();
    };

    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  process.on("exit", processExitHandler);

  child.once("error", (error) => {
    cleanup();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Package Ninja command worker error: ${message}`);
    process.exit(1);
  });

  child.once("exit", async (code, signal) => {
    childExited = true;
    childExitCode = (code as number | null) ?? null;
    childExitSignal = (signal as NodeJS.Signals | null) ?? null;
    cleanup();

    if (observedInterrupt) {
      process.exit(signalToExitCode(observedInterrupt));
    }

    if (childExitSignal) {
      process.exit(signalToExitCode(childExitSignal));
    }

    process.exit(childExitCode ?? 0);
  });
}

async function maybeWriteInternalPid(envName: string, pid: number): Promise<void> {
  const targetPath = process.env[envName];
  if (!targetPath || pid <= 0) {
    return;
  }

  await writeFile(targetPath, `${pid}\n`, "utf8");
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

async function forwardSignalToCommandChild(pid: number, signal: InterruptSignal): Promise<void> {
  if (!isProcessRunning(pid)) {
    return;
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Ignore delivery failures and let the forced cleanup path handle it.
  }
}

async function forceStopCommandChild(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await killWindowsProcessTree(pid);
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 2_000);
  } catch {
    // Ignore cleanup failures during forced shutdown.
  }
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

async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });

  await waitForExit(pid, 2_000);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return;
    }

    await delay(100);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Package Ninja command worker failed: ${message}`);
  process.exit(1);
});
