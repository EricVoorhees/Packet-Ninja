package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	handshakeTimeout = 5 * time.Millisecond
)

type sessionState struct {
	HandshakeEndpoint string `json:"handshakeEndpoint"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "ninja entry failed: %s\n", err.Error())
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	projectRoot := resolveProjectRoot(args)

	state, hasState, err := readState(projectRoot)
	if err != nil {
		return err
	}

	if hasState && pingHandshake(state.HandshakeEndpoint) {
		workerPath, err := resolveGoWorkerPath()
		if err != nil {
			return err
		}

		workerArgs := append([]string{"--entry", "--"}, args...)
		return execPassthrough(workerPath, workerArgs)
	}

	nodePath := resolveNodeBinary()
	cliPath, err := resolveNodeCLIPath()
	if err != nil {
		return err
	}

	nodeArgs := append([]string{cliPath}, args...)
	return execPassthrough(nodePath, nodeArgs)
}

func resolveProjectRoot(args []string) string {
	root, err := os.Getwd()
	if err != nil {
		return "."
	}

	// Keep routing intentionally minimal. We only honor --cwd/--root.
	for idx := 0; idx < len(args)-1; idx++ {
		option := args[idx]
		if option != "--cwd" && option != "--root" {
			continue
		}

		resolved := args[idx+1]
		if resolved == "" {
			break
		}

		absolute, err := filepath.Abs(resolved)
		if err == nil {
			return absolute
		}
	}

	return root
}

func readState(projectRoot string) (sessionState, bool, error) {
	statePath := filepath.Join(projectRoot, ".package-ninja", "state.json")
	payload, err := os.ReadFile(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return sessionState{}, false, nil
		}

		return sessionState{}, false, err
	}

	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" || trimmed == "null" {
		return sessionState{}, false, nil
	}

	var state sessionState
	if err := json.Unmarshal([]byte(trimmed), &state); err != nil {
		return sessionState{}, false, nil
	}

	if strings.TrimSpace(state.HandshakeEndpoint) == "" {
		return sessionState{}, false, nil
	}

	return state, true, nil
}

func pingHandshake(endpoint string) bool {
	if strings.TrimSpace(endpoint) == "" {
		return false
	}

	conn, err := dialHandshake(endpoint, handshakeTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	if _, err := conn.Write([]byte("ping\n")); err != nil {
		return false
	}

	response, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return false
	}

	return strings.EqualFold(strings.TrimSpace(response), "pong")
}

func resolveGoWorkerPath() (string, error) {
	if explicit := os.Getenv("PACKAGE_NINJA_GO_WORKER_PATH"); explicit != "" {
		return explicit, nil
	}

	executable, err := os.Executable()
	if err != nil {
		return "", err
	}

	exeDir := filepath.Dir(executable)
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}

	candidates := []string{
		filepath.Join(exeDir, "command-worker-go"+ext),
		filepath.Join(exeDir, "..", "bin", "command-worker-go"+ext),
		filepath.Join(".", "bin", "command-worker-go"+ext),
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

	return "", errors.New("command-worker-go binary not found")
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

func execPassthrough(binary string, args []string) error {
	cmd := exec.Command(binary, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	err := cmd.Run()
	if err == nil {
		return nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		os.Exit(exitErr.ExitCode())
	}

	return err
}

func pathExists(targetPath string) bool {
	info, err := os.Stat(targetPath)
	if err != nil {
		return false
	}

	return !info.IsDir()
}
