//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	processTerminate               = 0x0001
	processSetQuota                = 0x0100
	processQueryLimitedInformation = 0x1000
	jobObjectExtendedLimitInfo     = 9
	jobObjectBasicAccountingInfo   = 1
	jobObjectLimitKillOnClose      = 0x00002000
	stillActive                    = 259
)

var (
	kernel32                      = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW          = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject   = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject  = kernel32.NewProc("AssignProcessToJobObject")
	procQueryInformationJobObject = kernel32.NewProc("QueryInformationJobObject")
	procOpenProcess               = kernel32.NewProc("OpenProcess")
	procCloseHandle               = kernel32.NewProc("CloseHandle")
	procGetExitCodeProcess        = kernel32.NewProc("GetExitCodeProcess")
)

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type jobObjectBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

func startManagedProcess(manifest commandWorkerManifest) (*managedProcess, error) {
	commandLine := buildCommandLine(manifest.Command, manifest.Args)
	command := exec.Command("cmd.exe", "/d", "/s", "/c", commandLine)
	command.Dir = manifest.Cwd
	command.Env = manifestEnvironment(manifest.EnvEntries)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr

	if err := command.Start(); err != nil {
		return nil, err
	}

	pid := command.Process.Pid
	jobHandle, assigned := assignKillOnCloseJob(pid)

	return &managedProcess{
		command: command,
		pid:     pid,
		forward: func(_ os.Signal) {
			_ = killProcessTree(pid)
		},
		forceKill: func() {
			_ = killProcessTree(pid)
		},
		waitForDrain: func(timeout time.Duration) {
			if assigned {
				waitForJobDrain(jobHandle, timeout)
			}
		},
		close: func() {
			if assigned {
				closeHandle(jobHandle)
			}
		},
	}, nil
}

func registerInterruptSignals(signalCh chan os.Signal) {
	signal.Notify(signalCh, os.Interrupt)
}

func supportsGracefulForward() bool {
	return false
}

func defaultTerminationSignal() os.Signal {
	return namedSignal("SIGTERM")
}

func processExitSignal(_ *os.ProcessState) os.Signal {
	return nil
}

func isProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}

	handle, err := openProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer closeHandle(handle)

	var exitCode uint32
	result, _, _ := procGetExitCodeProcess.Call(handle, uintptr(unsafe.Pointer(&exitCode)))
	if result == 0 {
		return false
	}

	return exitCode == stillActive
}

func manifestEnvironment(entries []manifestKV) []string {
	env := make([]string, 0, len(entries))
	for _, entry := range entries {
		env = append(env, entry.Name+"="+entry.Value)
	}
	return env
}

func buildCommandLine(command string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, quoteCmdArgument(command))
	for _, arg := range args {
		parts = append(parts, quoteCmdArgument(arg))
	}
	return strings.Join(parts, " ")
}

func quoteCmdArgument(arg string) string {
	if arg == "" {
		return `""`
	}

	if !strings.ContainsAny(arg, " \t\"&|<>^()") {
		return arg
	}

	var builder strings.Builder
	builder.WriteByte('"')
	backslashes := 0

	for i := 0; i < len(arg); i++ {
		ch := arg[i]
		if ch == '\\' {
			backslashes++
			continue
		}

		if ch == '"' {
			builder.WriteString(strings.Repeat(`\`, backslashes*2+1))
			builder.WriteByte('"')
			backslashes = 0
			continue
		}

		if backslashes > 0 {
			builder.WriteString(strings.Repeat(`\`, backslashes))
			backslashes = 0
		}

		builder.WriteByte(ch)
	}

	if backslashes > 0 {
		builder.WriteString(strings.Repeat(`\`, backslashes*2))
	}

	builder.WriteByte('"')
	return builder.String()
}

func assignKillOnCloseJob(pid int) (uintptr, bool) {
	jobHandle, err := createKillOnCloseJob()
	if err != nil {
		return 0, false
	}

	processHandle, err := openProcess(processTerminate|processSetQuota|processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		closeHandle(jobHandle)
		return 0, false
	}
	defer closeHandle(processHandle)

	if err := assignProcessToJobObject(jobHandle, processHandle); err != nil {
		closeHandle(jobHandle)
		return 0, false
	}

	return jobHandle, true
}

func waitForJobDrain(jobHandle uintptr, timeout time.Duration) {
	startedAt := time.Now()
	for time.Since(startedAt) < timeout {
		active, err := queryActiveProcessCount(jobHandle)
		if err != nil || active == 0 {
			return
		}

		time.Sleep(100 * time.Millisecond)
	}
}

func queryActiveProcessCount(jobHandle uintptr) (uint32, error) {
	var info jobObjectBasicAccountingInformation
	result, _, callErr := procQueryInformationJobObject.Call(
		jobHandle,
		uintptr(jobObjectBasicAccountingInfo),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
		0,
	)
	if result == 0 {
		return 0, callErr
	}

	return info.ActiveProcesses, nil
}

func createKillOnCloseJob() (uintptr, error) {
	jobHandle, _, callErr := procCreateJobObjectW.Call(0, 0)
	if jobHandle == 0 {
		return 0, callErr
	}

	info := jobObjectExtendedLimitInformation{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnClose
	result, _, setErr := procSetInformationJobObject.Call(
		jobHandle,
		uintptr(jobObjectExtendedLimitInfo),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if result == 0 {
		closeHandle(jobHandle)
		return 0, setErr
	}

	return jobHandle, nil
}

func assignProcessToJobObject(jobHandle uintptr, processHandle uintptr) error {
	result, _, callErr := procAssignProcessToJobObject.Call(jobHandle, processHandle)
	if result == 0 {
		return callErr
	}
	return nil
}

func killProcessTree(pid int) error {
	if pid <= 0 {
		return nil
	}

	command := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	command.Stdout = nil
	command.Stderr = nil
	return command.Run()
}

func openProcess(desiredAccess uint32, inheritHandle bool, pid uint32) (uintptr, error) {
	var inherit uintptr
	if inheritHandle {
		inherit = 1
	}

	handle, _, callErr := procOpenProcess.Call(
		uintptr(desiredAccess),
		inherit,
		uintptr(pid),
	)
	if handle == 0 {
		return 0, fmt.Errorf("OpenProcess failed: %w", callErr)
	}

	return handle, nil
}

func closeHandle(handle uintptr) {
	if handle == 0 {
		return
	}

	procCloseHandle.Call(handle)
}
