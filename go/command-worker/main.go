package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	commandChildPIDEnv = "PACKAGE_NINJA_INTERNAL_COMMAND_CHILD_PID_PATH"
	entryModeFlag      = "--entry"
)

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

type entryInvocation struct {
	rawArgs         []string
	command         string
	rootDir         string
	managerOverride string
	scriptName      string
	commandArgs     []string
	passthroughArgs []string
}

type entrySessionState struct {
	RegistryURL string `json:"registryUrl"`
	NpmrcPath   string `json:"npmrcPath"`
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
		return errors.New("command-worker-go requires <manifestPath> or --entry -- <args>")
	}

	if os.Args[1] == entryModeFlag {
		return runEntryMode(os.Args[2:])
	}

	manifestPath := os.Args[1]
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return err
	}

	return executeManifest(manifest)
}

func runEntryMode(entryArgs []string) error {
	invocation, err := parseEntryInvocation(entryArgs)
	if err != nil {
		return runNodeFallback(entryArgs, ".")
	}

	state, hasState, err := readEntrySessionState(invocation.rootDir)
	if err != nil {
		return err
	}

	if !hasState {
		return runNodeFallback(invocation.rawArgs, invocation.rootDir)
	}

	manager := detectPackageManager(invocation.rootDir, invocation.managerOverride)
	manifest, handled := buildEntryManifest(invocation, state, manager)
	if !handled {
		return runNodeFallback(invocation.rawArgs, invocation.rootDir)
	}

	return executeManifest(manifest)
}

func parseEntryInvocation(entryArgs []string) (entryInvocation, error) {
	raw := normalizeEntryArgs(entryArgs)
	if len(raw) == 0 {
		return entryInvocation{}, errors.New("missing entry arguments")
	}

	rootDir, err := os.Getwd()
	if err != nil {
		return entryInvocation{}, err
	}

	if absolute, absErr := filepath.Abs(rootDir); absErr == nil {
		rootDir = absolute
	}

	invocation := entryInvocation{
		rawArgs: append([]string{}, raw...),
		command: raw[0],
		rootDir: rootDir,
	}

	for index := 1; index < len(raw); index += 1 {
		token := raw[index]
		if token == "--" {
			invocation.passthroughArgs = append(invocation.passthroughArgs, raw[index+1:]...)
			break
		}

		switch token {
		case "--cwd", "--root":
			if index+1 >= len(raw) {
				break
			}

			resolvedPath := raw[index+1]
			index += 1
			if absolute, absErr := filepath.Abs(resolvedPath); absErr == nil {
				invocation.rootDir = absolute
			}

		case "--pm", "--package-manager":
			if index+1 >= len(raw) {
				break
			}

			invocation.managerOverride = strings.ToLower(strings.TrimSpace(raw[index+1]))
			index += 1

		case "--script":
			if index+1 >= len(raw) {
				break
			}

			invocation.scriptName = strings.TrimSpace(raw[index+1])
			index += 1

		case "--port":
			if index+1 < len(raw) {
				index += 1
			}

		case "--persistent", "--offline", "--install", "--no-install":
			// Accepted wrapper flags; no direct effect in entry mode.
		default:
			invocation.commandArgs = append(invocation.commandArgs, token)
		}
	}

	return invocation, nil
}

func normalizeEntryArgs(entryArgs []string) []string {
	if len(entryArgs) == 0 {
		return []string{}
	}

	if entryArgs[0] == "--" {
		return append([]string{}, entryArgs[1:]...)
	}

	return append([]string{}, entryArgs...)
}

func readEntrySessionState(rootDir string) (entrySessionState, bool, error) {
	statePath := filepath.Join(rootDir, ".package-ninja", "state.json")
	payload, err := os.ReadFile(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return entrySessionState{}, false, nil
		}

		return entrySessionState{}, false, err
	}

	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" || trimmed == "null" {
		return entrySessionState{}, false, nil
	}

	var state entrySessionState
	if err := json.Unmarshal([]byte(trimmed), &state); err != nil {
		return entrySessionState{}, false, nil
	}

	if strings.TrimSpace(state.RegistryURL) == "" {
		return entrySessionState{}, false, nil
	}

	return state, true, nil
}

func detectPackageManager(rootDir string, override string) string {
	candidate := strings.ToLower(strings.TrimSpace(override))
	switch candidate {
	case "bun", "pnpm", "yarn", "npm":
		return candidate
	}

	lockfiles := []struct {
		name    string
		manager string
	}{
		{name: "bun.lockb", manager: "bun"},
		{name: "bun.lock", manager: "bun"},
		{name: "pnpm-lock.yaml", manager: "pnpm"},
		{name: "yarn.lock", manager: "yarn"},
		{name: "package-lock.json", manager: "npm"},
	}

	for _, lockfile := range lockfiles {
		if pathExists(filepath.Join(rootDir, lockfile.name)) {
			return lockfile.manager
		}
	}

	return "npm"
}

