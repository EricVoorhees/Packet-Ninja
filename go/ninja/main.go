package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	healthAttemptTimeout = 20 * time.Millisecond
	healthBudget         = 90 * time.Millisecond
	healthAttempts       = 3
)

type sessionState struct {
	HealthcheckURL string `json:"healthcheckUrl"`
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

	if hasState && pingHealthcheckWithRetry(state.HealthcheckURL) {
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

	if strings.TrimSpace(state.HealthcheckURL) == "" {
		return sessionState{}, false, nil
	}

	return state, true, nil
}

func pingHealthcheckWithRetry(url string) bool {
	deadline := time.Now().Add(healthBudget)

	for attempt := 0; attempt < healthAttempts; attempt++ {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false
		}

		timeout := healthAttemptTimeout
		if remaining < timeout {
			timeout = remaining
		}

		if pingHealthcheckOnce(url, timeout) {
			return true
		}

		if attempt == healthAttempts-1 {
			break
		}

		jitter := retryJitter(attempt)
		if jitter <= 0 {
			continue
		}

		remainingAfterAttempt := time.Until(deadline)
		if remainingAfterAttempt <= jitter {
			return false
		}

		time.Sleep(jitter)
	}

	return false
}

func pingHealthcheckOnce(url string, timeout time.Duration) bool {
	if strings.TrimSpace(url) == "" {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}

	client := http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode >= 200 && resp.StatusCode < 400
}

func retryJitter(attempt int) time.Duration {
	base := time.Duration(2+attempt*3) * time.Millisecond
	extra := time.Duration(time.Now().UnixNano()%2) * time.Millisecond
	return base + extra
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
