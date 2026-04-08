package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"time"
)

const commandChildPIDEnv = "PACKAGE_NINJA_INTERNAL_COMMAND_CHILD_PID_PATH"

type commandWorkerManifest struct {
	Command    string       `json:"command"`
	Args       []string     `json:"args"`
	Cwd        string       `json:"cwd"`
	EnvEntries []manifestKV `json:"envEntries"`
	ParentPID  int          `json:"parentPid"`
}

type manifestKV struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type namedSignal string

func (s namedSignal) Signal() {}

func (s namedSignal) String() string {
	return string(s)
}

type managedProcess struct {
	command      *exec.Cmd
	pid          int
	forward      func(os.Signal)
	forceKill    func()
	waitForDrain func(time.Duration)
	close        func()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "Package Ninja command worker failed: %s\n", err.Error())
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New("command-worker-go requires <manifestPath>")
	}

	manifestPath := os.Args[1]
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return err
	}

	managed, err := startManagedProcess(manifest)
	if err != nil {
		return err
	}
	defer managed.close()

	_ = maybeWriteInternalPID(commandChildPIDEnv, managed.pid)

	signalCh := make(chan os.Signal, 4)
	registerInterruptSignals(signalCh)
	defer signal.Stop(signalCh)

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- managed.command.Wait()
	}()

	var (
		mu         sync.Mutex
		observed   os.Signal
		forceTimer *time.Timer
	)

	recordInterrupt := func(sig os.Signal) bool {
		mu.Lock()
		defer mu.Unlock()

		if observed == nil {
			observed = sig
			return true
		}

		return false
	}

	currentInterrupt := func() os.Signal {
		mu.Lock()
		defer mu.Unlock()
		return observed
	}

	scheduleForceKill := func() {
		mu.Lock()
		defer mu.Unlock()

		if forceTimer != nil {
			return
		}

		forceTimer = time.AfterFunc(1500*time.Millisecond, func() {
			managed.forceKill()
		})
	}

	parentDeadCh := make(chan struct{}, 1)
	go monitorParent(manifest.ParentPID, parentDeadCh)

	for {
		select {
		case sig := <-signalCh:
			if sig == nil {
				continue
			}

			first := recordInterrupt(sig)
			if first {
				if supportsGracefulForward() {
					managed.forward(sig)
					scheduleForceKill()
				} else {
					managed.forceKill()
				}
				continue
			}

			managed.forceKill()

		case <-parentDeadCh:
			if recordInterrupt(defaultTerminationSignal()) {
				managed.forceKill()
			}

		case waitErr := <-waitCh:
			if forceTimer != nil {
				forceTimer.Stop()
			}

			managed.waitForDrain(2 * time.Second)
			return exitWithCode(waitErr, managed.command.ProcessState, currentInterrupt())
		}
	}
}

func readManifest(manifestPath string) (commandWorkerManifest, error) {
	absolutePath, err := filepath.Abs(manifestPath)
	if err != nil {
		return commandWorkerManifest{}, err
	}

	payload, err := os.ReadFile(absolutePath)
	if err != nil {
		return commandWorkerManifest{}, err
	}

	var manifest commandWorkerManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return commandWorkerManifest{}, err
	}

	if manifest.Command == "" {
		return commandWorkerManifest{}, errors.New("manifest.command is required")
	}

	if manifest.Cwd == "" {
		return commandWorkerManifest{}, errors.New("manifest.cwd is required")
	}

	return manifest, nil
}

func maybeWriteInternalPID(envName string, pid int) error {
	if pid <= 0 {
		return nil
	}

	targetPath := os.Getenv(envName)
	if targetPath == "" {
		return nil
	}

	return os.WriteFile(targetPath, []byte(fmt.Sprintf("%d\n", pid)), 0o644)
}

func monitorParent(parentPID int, parentDeadCh chan<- struct{}) {
	if parentPID <= 0 {
		return
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		if isProcessRunning(parentPID) {
			continue
		}

		select {
		case parentDeadCh <- struct{}{}:
		default:
		}
		return
	}
}

func exitWithCode(waitErr error, state *os.ProcessState, observed os.Signal) error {
	if observed != nil {
		os.Exit(signalToExitCode(observed))
	}

	if state != nil {
		if exitSignal := processExitSignal(state); exitSignal != nil {
			os.Exit(signalToExitCode(exitSignal))
		}

		if exitCode := state.ExitCode(); exitCode >= 0 {
			os.Exit(exitCode)
		}
	}

	if waitErr != nil {
		os.Exit(1)
	}

	os.Exit(0)
	return nil
}

func signalToExitCode(sig os.Signal) int {
	name := sig.String()

	switch name {
	case "SIGINT", "interrupt":
		return 130
	case "SIGTERM", "terminated":
		return 143
	case "SIGHUP", "hangup":
		return 129
	default:
		return 1
	}
}