func buildEntryManifest(invocation entryInvocation, state entrySessionState, manager string) (commandWorkerManifest, bool) {
	environment := buildEntryEnvEntries(os.Environ(), state)

	buildManagedManifest := func(command string, args []string) commandWorkerManifest {
		return commandWorkerManifest{
			Command:    command,
			Args:       args,
			Cwd:        invocation.rootDir,
			EnvEntries: environment,
			ParentPID:  os.Getppid(),
		}
	}

	extraArgs := append([]string{}, invocation.commandArgs...)
	extraArgs = append(extraArgs, invocation.passthroughArgs...)

	switch invocation.command {
	case "install":
		managerArgs := append([]string{"install"}, extraArgs...)
		return buildManagedManifest(manager, managerArgs), true

	case "publish":
		managerArgs := append([]string{}, extraArgs...)
		if manager == "yarn" {
			if isYarnClassic(invocation.rootDir) {
				managerArgs = append([]string{"publish"}, managerArgs...)
			} else {
				managerArgs = append([]string{"npm", "publish"}, managerArgs...)
			}
		} else {
			managerArgs = append([]string{"publish"}, managerArgs...)
		}
		return buildManagedManifest(manager, managerArgs), true

	case "dev", "test":
		scriptName := invocation.command
		if invocation.scriptName != "" {
			scriptName = invocation.scriptName
		}

		if manager == "npm" {
			managerArgs := []string{"run", scriptName}
			if len(extraArgs) > 0 {
				managerArgs = append(managerArgs, "--")
				managerArgs = append(managerArgs, extraArgs...)
			}
			return buildManagedManifest(manager, managerArgs), true
		}

		managerArgs := []string{"run", scriptName}
		managerArgs = append(managerArgs, extraArgs...)
		return buildManagedManifest(manager, managerArgs), true

	case "run":
		if len(invocation.passthroughArgs) == 0 {
			return commandWorkerManifest{}, false
		}

		command := invocation.passthroughArgs[0]
		args := append([]string{}, invocation.passthroughArgs[1:]...)
		return buildManagedManifest(command, args), true

	default:
		return commandWorkerManifest{}, false
	}
}

func buildEntryEnvEntries(base []string, state entrySessionState) []manifestKV {
	environment := make(map[string]string, len(base)+8)
	for _, entry := range base {
		separatorIndex := strings.Index(entry, "=")
		if separatorIndex <= 0 {
			continue
		}

		environment[entry[:separatorIndex]] = entry[separatorIndex+1:]
	}

	environment["PACKAGE_NINJA_REGISTRY_URL"] = state.RegistryURL
	environment["npm_config_registry"] = state.RegistryURL
	environment["NPM_CONFIG_REGISTRY"] = state.RegistryURL
	environment["YARN_NPM_REGISTRY_SERVER"] = state.RegistryURL
	environment["BUN_CONFIG_REGISTRY"] = state.RegistryURL

	if state.NpmrcPath != "" {
		environment["npm_config_userconfig"] = state.NpmrcPath
		environment["NPM_CONFIG_USERCONFIG"] = state.NpmrcPath
	}

	entries := make([]manifestKV, 0, len(environment))
	for name, value := range environment {
		entries = append(entries, manifestKV{Name: name, Value: value})
	}

	return entries
}

func runNodeFallback(rawArgs []string, rootDir string) error {
	nodePath := resolveNodeBinary()
	cliPath, err := resolveNodeCLIPath()
	if err != nil {
		return err
	}

	nodeArgs := append([]string{cliPath}, normalizeEntryArgs(rawArgs)...)
	environment := make([]manifestKV, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		separatorIndex := strings.Index(entry, "=")
		if separatorIndex <= 0 {
			continue
		}
		environment = append(environment, manifestKV{
			Name:  entry[:separatorIndex],
			Value: entry[separatorIndex+1:],
		})
	}

	manifest := commandWorkerManifest{
		Command:    nodePath,
		Args:       nodeArgs,
		Cwd:        rootDir,
		EnvEntries: environment,
		ParentPID:  os.Getppid(),
	}

	return executeManifest(manifest)
}

func resolveNodeBinary() string {
	if explicit := os.Getenv("PACKAGE_NINJA_NODE_BIN"); explicit != "" {
		return explicit
	}

	return "node"
}

func resolveNodeCLIPath() (string, error) {
	if explicit := os.Getenv("PACKAGE_NINJA_NODE_CLI_PATH"); explicit != "" {
		return explicit, nil
	}

	executable, err := os.Executable()
	if err != nil {
		return "", err
	}

	exeDir := filepath.Dir(executable)
	candidates := []string{
		filepath.Join(".", "dist", "cli.js"),
		filepath.Join(exeDir, "..", "dist", "cli.js"),
		filepath.Join(exeDir, "dist", "cli.js"),
	}

	for _, candidate := range candidates {
		if !pathExists(candidate) {
			continue
		}

		absolutePath, absErr := filepath.Abs(candidate)
		if absErr != nil {
			return candidate, nil
		}

		return absolutePath, nil
	}

	return "", errors.New("dist/cli.js not found")
}

func isYarnClassic(rootDir string) bool {
	packageJSONPath := filepath.Join(rootDir, "package.json")
	payload, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return false
	}

	var metadata struct {
		PackageManager string `json:"packageManager"`
	}

	if err := json.Unmarshal(payload, &metadata); err != nil {
		return false
	}

	return strings.HasPrefix(metadata.PackageManager, "yarn@1.")
}

func executeManifest(manifest commandWorkerManifest) error {
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

func pathExists(targetPath string) bool {
	info, err := os.Stat(targetPath)
	if err != nil {
		return false
	}

	return !info.IsDir()
}
