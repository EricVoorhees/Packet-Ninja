package parity

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	ResultMatch    = "match"
	ResultMismatch = "mismatch"
	ResultError    = "error"

	defaultMaxEntries = 300
)

type ReportEntry struct {
	Timestamp       string        `json:"timestamp"`
	Method          string        `json:"method"`
	Path            string        `json:"path"`
	AresStatus      int           `json:"aresStatus"`
	ShadowStatus    int           `json:"shadowStatus,omitempty"`
	AresTTFBMs      float64       `json:"aresTtfbMs"`
	ShadowTTFBMs    float64       `json:"shadowTtfbMs,omitempty"`
	AresBodyBytes   int           `json:"aresBodyBytes,omitempty"`
	ShadowBodyBytes int           `json:"shadowBodyBytes,omitempty"`
	Result          string        `json:"result"`
	Error           string        `json:"error,omitempty"`
	Diff            *MetadataDiff `json:"diff,omitempty"`
	StrictViolation bool          `json:"strictViolation,omitempty"`
}

type ReportSummary struct {
	Total            int `json:"total"`
	Matches          int `json:"matches"`
	Mismatches       int `json:"mismatches"`
	Errors           int `json:"errors"`
	StrictViolations int `json:"strictViolations"`
}

type ReportFile struct {
	UpdatedAt string        `json:"updatedAt"`
	Summary   ReportSummary `json:"summary"`
	Entries   []ReportEntry `json:"entries"`
}

type Reporter struct {
	mu         sync.Mutex
	filePath   string
	maxEntries int
}

func NewReporter(filePath string, maxEntries int) *Reporter {
	if maxEntries <= 0 {
		maxEntries = defaultMaxEntries
	}

	return &Reporter{
		filePath:   filePath,
		maxEntries: maxEntries,
	}
}

func (r *Reporter) Append(entry ReportEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if stringsTrim(entry.Timestamp) == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}

	report, err := r.readLocked()
	if err != nil {
		return err
	}

	report.Entries = append(report.Entries, entry)
	if overflow := len(report.Entries) - r.maxEntries; overflow > 0 {
		report.Entries = report.Entries[overflow:]
	}

	report.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	report.Summary = summarize(report.Entries)

	return r.writeLocked(report)
}

func (r *Reporter) readLocked() (ReportFile, error) {
	payload, err := os.ReadFile(r.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ReportFile{}, nil
		}
		return ReportFile{}, err
	}

	var report ReportFile
	if err := json.Unmarshal(payload, &report); err != nil {
		return ReportFile{}, fmt.Errorf("parity report parse failed: %w", err)
	}

	return report, nil
}

func (r *Reporter) writeLocked(report ReportFile) error {
	if err := os.MkdirAll(filepath.Dir(r.filePath), 0o755); err != nil {
		return err
	}

	payload, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	tempPath := fmt.Sprintf("%s.tmp-%d-%d", r.filePath, os.Getpid(), time.Now().UnixNano())
	if err := os.WriteFile(tempPath, payload, 0o644); err != nil {
		return err
	}

	return os.Rename(tempPath, r.filePath)
}

func summarize(entries []ReportEntry) ReportSummary {
	summary := ReportSummary{
		Total: len(entries),
	}

	for _, entry := range entries {
		switch entry.Result {
		case ResultMatch:
			summary.Matches += 1
		case ResultMismatch:
			summary.Mismatches += 1
		case ResultError:
			summary.Errors += 1
		}

		if entry.StrictViolation {
			summary.StrictViolations += 1
		}
	}

	return summary
}

func stringsTrim(value string) string {
	start := 0
	end := len(value)

	for start < end && (value[start] == ' ' || value[start] == '\t' || value[start] == '\n' || value[start] == '\r') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t' || value[end-1] == '\n' || value[end-1] == '\r') {
		end--
	}

	return value[start:end]
}
