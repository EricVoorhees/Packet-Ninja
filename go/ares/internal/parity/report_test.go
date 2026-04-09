package parity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReporterAppendAndSummarize(t *testing.T) {
	tempDir := t.TempDir()
	reportPath := filepath.Join(tempDir, "parity-report.json")
	reporter := NewReporter(reportPath, 3)

	if err := reporter.Append(ReportEntry{
		Method:     "GET",
		Path:       "/react",
		AresStatus: 200,
		Result:     ResultMatch,
	}); err != nil {
		t.Fatalf("append match entry failed: %v", err)
	}

	if err := reporter.Append(ReportEntry{
		Method:          "GET",
		Path:            "/lodash",
		AresStatus:      200,
		ShadowStatus:    200,
		Result:          ResultMismatch,
		StrictViolation: true,
	}); err != nil {
		t.Fatalf("append mismatch entry failed: %v", err)
	}

	if err := reporter.Append(ReportEntry{
		Method:          "GET",
		Path:            "/left-pad",
		AresStatus:      200,
		Result:          ResultError,
		Error:           "shadow timeout",
		StrictViolation: true,
	}); err != nil {
		t.Fatalf("append error entry failed: %v", err)
	}

	payload, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatalf("read report failed: %v", err)
	}

	var report ReportFile
	if err := json.Unmarshal(payload, &report); err != nil {
		t.Fatalf("decode report failed: %v", err)
	}

	if report.Summary.Total != 3 {
		t.Fatalf("expected total=3, received %d", report.Summary.Total)
	}
	if report.Summary.Matches != 1 {
		t.Fatalf("expected matches=1, received %d", report.Summary.Matches)
	}
	if report.Summary.Mismatches != 1 {
		t.Fatalf("expected mismatches=1, received %d", report.Summary.Mismatches)
	}
	if report.Summary.Errors != 1 {
		t.Fatalf("expected errors=1, received %d", report.Summary.Errors)
	}
	if report.Summary.StrictViolations != 2 {
		t.Fatalf("expected strictViolations=2, received %d", report.Summary.StrictViolations)
	}
}

func TestReporterTrimsEntries(t *testing.T) {
	tempDir := t.TempDir()
	reportPath := filepath.Join(tempDir, "parity-report.json")
	reporter := NewReporter(reportPath, 2)

	for index := 0; index < 3; index += 1 {
		if err := reporter.Append(ReportEntry{
			Method:     "GET",
			Path:       "/pkg",
			AresStatus: 200,
			Result:     ResultMatch,
		}); err != nil {
			t.Fatalf("append %d failed: %v", index, err)
		}
	}

	payload, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatalf("read report failed: %v", err)
	}

	var report ReportFile
	if err := json.Unmarshal(payload, &report); err != nil {
		t.Fatalf("decode report failed: %v", err)
	}

	if len(report.Entries) != 2 {
		t.Fatalf("expected 2 entries after trim, received %d", len(report.Entries))
	}
	if report.Summary.Total != 2 {
		t.Fatalf("expected summary total=2 after trim, received %d", report.Summary.Total)
	}
}
