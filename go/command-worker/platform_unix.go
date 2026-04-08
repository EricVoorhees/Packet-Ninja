//go:build !windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func startManagedProcess(manifest commandWorkerManifest) (*managedProcess, error) {
	command := exec.Command(manifest.Command, manifest.Args...)
	command.Dir = manifest.Cwd
	command.Env = manifestEnvironment(manifest.EnvEntries)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}

	if err := command.Start(); err != nil {
		return nil, err
	}

	pid := command.Process.Pid
	return &managedProcess{
		command: command,
		pid:     pid,
		forward: func(sig os.Signal) {
			unixSignal := normalizeUnixSignal(sig)
			_ = syscall.Kill(-pid, unixSignal)
		},
		forceKill: func() {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		},
		waitForDrain: func(_ time.Duration) {
			// No extra drain behavior required on Unix after Wait().
		},
		close: func() {},
	}, nil
}

func registerInterruptSignals(signalCh chan os.Signal) {
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
}

func supportsGracefulForward() bool {
	return true
}

func defaultTerminationSignal() os.Signal {
	return namedSignal("SIGTERM")
}

func processExitSignal(state *os.ProcessState) os.Signal {
	if state == nil {
		return nil
	}

	waitStatus, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !waitStatus.Signaled() {
		return nil
	}

	return waitStatus.Signal()
}

func isProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}

	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func manifestEnvironment(entries []manifestKV) []string {
	env := make([]string, 0, len(entries))
	for _, entry := range entries {
		env = append(env, entry.Name+"="+entry.Value)
	}
	return env
}

func normalizeUnixSignal(sig os.Signal) syscall.Signal {
	switch sig.String() {
	case "SIGHUP", "hangup":
		return syscall.SIGHUP
	case "SIGTERM", "terminated":
		return syscall.SIGTERM
	default:
		return syscall.SIGINT
	}
}
